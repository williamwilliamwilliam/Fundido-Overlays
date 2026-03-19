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
  setDirtyRegionOverlays(regions: Array<{ id: string; name: string; bounds: { x: number; y: number; width: number; height: number } }>): Promise<{ success: boolean }>;
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
}

declare global {
  interface Window {
    fundidoApi: FundidoApi;
  }
}
