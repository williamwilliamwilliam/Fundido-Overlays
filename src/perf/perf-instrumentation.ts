/**
 * Performance instrumentation for the capture → evaluate → overlay pipeline.
 *
 * Answers three questions that the existing perfCounters could not:
 *
 *   1. WHICH PROCESS is burning CPU? Electron runs the main process, a GPU
 *      process, and one renderer per window. `app.getAppMetrics()` attributes
 *      CPU and memory to each one, so we can tell "the overlay renderer is the
 *      problem" apart from "the pixel math is the problem".
 *
 *   2. WHICH THREAD inside the main process? Worker threads live inside the
 *      main process, so getAppMetrics() lumps them together with the main
 *      thread. Event-loop utilization (ELU) separates them: it reports the
 *      fraction of wall time each thread's event loop spent active. A worker
 *      sitting at 0.95 ELU is saturated; the main thread at 0.30 has headroom.
 *
 *   3. WHICH STAGE of the pipeline? Named stage timers replace the single
 *      aggregate `pipelineAvgMs`, reporting count / average / max per second
 *      so a slow stage points at its own code.
 *
 * KNOWN BLIND SPOT: the native DXGI capture thread is a raw OS thread inside
 * the main process. It has no event loop, so it produces no ELU sample, and
 * its CPU time is folded into the main process's `Browser` CPU figure. If the
 * Browser process shows high CPU while the main thread's ELU stays low, the
 * capture thread is the likely consumer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'perf_hooks';

/** Named pipeline stages, in roughly the order a frame passes through them. */
export type PerfStage =
  /** Total time spent inside the native capture callback on the main thread. */
  | 'captureCallback'
  /** Handing the frame to the preview service. */
  | 'previewFeed'
  /** Cropping + IPC-ing mirror pixels to the overlay windows. */
  | 'mirrorBroadcast'
  /** Region filtering and physical-bounds mapping before the worker send. */
  | 'evalPrep'
  /** Full-frame copy into a freshly allocated ArrayBuffer (worker mode). */
  | 'frameBufferAlloc'
  /** Full-frame copy into the buffer the worker handed back (worker mode). */
  | 'frameBufferReuse'
  /** Hashing every region's pixels to detect change (worker mode). */
  | 'regionPixelHash'
  /** Time spent inside evaluateFrameState, wherever it ran. */
  | 'stateEval'
  /** Everything the worker did for one request, hashing and eval included. */
  | 'workerTotal'
  /** Round trip minus the worker's own work: serialization and transfer. */
  | 'workerBoundary'
  /** Main-thread CPU spent inside postMessage serializing the request. */
  | 'requestSerialize'
  /** Worker-thread CPU spent inside postMessage serializing the result. */
  | 'resultSerialize'
  /** Request posted → worker began handling it. Argument clone plus pickup. */
  | 'workerInbound'
  /** Worker posted the result → main thread began handling it. */
  | 'workerOutbound'
  /** postMessage → result received: worker time plus queueing and transfer. */
  | 'workerRoundTrip'
  /** Expanding the worker's compact result back into a full FrameState. */
  | 'frameStateRebuild'
  /** Main-thread handling of the worker result (cache merge, fallbacks). */
  | 'evalResultHandling'
  /** Broadcasting the frame state to overlay windows and the UI. */
  | 'overlayStateBroadcast';

interface StageAccumulator {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface StageTiming {
  /** Number of times this stage ran during the reporting window. */
  count: number;
  avgMs: number;
  maxMs: number;
  /** Total wall time in this stage — the share of a 1000ms window it consumed. */
  totalMs: number;
}

export interface ProcessCpuSample {
  /** Electron process type: 'Browser' (main), 'GPU', 'Tab' (renderer), 'Utility'. */
  type: string;
  name: string;
  pid: number;
  /** Percent of a single CPU core. Can exceed 100 on multi-threaded processes. */
  cpuPercent: number;
  memoryMb: number;
}

export interface ThreadUtilizationSample {
  name: string;
  /** 0..1 — fraction of wall time this thread's event loop was active. */
  utilization: number;
}

export interface EventLoopDelaySample {
  meanMs: number;
  p99Ms: number;
  maxMs: number;
}

export interface PerfDiagnostics {
  stages: Partial<Record<PerfStage, StageTiming>>;
  processes: ProcessCpuSample[];
  /** Sum of cpuPercent across all Electron processes. */
  totalCpuPercent: number;
  threads: ThreadUtilizationSample[];
  /** Which state-evaluation path produced these numbers. Set by the caller. */
  evalMode?: string;
  /**
   * How long the main thread's event loop was blocked between ticks.
   * Rising delay means the main thread is the bottleneck — work queued behind
   * something long-running. Null until monitoring starts.
   */
  mainThreadLag: EventLoopDelaySample | null;
}

/** Raw event-loop utilization reading, as returned by perf_hooks. */
interface EluReading {
  idle: number;
  active: number;
}

type EluSampler = () => EluReading | null;

interface RegisteredThread {
  name: string;
  sample: EluSampler;
  previous: EluReading | null;
}

/** Cap on the trace file so a long session cannot fill the disk. */
const MAX_TRACE_LINES = 20_000;

class PerfInstrumentation {
  private readonly stageAccumulators = new Map<PerfStage, StageAccumulator>();
  private readonly threads: RegisteredThread[] = [];

  private traceFilePath: string | null = null;
  private traceStream: fs.WriteStream | null = null;
  private traceLinesWritten = 0;
  private eventLoopDelayHistogram: IntervalHistogram | null = null;

  /**
   * Records one occurrence of a stage. Cheap enough to call per frame —
   * three number updates on a Map entry, no allocation.
   */
  public recordStage(stage: PerfStage, durationMs: number): void {
    let accumulator = this.stageAccumulators.get(stage);
    if (!accumulator) {
      accumulator = { count: 0, totalMs: 0, maxMs: 0 };
      this.stageAccumulators.set(stage, accumulator);
    }
    accumulator.count++;
    accumulator.totalMs += durationMs;
    if (durationMs > accumulator.maxMs) {
      accumulator.maxMs = durationMs;
    }
  }

  /**
   * Times a synchronous function and records it as a stage.
   * Uses performance.now() for sub-millisecond resolution — Date.now() has
   * ~1-15ms granularity on Windows, which is far too coarse for these stages.
   */
  public timeStage<T>(stage: PerfStage, operation: () => T): T {
    const startMs = performance.now();
    try {
      return operation();
    } finally {
      this.recordStage(stage, performance.now() - startMs);
    }
  }

  /**
   * Starts sampling how long the main thread's event loop is blocked.
   *
   * Event-loop UTILIZATION is not usable here: Electron's main process is
   * driven by a Chromium message loop rather than a plain libuv loop, so
   * `performance.eventLoopUtilization()` reports zero idle and zero active on
   * the main thread. Event-loop DELAY still works, and answers the question we
   * actually care about — is the main thread blocked?
   */
  public startEventLoopDelayMonitoring(): void {
    if (this.eventLoopDelayHistogram) return;
    try {
      this.eventLoopDelayHistogram = monitorEventLoopDelay({ resolution: 10 });
      this.eventLoopDelayHistogram.enable();
    } catch {
      this.eventLoopDelayHistogram = null;
    }
  }

  public stopEventLoopDelayMonitoring(): void {
    if (!this.eventLoopDelayHistogram) return;
    this.eventLoopDelayHistogram.disable();
    this.eventLoopDelayHistogram = null;
  }

  /**
   * Registers a thread whose event-loop utilization should be sampled.
   *
   * @param name    Label shown in the UI and trace file.
   * @param sample  Returns the thread's cumulative {idle, active} counters,
   *                or null when the thread is not currently running.
   */
  public registerThread(name: string, sample: EluSampler): void {
    const alreadyRegistered = this.threads.some((thread) => thread.name === name);
    if (alreadyRegistered) return;
    this.threads.push({ name, sample, previous: null });
  }

  /**
   * Builds a diagnostics snapshot and resets the stage accumulators so the
   * next call reports only the following window.
   */
  public snapshot(): PerfDiagnostics {
    const stages: Partial<Record<PerfStage, StageTiming>> = {};
    for (const [stage, accumulator] of this.stageAccumulators) {
      if (accumulator.count === 0) continue;
      stages[stage] = {
        count: accumulator.count,
        avgMs: roundToHundredths(accumulator.totalMs / accumulator.count),
        maxMs: roundToHundredths(accumulator.maxMs),
        totalMs: roundToHundredths(accumulator.totalMs),
      };
    }
    this.stageAccumulators.clear();

    const processes = this.sampleProcessCpu();
    const totalCpuPercent = roundToHundredths(
      processes.reduce((runningTotal, sample) => runningTotal + sample.cpuPercent, 0)
    );

    return {
      stages,
      processes,
      totalCpuPercent,
      threads: this.sampleThreadUtilization(),
      mainThreadLag: this.sampleEventLoopDelay(),
    };
  }

  /** Reads and resets the event-loop delay histogram. Values are in ns. */
  private sampleEventLoopDelay(): EventLoopDelaySample | null {
    const histogram = this.eventLoopDelayHistogram;
    if (!histogram) return null;

    const sample: EventLoopDelaySample = {
      meanMs: roundToHundredths(nanosecondsToMilliseconds(histogram.mean)),
      p99Ms: roundToHundredths(nanosecondsToMilliseconds(histogram.percentile(99))),
      maxMs: roundToHundredths(nanosecondsToMilliseconds(histogram.max)),
    };
    histogram.reset();
    return sample;
  }

  // -------------------------------------------------------------------------
  // Trace file
  // -------------------------------------------------------------------------

  /**
   * Opens the JSONL trace file, truncating any previous run's data.
   * One line per reporting tick, so it can be tailed live while the app runs.
   */
  public startTraceFile(userDataPath: string): string | null {
    this.stopTraceFile();
    try {
      this.traceFilePath = path.join(userDataPath, 'fundido-perf.jsonl');
      this.traceStream = fs.createWriteStream(this.traceFilePath, { flags: 'w' });
      this.traceLinesWritten = 0;
      return this.traceFilePath;
    } catch {
      this.traceFilePath = null;
      this.traceStream = null;
      return null;
    }
  }

  public stopTraceFile(): void {
    if (this.traceStream) {
      this.traceStream.end();
      this.traceStream = null;
    }
  }

  public getTraceFilePath(): string | null {
    return this.traceFilePath;
  }

  /** Appends one record to the trace file. No-op once the line cap is hit. */
  public writeTraceRecord(record: unknown): void {
    if (!this.traceStream) return;
    if (this.traceLinesWritten >= MAX_TRACE_LINES) return;
    try {
      this.traceStream.write(JSON.stringify(record) + '\n');
      this.traceLinesWritten++;
    } catch {
      // A failed trace write must never disturb the pipeline.
    }
  }

  // -------------------------------------------------------------------------
  // Sampling helpers
  // -------------------------------------------------------------------------

  private sampleProcessCpu(): ProcessCpuSample[] {
    const electronApp = tryGetElectronApp();
    if (!electronApp) return [];

    try {
      return electronApp.getAppMetrics().map((processMetric: any) => ({
        type: processMetric.type ?? 'Unknown',
        name: processMetric.serviceName || processMetric.name || processMetric.type || 'Unknown',
        pid: processMetric.pid ?? 0,
        cpuPercent: roundToHundredths(processMetric.cpu?.percentCPUUsage ?? 0),
        memoryMb: Math.round((processMetric.memory?.workingSetSize ?? 0) / 1024),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Converts each thread's cumulative idle/active counters into the
   * utilization observed since the previous snapshot.
   */
  private sampleThreadUtilization(): ThreadUtilizationSample[] {
    const samples: ThreadUtilizationSample[] = [];

    for (const thread of this.threads) {
      let current: EluReading | null = null;
      try {
        current = thread.sample();
      } catch {
        current = null;
      }

      if (!current) {
        // Thread is not running (e.g. the worker failed and we fell back).
        thread.previous = null;
        continue;
      }

      const previous = thread.previous;
      thread.previous = current;

      // First sample for this thread establishes the baseline only.
      if (!previous) continue;

      const activeDelta = current.active - previous.active;
      const totalDelta = activeDelta + (current.idle - previous.idle);
      const utilization = totalDelta > 0 ? activeDelta / totalDelta : 0;

      samples.push({
        name: thread.name,
        utilization: Math.round(clampToUnitRange(utilization) * 1000) / 1000,
      });
    }

    return samples;
  }
}

function roundToHundredths(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function nanosecondsToMilliseconds(nanoseconds: number): number {
  return nanoseconds / 1_000_000;
}

function clampToUnitRange(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function tryGetElectronApp(): any | null {
  try {
    return (require('electron') as typeof import('electron')).app ?? null;
  } catch {
    return null;
  }
}

export const perf = new PerfInstrumentation();
