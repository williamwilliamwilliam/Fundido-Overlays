import { BrowserWindow, nativeImage, screen } from 'electron';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { CapturedFrame } from './game-capture.service';
import { PreviewConfig, PreviewDownsampleMethod } from '../shared';
import { logger, LogCategory } from '../shared/logger';
import * as IpcChannels from '../shared/ipc-channels';

interface PreviewWorkerRequest {
  type: 'process-preview';
  jobId: number;
  frameBuffer: Buffer;
  frameWidth: number;
  frameHeight: number;
  previewScale: number;
  downsampleMethod: PreviewDownsampleMethod;
}

interface PreviewWorkerResult {
  type: 'process-preview-result';
  jobId: number;
  buffer: Buffer;
  width: number;
  height: number;
}

interface PendingPreviewJob {
  originalWidth: number;
  originalHeight: number;
  jpegQuality: number;
}

type PreviewUsageMode = 'capture' | 'regions' | 'inactive';

/**
 * Handles downsampling captured frames and encoding them as base64 JPEG
 * for efficient transfer to the renderer process.
 *
 * The preview runs on its own throttled interval, independent of the
 * capture FPS, so the UI gets smooth previews without overwhelming IPC.
 * When scaling is required, the expensive pixel resampling runs in a
 * worker thread so the Electron main thread only handles encoding + IPC.
 */
export class PreviewFrameService {
  private previewIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private latestFrame: CapturedFrame | null = null;
  private mainWindow: BrowserWindow | null = null;
  private isRunning = false;
  private displayOriginX = 0;
  private displayOriginY = 0;
  private displayScaleFactor = 1;
  private onPreviewFrameSentCallback: ((previewData: any) => void) | null = null;
  private currentConfig: PreviewConfig | null = null;
  private previewFps = 10;
  private usageMode: PreviewUsageMode = 'inactive';

  private paused = false;

  private previewWorker: Worker | null = null;
  private previewWorkerBusy = false;
  private previewWorkerDisabled = false;
  private nextPreviewJobId = 1;
  private pendingPreviewJobs = new Map<number, PendingPreviewJob>();

  constructor() {
    this.initializePreviewWorker();
  }

  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /** Dynamically update preview settings without restarting capture. */
  public updateRuntimeConfig(config: PreviewConfig, fps: number, usageMode: PreviewUsageMode): void {
    this.currentConfig = { ...config };
    this.usageMode = usageMode;

    const nextFps = Math.max(1, Math.round(fps));
    const fpsChanged = nextFps !== this.previewFps;
    this.previewFps = nextFps;

    if (this.isRunning && fpsChanged) {
      this.restartPreviewInterval();
    }
  }

  /** Kept for compatibility with existing callers. */
  public setPreviewScale(scale: number): void {
    if (this.currentConfig) {
      this.currentConfig = { ...this.currentConfig, previewScale: scale };
    }
  }

  /** Pause or unpause the preview. When paused, no frames are encoded or sent. */
  public setPaused(paused: boolean): void {
    const changed = this.paused !== paused;
    this.paused = paused;
    if (changed && this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IpcChannels.PREVIEW_PAUSED, paused);
    }
  }

  /**
   * Sets a callback that fires each time a preview frame is encoded and sent.
   * Used to pipe preview data to overlay windows for region mirror rendering.
   */
  public setOnPreviewFrameSent(callback: (previewData: any) => void): void {
    this.onPreviewFrameSentCallback = callback;
  }

  /**
   * Sets which display is being captured so we can include its screen
   * origin and DPI scale factor in the preview frame data.
   *
   * This lets the UI convert between screen-absolute coordinates and
   * frame-relative coordinates.
   */
  public setCaptureDisplayIndex(displayIndex: number): void {
    const allDisplays = screen.getAllDisplays();
    const isValidIndex = displayIndex >= 0 && displayIndex < allDisplays.length;
    if (isValidIndex) {
      const display = allDisplays[displayIndex];
      this.displayOriginX = display.bounds.x;
      this.displayOriginY = display.bounds.y;
      this.displayScaleFactor = display.scaleFactor || 1;
    } else {
      this.displayOriginX = 0;
      this.displayOriginY = 0;
      this.displayScaleFactor = 1;
    }
    logger.info(
      LogCategory.Capture,
      `Display origin: (${this.displayOriginX}, ${this.displayOriginY}), scaleFactor: ${this.displayScaleFactor}`
    );
  }

  /**
   * Called by the capture pipeline each time a new frame arrives.
   * We just stash the reference - the preview interval picks it up
   * at the preview FPS rate.
   */
  public onFrameCaptured(frame: CapturedFrame): void {
    this.latestFrame = frame;
  }

  public start(config: PreviewConfig, fps: number): void {
    if (this.isRunning) {
      this.stop();
    }

    this.currentConfig = { ...config };
    this.previewFps = Math.max(1, Math.round(fps));

    logger.info(
      LogCategory.Capture,
      `Preview started: ${this.previewFps}fps, scale=${config.previewScale}, method=${config.downsampleMethod}`
    );

    this.isRunning = true;
    this.initializePreviewWorker();
    this.restartPreviewInterval();
  }

  public stop(): void {
    if (this.previewIntervalHandle !== null) {
      clearInterval(this.previewIntervalHandle);
      this.previewIntervalHandle = null;
    }

    this.isRunning = false;
    this.latestFrame = null;
    this.previewWorkerBusy = false;
    this.pendingPreviewJobs.clear();

    if (this.previewWorker) {
      const workerToTerminate = this.previewWorker;
      this.previewWorker = null;
      workerToTerminate.removeAllListeners();
      workerToTerminate.terminate().catch(() => {
        // Ignore shutdown races while tearing down preview.
      });
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  private restartPreviewInterval(): void {
    if (this.previewIntervalHandle !== null) {
      clearInterval(this.previewIntervalHandle);
      this.previewIntervalHandle = null;
    }

    if (!this.isRunning) {
      return;
    }

    const intervalMilliseconds = Math.max(1, Math.round(1000 / this.previewFps));
    this.previewIntervalHandle = setInterval(() => {
      if (this.currentConfig) {
        this.sendPreviewFrame(this.currentConfig);
      }
    }, intervalMilliseconds);
  }

  private initializePreviewWorker(): void {
    if (this.previewWorker || this.previewWorkerDisabled) {
      return;
    }

    const workerPath = path.join(__dirname, 'preview-frame.worker.js');
    try {
      const worker = new Worker(workerPath);
      worker.on('message', (message: PreviewWorkerResult) => {
        this.handlePreviewWorkerMessage(message);
      });
      worker.on('error', (error) => {
        this.handlePreviewWorkerError(error);
      });
      worker.on('exit', (exitCode) => {
        if (this.previewWorker === worker) {
          this.previewWorker = null;
          this.previewWorkerBusy = false;
          this.pendingPreviewJobs.clear();
        }

        if (exitCode !== 0 && !this.previewWorkerDisabled) {
          logger.warn(LogCategory.Capture, `Preview worker exited unexpectedly with code ${exitCode}.`);
        }
      });

      this.previewWorker = worker;
      logger.info(LogCategory.Capture, `Preview worker started: ${workerPath}`);
    } catch (error) {
      this.previewWorkerDisabled = true;
      logger.warn(LogCategory.Capture, 'Preview worker unavailable - falling back to main-thread downsampling.', error);
    }
  }

  private handlePreviewWorkerMessage(message: PreviewWorkerResult): void {
    if (!message || message.type !== 'process-preview-result') {
      return;
    }

    this.previewWorkerBusy = false;

    const pendingJob = this.pendingPreviewJobs.get(message.jobId);
    this.pendingPreviewJobs.delete(message.jobId);
    if (!pendingJob) {
      return;
    }

    if (this.paused) {
      return;
    }

    const windowIsGone = !this.mainWindow || this.mainWindow.isDestroyed();
    if (windowIsGone) {
      return;
    }

    this.dispatchPreviewFrame(
      Buffer.from(message.buffer),
      message.width,
      message.height,
      pendingJob.originalWidth,
      pendingJob.originalHeight,
      pendingJob.jpegQuality,
    );
  }

  private handlePreviewWorkerError(error: unknown): void {
    this.previewWorkerBusy = false;
    this.pendingPreviewJobs.clear();

    if (this.previewWorker) {
      const workerToTerminate = this.previewWorker;
      this.previewWorker = null;
      workerToTerminate.removeAllListeners();
      workerToTerminate.terminate().catch(() => {
        // Ignore cleanup races while disabling the preview worker.
      });
    }

    this.previewWorkerDisabled = true;
    logger.error(LogCategory.Capture, 'Preview worker failed - falling back to main-thread downsampling.', error);
  }

  private sendPreviewFrame(config: PreviewConfig): void {
    if (this.paused) return;

    const hasNoFrame = this.latestFrame === null;
    if (hasNoFrame) {
      return;
    }

    const windowIsGone = !this.mainWindow || this.mainWindow.isDestroyed();
    if (windowIsGone) {
      return;
    }

    const frame = this.latestFrame!;

    if (this.usageMode === 'regions') {
      this.dispatchRegionsPreviewFrame(frame);
      return;
    }

    if (this.shouldUsePreviewWorker(config)) {
      this.sendPreviewFrameToWorker(frame, config);
      return;
    }

    const downsampled = this.downsampleFrame(frame, config);
    this.dispatchPreviewFrame(
      downsampled.buffer,
      downsampled.width,
      downsampled.height,
      frame.width,
      frame.height,
      config.jpegQuality ?? 70,
    );
  }

  private shouldUsePreviewWorker(config: PreviewConfig): boolean {
    return config.previewScale < 1 && !!this.previewWorker && !this.previewWorkerDisabled;
  }

  private sendPreviewFrameToWorker(frame: CapturedFrame, config: PreviewConfig): void {
    if (!this.previewWorker || this.previewWorkerBusy) {
      return;
    }

    const jobId = this.nextPreviewJobId++;
    this.previewWorkerBusy = true;
    this.pendingPreviewJobs.set(jobId, {
      originalWidth: frame.width,
      originalHeight: frame.height,
      jpegQuality: config.jpegQuality ?? 70,
    });

    const request: PreviewWorkerRequest = {
      type: 'process-preview',
      jobId,
      frameBuffer: Buffer.from(frame.buffer),
      frameWidth: frame.width,
      frameHeight: frame.height,
      previewScale: config.previewScale,
      downsampleMethod: config.downsampleMethod,
    };

    try {
      this.previewWorker.postMessage(request);
    } catch (error) {
      this.previewWorkerBusy = false;
      this.pendingPreviewJobs.delete(jobId);
      this.handlePreviewWorkerError(error);

      const downsampled = this.downsampleFrame(frame, config);
      this.dispatchPreviewFrame(
        downsampled.buffer,
        downsampled.width,
        downsampled.height,
        frame.width,
        frame.height,
        config.jpegQuality ?? 70,
      );
    }
  }

  private dispatchPreviewFrame(
    bgraBuffer: Buffer,
    previewWidth: number,
    previewHeight: number,
    originalWidth: number,
    originalHeight: number,
    jpegQuality: number,
  ): void {
    const base64Jpeg = this.encodeBgraToBase64Jpeg(
      bgraBuffer,
      previewWidth,
      previewHeight,
      jpegQuality,
    );

    const previewData = {
      imageDataUrl: `data:image/jpeg;base64,${base64Jpeg}`,
      originalWidth,
      originalHeight,
      previewWidth,
      previewHeight,
      displayOriginX: this.displayOriginX,
      displayOriginY: this.displayOriginY,
      displayScaleFactor: this.displayScaleFactor,
    };

    this.mainWindow!.webContents.send(IpcChannels.CAPTURE_PREVIEW_FRAME, previewData);

    if (this.onPreviewFrameSentCallback) {
      this.onPreviewFrameSentCallback(previewData);
    }
  }

  private dispatchRegionsPreviewFrame(frame: CapturedFrame): void {
    const previewData = {
      bgraBuffer: Uint8Array.from(frame.buffer),
      originalWidth: frame.width,
      originalHeight: frame.height,
      previewWidth: frame.width,
      previewHeight: frame.height,
      displayOriginX: this.displayOriginX,
      displayOriginY: this.displayOriginY,
      displayScaleFactor: this.displayScaleFactor,
    };

    this.mainWindow!.webContents.send(IpcChannels.REGIONS_PREVIEW_FRAME, previewData);
  }

  private downsampleFrame(
    frame: CapturedFrame,
    config: PreviewConfig
  ): { buffer: Buffer; width: number; height: number } {
    const scaledWidth = Math.max(1, Math.round(frame.width * config.previewScale));
    const scaledHeight = Math.max(1, Math.round(frame.height * config.previewScale));

    const noScalingNeeded = config.previewScale >= 1.0;
    if (noScalingNeeded) {
      return { buffer: frame.buffer, width: frame.width, height: frame.height };
    }

    switch (config.downsampleMethod) {
      case 'nearestNeighbor':
        return this.downsampleNearestNeighbor(frame, scaledWidth, scaledHeight);
      case 'bilinear':
        return this.downsampleBilinear(frame, scaledWidth, scaledHeight);
      case 'skip':
        return this.downsampleSkip(frame, scaledWidth, scaledHeight);
      default:
        return this.downsampleNearestNeighbor(frame, scaledWidth, scaledHeight);
    }
  }

  /**
   * Nearest-neighbor downsampling. Fast, can look blocky.
   */
  private downsampleNearestNeighbor(
    frame: CapturedFrame,
    targetWidth: number,
    targetHeight: number
  ): { buffer: Buffer; width: number; height: number } {
    const bytesPerPixel = 4;
    const outputBuffer = Buffer.alloc(targetWidth * targetHeight * bytesPerPixel);
    const sourceRowPitch = frame.width * bytesPerPixel;

    const xRatio = frame.width / targetWidth;
    const yRatio = frame.height / targetHeight;

    for (let destY = 0; destY < targetHeight; destY++) {
      const sourceY = Math.floor(destY * yRatio);
      for (let destX = 0; destX < targetWidth; destX++) {
        const sourceX = Math.floor(destX * xRatio);
        const sourceOffset = sourceY * sourceRowPitch + sourceX * bytesPerPixel;
        const destOffset = (destY * targetWidth + destX) * bytesPerPixel;

        outputBuffer[destOffset] = frame.buffer[sourceOffset];
        outputBuffer[destOffset + 1] = frame.buffer[sourceOffset + 1];
        outputBuffer[destOffset + 2] = frame.buffer[sourceOffset + 2];
        outputBuffer[destOffset + 3] = frame.buffer[sourceOffset + 3];
      }
    }

    return { buffer: outputBuffer, width: targetWidth, height: targetHeight };
  }

  /**
   * Bilinear interpolation downsampling. Smoother, slightly slower.
   */
  private downsampleBilinear(
    frame: CapturedFrame,
    targetWidth: number,
    targetHeight: number
  ): { buffer: Buffer; width: number; height: number } {
    const bytesPerPixel = 4;
    const outputBuffer = Buffer.alloc(targetWidth * targetHeight * bytesPerPixel);
    const sourceRowPitch = frame.width * bytesPerPixel;

    const xRatio = (frame.width - 1) / targetWidth;
    const yRatio = (frame.height - 1) / targetHeight;

    for (let destY = 0; destY < targetHeight; destY++) {
      const srcYExact = destY * yRatio;
      const srcY0 = Math.floor(srcYExact);
      const srcY1 = Math.min(srcY0 + 1, frame.height - 1);
      const yLerp = srcYExact - srcY0;

      for (let destX = 0; destX < targetWidth; destX++) {
        const srcXExact = destX * xRatio;
        const srcX0 = Math.floor(srcXExact);
        const srcX1 = Math.min(srcX0 + 1, frame.width - 1);
        const xLerp = srcXExact - srcX0;

        const offsetTopLeft = srcY0 * sourceRowPitch + srcX0 * bytesPerPixel;
        const offsetTopRight = srcY0 * sourceRowPitch + srcX1 * bytesPerPixel;
        const offsetBottomLeft = srcY1 * sourceRowPitch + srcX0 * bytesPerPixel;
        const offsetBottomRight = srcY1 * sourceRowPitch + srcX1 * bytesPerPixel;

        const destOffset = (destY * targetWidth + destX) * bytesPerPixel;

        for (let channel = 0; channel < 4; channel++) {
          const topLeft = frame.buffer[offsetTopLeft + channel];
          const topRight = frame.buffer[offsetTopRight + channel];
          const bottomLeft = frame.buffer[offsetBottomLeft + channel];
          const bottomRight = frame.buffer[offsetBottomRight + channel];

          const topInterpolated = topLeft + (topRight - topLeft) * xLerp;
          const bottomInterpolated = bottomLeft + (bottomRight - bottomLeft) * xLerp;
          const finalValue = topInterpolated + (bottomInterpolated - topInterpolated) * yLerp;

          outputBuffer[destOffset + channel] = Math.round(finalValue);
        }
      }
    }

    return { buffer: outputBuffer, width: targetWidth, height: targetHeight };
  }

  /**
   * Skip downsampling - just takes every Nth pixel. Fastest, lowest quality.
   */
  private downsampleSkip(
    frame: CapturedFrame,
    targetWidth: number,
    targetHeight: number
  ): { buffer: Buffer; width: number; height: number } {
    return this.downsampleNearestNeighbor(frame, targetWidth, targetHeight);
  }

  /**
   * Encodes a BGRA buffer as a base64 JPEG string.
   */
  private encodeBgraToBase64Jpeg(
    bgraBuffer: Buffer,
    width: number,
    height: number,
    quality: number
  ): string {
    const image = nativeImage.createFromBuffer(bgraBuffer, {
      width,
      height,
    });

    const jpegBuffer = image.toJPEG(quality);
    return jpegBuffer.toString('base64');
  }
}
