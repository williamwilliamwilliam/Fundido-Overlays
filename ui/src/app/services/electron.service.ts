import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import type { LogEntry, PreviewFrameData } from '../models/electron-api';

/** Default config returned when running outside Electron (e.g. ng serve in a browser). */
const STUB_CONFIG = {
  gameCapture: { captureSource: 'primary', targetFps: 30 },
  preview: { previewFps: 10, previewScale: 0.5, downsampleMethod: 'bilinear', jpegQuality: 70 },
  monitoredRegions: [],
  overlayGroups: [],
};

/**
 * Provides Angular components with access to the Electron main process
 * via the preload-exposed `window.fundidoApi`.
 *
 * When running outside Electron (e.g. `ng serve` in a regular browser),
 * all calls return safe stub responses so the UI can be developed without
 * the Electron shell.
 *
 * All IPC callbacks are piped through NgZone.run() so Angular change
 * detection picks up the updates.
 */
@Injectable({ providedIn: 'root' })
export class ElectronService {
  private readonly debugLog$ = new Subject<LogEntry>();
  private readonly stateUpdated$ = new Subject<any>();
  private readonly previewFrame$ = new Subject<PreviewFrameData>();

  public readonly debugLogStream = this.debugLog$.asObservable();
  public readonly stateUpdateStream = this.stateUpdated$.asObservable();
  public readonly previewFrameStream = this.previewFrame$.asObservable();

  public readonly isRunningInElectron: boolean;

  constructor(private readonly ngZone: NgZone) {
    this.isRunningInElectron = !!window.fundidoApi;

    if (this.isRunningInElectron) {
      this.registerIpcListeners();
    } else {
      console.warn('[ElectronService] window.fundidoApi not found — running in stub mode.');
    }
  }

  // -- Configuration --------------------------------------------------------

  public async loadConfig(): Promise<any> {
    if (!this.isRunningInElectron) return STUB_CONFIG;
    return window.fundidoApi.loadConfig();
  }

  public async saveConfig(config: any): Promise<{ success: boolean }> {
    if (!this.isRunningInElectron) return { success: true };
    return window.fundidoApi.saveConfig(config);
  }

  public async exportRegions(): Promise<string> {
    if (!this.isRunningInElectron) return '[]';
    return window.fundidoApi.exportRegions();
  }

  public async importRegions(json: string): Promise<{ success: boolean; regionCount?: number; error?: string }> {
    if (!this.isRunningInElectron) return { success: true, regionCount: 0 };
    return window.fundidoApi.importRegions(json);
  }

  public async exportOverlayGroups(): Promise<string> {
    if (!this.isRunningInElectron) return '[]';
    return window.fundidoApi.exportOverlayGroups();
  }

  public async importOverlayGroups(json: string): Promise<{ success: boolean; groupCount?: number; error?: string }> {
    if (!this.isRunningInElectron) return { success: true, groupCount: 0 };
    return window.fundidoApi.importOverlayGroups(json);
  }

  // -- Capture --------------------------------------------------------------

  public async startCapture(): Promise<{ success: boolean }> {
    if (!this.isRunningInElectron) return { success: true };
    return window.fundidoApi.startCapture();
  }

  public async stopCapture(): Promise<{ success: boolean }> {
    if (!this.isRunningInElectron) return { success: true };
    return window.fundidoApi.stopCapture();
  }

  public async getCaptureStatus(): Promise<{ isCapturing: boolean; isNativeAvailable: boolean }> {
    if (!this.isRunningInElectron) return { isCapturing: false, isNativeAvailable: false };
    return window.fundidoApi.getCaptureStatus();
  }

  public async listDisplays(): Promise<Array<{ adapterIndex: number; outputIndex: number; name: string; width: number; height: number }>> {
    if (!this.isRunningInElectron) {
      return [{ adapterIndex: 0, outputIndex: 0, name: 'Stub Display (not in Electron)', width: 1920, height: 1080 }];
    }
    return window.fundidoApi.listDisplays();
  }

  // -- Screen picker --------------------------------------------------------

  private readonly pickerRegionUpdate$ = new Subject<{ x: number; y: number; width: number; height: number }>();
  public readonly pickerRegionUpdateStream = this.pickerRegionUpdate$.asObservable();

  public async pickRegion(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    if (!this.isRunningInElectron) return null;
    return window.fundidoApi.pickRegion();
  }

  // -- Working regions (live evaluation) ------------------------------------

  public async setWorkingRegions(regions: any[]): Promise<void> {
    if (!this.isRunningInElectron) return;
    await window.fundidoApi.setWorkingRegions(regions);
  }

  // -- IPC listeners --------------------------------------------------------

  private registerIpcListeners(): void {
    window.fundidoApi.onDebugLog((entry: LogEntry) => {
      this.ngZone.run(() => this.debugLog$.next(entry));
    });

    window.fundidoApi.onPickerRegionUpdate((region) => {
      this.ngZone.run(() => this.pickerRegionUpdate$.next(region));
    });

    window.fundidoApi.onStateUpdated((frameState: any) => {
      this.ngZone.run(() => this.stateUpdated$.next(frameState));
    });

    window.fundidoApi.onPreviewFrame((previewData: PreviewFrameData) => {
      this.ngZone.run(() => this.previewFrame$.next(previewData));
    });
  }
}
