/**
 * Declares the `fundidoApi` object that the Electron preload script
 * exposes on `window`. This lets Angular services call it in a type-safe way.
 */

export interface LogEntry {
  timestamp: number;
  category: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

export interface DisplayInfo {
  adapterIndex: number;
  outputIndex: number;
  name: string;
  width: number;
  height: number;
}

export interface PreviewFrameData {
  imageDataUrl: string;
  originalWidth: number;
  originalHeight: number;
  previewWidth: number;
  previewHeight: number;
  displayOriginX: number;
  displayOriginY: number;
  displayScaleFactor: number;
}

export interface RegionsPreviewFrameData {
  bgraBuffer: Uint8Array;
  originalWidth: number;
  originalHeight: number;
  previewWidth: number;
  previewHeight: number;
  displayOriginX: number;
  displayOriginY: number;
  displayScaleFactor: number;
}

export interface RegionPerfMetrics {
  medianColorPerSec: number;
  colorThresholdPerSec: number;
  ocrPerSec: number;
  ollamaPerSec: number;
  totalCalcsPerSec: number;
  /** Total milliseconds spent in calculation over the last 10 seconds. */
  timeInCalcMs: number;
}

export interface StageTiming {
  count: number;
  avgMs: number;
  maxMs: number;
  /** Total wall time in this stage during the 1-second window. */
  totalMs: number;
}

export interface ProcessCpuSample {
  /** 'Browser' (main process), 'GPU', 'Tab' (renderer), 'Utility'. */
  type: string;
  name: string;
  pid: number;
  /** Percent of a single CPU core — can exceed 100 for multi-threaded processes. */
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
  stages: Record<string, StageTiming>;
  processes: ProcessCpuSample[];
  totalCpuPercent: number;
  threads: ThreadUtilizationSample[];
  /** Main-thread event loop blocking. Null when monitoring is unavailable. */
  mainThreadLag: EventLoopDelaySample | null;
}

export interface PerfMetrics {
  captureFps: number;
  previewFps: number;
  stateEvalPerSec: number;
  medianColorCalcsPerSec: number;
  colorThresholdCalcsPerSec: number;
  ocrCalcsPerSec: number;
  ollamaCalcsPerSec: number;
  pipelineAvgMs: number;
  activeRegionCount: number;
  activeOverlayGroupCount: number;
  /** Per-region calc counts, keyed by region ID. */
  regionMetrics: Record<string, RegionPerfMetrics>;
  /**
   * Process CPU attribution, per-thread utilization, and pipeline stage timings.
   * Optional so the UI stays functional against a main process that predates it.
   */
  diagnostics?: PerfDiagnostics;
}

export interface FundidoApi {
  globalEnable(): Promise<{ success: boolean }>;
  globalDisable(): Promise<{ success: boolean }>;
  globalStatus(): Promise<{ enabled: boolean }>;
  loadConfig(): Promise<any>;
  saveConfig(config: any): Promise<{ success: boolean }>;
  exportRegions(): Promise<string>;
  importRegions(json: string): Promise<{ success: boolean; regionCount?: number; error?: string }>;
  exportOverlayGroups(): Promise<string>;
  importOverlayGroups(json: string): Promise<{ success: boolean; groupCount?: number; error?: string }>;
  startCapture(): Promise<{ success: boolean }>;
  stopCapture(): Promise<{ success: boolean }>;
  getCaptureStatus(): Promise<{ isCapturing: boolean; isNativeAvailable: boolean }>;
  listDisplays(): Promise<DisplayInfo[]>;
  pickRegion(options?: { autoConfirmSingleClick?: boolean }): Promise<{ x: number; y: number; width: number; height: number } | null>;
  pickColor(): Promise<{ red: number; green: number; blue: number } | null>;
  setWorkingRegions(regions: any[]): Promise<{ success: boolean }>;
  setDirtyRegionOverlays(regions: Array<{ id: string; name: string; showLabel?: boolean; bounds: { x: number; y: number; width: number; height: number } }>): Promise<{ success: boolean }>;
  setWorkingGroups(groups: any[]): Promise<{ success: boolean }>;
  openFileDialog(options?: any): Promise<string | null>;
  ollamaListModels(): Promise<Array<{ name: string; size: number }>>;
  onPickerRegionUpdate(callback: (region: { x: number; y: number; width: number; height: number }) => void): void;
  onDebugLog(callback: (entry: LogEntry) => void): void;
  onStateUpdated(callback: (frameState: any) => void): void;
  onPreviewFrame(callback: (previewData: PreviewFrameData) => void): void;
  onRegionsPreviewFrame(callback: (previewData: RegionsPreviewFrameData) => void): void;
  onPerfMetrics(callback: (metrics: PerfMetrics) => void): void;
  onPreviewPaused(callback: (paused: boolean) => void): void;
  onAppCloseRequested(callback: () => void): void;
  setActivePage(page: string): void;
  respondToAppCloseRequest(allowClose: boolean): void;
  // Sound Library
  soundIndexFolders(folderPaths: string[]): Promise<{ success: boolean }>;
  soundGetIndex(): Promise<string[]>;
  soundCancelIndex(): Promise<{ success: boolean }>;
  soundPlayPreview(filePath: string, volume: number): Promise<{ success: boolean }>;
  onSoundIndexProgress(callback: (progress: { filesFound: number; currentFolder: string; complete: boolean; cancelled: boolean }) => void): void;
  offSoundIndexProgress(callback: (...args: any[]) => void): void;
}

declare global {
  interface Window {
    fundidoApi: FundidoApi;
  }
}
