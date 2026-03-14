/**
 * Preload script for transparent overlay windows.
 *
 * Exposes a minimal API for receiving overlay configuration
 * and frame-state updates from the main process.
 *
 * IMPORTANT: Preload scripts run in a sandboxed context and cannot use
 * relative require() imports. Channel names are inlined here.
 */
import { contextBridge, ipcRenderer } from 'electron';

const overlayApi = {
    onInit: (callback: (group: any) => void): void => {
        ipcRenderer.on('overlay:init', (_event, group) => {
            callback(group);
        });
    },

    onFrameState: (callback: (frameState: any) => void): void => {
        ipcRenderer.on('overlay:frame-state', (_event, frameState) => {
            callback(frameState);
        });
    },
};

contextBridge.exposeInMainWorld('overlayApi', overlayApi);

export type OverlayApi = typeof overlayApi;