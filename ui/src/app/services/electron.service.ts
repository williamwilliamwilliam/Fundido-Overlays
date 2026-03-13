import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import type { LogEntry } from '../models/electron-api';

/** Default config returned when running outside Electron (e.g. ng serve in a browser). */
const STUB_CONFIG = {
    gameCapture: { captureSource: 'primary', targetFps: 30 },
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

    public readonly debugLogStream = this.debugLog$.asObservable();
    public readonly stateUpdateStream = this.stateUpdated$.asObservable();

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

    public async getCaptureStatus(): Promise<{ isCapturing: boolean }> {
        if (!this.isRunningInElectron) return { isCapturing: false };
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