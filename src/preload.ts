/**
 * Preload script for the main configuration UI window.
 *
 * Exposes a typed `fundidoApi` object on `window` that the Angular app
 * uses to communicate with the main process via IPC.
 *
 * Context isolation is enabled, so this is the only bridge between the
 * renderer's web context and Node/Electron APIs.
 */
import { contextBridge, ipcRenderer } from 'electron';
import * as IpcChannels from './shared/ipc-channels';
import type { FundidoConfig } from './shared';
import type { LogEntry } from './shared/logger';

const fundidoApi = {
  // -- Configuration --------------------------------------------------------
  loadConfig: (): Promise<FundidoConfig> =>
    ipcRenderer.invoke(IpcChannels.CONFIG_LOAD),

  saveConfig: (config: FundidoConfig): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannels.CONFIG_SAVE, config),

  exportRegions: (): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.CONFIG_EXPORT_REGIONS),

  importRegions: (json: string): Promise<{ success: boolean; regionCount?: number; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.CONFIG_IMPORT_REGIONS, json),

  exportOverlayGroups: (): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.CONFIG_EXPORT_OVERLAY_GROUPS),

  importOverlayGroups: (json: string): Promise<{ success: boolean; groupCount?: number; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.CONFIG_IMPORT_OVERLAY_GROUPS, json),

  // -- Capture --------------------------------------------------------------
  startCapture: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannels.CAPTURE_START),

  stopCapture: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannels.CAPTURE_STOP),

  getCaptureStatus: (): Promise<{ isCapturing: boolean }> =>
    ipcRenderer.invoke(IpcChannels.CAPTURE_STATUS),

  // -- Debug log listener ---------------------------------------------------
  onDebugLog: (callback: (entry: LogEntry) => void): void => {
    ipcRenderer.on(IpcChannels.DEBUG_LOG, (_event, entry: LogEntry) => {
      callback(entry);
    });
  },

  // -- State updates listener -----------------------------------------------
  onStateUpdated: (callback: (frameState: unknown) => void): void => {
    ipcRenderer.on(IpcChannels.STATE_UPDATED, (_event, frameState) => {
      callback(frameState);
    });
  },
};

contextBridge.exposeInMainWorld('fundidoApi', fundidoApi);

/** TypeScript declaration so Angular can see the API on `window`. */
export type FundidoApi = typeof fundidoApi;
