/**
 * Worker thread for CPU-intensive state evaluation.
 * Receives frame buffer + region configs, runs pixel hashing and evaluateFrameState,
 * posts back the computed FrameState.
 *
 * This keeps the main thread's event loop free for capture callbacks and IPC.
 */

import { parentPort } from 'worker_threads';
import { computeRegionPixelHash } from '../shared/pixel-hash';
import { evaluateFrameState } from './state-calculation.service';

interface EvalRequest {
  type: 'evaluate';
  frameBuffer: Buffer;
  frameWidth: number;
  frameHeight: number;
  frameCapturedAt: number;
  physicalBoundsRegions: any[];
  monitoredRegions: any[];
  throttleConfig: {
    maxCalcFrequency: number;
    lastCalcTimestamps: Record<string, number>;
    regionPixelHashCache: Record<string, number>;
  };
  ocrResults: Array<[string, any]>;
  ollamaResults: Array<[string, any]>;
}

// Local caches maintained within the worker
const lastCalcTimestamps = new Map<string, number>();
const regionPixelHashCache = new Map<string, number>();

parentPort!.on('message', (request: EvalRequest) => {
  if (request.type !== 'evaluate') return;

  const frame = {
    buffer: Buffer.from(request.frameBuffer),
    width: request.frameWidth,
    height: request.frameHeight,
    capturedAt: request.frameCapturedAt,
  };

  const nowMs = Date.now();
  const minCalcIntervalMs = Math.round(1000 / (request.throttleConfig.maxCalcFrequency || 10));

  // Restore timestamps from main thread on first call, then maintain locally
  for (const [key, val] of Object.entries(request.throttleConfig.lastCalcTimestamps)) {
    if (!lastCalcTimestamps.has(key)) {
      lastCalcTimestamps.set(key, val);
    }
  }
  for (const [key, val] of Object.entries(request.throttleConfig.regionPixelHashCache)) {
    if (!regionPixelHashCache.has(key)) {
      regionPixelHashCache.set(key, val);
    }
  }

  // Compute pixel hashes
  const regionPixelHashes = new Map<string, number>();
  for (const region of request.physicalBoundsRegions) {
    const currentHash = computeRegionPixelHash(frame as any, region.bounds);
    regionPixelHashes.set(region.id, currentHash);
  }

  // Build throttled regions
  const throttledRegions = request.physicalBoundsRegions.map((region: any) => {
    const previousHash = regionPixelHashCache.get(region.id);
    const currentHash = regionPixelHashes.get(region.id)!;
    const regionIsUnchanged = previousHash !== undefined && previousHash === currentHash;

    const allowedCalcs = (region.stateCalculations || []).filter((calc: any) => {
      const calcKey = `${region.id}:${calc.id}`;
      const lastRun = lastCalcTimestamps.get(calcKey);
      const isRateLimited = lastRun !== undefined && (nowMs - lastRun) < minCalcIntervalMs;
      if (isRateLimited) return false;
      const shouldSkip = calc.skipIfUnchanged === true && regionIsUnchanged;
      if (shouldSkip) return false;
      return true;
    });
    return { ...region, stateCalculations: allowedCalcs };
  });

  // Update local caches
  for (const [regionId, hash] of regionPixelHashes) {
    regionPixelHashCache.set(regionId, hash);
  }
  for (const region of throttledRegions) {
    for (const calc of (region.stateCalculations || [])) {
      lastCalcTimestamps.set(`${region.id}:${calc.id}`, nowMs);
    }
  }

  // Reconstruct OCR/Ollama result maps
  const ocrResultsMap = new Map<string, any>(request.ocrResults || []);
  const ollamaResultsMap = new Map<string, any>(request.ollamaResults || []);

  // Run the CPU-intensive evaluation
  const evalStartMs = Date.now();
  const frameState = evaluateFrameState(frame as any, throttledRegions, ocrResultsMap, ollamaResultsMap);
  const evalDurationMs = Date.now() - evalStartMs;

  // Count calc types for metrics
  let medianColorCalcCount = 0;
  let colorThresholdCalcCount = 0;
  let ocrCalcCount = 0;
  let ollamaCalcCount = 0;
  const regionCalcCounts: Record<string, { medianColor: number; colorThreshold: number; ocr: number; ollama: number }> = {};

  for (const region of throttledRegions) {
    let rm = 0, rt = 0, ro = 0, rl = 0;
    for (const calc of (region.stateCalculations || [])) {
      if (calc.type === 'MedianPixelColor') { medianColorCalcCount++; rm++; }
      else if (calc.type === 'ColorThreshold') { colorThresholdCalcCount++; rt++; }
      else if (calc.type === 'OCR') { ocrCalcCount++; ro++; }
      else if (calc.type === 'OllamaLLM') { ollamaCalcCount++; rl++; }
    }
    regionCalcCounts[region.sourceMonitoredRegionId || region.id] = {
      medianColor: (regionCalcCounts[region.sourceMonitoredRegionId || region.id]?.medianColor || 0) + rm,
      colorThreshold: (regionCalcCounts[region.sourceMonitoredRegionId || region.id]?.colorThreshold || 0) + rt,
      ocr: (regionCalcCounts[region.sourceMonitoredRegionId || region.id]?.ocr || 0) + ro,
      ollama: (regionCalcCounts[region.sourceMonitoredRegionId || region.id]?.ollama || 0) + rl,
    };
  }

  parentPort!.postMessage({
    type: 'result',
    frameState,
    evalDurationMs,
    throttledRegionIds: throttledRegions.map((r: any) => r.id),
    throttledCalcIdsByRegion: Object.fromEntries(
      throttledRegions.map((r: any) => [r.id, (r.stateCalculations || []).map((c: any) => c.id)])
    ),
    metrics: {
      medianColorCalcCount,
      colorThresholdCalcCount,
      ocrCalcCount,
      ollamaCalcCount,
      regionCalcCounts,
    },
  });
});
