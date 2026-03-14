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
}

export interface FundidoApi {
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
  pickPosition(): Promise<{ x: number; y: number } | null>;
  onDebugLog(callback: (entry: LogEntry) => void): void;
  onStateUpdated(callback: (frameState: any) => void): void;
  onPreviewFrame(callback: (previewData: PreviewFrameData) => void): void;
}

declare global {
  interface Window {
    fundidoApi: FundidoApi;
  }
}
