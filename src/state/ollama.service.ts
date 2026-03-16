import { CapturedFrame } from '../capture/game-capture.service';
import {
  MonitoredRegion,
  StateCalculation,
  StateCalculationResult,
  Rectangle,
  OllamaConfig,
} from '../shared';
import { logger, LogCategory } from '../shared/logger';
import { computeRegionPixelHash } from '../shared/pixel-hash';

/**
 * Manages Ollama LLM inference for monitored regions that have OllamaLLM-type
 * state calculations.
 *
 * Runs on its own throttled interval (independent of capture FPS) because LLM
 * inference is significantly more expensive than color math or OCR.
 */
export class OllamaService {
  private isProcessing = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Latest Ollama results keyed by `regionId:calcId`. */
  private latestResults = new Map<string, StateCalculationResult>();

  /** Pixel hash cache keyed by `regionId:calcId` for skip-if-unchanged. */
  private pixelHashCache = new Map<string, number>();

  /** The most recent frame to run inference on. */
  private latestFrame: CapturedFrame | null = null;

  /** Regions to evaluate. Updated from working or saved config. */
  private regions: MonitoredRegion[] = [];

  private config: OllamaConfig = {
    baseUrl: 'http://localhost:11434',
    modelName: 'qwen3.5:0.8b',
    intervalMs: 500,
    keepAlive: '5m',
  };

  public start(config: OllamaConfig): void {
    this.config = config;
    this.stop();

    this.intervalHandle = setInterval(() => {
      this.runInferenceCycle();
    }, config.intervalMs);

    logger.info(LogCategory.StateCalculation,
      `Ollama service started: model=${config.modelName}, interval=${config.intervalMs}ms, baseUrl=${config.baseUrl}`
    );
  }

  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  public onFrameCaptured(frame: CapturedFrame): void {
    this.latestFrame = frame;
  }

  public setRegions(regions: MonitoredRegion[]): void {
    this.regions = regions;
  }

  public getAllResults(): Map<string, StateCalculationResult> {
    return this.latestResults;
  }

  /**
   * Lists available models from the Ollama API.
   */
  public async listModels(): Promise<Array<{ name: string; size: number }>> {
    try {
      const http = require('http');
      const url = `${this.config.baseUrl}/api/tags`;

      return new Promise((resolve, reject) => {
        const req = http.get(url, (res: any) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const models = (parsed.models || []).map((m: any) => ({
                name: m.name || m.model,
                size: m.size || 0,
              }));
              resolve(models);
            } catch {
              resolve([]);
            }
          });
        });
        req.on('error', () => resolve([]));
        req.setTimeout(3000, () => { req.destroy(); resolve([]); });
      });
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async runInferenceCycle(): Promise<void> {
    if (this.isProcessing || !this.latestFrame) return;

    const ollamaCalcs = this.collectOllamaCalculations();
    if (ollamaCalcs.length === 0) return;

    this.isProcessing = true;
    const frame = this.latestFrame!;

    try {
      // Group calcs by calculation ID so that multiple regions sharing the
      // same calc run serially, but different calcs run in parallel.
      const calcGroups = new Map<string, Array<{ region: MonitoredRegion; calculation: StateCalculation }>>();
      for (const entry of ollamaCalcs) {
        const calcId = entry.calculation.id;
        const existingGroup = calcGroups.get(calcId);
        if (existingGroup) {
          existingGroup.push(entry);
        } else {
          calcGroups.set(calcId, [entry]);
        }
      }

      // Each calc group runs its entries serially; all groups run in parallel.
      const groupTasks: Array<Promise<void>> = [];

      for (const [_calcId, entries] of calcGroups) {
        const groupTask = (async () => {
          for (const { region, calculation } of entries) {
            await this.runSingleInference(frame, region, calculation);
          }
        })();
        groupTasks.push(groupTask);
      }

      await Promise.all(groupTasks);
    } catch (error) {
      logger.error(LogCategory.StateCalculation, 'Ollama inference cycle error.', error);
    }
    this.isProcessing = false;
  }

  private async runSingleInference(
    frame: CapturedFrame,
    region: MonitoredRegion,
    calculation: StateCalculation,
  ): Promise<void> {
    const ollamaCalcConfig = calculation.ollamaConfig;
    if (!ollamaCalcConfig || !ollamaCalcConfig.prompt) return;

    const cacheKey = `${region.id}:${calculation.id}`;

    const shouldSkipIfUnchanged = ollamaCalcConfig.skipIfUnchanged !== false;
    if (shouldSkipIfUnchanged) {
      const currentHash = computeRegionPixelHash(frame, region.bounds);
      const previousHash = this.pixelHashCache.get(cacheKey);
      const regionIsUnchanged = previousHash !== undefined && previousHash === currentHash;
      if (regionIsUnchanged) return;
      this.pixelHashCache.set(cacheKey, currentHash);
    }

    const imageBase64 = this.extractRegionAsBase64Png(frame, region.bounds);
    if (!imageBase64) return;

    const startTime = Date.now();
    const responseText = await this.callOllama(
      ollamaCalcConfig.prompt,
      imageBase64,
      ollamaCalcConfig.numPredict || 5,
      ollamaCalcConfig.think ?? false,
    );
    const elapsedMs = Date.now() - startTime;
    const trimmedResponse = responseText.trim();

    this.latestResults.set(cacheKey, {
      stateCalculationId: calculation.id,
      medianColor: { red: 0, green: 0, blue: 0 },
      currentValue: trimmedResponse,
      confidenceByMapping: {},
      ollamaResponse: trimmedResponse,
      ollamaResponseTimeMs: elapsedMs,
    });
  }

  private collectOllamaCalculations(): Array<{ region: MonitoredRegion; calculation: StateCalculation }> {
    const results: Array<{ region: MonitoredRegion; calculation: StateCalculation }> = [];
    for (const region of this.regions) {
      for (const calc of region.stateCalculations) {
        if (calc.type === 'OllamaLLM') {
          results.push({ region, calculation: calc });
        }
      }
    }
    return results;
  }

  private async callOllama(
    prompt: string,
    imageBase64: string,
    numPredict: number,
    think: boolean,
  ): Promise<string> {
    const http = require('http');
    const url = new (require('url').URL)(`${this.config.baseUrl}/api/generate`);

    const requestBody = JSON.stringify({
      model: this.config.modelName,
      prompt,
      images: [imageBase64],
      stream: false,
      think,
      keep_alive: this.config.keepAlive,
      options: {
        temperature: 0,
        num_predict: numPredict,
      },
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || 11434,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      };

      const req = http.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.response || '');
          } catch {
            resolve('');
          }
        });
      });

      req.on('error', (err: any) => {
        logger.error(LogCategory.StateCalculation, 'Ollama HTTP request failed.', err);
        resolve('');
      });

      req.setTimeout(10000, () => {
        logger.warn(LogCategory.StateCalculation, 'Ollama request timed out (10s).');
        req.destroy();
        resolve('');
      });

      req.write(requestBody);
      req.end();
    });
  }

  /**
   * Extracts a rectangular region from the BGRA frame buffer and returns
   * a base64-encoded PNG string for the Ollama images API.
   */
  private extractRegionAsBase64Png(frame: CapturedFrame, bounds: Rectangle): string | null {
    const { nativeImage } = require('electron');

    const bytesPerPixel = 4;
    const regionWidth = Math.min(bounds.width, frame.width - bounds.x);
    const regionHeight = Math.min(bounds.height, frame.height - bounds.y);

    if (regionWidth <= 0 || regionHeight <= 0) return null;

    const regionBuffer = Buffer.alloc(regionWidth * regionHeight * bytesPerPixel);
    const frameRowBytes = frame.width * bytesPerPixel;

    for (let row = 0; row < regionHeight; row++) {
      const sourceOffset = (bounds.y + row) * frameRowBytes + bounds.x * bytesPerPixel;
      const destOffset = row * regionWidth * bytesPerPixel;
      frame.buffer.copy(regionBuffer, destOffset, sourceOffset, sourceOffset + regionWidth * bytesPerPixel);
    }

    // Convert BGRA to RGBA
    for (let i = 0; i < regionBuffer.length; i += 4) {
      const blue = regionBuffer[i];
      regionBuffer[i] = regionBuffer[i + 2];
      regionBuffer[i + 2] = blue;
    }

    const image = nativeImage.createFromBuffer(regionBuffer, {
      width: regionWidth,
      height: regionHeight,
    });

    return image.toPNG().toString('base64');
  }
}
