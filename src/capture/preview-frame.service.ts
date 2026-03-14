import { BrowserWindow } from 'electron';
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

  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Called by the capture pipeline each time a new frame arrives.
   * We just stash the reference — the preview interval picks it up
   * at the preview FPS rate.
   */
  public onFrameCaptured(frame: CapturedFrame): void {
    this.latestFrame = frame;
  }

  public start(config: PreviewConfig): void {
    if (this.isRunning) {
      this.stop();
    }

    const intervalMilliseconds = Math.round(1000 / config.previewFps);

    logger.info(
      LogCategory.Capture,
      `Preview started: ${config.previewFps}fps, scale=${config.previewScale}, method=${config.downsampleMethod}, jpeg=${config.jpegQuality}%`
    );

    this.isRunning = true;
    this.previewIntervalHandle = setInterval(() => {
      this.sendPreviewFrame(config);
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
    const base64Jpeg = this.encodeBgraToBase64Jpeg(downsampled.buffer, downsampled.width, downsampled.height, config.jpegQuality);

    this.mainWindow!.webContents.send('capture:preview-frame', {
      imageDataUrl: `data:image/jpeg;base64,${base64Jpeg}`,
      originalWidth: frame.width,
      originalHeight: frame.height,
      previewWidth: downsampled.width,
      previewHeight: downsampled.height,
    });
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
