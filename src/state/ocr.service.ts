import { CapturedFrame } from '../capture/game-capture.service';
import {
  MonitoredRegion,
  StateCalculation,
  StateCalculationResult,
  Rectangle,
  OcrConfig,
} from '../shared';
import { logger, LogCategory } from '../shared/logger';

// Dynamic require to avoid compile-time failure if tesseract.js isn't installed yet.
// The types are inferred at runtime.
let tesseractModule: any = null;
function getTesseract(): any {
  if (!tesseractModule) {
    try {
      tesseractModule = require('tesseract.js');
    } catch {
      logger.error(LogCategory.StateCalculation, 'tesseract.js is not installed. Run: npm install tesseract.js');
    }
  }
  return tesseractModule;
}

/**
 * Manages OCR evaluation for monitored regions that have OCR-type state calculations.
 *
 * Runs on its own throttled interval (independent of capture FPS) because OCR
 * is significantly more expensive than color math. Uses a persistent Tesseract
 * worker to avoid reinitialisation overhead on each frame.
 */
export class OcrService {
  private worker: any = null;
  private isInitializing = false;
  private isProcessing = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Latest OCR results keyed by `regionId:calcId`. */
  private latestResults = new Map<string, StateCalculationResult>();

  /** The most recent frame to OCR against. Updated by the capture pipeline. */
  private latestFrame: CapturedFrame | null = null;

  /** Regions to evaluate. Updated from working or saved config. */
  private regions: MonitoredRegion[] = [];

  private ocrConfig: OcrConfig = { ocrIntervalMs: 200, maxCharacters: 10 };

  /**
   * Starts the OCR evaluation loop.
   */
  public start(config: OcrConfig): void {
    this.ocrConfig = config;
    this.stop();
    this.ensureWorkerInitialized();

    this.intervalHandle = setInterval(() => {
      this.runOcrCycle();
    }, config.ocrIntervalMs);

    logger.info(LogCategory.StateCalculation, `OCR service started: interval=${config.ocrIntervalMs}ms, maxChars=${config.maxCharacters}`);
  }

  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  public async shutdown(): Promise<void> {
    this.stop();
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }
  }

  /**
   * Called by the capture pipeline with each new frame.
   */
  public onFrameCaptured(frame: CapturedFrame): void {
    this.latestFrame = frame;
  }

  /**
   * Update the set of regions to evaluate.
   */
  public setRegions(regions: MonitoredRegion[]): void {
    this.regions = regions;
  }

  /**
   * Returns the latest OCR result for a given region+calc, or null if not yet available.
   */
  public getResult(regionId: string, calcId: string): StateCalculationResult | null {
    return this.latestResults.get(`${regionId}:${calcId}`) || null;
  }

  /**
   * Returns all current OCR results.
   */
  public getAllResults(): Map<string, StateCalculationResult> {
    return this.latestResults;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async ensureWorkerInitialized(): Promise<void> {
    if (this.worker || this.isInitializing) return;

    const tesseract = getTesseract();
    if (!tesseract) return;

    this.isInitializing = true;
    try {
      this.worker = await tesseract.createWorker('eng', 1, {
        logger: () => {},
      });

      // PSM.SINGLE_LINE = 7 — best for small game UI regions with a single line of text
      const psmSingleLine = tesseract.PSM?.SINGLE_LINE ?? 7;

      await this.worker.setParameters({
        tessedit_pageseg_mode: psmSingleLine,
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?/-+',
      });

      logger.info(LogCategory.StateCalculation, 'Tesseract OCR worker initialized.');
    } catch (error) {
      logger.error(LogCategory.StateCalculation, 'Failed to initialize Tesseract worker.', error);
      this.worker = null;
    }
    this.isInitializing = false;
  }

  private async runOcrCycle(): Promise<void> {
    if (this.isProcessing || !this.worker || !this.latestFrame) return;

    const ocrCalculations = this.collectOcrCalculations();
    if (ocrCalculations.length === 0) return;

    this.isProcessing = true;
    try {
      for (const { region, calculation } of ocrCalculations) {
        const imageBuffer = this.extractRegionAsPng(this.latestFrame!, region.bounds);
        if (!imageBuffer) continue;

        const { data } = await this.worker.recognize(imageBuffer);
        const rawText = data.text.trim().substring(0, this.ocrConfig.maxCharacters);

        const result = this.evaluateSubstringMappings(rawText, calculation);
        this.latestResults.set(`${region.id}:${calculation.id}`, result);
      }
    } catch (error) {
      logger.error(LogCategory.StateCalculation, 'OCR cycle error.', error);
    }
    this.isProcessing = false;
  }

  private collectOcrCalculations(): Array<{ region: MonitoredRegion; calculation: StateCalculation }> {
    const results: Array<{ region: MonitoredRegion; calculation: StateCalculation }> = [];
    for (const region of this.regions) {
      for (const calc of region.stateCalculations) {
        if (calc.type === 'OCR') {
          results.push({ region, calculation: calc });
        }
      }
    }
    return results;
  }

  /**
   * Extracts a rectangular region from the BGRA frame buffer and converts to
   * a PNG-format Buffer that Tesseract can consume.
   */
  private extractRegionAsPng(frame: CapturedFrame, bounds: Rectangle): Buffer | null {
    const { nativeImage } = require('electron');

    const bytesPerPixel = 4;
    const regionWidth = Math.min(bounds.width, frame.width - bounds.x);
    const regionHeight = Math.min(bounds.height, frame.height - bounds.y);

    if (regionWidth <= 0 || regionHeight <= 0) return null;

    // Extract the region pixels into a new BGRA buffer
    const regionBuffer = Buffer.alloc(regionWidth * regionHeight * bytesPerPixel);
    const frameRowBytes = frame.width * bytesPerPixel;

    for (let row = 0; row < regionHeight; row++) {
      const sourceOffset = (bounds.y + row) * frameRowBytes + bounds.x * bytesPerPixel;
      const destOffset = row * regionWidth * bytesPerPixel;
      frame.buffer.copy(regionBuffer, destOffset, sourceOffset, sourceOffset + regionWidth * bytesPerPixel);
    }

    // Convert BGRA to RGBA (swap B and R channels) for nativeImage
    for (let i = 0; i < regionBuffer.length; i += 4) {
      const blue = regionBuffer[i];
      regionBuffer[i] = regionBuffer[i + 2]; // R
      regionBuffer[i + 2] = blue;             // B
    }

    // Create a nativeImage and export as PNG
    const image = nativeImage.createFromBuffer(regionBuffer, {
      width: regionWidth,
      height: regionHeight,
    });

    return image.toPNG();
  }

  private evaluateSubstringMappings(
    ocrText: string,
    calculation: StateCalculation
  ): StateCalculationResult {
    const lowerText = ocrText.toLowerCase();
    let matchedValue = '';

    const mappings = calculation.substringMappings || [];
    for (const mapping of mappings) {
      const substringLower = mapping.substring.toLowerCase();
      const isMatch = substringLower.length > 0 && lowerText.includes(substringLower);
      if (isMatch) {
        matchedValue = mapping.stateValue;
        break; // First match wins
      }
    }

    return {
      stateCalculationId: calculation.id,
      medianColor: { red: 0, green: 0, blue: 0 },
      currentValue: matchedValue,
      confidenceByMapping: {},
      ocrText,
    };
  }
}
