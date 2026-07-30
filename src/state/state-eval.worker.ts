/**
 * Worker thread for CPU-intensive state evaluation.
 * Receives frame buffer + region configs, runs pixel hashing and evaluateFrameState,
 * posts back the computed FrameState.
 *
 * This keeps the main thread's event loop free for capture callbacks and IPC.
 */

import { parentPort } from 'worker_threads';
import { performance } from 'perf_hooks';
import { computeRegionPixelHash } from '../shared/pixel-hash';
import { nowMonotonicMs } from '../shared/monotonic-clock';
import { evaluateFrameState } from './state-calculation.service';

interface EvalRequest {
  type: 'evaluate';
  /**
   * The raw frame pixel data, transferred (not cloned) from the main thread.
   * Arrives as an ArrayBuffer — Buffer.from(ArrayBuffer) wraps it in-place,
   * so the worker reads the data without any additional copy.
   */
  frameBuffer: ArrayBuffer;
  frameWidth: number;
  frameHeight: number;
  frameCapturedAt: number;
  /** Shared-monotonic-clock reading taken just before the request was posted. */
  sentAtMonotonicMs?: number;
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

/**
 * Post-change evaluation window.
 *
 * When a region's pixel hash changes, the first evaluation runs on whatever
 * frame triggered the hash change — which may be a mid-transition or
 * partially-rendered frame. If that evaluation produces a wrong result, and
 * the next frame's hash happens to match the transition-frame hash, the
 * `skipIfUnchanged` gate will suppress all further evaluations, locking in
 * the incorrect state.
 *
 * Fix: after detecting a hash change, continue forcing evaluation for
 * EXTRA_EVAL_PASSES_AFTER_CHANGE additional passes even if the hash appears
 * unchanged. This ensures the settled final state is always evaluated at
 * least once after a transition, regardless of what the first changed frame
 * looked like.
 */
const regionPostChangeEvalCountdown = new Map<string, number>();
const EXTRA_EVAL_PASSES_AFTER_CHANGE = 2;

parentPort!.on('message', (request: EvalRequest) => {
  if (request.type !== 'evaluate') return;

  // Timed with performance.now() rather than Date.now(): these sections run in
  // well under a millisecond, and Date.now()'s ~15ms granularity on Windows
  // quantizes them to 0 or 1.
  const workerStartMs = performance.now();

  // Cross-thread readings must come from the shared monotonic clock, not
  // performance.now() — see monotonic-clock.ts.
  const inboundLatencyMs = typeof request.sentAtMonotonicMs === 'number'
    ? nowMonotonicMs() - request.sentAtMonotonicMs
    : null;

  // request.frameBuffer arrives as an ArrayBuffer (transferred from the main thread —
  // not structured-cloned). Buffer.from(ArrayBuffer) wraps the memory in-place
  // without copying it, so this is a zero-copy construction.
  const frame = {
    buffer: Buffer.from(request.frameBuffer),
    width: request.frameWidth,
    height: request.frameHeight,
    capturedAt: request.frameCapturedAt,
  };

  const nowMs = Date.now();
  const globalMinCalcIntervalMs = Math.round(1000 / (request.throttleConfig.maxCalcFrequency || 10));

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

  // Compute pixel hashes. Timed separately from evaluation: this loop touches
  // every region's pixels on every pass regardless of throttling, so it is a
  // cost that evaluation-side throttling cannot reduce.
  const hashStartMs = performance.now();
  const regionPixelHashes = new Map<string, number>();
  for (const region of request.physicalBoundsRegions) {
    const currentHash = computeRegionPixelHash(frame as any, region.bounds);
    regionPixelHashes.set(region.id, currentHash);
  }
  const hashDurationMs = performance.now() - hashStartMs;

  // Phase 1: determine per-region force-eval flags and advance the post-change
  // countdown. Must run before throttled region building so the filter can read
  // up-to-date flags.
  const regionIsInPostChangeWindow = new Map<string, boolean>();
  for (const region of request.physicalBoundsRegions) {
    const previousHash = regionPixelHashCache.get(region.id);
    const currentHash = regionPixelHashes.get(region.id)!;
    const hashChanged = previousHash === undefined || previousHash !== currentHash;

    if (hashChanged) {
      // Pixel changed this pass — reset the countdown. The current pass will
      // evaluate normally because regionIsUnchanged will be false. The countdown
      // covers the N passes immediately AFTER the change settles.
      //
      // The window size is at least EXTRA_EVAL_PASSES_AFTER_CHANGE, but raised to:
      //   - the region's maximum ColorThreshold consecutiveRequired so the
      //     consecutive counter has enough passes to reach its target, and
      //   - ceil(maxOcrMinDurationMs / evalIntervalMs) so the OCR duration
      //     clock has enough time to accumulate before skipIfUnchanged fires.
      const regionEvalIntervalMs = getRegionEvaluationIntervalMs(region, globalMinCalcIntervalMs);
      const requiredPostChangePasses = computePostChangeEvalPasses(region, EXTRA_EVAL_PASSES_AFTER_CHANGE, regionEvalIntervalMs);
      regionPostChangeEvalCountdown.set(region.id, requiredPostChangePasses);
      regionIsInPostChangeWindow.set(region.id, false);
    } else {
      // Pixel is unchanged — check whether we are still in the post-change window.
      const remainingPasses = regionPostChangeEvalCountdown.get(region.id) ?? 0;
      if (remainingPasses > 0) {
        regionPostChangeEvalCountdown.set(region.id, remainingPasses - 1);
        regionIsInPostChangeWindow.set(region.id, true);
      } else {
        regionIsInPostChangeWindow.set(region.id, false);
      }
    }
  }

  // Phase 2: build throttled regions — skip calcs only when the region is
  // unchanged AND the post-change window has fully expired.
  const throttledRegions = request.physicalBoundsRegions.map((region: any) => {
    const previousHash = regionPixelHashCache.get(region.id);
    const currentHash = regionPixelHashes.get(region.id)!;
    const regionIsUnchanged = previousHash !== undefined && previousHash === currentHash;
    const isInPostChangeWindow = regionIsInPostChangeWindow.get(region.id) ?? false;

    const allowedCalcs = (region.stateCalculations || []).filter((calc: any) => {
      const calcKey = `${region.id}:${calc.id}`;
      const lastRun = lastCalcTimestamps.get(calcKey);
      const minCalcIntervalMs = getRegionEvaluationIntervalMs(region, globalMinCalcIntervalMs);
      const isRateLimited = lastRun !== undefined && (nowMs - lastRun) < minCalcIntervalMs;
      if (isRateLimited) return false;
      // Suppress only when: the calc opts in to skip-if-unchanged, the pixel
      // hash is genuinely stable, the post-change window has expired, and the
      // region is not being force-evaluated because the user is editing it.
      const isSettledAndWindowExpired = regionIsUnchanged && !isInPostChangeWindow;
      const shouldSkip = calc.skipIfUnchanged !== false && isSettledAndWindowExpired && region.alwaysEvaluate !== true;
      if (shouldSkip) return false;
      return true;
    });
    return { ...region, stateCalculations: allowedCalcs };
  });

  // Update local hash cache
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

  // Only enabled regions produce instance states. Filtering here rather than
  // letting evaluateFrameState do it internally lets us record where each
  // produced state came from in the request's region array — which is how the
  // main thread reattaches the static per-region fields it already holds.
  const enabledRegionIndices: number[] = [];
  const enabledThrottledRegions: any[] = [];
  for (let regionIndex = 0; regionIndex < throttledRegions.length; regionIndex++) {
    if (throttledRegions[regionIndex].enabled !== false) {
      enabledRegionIndices.push(regionIndex);
      enabledThrottledRegions.push(throttledRegions[regionIndex]);
    }
  }

  // Run the CPU-intensive evaluation
  const evalStartMs = performance.now();
  const frameState = evaluateFrameState(frame as any, enabledThrottledRegions, ocrResultsMap, ollamaResultsMap);
  const evalDurationMs = performance.now() - evalStartMs;

  const compactFrameState = buildCompactFrameState(frameState, enabledRegionIndices);

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

  // Transfer the frame buffer back so the main thread can refill and resend it
  // rather than allocating a new one every eval. Nothing below reads `frame`
  // after this point — transferring detaches it on this side.
  // Measured up to the postMessage call, so it excludes result serialization.
  // The main thread subtracts this from the round trip to isolate the cost of
  // moving data across the thread boundary.
  const workerTotalMs = performance.now() - workerStartMs;

  // postMessage structured-clones on the calling thread, so timing the call
  // itself isolates serialization CPU from queueing and delivery — which the
  // inbound/outbound latencies cannot separate. The measurement can only be
  // reported on the following message, which is immaterial for a per-second
  // aggregate.
  const serializeStartMs = performance.now();
  parentPort!.postMessage({
    type: 'result',
    frameBuffer: request.frameBuffer,
    compactFrameState,
    previousResultSerializeMs: lastResultSerializeMs,
    evalDurationMs,
    hashDurationMs,
    workerTotalMs,
    inboundLatencyMs,
    // Read as late as possible so the main thread's outbound measurement covers
    // result serialization and delivery, and nothing else.
    repliedAtMonotonicMs: nowMonotonicMs(),
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
  }, [
    request.frameBuffer,
    // Transferred rather than cloned — moves ownership instead of copying.
    compactFrameState.regionIndices.buffer,
    compactFrameState.medianColorBytes.buffer,
  ]);
  lastResultSerializeMs = performance.now() - serializeStartMs;
});

/** Serialization cost of the previous result, reported on the next one. */
let lastResultSerializeMs = 0;

/**
 * Repackages a FrameState into the smallest form that still lets the main
 * thread rebuild it exactly.
 *
 * Every region instance carries two UUID strings, a bounds object, a
 * median-colour object and three indices — all of which the main thread already
 * knows, since it built the region list it sent us. What it does not know is
 * the median colour and the calculation results. Median colours are three bytes
 * each and go into one transferable typed array; calculation results are sent
 * only for regions that actually evaluated one this pass, which throttling
 * usually keeps to a small subset.
 *
 * PERF-TRADEOFF — revisit before assuming this is worth keeping.
 *
 * Measured at 181 regions: serializing the full FrameState costs ~0.18ms per
 * eval (~3.4ms/s); this compaction removes nearly all of it, and rebuilding on
 * the main thread costs ~0.06ms. So the net saving is real but small — well
 * under 1% of a second.
 *
 * It was built on the expectation of a ~1.6ms saving, which came from
 * attributing the worker's outbound latency to serialization. Timing
 * postMessage directly showed that latency is dominated by waiting for the
 * receiving thread's event loop, not by marshalling. The optimisation is kept
 * because it is measured, verified equivalent, and reduces per-eval garbage —
 * not because it addressed the bottleneck.
 *
 * The cost is an invariant: the indices in `regionIndices` must line up with
 * the region array the main thread retained when it sent the request. See
 * `reconstructFrameState` in main.ts, which warns loudly if they ever diverge.
 *
 * Revert both halves and send `frameState` directly if that invariant becomes
 * awkward to hold — for example if more than one eval is ever allowed in
 * flight, or if the region list can change between send and reply.
 */
function buildCompactFrameState(frameState: any, enabledRegionIndices: number[]) {
  const instanceStates = frameState.regionInstanceStates || [];
  const producedCount = instanceStates.length;

  // Uint16 caps the addressable region list at 65535 entries, far beyond the
  // point where the rest of the pipeline would remain usable.
  const regionIndices = new Uint16Array(producedCount);
  const medianColorBytes = new Uint8Array(producedCount * 3);
  const calculationResultsByIndex: Array<[number, any[]]> = [];

  for (let stateIndex = 0; stateIndex < producedCount; stateIndex++) {
    const instanceState = instanceStates[stateIndex];
    regionIndices[stateIndex] = enabledRegionIndices[stateIndex];

    const colorOffset = stateIndex * 3;
    medianColorBytes[colorOffset] = instanceState.medianColor.red;
    medianColorBytes[colorOffset + 1] = instanceState.medianColor.green;
    medianColorBytes[colorOffset + 2] = instanceState.medianColor.blue;

    if (instanceState.calculationResults.length > 0) {
      calculationResultsByIndex.push([stateIndex, instanceState.calculationResults]);
    }
  }

  return {
    timestamp: frameState.timestamp,
    regionIndices,
    medianColorBytes,
    calculationResultsByIndex,
  };
}

function getRegionEvaluationIntervalMs(region: any, globalMinCalcIntervalMs: number): number {
  const regionIntervalMs = Number(region.evaluationIntervalMs);
  if (Number.isFinite(regionIntervalMs) && regionIntervalMs > 0) {
    return Math.max(20, Math.round(regionIntervalMs));
  }

  return globalMinCalcIntervalMs;
}

/**
 * Computes how many forced-evaluation passes should run after a pixel hash
 * change for a given region.
 *
 * The base value covers transition-frame noise (see EXTRA_EVAL_PASSES_AFTER_CHANGE).
 *
 * ColorThreshold calculations can require N consecutive passing evaluations
 * before a state value is committed. If skipIfUnchanged cuts off evaluations
 * before N passes accumulate, the consecutive counter in state-calculation.service
 * never reaches the target and the state never transitions — even though the
 * pixel has been the correct color the whole time.
 *
 * OCR calculations can require a match to hold continuously for minDurationMs
 * before a state value is committed. The OCR service is fed the throttled region
 * list, so if skipIfUnchanged removes the OCR calc before minDurationMs has
 * elapsed, the duration clock stalls and the state never transitions.
 *
 * Fix: the post-change window must be at least as long as:
 *   - the largest consecutiveRequired across all ColorThreshold mappings, AND
 *   - ceil(maxMinDurationMs / evalIntervalMs) for the largest OCR minDurationMs.
 *
 * @param evalIntervalMs  The effective per-region evaluation interval — used to
 *                        convert OCR minDurationMs into a pass count.
 */
function computePostChangeEvalPasses(region: any, basePasses: number, evalIntervalMs: number): number {
  let requiredPasses = basePasses;
  for (const calc of (region.stateCalculations || [])) {
    if (calc.type === 'ColorThreshold') {
      for (const mapping of (calc.colorThresholdMappings || [])) {
        const consecutiveRequired = (mapping.consecutiveRequired as number) || 1;
        if (consecutiveRequired > requiredPasses) {
          requiredPasses = consecutiveRequired;
        }
      }
    } else if (calc.type === 'OCR') {
      for (const mapping of (calc.substringMappings || [])) {
        const minDurationMs = (mapping.minDurationMs as number) || 0;
        if (minDurationMs > 0) {
          const passesNeededForDuration = Math.ceil(minDurationMs / evalIntervalMs);
          if (passesNeededForDuration > requiredPasses) {
            requiredPasses = passesNeededForDuration;
          }
        }
      }
    }
  }
  return requiredPasses;
}
