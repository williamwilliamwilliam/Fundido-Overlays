import { evaluateFrameState } from './state-calculation.service';
import {
  MonitoredRegion,
  MonitoredRegionId,
  StateCalculationId,
} from '../shared';
import { CapturedFrame } from '../capture/game-capture.service';

/**
 * Builds a small BGRA frame buffer filled with a single solid color.
 * Useful for testing state calculations against known pixel data.
 */
function buildSolidColorFrame(
  width: number,
  height: number,
  red: number,
  green: number,
  blue: number
): CapturedFrame {
  const bytesPerPixel = 4;
  const buffer = Buffer.alloc(width * height * bytesPerPixel);

  for (let i = 0; i < width * height; i++) {
    const offset = i * bytesPerPixel;
    buffer[offset] = blue;      // B
    buffer[offset + 1] = green;  // G
    buffer[offset + 2] = red;    // R
    buffer[offset + 3] = 255;    // A
  }

  return { buffer, width, height, capturedAt: 0 };
}

describe('evaluateFrameState', () => {
  const testRegion: MonitoredRegion = {
    id: 'region-1' as MonitoredRegionId,
    name: 'Test Region',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    stateCalculations: [
      {
        id: 'calc-1' as StateCalculationId,
        name: 'isBlack?',
        type: 'MedianPixelColor',
        colorStateMappings: [
          { color: { red: 0, green: 0, blue: 0 }, stateValue: 'Yes' },
          { color: { red: 255, green: 255, blue: 255 }, stateValue: 'No' },
        ],
      },
    ],
  };

  it('should detect a solid black region as "Yes"', () => {
    const blackFrame = buildSolidColorFrame(10, 10, 0, 0, 0);
    const result = evaluateFrameState(blackFrame, [testRegion]);

    expect(result.regionStates).toHaveLength(1);
    const calculationResult = result.regionStates[0].calculationResults[0];
    expect(calculationResult.currentValue).toBe('Yes');
    expect(calculationResult.confidenceByMapping['Yes']).toBe(100);
  });

  it('should detect a solid white region as "No"', () => {
    const whiteFrame = buildSolidColorFrame(10, 10, 255, 255, 255);
    const result = evaluateFrameState(whiteFrame, [testRegion]);

    const calculationResult = result.regionStates[0].calculationResults[0];
    expect(calculationResult.currentValue).toBe('No');
    expect(calculationResult.confidenceByMapping['No']).toBe(100);
  });

  it('should pick the closest matching color for a gray frame', () => {
    // Dark gray (64,64,64) is closer to black than to white
    const darkGrayFrame = buildSolidColorFrame(10, 10, 64, 64, 64);
    const result = evaluateFrameState(darkGrayFrame, [testRegion]);

    const calculationResult = result.regionStates[0].calculationResults[0];
    expect(calculationResult.currentValue).toBe('Yes');

    const yesConfidence = calculationResult.confidenceByMapping['Yes'];
    const noConfidence = calculationResult.confidenceByMapping['No'];
    expect(yesConfidence).toBeGreaterThan(noConfidence);
  });

  it('should return an empty regionStates array when no regions are defined', () => {
    const frame = buildSolidColorFrame(10, 10, 128, 128, 128);
    const result = evaluateFrameState(frame, []);

    expect(result.regionStates).toHaveLength(0);
  });
});
