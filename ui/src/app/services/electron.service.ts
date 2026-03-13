import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import type { LogEntry } from '../models/electron-api';

/**
 * Provides Angular components with access to the Electron main process
 * via the preload-exposed `window.fundidoApi`.
 *
 * All IPC callbacks are piped through NgZone.run() so Angular change
 * detection picks up the updates.
 */
@Injectable({ providedIn: 'root' })
export class ElectronService {
  private readonly debugLog$ = new Subject<LogEntry>();
  private readonly stateUpdated$ = new Subject<any>();

  public readonly debugLogStream = this.debugLog$.asObservable();
  public readonly stateUpdateStream = this.stateUpdated$.asObservable();

  constructor(private readonly ngZone: NgZone) {
    this.registerIpcListeners();
  }

  // -- Configuration --------------------------------------------------------

  public async loadConfig(): Promise<any> {
    return window.fundidoApi.loadConfig();
  }

  public async saveConfig(config: any): Promise<{ success: boolean }> {
    return window.fundidoApi.saveConfig(config);
  }

  public async exportRegions(): Promise<string> {
    return window.fundidoApi.exportRegions();
  }

  public async importRegions(json: string): Promise<{ success: boolean; regionCount?: number; error?: string }> {
    return window.fundidoApi.importRegions(json);
  }

  public async exportOverlayGroups(): Promise<string> {
    return window.fundidoApi.exportOverlayGroups();
  }

  public async importOverlayGroups(json: string): Promise<{ success: boolean; groupCount?: number; error?: string }> {
    return window.fundidoApi.importOverlayGroups(json);
  }

  // -- Capture --------------------------------------------------------------

  public async startCapture(): Promise<{ success: boolean }> {
    return window.fundidoApi.startCapture();
  }

  public async stopCapture(): Promise<{ success: boolean }> {
    return window.fundidoApi.stopCapture();
  }

  public async getCaptureStatus(): Promise<{ isCapturing: boolean }> {
    return window.fundidoApi.getCaptureStatus();
  }

  // -- IPC listeners --------------------------------------------------------

  private registerIpcListeners(): void {
    window.fundidoApi.onDebugLog((entry: LogEntry) => {
      this.ngZone.run(() => this.debugLog$.next(entry));
    });

    window.fundidoApi.onStateUpdated((frameState: any) => {
      this.ngZone.run(() => this.stateUpdated$.next(frameState));
    });
  }
}
