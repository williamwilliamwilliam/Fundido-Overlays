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

/**
 * Tracks consecutive pass counts for ColorThreshold mappings.
 * Keyed by `calcId:mappingIndex` → number of consecutive frames that met the threshold.
 */
const consecutivePassCounts = new Map<string, number>();

/**
 * Evaluates a ColorThreshold calculation. Iterates top-down through
 * colorThresholdMappings; the first row whose match percentage meets
 * its threshold for the required number of consecutive evaluations wins.
 */
function evaluateColorThresholdCalculation(
  medianColor: RgbColor,
  calculation: StateCalculation
): StateCalculationResult {
  const confidenceByMapping: Record<string, number> = {};
  let matchedValue = '';

  const mappings = calculation.colorThresholdMappings || [];
  for (let i = 0; i < mappings.length; i++) {
    const mapping = mappings[i];
    const distance = computeColorDistance(medianColor, mapping.color);
    const confidence = computeConfidenceFromDistance(distance);
    confidenceByMapping[mapping.stateValue] = confidence;

    const counterKey = `${calculation.id}:${i}`;
    const meetsThreshold = confidence >= mapping.matchThreshold;

    if (meetsThreshold) {
      const previousCount = consecutivePassCounts.get(counterKey) || 0;
      const newCount = previousCount + 1;
      consecutivePassCounts.set(counterKey, newCount);

      const requiredConsecutive = mapping.consecutiveRequired || 1;
      const meetsConsecutiveRequirement = newCount >= requiredConsecutive;
      if (meetsConsecutiveRequirement && matchedValue === '') {
        matchedValue = mapping.stateValue;
        // Don't break — continue computing confidence for all rows for display
      }
    } else {
      // Reset consecutive counter on miss
      consecutivePassCounts.set(counterKey, 0);
    }
  }

  return {
    stateCalculationId: calculation.id,
    medianColor,
    currentValue: matchedValue,
    confidenceByMapping,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluates all monitored regions against a captured frame and produces
 * a complete FrameState.
 *
 * OCR and Ollama calculations run on their own throttled intervals.
 * Their results are merged in via the optional parameters.
 */
export function evaluateFrameState(
  frame: CapturedFrame,
  monitoredRegions: MonitoredRegion[],
  ocrResults?: Map<string, StateCalculationResult>,
  ollamaResults?: Map<string, StateCalculationResult>
): FrameState {
  const regionStates: MonitoredRegionState[] = monitoredRegions.map((region) => {
    const medianColor = computeMedianColorForRegion(frame, region.bounds);

    const calculationResults: StateCalculationResult[] = [];
    for (const calculation of region.stateCalculations) {
      if (calculation.type === 'OCR') {
        const ocrKey = `${region.id}:${calculation.id}`;
        const ocrResult = ocrResults?.get(ocrKey);
        if (ocrResult) {
          calculationResults.push(ocrResult);
        } else {
          calculationResults.push({
            stateCalculationId: calculation.id,
            medianColor: { red: 0, green: 0, blue: 0 },
            currentValue: '',
            confidenceByMapping: {},
            ocrText: '',
          });
        }
      } else if (calculation.type === 'OllamaLLM') {
        const ollamaKey = `${region.id}:${calculation.id}`;
        const ollamaResult = ollamaResults?.get(ollamaKey);
        if (ollamaResult) {
          calculationResults.push(ollamaResult);
        } else {
          calculationResults.push({
            stateCalculationId: calculation.id,
            medianColor: { red: 0, green: 0, blue: 0 },
            currentValue: '',
            confidenceByMapping: {},
            ollamaResponse: '',
            ollamaResponseTimeMs: 0,
          });
        }
      } else if (calculation.type === 'ColorThreshold') {
        calculationResults.push(evaluateColorThresholdCalculation(medianColor, calculation));
      } else {
        calculationResults.push(evaluateSingleCalculation(medianColor, calculation));
      }
    }

    return {
      monitoredRegionId: region.id,
      medianColor,
      calculationResults,
    };
  });

  return {
    timestamp: frame.capturedAt,
    regionStates,
  };
}
