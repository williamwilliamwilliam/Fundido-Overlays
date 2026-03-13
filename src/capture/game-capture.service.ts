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
 * Wraps the native DXGI Desktop Duplication addon to provide
 * frame capture from a display or window.
 *
 * The native addon is expected to expose:
 *   - startCapture(sourceId: string): void
 *   - stopCapture(): void
 *   - getLatestFrame(): { buffer: Buffer, width: number, height: number } | null
 *
 * Until the native addon is built, this service operates in a stub mode
 * that produces blank frames for UI development.
 */
export class GameCaptureService {
  private captureIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private isCapturing = false;
  private onFrameCaptured: FrameCapturedCallback | null = null;

  // TODO: Replace with actual native addon require once built.
  // private nativeCapture = require('../../native/build/Release/dxgi_capture.node');
  private readonly isNativeAvailable = false;

  public setFrameCapturedCallback(callback: FrameCapturedCallback): void {
    this.onFrameCaptured = callback;
  }

  public start(config: GameCaptureConfig): void {
    if (this.isCapturing) {
      logger.warn(LogCategory.Capture, 'Capture is already running — ignoring start request.');
      return;
    }

    logger.info(LogCategory.Capture, `Starting capture: source="${config.captureSource}", targetFps=${config.targetFps}`);

    const intervalMilliseconds = Math.round(1000 / config.targetFps);
    this.isCapturing = true;

    if (this.isNativeAvailable) {
      // nativeCapture.startCapture(config.captureSource);
    }

    this.captureIntervalHandle = setInterval(() => {
      this.grabFrame();
    }, intervalMilliseconds);
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

    if (this.isNativeAvailable) {
      // nativeCapture.stopCapture();
    }

    this.isCapturing = false;
  }

  public getIsCapturing(): boolean {
    return this.isCapturing;
  }

  private grabFrame(): void {
    let frame: CapturedFrame;

    if (this.isNativeAvailable) {
      // const nativeFrame = nativeCapture.getLatestFrame();
      // if (!nativeFrame) return;
      // frame = { ...nativeFrame, capturedAt: performance.now() };
      return; // unreachable while native is stubbed, but keeps the compiler happy
    } else {
      // Stub: produce a small blank frame for UI development
      const stubWidth = 1920;
      const stubHeight = 1080;
      const bytesPerPixel = 4; // BGRA
      const stubBuffer = Buffer.alloc(stubWidth * stubHeight * bytesPerPixel, 0);

      frame = {
        buffer: stubBuffer,
        width: stubWidth,
        height: stubHeight,
        capturedAt: performance.now(),
      };
    }

    if (this.onFrameCaptured) {
      this.onFrameCaptured(frame);
    }
  }
}
