import * as path from 'path';
import { GameCaptureConfig } from '../shared';
import { logger, LogCategory } from '../shared/logger';

/**
 * Represents a single captured frame as a raw BGRA pixel buffer
 * along with its dimensions.
 */
export interface CapturedFrame {
  /** Raw pixel data in BGRA format. */
  buffer: Buffer;
  width: number;
  height: number;
  /** High-resolution timestamp from performance.now(). */
  capturedAt: number;
}

/**
 * Callback invoked each time a new frame is captured.
 */
export type FrameCapturedCallback = (frame: CapturedFrame) => void;

/**
 * Information about an available display, as reported by the native addon.
 */
export interface DisplayInfo {
  adapterIndex: number;
  outputIndex: number;
  name: string;
  width: number;
  height: number;
}

/**
 * Shape of the native DXGI capture addon's exports.
 */
interface NativeDxgiCapture {
  listDisplays(): DisplayInfo[];
  startCapture(displayIndex: number, callback?: (frame: { buffer: Buffer; width: number; height: number }) => void): boolean;
  stopCapture(): void;
  getLatestFrame(): { buffer: Buffer; width: number; height: number } | null;
}

/**
 * Attempts to load the compiled native DXGI addon.
 * Returns null if the addon is not available (e.g. not compiled yet,
 * or running on a non-Windows platform).
 */
function tryLoadNativeAddon(): NativeDxgiCapture | null {
  try {
    const addonPath = path.join(__dirname, '..', '..', '..', 'native', 'build', 'Release', 'dxgi_capture.node');
    const addon = require(addonPath) as NativeDxgiCapture;

    // Verify it has the functions we expect
    const hasListDisplays = typeof addon.listDisplays === 'function';
    const hasStartCapture = typeof addon.startCapture === 'function';
    const hasStopCapture = typeof addon.stopCapture === 'function';
    const hasGetLatestFrame = typeof addon.getLatestFrame === 'function';
    const allFunctionsPresent = hasListDisplays && hasStartCapture && hasStopCapture && hasGetLatestFrame;

    if (!allFunctionsPresent) {
      logger.warn(LogCategory.Capture, 'Native addon loaded but missing expected functions.');
      return null;
    }

    logger.info(LogCategory.Capture, 'Native DXGI capture addon loaded successfully.');
    return addon;
  } catch (error) {
    logger.warn(LogCategory.Capture, 'Native DXGI capture addon not available — running in stub mode.', error);
    return null;
  }
}

/**
 * Wraps the native DXGI Desktop Duplication addon to provide
 * frame capture from a display.
 *
 * When the native addon is not available (not compiled or not on Windows),
 * the service operates in stub mode and produces blank frames so the
 * rest of the app can still be developed and tested.
 */
export class GameCaptureService {
  private captureIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private isCapturing = false;
  private onFrameCaptured: FrameCapturedCallback | null = null;
  private latestFrame: CapturedFrame | null = null;

  private readonly nativeCapture: NativeDxgiCapture | null;
  private readonly isNativeAvailable: boolean;

  constructor() {
    this.nativeCapture = tryLoadNativeAddon();
    this.isNativeAvailable = this.nativeCapture !== null;
  }

  public getIsNativeAvailable(): boolean {
    return this.isNativeAvailable;
  }

  public getLatestFrame(): CapturedFrame | null {
    return this.latestFrame;
  }

  /**
   * Returns the list of available displays.
   * In stub mode, returns a single fake "primary" display.
   */
  public listDisplays(): DisplayInfo[] {
    if (this.isNativeAvailable && this.nativeCapture) {
      try {
        return this.nativeCapture.listDisplays();
      } catch (error) {
        logger.error(LogCategory.Capture, 'Failed to list displays from native addon.', error);
        return [];
      }
    }

    // Stub mode: return a fake display
    return [
      {
        adapterIndex: 0,
        outputIndex: 0,
        name: 'Stub Display (native addon not loaded)',
        width: 1920,
        height: 1080,
      },
    ];
  }

  public setFrameCapturedCallback(callback: FrameCapturedCallback): void {
    this.onFrameCaptured = callback;
  }

  public start(config: GameCaptureConfig): void {
    if (this.isCapturing) {
      logger.warn(LogCategory.Capture, 'Capture is already running — ignoring start request.');
      return;
    }

    const displayIndex = this.resolveDisplayIndex(config.captureSource);

    logger.info(
      LogCategory.Capture,
      `Starting capture: source="${config.captureSource}" (displayIndex=${displayIndex}), targetFps=${config.targetFps}`
    );

    if (this.isNativeAvailable && this.nativeCapture) {
      // Threaded capture mode: the native addon runs a capture thread and calls
      // us back via napi_threadsafe_function when each frame is ready.
      // No setInterval, no polling — frames arrive at the display's refresh rate.
      const nativeFrameCallback = (nativeFrame: { buffer: Buffer; width: number; height: number }) => {
        const frame: CapturedFrame = {
          buffer: nativeFrame.buffer,
          width: nativeFrame.width,
          height: nativeFrame.height,
          capturedAt: performance.now(),
        };
        this.latestFrame = frame;
        if (this.onFrameCaptured) {
          this.onFrameCaptured(frame);
        }
      };

      try {
        const startedSuccessfully = this.nativeCapture.startCapture(displayIndex, nativeFrameCallback);
        if (!startedSuccessfully) {
          logger.error(LogCategory.Capture, 'Native startCapture returned false.');
          return;
        }
        logger.info(LogCategory.Capture, 'Native threaded capture started — frames delivered via callback.');
      } catch (error) {
        logger.error(LogCategory.Capture, 'Native startCapture threw an error.', error);
        return;
      }
    } else {
      // Stub mode: use setInterval to produce blank frames
      const intervalMilliseconds = Math.round(1000 / config.targetFps);
      this.captureIntervalHandle = setInterval(() => {
        this.grabStubFrame();
      }, intervalMilliseconds);
    }

    this.isCapturing = true;
  }

  public stop(): void {
    if (!this.isCapturing) {
      return;
    }

    logger.info(LogCategory.Capture, 'Stopping capture.');

    if (this.captureIntervalHandle !== null) {
      clearInterval(this.captureIntervalHandle);
      this.captureIntervalHandle = null;
    }

    if (this.isNativeAvailable && this.nativeCapture) {
      try {
        this.nativeCapture.stopCapture();
      } catch (error) {
        logger.error(LogCategory.Capture, 'Native stopCapture threw an error.', error);
      }
    }

    this.isCapturing = false;
  }

  public getIsCapturing(): boolean {
    return this.isCapturing;
  }

  /**
   * Resolves the captureSource config string to a numeric display index.
   * Accepts "primary" (→ 0), "0", "1", etc.
   */
  private resolveDisplayIndex(captureSource: string): number {
    const isPrimaryAlias = captureSource === 'primary';
    if (isPrimaryAlias) {
      return 0;
    }

    const parsedIndex = parseInt(captureSource, 10);
    const isValidNumber = !isNaN(parsedIndex) && parsedIndex >= 0;
    if (isValidNumber) {
      return parsedIndex;
    }

    logger.warn(LogCategory.Capture, `Unrecognized captureSource "${captureSource}" — defaulting to display 0.`);
    return 0;
  }

  private grabStubFrame(): void {
    const stubWidth = 1920;
    const stubHeight = 1080;
    const bytesPerPixel = 4;
    const stubBuffer = Buffer.alloc(stubWidth * stubHeight * bytesPerPixel, 0);

    const frame: CapturedFrame = {
      buffer: stubBuffer,
      width: stubWidth,
      height: stubHeight,
      capturedAt: performance.now(),
    };

    this.latestFrame = frame;

    if (this.onFrameCaptured) {
      this.onFrameCaptured(frame);
    }
  }
}
