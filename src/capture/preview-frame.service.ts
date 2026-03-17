import { BrowserWindow, screen } from 'electron';
import { CapturedFrame } from './game-capture.service';
import { PreviewConfig } from '../shared';
import { logger, LogCategory } from '../shared/logger';

/**
 * Handles downsampling captured frames and encoding them as base64 JPEG
 * for efficient transfer to the renderer process.
 *
 * The preview runs on its own throttled interval, independent of the
 * capture FPS, so the UI gets smooth previews without overwhelming IPC.
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

  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /** Dynamically update the preview scale without restarting the service. */
  public setPreviewScale(scale: number): void {
    if (this.currentConfig) {
      this.currentConfig = { ...this.currentConfig, previewScale: scale };
    }
  }

  /** Pause or unpause the preview. When paused, no frames are encoded or sent. */
  private paused = false;
  public setPaused(paused: boolean): void {
    const changed = this.paused !== paused;
    this.paused = paused;
    if (changed && this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('preview:paused', paused);
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
   * This lets the UI convert between screen-absolute coordinates (from
   * the picker, which are in DPI-scaled logical pixels) and frame-relative
   * coordinates (which are in native physical pixels, since DXGI captures
   * at native resolution).
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
   * We just stash the reference — the preview interval picks it up
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
    const intervalMilliseconds = Math.round(1000 / fps);

    logger.info(
      LogCategory.Capture,
      `Preview started: ${fps}fps, scale=${config.previewScale}, method=${config.downsampleMethod}`
    );

    this.isRunning = true;
    this.previewIntervalHandle = setInterval(() => {
      if (this.currentConfig) {
        this.sendPreviewFrame(this.currentConfig);
      }
    }, intervalMilliseconds);
  }

  public stop(): void {
    if (this.previewIntervalHandle !== null) {
      clearInterval(this.previewIntervalHandle);
      this.previewIntervalHandle = null;
    }
    this.isRunning = false;
    this.latestFrame = null;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
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
    const downsampled = this.downsampleFrame(frame, config);

    // Encode to JPEG for the UI preview path — much smaller IPC payload
    // than raw BGRA, and the renderer just sets img.src (no per-pixel conversion).
    const base64Jpeg = this.encodeBgraToBase64Jpeg(
      downsampled.buffer,
      downsampled.width,
      downsampled.height,
      config.jpegQuality ?? 70,
    );

    const previewData = {
      imageDataUrl: `data:image/jpeg;base64,${base64Jpeg}`,
      originalWidth: frame.width,
      originalHeight: frame.height,
      previewWidth: downsampled.width,
      previewHeight: downsampled.height,
      displayOriginX: this.displayOriginX,
      displayOriginY: this.displayOriginY,
      displayScaleFactor: this.displayScaleFactor,
    };

    this.mainWindow!.webContents.send('capture:preview-frame', previewData);

    // Also pipe to overlay windows for region mirror rendering
    if (this.onPreviewFrameSentCallback) {
      this.onPreviewFrameSentCallback(previewData);
    }
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

        outputBuffer[destOffset]     = frame.buffer[sourceOffset];     // B
        outputBuffer[destOffset + 1] = frame.buffer[sourceOffset + 1]; // G
        outputBuffer[destOffset + 2] = frame.buffer[sourceOffset + 2]; // R
        outputBuffer[destOffset + 3] = frame.buffer[sourceOffset + 3]; // A
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

        const offsetTopLeft     = srcY0 * sourceRowPitch + srcX0 * bytesPerPixel;
        const offsetTopRight    = srcY0 * sourceRowPitch + srcX1 * bytesPerPixel;
        const offsetBottomLeft  = srcY1 * sourceRowPitch + srcX0 * bytesPerPixel;
        const offsetBottomRight = srcY1 * sourceRowPitch + srcX1 * bytesPerPixel;

        const destOffset = (destY * targetWidth + destX) * bytesPerPixel;

        for (let channel = 0; channel < 4; channel++) {
          const topLeft     = frame.buffer[offsetTopLeft + channel];
          const topRight    = frame.buffer[offsetTopRight + channel];
          const bottomLeft  = frame.buffer[offsetBottomLeft + channel];
          const bottomRight = frame.buffer[offsetBottomRight + channel];

          const topInterpolated    = topLeft + (topRight - topLeft) * xLerp;
          const bottomInterpolated = bottomLeft + (bottomRight - bottomLeft) * xLerp;
          const finalValue         = topInterpolated + (bottomInterpolated - topInterpolated) * yLerp;

          outputBuffer[destOffset + channel] = Math.round(finalValue);
        }
      }
    }

    return { buffer: outputBuffer, width: targetWidth, height: targetHeight };
  }

  /**
   * Skip downsampling — just takes every Nth pixel. Fastest, lowest quality.
   */
  private downsampleSkip(
    frame: CapturedFrame,
    targetWidth: number,
    targetHeight: number
  ): { buffer: Buffer; width: number; height: number } {
    // Same as nearest neighbor for this simple implementation
    return this.downsampleNearestNeighbor(frame, targetWidth, targetHeight);
  }

  /**
   * Encodes a BGRA buffer as a base64 JPEG string.
   *
   * Since we don't have a native JPEG encoder in Node, we construct
   * a BMP in memory and use Electron's nativeImage to convert to JPEG.
   */
  private encodeBgraToBase64Jpeg(
    bgraBuffer: Buffer,
    width: number,
    height: number,
    quality: number
  ): string {
    // Use Electron's nativeImage to handle the encoding.
    // nativeImage.createFromBuffer expects BGRA on Windows.
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromBuffer(bgraBuffer, {
      width,
      height,
    });

    const jpegBuffer = image.toJPEG(quality);
    return jpegBuffer.toString('base64');
  }
}
