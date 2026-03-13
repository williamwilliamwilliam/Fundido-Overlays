import {
  MonitoredRegion,
  RgbColor,
  StateCalculation,
  StateCalculationResult,
  MonitoredRegionState,
  FrameState,
  Rectangle,
} from '../shared';
import { CapturedFrame } from '../capture/game-capture.service';
import { logger, LogCategory } from '../shared/logger';

// ---------------------------------------------------------------------------
// Color math helpers
// ---------------------------------------------------------------------------

/**
 * Computes the Euclidean distance between two RGB colors.
 * Range is 0 (identical) to ~441.67 (black vs white).
 */
function computeColorDistance(colorA: RgbColor, colorB: RgbColor): number {
  const deltaRed = colorA.red - colorB.red;
  const deltaGreen = colorA.green - colorB.green;
  const deltaBlue = colorA.blue - colorB.blue;
  return Math.sqrt(deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue);
}

/** Maximum possible distance in RGB space (black to white). */
const MAX_COLOR_DISTANCE = Math.sqrt(255 * 255 + 255 * 255 + 255 * 255);

/**
 * Converts a color distance to a confidence percentage.
 * 0 distance = 100% confidence; max distance = 0% confidence.
 */
function computeConfidenceFromDistance(distance: number): number {
  const confidenceRatio = 1 - distance / MAX_COLOR_DISTANCE;
  const confidencePercentage = Math.round(confidenceRatio * 10000) / 100;
  return confidencePercentage;
}

// ---------------------------------------------------------------------------
// Pixel extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the median RGB color from a rectangular region of a BGRA frame buffer.
 *
 * "Median" here uses a channel-wise median: the red, green, and blue channels
 * are independently sorted and the middle value of each is taken. This is
 * more robust to outliers than a simple average.
 */
function computeMedianColorForRegion(frame: CapturedFrame, bounds: Rectangle): RgbColor {
  const redValues: number[] = [];
  const greenValues: number[] = [];
  const blueValues: number[] = [];

  const bytesPerPixel = 4; // BGRA
  const bytesPerRow = frame.width * bytesPerPixel;

  const regionEndX = Math.min(bounds.x + bounds.width, frame.width);
  const regionEndY = Math.min(bounds.y + bounds.height, frame.height);

  for (let y = bounds.y; y < regionEndY; y++) {
    for (let x = bounds.x; x < regionEndX; x++) {
      const pixelOffset = y * bytesPerRow + x * bytesPerPixel;
      // BGRA layout
      blueValues.push(frame.buffer[pixelOffset]);
      greenValues.push(frame.buffer[pixelOffset + 1]);
      redValues.push(frame.buffer[pixelOffset + 2]);
    }
  }

  if (redValues.length === 0) {
    logger.warn(LogCategory.StateCalculation, 'Region has zero pixels — returning black.');
    return { red: 0, green: 0, blue: 0 };
  }

  redValues.sort((a, b) => a - b);
  greenValues.sort((a, b) => a - b);
  blueValues.sort((a, b) => a - b);

  const medianIndex = Math.floor(redValues.length / 2);

  return {
    red: redValues[medianIndex],
    green: greenValues[medianIndex],
    blue: blueValues[medianIndex],
  };
}

// ---------------------------------------------------------------------------
// State calculation
// ---------------------------------------------------------------------------

function evaluateSingleCalculation(
  medianColor: RgbColor,
  calculation: StateCalculation
): StateCalculationResult {
  const confidenceByMapping: Record<string, number> = {};
  let closestStateValue = '';
  let shortestDistance = Infinity;

  for (const mapping of calculation.colorStateMappings) {
    const distance = computeColorDistance(medianColor, mapping.color);
    const confidence = computeConfidenceFromDistance(distance);
    confidenceByMapping[mapping.stateValue] = confidence;

    const isBetterMatch = distance < shortestDistance;
    if (isBetterMatch) {
      shortestDistance = distance;
      closestStateValue = mapping.stateValue;
    }
  }

  return {
    stateCalculationId: calculation.id,
    medianColor,
    currentValue: closestStateValue,
    confidenceByMapping,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluates all monitored regions against a captured frame and produces
 * a complete FrameState.
 */
export function evaluateFrameState(
  frame: CapturedFrame,
  monitoredRegions: MonitoredRegion[]
): FrameState {
  const regionStates: MonitoredRegionState[] = monitoredRegions.map((region) => {
    const medianColor = computeMedianColorForRegion(frame, region.bounds);

    const calculationResults = region.stateCalculations.map((calculation) =>
      evaluateSingleCalculation(medianColor, calculation)
    );

    return {
      monitoredRegionId: region.id,
      calculationResults,
    };
  });

  return {
    timestamp: frame.capturedAt,
    regionStates,
  };
}
