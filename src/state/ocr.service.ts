import { CapturedFrame } from '../capture/game-capture.service';
import {
  MonitoredRegion,
  StateCalculation,
  StateCalculationResult,
  Rectangle,
  OcrConfig,
  OcrPreprocessConfig,
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

const DEFAULT_CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?/-+';
const DEFAULT_PAGE_SEG_MODE = 7; // PSM.SINGLE_LINE

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

      // Set sensible defaults — these get overridden per-calc in runOcrCycle
      await this.worker.setParameters({
        tessedit_pageseg_mode: DEFAULT_PAGE_SEG_MODE,
        tessedit_char_whitelist: DEFAULT_CHAR_WHITELIST,
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
        // Extract raw RGBA pixels from the frame buffer
        const rawPixels = this.extractRegionRgba(this.latestFrame!, region.bounds);
        if (!rawPixels) continue;

        // Apply the preprocessing pipeline, then convert to PNG for Tesseract
        const preprocessConfig = calculation.ocrPreprocess;
        const processedPng = this.applyPreprocessingPipeline(
          rawPixels.buffer,
          rawPixels.width,
          rawPixels.height,
          preprocessConfig,
        );

        // Apply per-calc Tesseract parameters
        const charWhitelist = preprocessConfig?.charWhitelist || DEFAULT_CHAR_WHITELIST;
        const pageSegMode = preprocessConfig?.pageSegMode ?? DEFAULT_PAGE_SEG_MODE;
        await this.worker.setParameters({
          tessedit_pageseg_mode: pageSegMode,
          tessedit_char_whitelist: charWhitelist,
        });

        const { data } = await this.worker.recognize(processedPng);
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

  // ---------------------------------------------------------------------------
  // Region extraction
  // ---------------------------------------------------------------------------

  /**
   * Extracts a rectangular region from the BGRA frame buffer and returns
   * an RGBA pixel buffer with dimensions. This is the raw input to the
   * preprocessing pipeline.
   */
  private extractRegionRgba(
    frame: CapturedFrame,
    bounds: Rectangle,
  ): { buffer: Buffer; width: number; height: number } | null {
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

    // Convert BGRA to RGBA (swap B and R channels)
    for (let i = 0; i < regionBuffer.length; i += 4) {
      const blue = regionBuffer[i];
      regionBuffer[i] = regionBuffer[i + 2]; // R
      regionBuffer[i + 2] = blue;             // B
    }

    return { buffer: regionBuffer, width: regionWidth, height: regionHeight };
  }

  // ---------------------------------------------------------------------------
  // Preprocessing pipeline
  // ---------------------------------------------------------------------------

  /**
   * Applies the preprocessing pipeline to RGBA pixel data and returns a PNG buffer.
   *
   * Pipeline order:
   *   1. Upscale (nearest-neighbor, fast)
   *   2. Color filter (zero out pixels outside the target color range)
   *   3. Threshold / binarize (convert to black & white at a brightness cutoff)
   *   4. Invert (swap black/white)
   *   5. Convert to PNG via nativeImage
   */
  private applyPreprocessingPipeline(
    rgbaBuffer: Buffer,
    width: number,
    height: number,
    config?: OcrPreprocessConfig,
  ): Buffer {
    const { nativeImage } = require('electron');

    let pixels = rgbaBuffer;
    let w = width;
    let h = height;

    // Step 1: Upscale
    const upscaleFactor = config?.upscaleFactor ?? 1;
    if (upscaleFactor > 1) {
      const upscaled = this.upscaleNearestNeighbor(pixels, w, h, upscaleFactor);
      pixels = upscaled.buffer;
      w = upscaled.width;
      h = upscaled.height;
    }

    // Step 2: Color filter — zero out pixels not near the target color
    const colorFilterIsEnabled = config?.colorFilterEnabled === true;
    if (colorFilterIsEnabled) {
      const target = config!.colorFilterTarget;
      const tolerance = config!.colorFilterTolerance ?? 40;
      this.applyColorFilter(pixels, target.red, target.green, target.blue, tolerance);
    }

    // Step 3: Threshold / binarize
    const thresholdValue = config?.threshold ?? 0;
    const thresholdIsEnabled = thresholdValue > 0;
    if (thresholdIsEnabled) {
      this.applyThreshold(pixels, thresholdValue);
    }

    // Step 4: Invert
    const shouldInvert = config?.invert === true;
    if (shouldInvert) {
      this.applyInvert(pixels);
    }

    // Convert to PNG
    const image = nativeImage.createFromBuffer(pixels, { width: w, height: h });
    return image.toPNG();
  }

  /**
   * Nearest-neighbor upscale of RGBA buffer.
   */
  private upscaleNearestNeighbor(
    pixels: Buffer,
    width: number,
    height: number,
    factor: number,
  ): { buffer: Buffer; width: number; height: number } {
    const newWidth = width * factor;
    const newHeight = height * factor;
    const bytesPerPixel = 4;
    const result = Buffer.alloc(newWidth * newHeight * bytesPerPixel);

    for (let destRow = 0; destRow < newHeight; destRow++) {
      const sourceRow = (destRow / factor) | 0;
      for (let destCol = 0; destCol < newWidth; destCol++) {
        const sourceCol = (destCol / factor) | 0;
        const sourceOffset = (sourceRow * width + sourceCol) * bytesPerPixel;
        const destOffset = (destRow * newWidth + destCol) * bytesPerPixel;
        pixels.copy(result, destOffset, sourceOffset, sourceOffset + bytesPerPixel);
      }
    }

    return { buffer: result, width: newWidth, height: newHeight };
  }

  /**
   * Zeros out pixels whose R/G/B channels are not within `tolerance` of the
   * target color. Keeps matching pixels as-is. Operates in-place on RGBA buffer.
   */
  private applyColorFilter(
    pixels: Buffer,
    targetR: number,
    targetG: number,
    targetB: number,
    tolerance: number,
  ): void {
    for (let i = 0; i < pixels.length; i += 4) {
      const redDifference = Math.abs(pixels[i] - targetR);
      const greenDifference = Math.abs(pixels[i + 1] - targetG);
      const blueDifference = Math.abs(pixels[i + 2] - targetB);
      const isWithinTolerance = redDifference <= tolerance
                             && greenDifference <= tolerance
                             && blueDifference <= tolerance;
      if (!isWithinTolerance) {
        pixels[i] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
      }
    }
  }

  /**
   * Converts RGBA pixels to black or white based on brightness threshold.
   * Pixels brighter than the threshold become white (255), others become black (0).
   * Operates in-place.
   */
  private applyThreshold(pixels: Buffer, threshold: number): void {
    for (let i = 0; i < pixels.length; i += 4) {
      // Luminance approximation: (R*299 + G*587 + B*114) / 1000
      const brightness = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
      const outputValue = brightness >= threshold ? 255 : 0;
      pixels[i] = outputValue;
      pixels[i + 1] = outputValue;
      pixels[i + 2] = outputValue;
    }
  }

  /**
   * Inverts R/G/B channels of every pixel. Operates in-place on RGBA buffer.
   */
  private applyInvert(pixels: Buffer): void {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255 - pixels[i];
      pixels[i + 1] = 255 - pixels[i + 1];
      pixels[i + 2] = 255 - pixels[i + 2];
    }
  }

  // ---------------------------------------------------------------------------
  // Substring mapping evaluation
  // ---------------------------------------------------------------------------

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
