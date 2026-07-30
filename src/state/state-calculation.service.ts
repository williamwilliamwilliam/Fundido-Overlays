import {
    RuntimeMonitoredRegion,
    RgbColor,
    StateCalculation,
    StateCalculationResult,
    MonitoredRegionState,
    MonitoredRegionInstanceState,
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
 * Channel histograms reused across calls, one bin per possible 8-bit value.
 *
 * Evaluation is synchronous and single-threaded, so a single set of scratch
 * histograms is safe to share: no call can start before the previous one has
 * finished reading them. Reusing them keeps this function allocation-free,
 * which matters when it runs across ~180 regions several times a second.
 */
const CHANNEL_VALUE_COUNT = 256;
const redHistogram = new Uint32Array(CHANNEL_VALUE_COUNT);
const greenHistogram = new Uint32Array(CHANNEL_VALUE_COUNT);
const blueHistogram = new Uint32Array(CHANNEL_VALUE_COUNT);

/**
 * Finds the value at `medianIndex` in the sorted order a histogram represents,
 * by walking the bins in ascending order until enough values are accounted for.
 *
 * Equivalent to sorting the samples and indexing into them, without either the
 * sort or the array.
 */
function findMedianValueInHistogram(histogram: Uint32Array, medianIndex: number): number {
    let valuesSeen = 0;
    for (let value = 0; value < CHANNEL_VALUE_COUNT; value++) {
        valuesSeen += histogram[value];
        if (valuesSeen > medianIndex) {
            return value;
        }
    }
    return CHANNEL_VALUE_COUNT - 1;
}

/**
 * Extracts the median RGB color from a rectangular region of a BGRA frame buffer.
 *
 * "Median" here uses a channel-wise median: the red, green, and blue channels
 * are independently sorted and the middle value of each is taken. This is
 * more robust to outliers than a simple average.
 *
 * Channel values are 8-bit, so instead of collecting every pixel into three
 * arrays and sorting them — O(n log n), with three allocations and a comparator
 * call per comparison — the samples are counted into 256-bin histograms and the
 * median is read off by walking the bins. That is O(n) with a fixed 768-word
 * working set, and produces exactly the same value as sorting would.
 */
function computeMedianColorForRegion(frame: CapturedFrame, bounds: Rectangle): RgbColor {
    const bytesPerPixel = 4; // BGRA
    const bytesPerRow = frame.width * bytesPerPixel;

    // Clamp to the frame on all four sides. The previous implementation clamped
    // only the far edges; a region whose origin sits above or left of the frame
    // produced negative offsets, which read back as undefined and corrupted the
    // result. Physical-pixel conversion can generate such bounds when a region
    // straddles the edge of the capture display.
    const regionStartX = Math.max(bounds.x, 0);
    const regionStartY = Math.max(bounds.y, 0);
    const regionEndX = Math.min(bounds.x + bounds.width, frame.width);
    const regionEndY = Math.min(bounds.y + bounds.height, frame.height);

    const regionWidth = regionEndX - regionStartX;
    const regionHeight = regionEndY - regionStartY;
    const sampledPixelCount = regionWidth > 0 && regionHeight > 0 ? regionWidth * regionHeight : 0;

    if (sampledPixelCount === 0) {
        logger.warn(LogCategory.StateCalculation, 'Region has zero pixels — returning black.');
        return { red: 0, green: 0, blue: 0 };
    }

    redHistogram.fill(0);
    greenHistogram.fill(0);
    blueHistogram.fill(0);

    const pixelBuffer = frame.buffer;
    for (let y = regionStartY; y < regionEndY; y++) {
        const rowStartOffset = y * bytesPerRow + regionStartX * bytesPerPixel;
        const rowEndOffset = rowStartOffset + regionWidth * bytesPerPixel;
        for (let pixelOffset = rowStartOffset; pixelOffset < rowEndOffset; pixelOffset += bytesPerPixel) {
            // BGRA layout
            blueHistogram[pixelBuffer[pixelOffset]]++;
            greenHistogram[pixelBuffer[pixelOffset + 1]]++;
            redHistogram[pixelBuffer[pixelOffset + 2]]++;
        }
    }

    // Matches the previous behaviour of indexing a sorted array at
    // floor(length / 2) — for an even count that is the upper of the two
    // middle values, not their average.
    const medianIndex = Math.floor(sampledPixelCount / 2);

    return {
        red: findMedianValueInHistogram(redHistogram, medianIndex),
        green: findMedianValueInHistogram(greenHistogram, medianIndex),
        blue: findMedianValueInHistogram(blueHistogram, medianIndex),
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
    monitoredRegions: RuntimeMonitoredRegion[],
    ocrResults?: Map<string, StateCalculationResult>,
    ollamaResults?: Map<string, StateCalculationResult>
): FrameState {
    const enabledRegions = monitoredRegions.filter((region) => region.enabled !== false);
    const regionInstanceStates: MonitoredRegionInstanceState[] = enabledRegions.map((region) => {
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

        // Apply explicit defaultStateValue for calculations using defaultValue mode.
        for (const result of calculationResults) {
            if (result.currentValue === '') {
                const matchingCalc = region.stateCalculations.find((c) => c.id === result.stateCalculationId);
                if ((matchingCalc?.defaultValueMode ?? 'defaultValue') === 'defaultValue' && matchingCalc?.defaultStateValue) {
                    result.currentValue = matchingCalc.defaultStateValue;
                }
            }
        }

        return {
            runtimeMonitoredRegionId: region.id,
            monitoredRegionId: region.sourceMonitoredRegionId,
            bounds: region.bounds,
            medianColor,
            calculationResults,
            instanceIndex: region.instanceIndex,
            repeatIndexX: region.repeatIndexX,
            repeatIndexY: region.repeatIndexY,
        };
    });

    const regionStatesBySourceId = new Map<string, MonitoredRegionState>();
    for (const instanceState of regionInstanceStates) {
      if (!regionStatesBySourceId.has(instanceState.monitoredRegionId)) {
        regionStatesBySourceId.set(instanceState.monitoredRegionId, {
          monitoredRegionId: instanceState.monitoredRegionId,
          medianColor: instanceState.medianColor,
          calculationResults: instanceState.calculationResults,
        });
      }
    }

    return {
        timestamp: frame.capturedAt,
        regionStates: Array.from(regionStatesBySourceId.values()),
        regionInstanceStates,
    };
}
