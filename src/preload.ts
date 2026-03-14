/**
 * Preload script for the main configuration UI window.
 *
 * Exposes a typed `fundidoApi` object on `window` that the Angular app
 * uses to communicate with the main process via IPC.
 *
 * Context isolation is enabled, so this is the only bridge between the
 * renderer's web context and Node/Electron APIs.
 *
 * IMPORTANT: Preload scripts run in a sandboxed context and cannot use
 * relative require() imports. All IPC channel names are inlined here
 * and must be kept in sync with src/shared/ipc-channels.ts.
 */
import { contextBridge, ipcRenderer } from 'electron';

// ---------------------------------------------------------------------------
// IPC channel names (mirrored from src/shared/ipc-channels.ts)
// ---------------------------------------------------------------------------
const IPC = {
  CONFIG_LOAD:                 'config:load',
  CONFIG_SAVE:                 'config:save',
  CONFIG_EXPORT_REGIONS:       'config:export-regions',
  CONFIG_IMPORT_REGIONS:       'config:import-regions',
  CONFIG_EXPORT_OVERLAY_GROUPS:'config:export-overlay-groups',
  CONFIG_IMPORT_OVERLAY_GROUPS:'config:import-overlay-groups',
  CAPTURE_START:               'capture:start',
  CAPTURE_STOP:                'capture:stop',
  CAPTURE_STATUS:              'capture:status',
  CAPTURE_LIST_DISPLAYS:       'capture:list-displays',
  CAPTURE_PREVIEW_FRAME:       'capture:preview-frame',
  STATE_UPDATED:               'state:updated',
  REGIONS_SET_WORKING:         'regions:set-working',
  GROUPS_SET_WORKING:          'groups:set-working',
  DEBUG_LOG:                   'debug:log',
  PICKER_START:                'picker:start',
  PICKER_REGION_UPDATE:        'picker:region-update',
} as const;

// ---------------------------------------------------------------------------
// API exposed to the renderer
// ---------------------------------------------------------------------------

const fundidoApi = {
  // -- Configuration --------------------------------------------------------
  loadConfig: (): Promise<any> =>
    ipcRenderer.invoke(IPC.CONFIG_LOAD),

  saveConfig: (config: any): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC.CONFIG_SAVE, config),

  exportRegions: (): Promise<string> =>
    ipcRenderer.invoke(IPC.CONFIG_EXPORT_REGIONS),

  importRegions: (json: string): Promise<{ success: boolean; regionCount?: number; error?: string }> =>
    ipcRenderer.invoke(IPC.CONFIG_IMPORT_REGIONS, json),

  exportOverlayGroups: (): Promise<string> =>
    ipcRenderer.invoke(IPC.CONFIG_EXPORT_OVERLAY_GROUPS),

  importOverlayGroups: (json: string): Promise<{ success: boolean; groupCount?: number; error?: string }> =>
    ipcRenderer.invoke(IPC.CONFIG_IMPORT_OVERLAY_GROUPS, json),

  // -- Capture --------------------------------------------------------------
  startCapture: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC.CAPTURE_START),

  stopCapture: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC.CAPTURE_STOP),

  getCaptureStatus: (): Promise<{ isCapturing: boolean; isNativeAvailable: boolean }> =>
    ipcRenderer.invoke(IPC.CAPTURE_STATUS),

  listDisplays: (): Promise<Array<{ adapterIndex: number; outputIndex: number; name: string; width: number; height: number }>> =>
    ipcRenderer.invoke(IPC.CAPTURE_LIST_DISPLAYS),

  // -- Screen picker --------------------------------------------------------
  pickRegion: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
    ipcRenderer.invoke(IPC.PICKER_START),

  // -- Working regions/groups (live evaluation without saving) ---------------
  setWorkingRegions: (regions: any[]): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC.REGIONS_SET_WORKING, regions),

  setWorkingGroups: (groups: any[]): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC.GROUPS_SET_WORKING, groups),

  onPickerRegionUpdate: (callback: (region: { x: number; y: number; width: number; height: number }) => void): void => {
    ipcRenderer.on(IPC.PICKER_REGION_UPDATE, (_event, region) => {
      callback(region);
    });
  },

  // -- Debug log listener ---------------------------------------------------
  onDebugLog: (callback: (entry: any) => void): void => {
    ipcRenderer.on(IPC.DEBUG_LOG, (_event, entry) => {
      callback(entry);
    });
  },

  // -- State updates listener -----------------------------------------------
  onStateUpdated: (callback: (frameState: unknown) => void): void => {
    ipcRenderer.on(IPC.STATE_UPDATED, (_event, frameState) => {
      callback(frameState);
    });
  },

  // -- Preview frame listener -----------------------------------------------
  onPreviewFrame: (callback: (previewData: any) => void): void => {
    ipcRenderer.on(IPC.CAPTURE_PREVIEW_FRAME, (_event, previewData) => {
      callback(previewData);
    });
  },
};

contextBridge.exposeInMainWorld('fundidoApi', fundidoApi);

/** TypeScript declaration so Angular can see the API on `window`. */
export type FundidoApi = typeof fundidoApi;
