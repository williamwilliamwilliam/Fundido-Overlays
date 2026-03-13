/**
 * Preload script for transparent overlay windows.
 *
 * Exposes a minimal API for receiving overlay configuration
 * and frame-state updates from the main process.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayGroup, FrameState } from './shared';

const overlayApi = {
  onInit: (callback: (group: OverlayGroup) => void): void => {
    ipcRenderer.on('overlay:init', (_event, group: OverlayGroup) => {
      callback(group);
    });
  },

  onFrameState: (callback: (frameState: FrameState) => void): void => {
    ipcRenderer.on('overlay:frame-state', (_event, frameState: FrameState) => {
      callback(frameState);
    });
  },
};

contextBridge.exposeInMainWorld('overlayApi', overlayApi);

export type OverlayApi = typeof overlayApi;
