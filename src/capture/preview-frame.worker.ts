import { parentPort } from 'worker_threads';
import { PreviewDownsampleMethod } from '../shared';

interface PreviewWorkerRequest {
  type: 'process-preview';
  jobId: number;
  frameBuffer: Buffer;
  frameWidth: number;
  frameHeight: number;
  previewScale: number;
  downsampleMethod: PreviewDownsampleMethod;
}

interface CapturedPreviewFrame {
  buffer: Buffer;
  width: number;
  height: number;
}

function downsampleFrame(
  frame: CapturedPreviewFrame,
  previewScale: number,
  downsampleMethod: PreviewDownsampleMethod
): { buffer: Buffer; width: number; height: number } {
  const scaledWidth = Math.max(1, Math.round(frame.width * previewScale));
  const scaledHeight = Math.max(1, Math.round(frame.height * previewScale));

  if (previewScale >= 1) {
    return { buffer: frame.buffer, width: frame.width, height: frame.height };
  }

  switch (downsampleMethod) {
    case 'nearestNeighbor':
      return downsampleNearestNeighbor(frame, scaledWidth, scaledHeight);
    case 'bilinear':
      return downsampleBilinear(frame, scaledWidth, scaledHeight);
    case 'skip':
      return downsampleNearestNeighbor(frame, scaledWidth, scaledHeight);
    default:
      return downsampleNearestNeighbor(frame, scaledWidth, scaledHeight);
  }
}

function downsampleNearestNeighbor(
  frame: CapturedPreviewFrame,
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

function downsampleBilinear(
  frame: CapturedPreviewFrame,
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

parentPort?.on('message', (request: PreviewWorkerRequest) => {
  if (request.type !== 'process-preview') {
    return;
  }

  const frame: CapturedPreviewFrame = {
    buffer: Buffer.from(request.frameBuffer),
    width: request.frameWidth,
    height: request.frameHeight,
  };

  const downsampled = downsampleFrame(frame, request.previewScale, request.downsampleMethod);

  parentPort?.postMessage({
    type: 'process-preview-result',
    jobId: request.jobId,
    buffer: downsampled.buffer,
    width: downsampled.width,
    height: downsampled.height,
  });
});
