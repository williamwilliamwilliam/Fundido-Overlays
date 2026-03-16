import { CapturedFrame } from '../capture/game-capture.service';
import { Rectangle } from './models/domain';

/**
 * Computes a tolerance-aware fingerprint of the pixel data in a region.
 *
 * Instead of hashing exact pixel values (which drift due to DXGI capture
 * artifacts, JPEG compression, and color subsampling), each sampled pixel's
 * R/G/B channels are quantized into buckets before hashing. A bucket size
 * of 8 means values 0-7 map to 0, 8-15 map to 1, etc. This absorbs the
 * small per-frame noise while still detecting meaningful changes.
 */
export function computeRegionPixelHash(frame: CapturedFrame, bounds: Rectangle): number {
  const bytesPerPixel = 4;
  const frameRowBytes = frame.width * bytesPerPixel;
  const regionWidth = Math.min(bounds.width, frame.width - bounds.x);
  const regionHeight = Math.min(bounds.height, frame.height - bounds.y);

  if (regionWidth <= 0 || regionHeight <= 0) return 0;

  const totalPixels = regionWidth * regionHeight;
  const sampleStep = totalPixels <= 500 ? 1 : Math.max(1, Math.floor(totalPixels / 500));

  const quantizeBucketSize = 8;

  let hash = 2166136261; // FNV offset basis (32-bit)
  let pixelIndex = 0;

  for (let row = 0; row < regionHeight; row++) {
    for (let col = 0; col < regionWidth; col++) {
      if (pixelIndex % sampleStep === 0) {
        const offset = (bounds.y + row) * frameRowBytes + (bounds.x + col) * bytesPerPixel;
        const quantizedBlue = (frame.buffer[offset] / quantizeBucketSize) | 0;
        const quantizedGreen = (frame.buffer[offset + 1] / quantizeBucketSize) | 0;
        const quantizedRed = (frame.buffer[offset + 2] / quantizeBucketSize) | 0;
        hash ^= quantizedBlue;
        hash = (hash * 16777619) | 0;
        hash ^= quantizedGreen;
        hash = (hash * 16777619) | 0;
        hash ^= quantizedRed;
        hash = (hash * 16777619) | 0;
      }
      pixelIndex++;
    }
  }

  return hash;
}
