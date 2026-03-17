import { app, BrowserWindow, screen, Menu, shell, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigPersistenceService } from './persistence/config-persistence.service';
import { GameCaptureService, CapturedFrame } from './capture/game-capture.service';
import { PreviewFrameService } from './capture/preview-frame.service';
import { OverlayWindowManager } from './overlay/overlay-window-manager';
import { evaluateFrameState } from './state/state-calculation.service';
import { OcrService } from './state/ocr.service';
import { OllamaService } from './state/ollama.service';
import { registerIpcHandlers } from './ipc/ipc-handlers';
import { logger, LogCategory } from './shared/logger';
import { computeRegionPixelHash } from './shared/pixel-hash';
import { FundidoConfig } from './shared';
import * as IpcChannels from './shared/ipc-channels';

// ---------------------------------------------------------------------------
// Window bounds persistence
// ---------------------------------------------------------------------------

interface WindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
    isMaximized: boolean;
}

function getWindowBoundsFilePath(): string {
    return path.join(app.getPath('userData'), 'window-bounds.json');
}

function loadWindowBounds(): WindowBounds | null {
    try {
        const filePath = getWindowBoundsFilePath();
        const fileExists = fs.existsSync(filePath);
        if (!fileExists) return null;

        const rawJson = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(rawJson) as WindowBounds;

        // Validate that the saved position is still on a visible display
        const savedCenterX = parsed.x + parsed.width / 2;
        const savedCenterY = parsed.y + parsed.height / 2;
        const isOnAnyDisplay = screen.getAllDisplays().some((display) => {
            const bounds = display.bounds;
            return (
                savedCenterX >= bounds.x &&
                savedCenterX <= bounds.x + bounds.width &&
                savedCenterY >= bounds.y &&
                savedCenterY <= bounds.y + bounds.height
            );
        });

        if (!isOnAnyDisplay) {
            logger.info(LogCategory.General, 'Saved window position is off-screen — using defaults.');
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}

function saveWindowBounds(window: BrowserWindow): void {
    try {
        const isMaximized = window.isMaximized();
        // Save the non-maximized bounds so restoring from maximized works correctly
        const bounds = isMaximized ? (window as any).__lastNonMaximizedBounds || window.getBounds() : window.getBounds();
        const windowBounds: WindowBounds = {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            isMaximized,
        };
        fs.writeFileSync(getWindowBoundsFilePath(), JSON.stringify(windowBounds), 'utf-8');
    } catch {
        // ignore
    }
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const configService = new ConfigPersistenceService();
const captureService = new GameCaptureService();
const previewService = new PreviewFrameService();
const overlayWindowManager = new OverlayWindowManager();
const ocrService = new OcrService();
const ollamaService = new OllamaService();

/** Mutable reference so IPC handlers can read/write the active config. */
const currentConfigRef: { config: FundidoConfig } = {
    config: configService.load(),
};

/**
 * Working copy of monitored regions pushed from the UI.
 * The evaluation pipeline uses these instead of the persisted config
 * so users can see median colors and state results while still editing.
 * Set to null when no working copy has been pushed (falls back to saved config).
 */
const workingRegionsRef: { regions: any[] | null } = {
    regions: null,
};

/** Global on/off switch. When disabled, capture and overlays are all stopped. */
const globalEnabledRef: { enabled: boolean } = {
    enabled: true,
};

/** Tracks whether the main UI window is minimized. When minimized, only
 *  regions referenced by enabled overlay groups are evaluated. */
const uiMinimizedRef: { minimized: boolean } = {
    minimized: false,
};

/** Tracks which page the UI is currently showing. Used to decide whether
 *  unreferenced regions need evaluation (only on the 'regions' page). */
const uiActivePageRef: { page: string } = {
    page: '',
};

/** Tracks whether a screen picker (region or color) is currently active. */
const pickerActiveRef: { active: boolean } = {
    active: false,
};

// ---------------------------------------------------------------------------
// Performance metrics
// ---------------------------------------------------------------------------

const perfCounters = {
    captureFrames: 0,
    previewFrames: 0,
    stateEvals: 0,
    medianColorCalcs: 0,
    colorThresholdCalcs: 0,
    ocrCalcs: 0,
    ollamaCalcs: 0,
    pipelineTotalMs: 0,
    pipelineSamples: 0,
    activeRegionCount: 0,
    activeOverlayGroupCount: 0,
    /** Per-region counters: regionId → { medianColor, colorThreshold, ocr, ollama } */
    regionCalcs: new Map<string, { medianColor: number; colorThreshold: number; ocr: number; ollama: number }>(),
};

let perfMetricsInterval: ReturnType<typeof setInterval> | null = null;

function startPerfMetricsReporting(): void {
    if (perfMetricsInterval) return;
    perfMetricsInterval = setInterval(() => {
        const reportNowMs = Date.now();
        // Build per-region metrics snapshot including time-in-calc
        const regionMetrics: Record<string, { medianColorPerSec: number; colorThresholdPerSec: number; ocrPerSec: number; ollamaPerSec: number; totalCalcsPerSec: number; timeInCalcMs: number }> = {};

        // First pass: aggregate calc counts per region
        for (const [regionId, counts] of perfCounters.regionCalcs) {
            const totalCalcsPerSec = counts.medianColor + counts.colorThreshold + counts.ocr + counts.ollama;
            regionMetrics[regionId] = {
                medianColorPerSec: counts.medianColor,
                colorThresholdPerSec: counts.colorThreshold,
                ocrPerSec: counts.ocr,
                ollamaPerSec: counts.ollama,
                totalCalcsPerSec,
                timeInCalcMs: 0,
            };
        }

        // Second pass: sum time-in-calc across all calcs belonging to each region
        for (const [calcKey, _window] of calcTimeWindow) {
            const regionId = calcKey.split(':')[0];
            const timeMs = getCalcTimeInWindowMs(calcKey, reportNowMs);
            if (!regionMetrics[regionId]) {
                regionMetrics[regionId] = { medianColorPerSec: 0, colorThresholdPerSec: 0, ocrPerSec: 0, ollamaPerSec: 0, totalCalcsPerSec: 0, timeInCalcMs: 0 };
            }
            regionMetrics[regionId].timeInCalcMs += Math.round(timeMs);
        }

        const metrics = {
            captureFps: perfCounters.captureFrames,
            previewFps: perfCounters.previewFrames,
            stateEvalPerSec: perfCounters.stateEvals,
            medianColorCalcsPerSec: perfCounters.medianColorCalcs,
            colorThresholdCalcsPerSec: perfCounters.colorThresholdCalcs,
            ocrCalcsPerSec: perfCounters.ocrCalcs,
            ollamaCalcsPerSec: perfCounters.ollamaCalcs,
            pipelineAvgMs: perfCounters.pipelineSamples > 0
                ? Math.round((perfCounters.pipelineTotalMs / perfCounters.pipelineSamples) * 100) / 100
                : 0,
            activeRegionCount: perfCounters.activeRegionCount,
            activeOverlayGroupCount: perfCounters.activeOverlayGroupCount,
            regionMetrics,
        };

        // Reset counters for next second
        perfCounters.captureFrames = 0;
        perfCounters.previewFrames = 0;
        perfCounters.stateEvals = 0;
        perfCounters.medianColorCalcs = 0;
        perfCounters.colorThresholdCalcs = 0;
        perfCounters.ocrCalcs = 0;
        perfCounters.ollamaCalcs = 0;
        perfCounters.pipelineTotalMs = 0;
        perfCounters.pipelineSamples = 0;
        perfCounters.regionCalcs.clear();

        if (mainWindow && !mainWindow.isDestroyed() && !uiMinimizedRef.minimized) {
            mainWindow.webContents.send(IpcChannels.PERF_METRICS, metrics);
        }
    }, 1000);
}

function stopPerfMetricsReporting(): void {
    if (perfMetricsInterval) {
        clearInterval(perfMetricsInterval);
        perfMetricsInterval = null;
    }
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
    const isDevelopmentMode = process.argv.includes('--dev');
    const savedBounds = loadWindowBounds();

    const windowOptions: Electron.BrowserWindowConstructorOptions = {
        width: savedBounds?.width ?? 1280,
        height: savedBounds?.height ?? 800,
        title: 'Fundido Overlays',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    };

    // Only set position if we have saved bounds (otherwise let the OS center it)
    if (savedBounds) {
        windowOptions.x = savedBounds.x;
        windowOptions.y = savedBounds.y;
    }

    mainWindow = new BrowserWindow(windowOptions);

    if (savedBounds?.isMaximized) {
        mainWindow.maximize();
    }

    // Track non-maximized bounds so we can restore them correctly
    (mainWindow as any).__lastNonMaximizedBounds = mainWindow.getBounds();

    mainWindow.on('resize', () => {
        if (mainWindow && !mainWindow.isMaximized()) {
            (mainWindow as any).__lastNonMaximizedBounds = mainWindow.getBounds();
        }
        if (mainWindow) saveWindowBounds(mainWindow);
    });

    mainWindow.on('move', () => {
        if (mainWindow && !mainWindow.isMaximized()) {
            (mainWindow as any).__lastNonMaximizedBounds = mainWindow.getBounds();
        }
        if (mainWindow) saveWindowBounds(mainWindow);
    });

    mainWindow.on('maximize', () => {
        if (mainWindow) saveWindowBounds(mainWindow);
    });

    mainWindow.on('unmaximize', () => {
        if (mainWindow) saveWindowBounds(mainWindow);
    });

    logger.setMainWindow(mainWindow);
    previewService.setMainWindow(mainWindow);

    if (isDevelopmentMode) {
        const angularDevServerUrl = 'http://localhost:4241';
        mainWindow.loadURL(angularDevServerUrl);
        mainWindow.webContents.openDevTools();
        logger.info(LogCategory.General, `Dev mode — loading Angular from ${angularDevServerUrl}`);
    } else {
        // In packaged mode, app.getAppPath() points to the asar root (or the unpacked app dir).
        // The Angular production build lives at dist/ui/browser/ relative to that root.
        const appRoot = app.getAppPath();
        const angularDistPath = path.join(appRoot, 'dist', 'ui', 'browser', 'index.html');
        logger.info(LogCategory.General, `Production mode — loading Angular from ${angularDistPath}`);

        const fileExists = fs.existsSync(angularDistPath);
        if (!fileExists) {
            logger.error(LogCategory.General, `Angular dist not found at: ${angularDistPath}`);
            logger.error(LogCategory.General, `App root: ${appRoot}`);
            // Show an error dialog so the user knows what's wrong
            const { dialog } = require('electron');
            dialog.showErrorBox('Fundido Overlays', `Could not find UI files at:\n${angularDistPath}\n\nApp root: ${appRoot}`);
        }

        mainWindow.loadFile(angularDistPath).catch((err: any) => {
            logger.error(LogCategory.General, 'Failed to load Angular dist.', err);
        });
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
        // Close all overlay windows so the app can fully exit
        captureService.stop();
        previewService.stop();
        ocrService.shutdown();
        ollamaService.stop();
        overlayWindowManager.closeAll();
    });

    mainWindow.on('minimize', () => {
        uiMinimizedRef.minimized = true;
        previewService.setPaused(true);
    });
    mainWindow.on('restore', () => {
        uiMinimizedRef.minimized = false;
        const userScale = currentConfigRef.config.preview?.previewScale ?? 0.5;
        previewService.setPreviewScale(userScale);
        previewService.setPaused(false);
    });
    mainWindow.on('focus', () => {
        const userScale = currentConfigRef.config.preview?.previewScale ?? 0.5;
        previewService.setPreviewScale(userScale);
        previewService.setPaused(false);
    });
    mainWindow.on('blur', () => {
        // Don't pause if a picker is active or user is on the Monitored Regions page
        // (regions page needs live preview for region crop previews)
        const pickerIsActive = pickerActiveRef.active;
        const userIsConfiguringRegions = uiActivePageRef.page === 'regions';
        if (!pickerIsActive && !userIsConfiguringRegions) {
            previewService.setPaused(true);
        }
        // Start a 10-second performance diagnostic logging window
        if ((setupCaptureToOverlayPipeline as any).startDiagWindow) {
            (setupCaptureToOverlayPipeline as any).startDiagWindow();
        }
    });

    // Application menu
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'File',
            submenu: [
                { role: 'quit' },
            ],
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Open Log File',
                    click: () => {
                        const logPath = logger.getLogFilePath();
                        if (logPath && fs.existsSync(logPath)) {
                            shell.openPath(logPath);
                        } else {
                            const { dialog } = require('electron');
                            dialog.showMessageBox({ message: 'Log file not found.', type: 'warning' });
                        }
                    },
                },
                {
                    label: 'Open Log Folder',
                    click: () => {
                        const logPath = logger.getLogFilePath();
                        if (logPath) {
                            shell.showItemInFolder(logPath);
                        }
                    },
                },
                { type: 'separator' },
                {
                    label: 'Open Install Location',
                    click: () => {
                        const appPath = app.isPackaged
                            ? path.dirname(app.getPath('exe'))
                            : app.getAppPath();
                        shell.openPath(appPath);
                    },
                },
                {
                    label: 'Open User Data Folder',
                    click: () => {
                        shell.openPath(app.getPath('userData'));
                    },
                },
            ],
        },
    ];

    const appMenu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(appMenu);
}

// ---------------------------------------------------------------------------
// Capture → Preview + State → Overlay pipeline
// ---------------------------------------------------------------------------

/**
 * Returns the set of monitored region IDs that are referenced by at least
 * one enabled overlay group (via rule conditions or regionMirror configs).
 */
function getRegionIdsReferencedByEnabledOverlays(): Set<string> {
    const referencedIds = new Set<string>();
    const overlayGroups = currentConfigRef.config.overlayGroups || [];

    for (const group of overlayGroups) {
        const groupIsDisabled = group.enabled === false;
        if (groupIsDisabled) continue;

        for (const overlay of (group.overlays || [])) {
            // Collect from rules
            for (const rule of (overlay.rules || [])) {
                for (const cond of (rule.conditions || [])) {
                    if (cond.monitoredRegionId) {
                        referencedIds.add(cond.monitoredRegionId);
                    }
                }
            }
            // Collect from regionMirror
            if (overlay.contentType === 'regionMirror' && overlay.regionMirrorConfig?.monitoredRegionId) {
                referencedIds.add(overlay.regionMirrorConfig.monitoredRegionId);
            }
        }
    }

    return referencedIds;
}

// ---------------------------------------------------------------------------
// State calculation throttling and time tracking
// ---------------------------------------------------------------------------

/** Tracks the last evaluation timestamp per calcKey (regionId:calcId). */
const lastCalcTimestamps = new Map<string, number>();

/** Caches the last result for each calcKey so throttled calcs retain their state. */
const lastCalcResults = new Map<string, any>();

/** Caches the last pixel hash per region ID for skip-if-unchanged logic. */
const regionPixelHashCache = new Map<string, number>();

/** Rolling window of time-in-calculation per calcKey. Stores [timestamp, durationMs] pairs. */
const calcTimeWindow = new Map<string, Array<[number, number]>>();
const CALC_TIME_WINDOW_SECONDS = 10;

/** Checks whether a given calc should run based on the configured max frequency. */
function shouldThrottleCalc(calcKey: string, nowMs: number, minIntervalMs: number): boolean {
    const lastRun = lastCalcTimestamps.get(calcKey);
    if (lastRun === undefined) return false;
    const elapsedSinceLastRun = nowMs - lastRun;
    return elapsedSinceLastRun < minIntervalMs;
}

/** Records that a calc ran and how long it took. */
function recordCalcExecution(calcKey: string, nowMs: number, durationMs: number): void {
    lastCalcTimestamps.set(calcKey, nowMs);

    const window = calcTimeWindow.get(calcKey) || [];
    window.push([nowMs, durationMs]);
    // Trim entries older than the window
    const cutoff = nowMs - (CALC_TIME_WINDOW_SECONDS * 1000);
    while (window.length > 0 && window[0][0] < cutoff) {
        window.shift();
    }
    calcTimeWindow.set(calcKey, window);
}

/** Returns the total time spent in a calculation over the last N seconds. */
function getCalcTimeInWindowMs(calcKey: string, nowMs: number): number {
    const window = calcTimeWindow.get(calcKey);
    if (!window) return 0;
    const cutoff = nowMs - (CALC_TIME_WINDOW_SECONDS * 1000);
    let totalMs = 0;
    for (const [ts, dur] of window) {
        if (ts >= cutoff) totalMs += dur;
    }
    return totalMs;
}

/** Holds the most recently captured frame for the slow path to consume. */
const latestFrameRef: { frame: CapturedFrame | null } = { frame: null };

/** Timer handle for the state evaluation loop. */
let stateEvalInterval: ReturnType<typeof setInterval> | null = null;

/**
 * FAST PATH — runs on every captured frame.
 * Only does the absolute minimum: stash the frame, feed preview, and
 * broadcast the raw frame to overlay windows for mirror rendering.
 * No state calculation, no median color, no pixel hashing.
 */
/** Cached display info for the fast path, refreshed when capture starts. */
const captureDisplayCache: {
    originX: number;
    originY: number;
    scaleFactor: number;
} = { originX: 0, originY: 0, scaleFactor: 1 };

function refreshCaptureDisplayCache(): void {
    const captureSourceString = currentConfigRef.config.gameCapture.captureSource;
    const displayIndex = captureSourceString === 'primary' ? 0 : (parseInt(captureSourceString, 10) || 0);
    const allDisplays = require('electron').screen.getAllDisplays();
    const captureDisplay = allDisplays[displayIndex] || allDisplays[0];
    captureDisplayCache.originX = captureDisplay.bounds.x;
    captureDisplayCache.originY = captureDisplay.bounds.y;
    captureDisplayCache.scaleFactor = captureDisplay.scaleFactor || 1;
}

function setupCaptureToOverlayPipeline(): void {
    refreshCaptureDisplayCache();
    let diagFrameCount = 0;
    let lastFrameTimestamp = 0;
    /** Timestamp when diag logging started (on blur). 0 = not logging. */
    let diagLoggingUntil = 0;
    const DIAG_LOGGING_DURATION_MS = 10_000;

    /** Called when the UI loses focus to start a 10-second diagnostic window. */
    (setupCaptureToOverlayPipeline as any).startDiagWindow = () => {
        diagLoggingUntil = Date.now() + DIAG_LOGGING_DURATION_MS;
        logger.info(LogCategory.General, '[PERF DIAG] Starting 10-second capture performance diagnostic window.');
    };

    captureService.setFrameCapturedCallback((frame) => {
        const callbackEntryTime = Date.now();
        const timeSinceLastFrame = lastFrameTimestamp > 0 ? callbackEntryTime - lastFrameTimestamp : 0;
        lastFrameTimestamp = callbackEntryTime;

        perfCounters.captureFrames++;
        diagFrameCount++;
        latestFrameRef.frame = frame;

        // Feed frame to preview service (it has its own throttled interval)
        previewService.onFrameCaptured(frame);

        // FAST PATH: Send raw pixel crops directly to overlay windows for mirror rendering.
        const t0 = Date.now();
        const monitoredRegions = workingRegionsRef.regions ?? currentConfigRef.config.monitoredRegions ?? [];
        overlayWindowManager.broadcastMirrorCrops(
            frame.buffer,
            frame.width,
            frame.height,
            monitoredRegions,
            captureDisplayCache.originX,
            captureDisplayCache.originY,
            captureDisplayCache.scaleFactor,
        );
        const mirrorElapsed = Date.now() - t0;
        const totalCallbackTime = Date.now() - callbackEntryTime;

        const isDiagActive = diagLoggingUntil > 0 && callbackEntryTime <= diagLoggingUntil;
        if (isDiagActive && diagFrameCount % 30 === 0) {
            logger.info(LogCategory.General,
                `[PERF DIAG] gap=${timeSinceLastFrame}ms callback=${totalCallbackTime}ms mirrors=${mirrorElapsed}ms visible=${overlayWindowManager.getVisibleMirrorCount()} frame#${diagFrameCount}`
            );
        }
        // Log a final summary when the window expires
        if (diagLoggingUntil > 0 && callbackEntryTime > diagLoggingUntil) {
            logger.info(LogCategory.General, '[PERF DIAG] Diagnostic window ended.');
            diagLoggingUntil = 0;
        }
    });
}

/**
 * SLOW PATH — runs on a separate timer at maxCalcFrequency.
 * Grabs the latest frame and runs all state calculation logic against it.
 * Completely decoupled from the capture rate.
 */
function startStateEvaluationLoop(): void {
    if (stateEvalInterval) return;

    const runStateEvaluation = () => {
        const frame = latestFrameRef.frame;
        if (!frame) return;

        const pipelineStartTime = Date.now();

        // Use working regions from the UI if available, otherwise fall back to saved config.
        const allMonitoredRegions = workingRegionsRef.regions ?? currentConfigRef.config.monitoredRegions;

        // --- Region filtering rules ---
        const enabledRegions = allMonitoredRegions.filter((region: any) => region.enabled !== false);

        const userIsActivelyConfiguringRegions = uiActivePageRef.page === 'regions' && !uiMinimizedRef.minimized;
        let monitoredRegions: any[];
        if (userIsActivelyConfiguringRegions) {
            monitoredRegions = enabledRegions;
        } else {
            const referencedRegionIds = getRegionIdsReferencedByEnabledOverlays();
            monitoredRegions = enabledRegions.filter(
                (region: any) => referencedRegionIds.has(region.id)
            );
        }

        if (monitoredRegions.length === 0) {
            perfCounters.pipelineTotalMs += Date.now() - pipelineStartTime;
            perfCounters.pipelineSamples++;
            return;
        }

        // --- Throttle state calculations ---
        const maxCalcFrequency = currentConfigRef.config.maxCalcFrequency ?? 10;
        const minCalcIntervalMs = Math.round(1000 / maxCalcFrequency);
        const nowMs = Date.now();

        // Convert to physical pixel coordinates
        const captureSourceString = currentConfigRef.config.gameCapture.captureSource;
        const displayIndex = captureSourceString === 'primary' ? 0 : (parseInt(captureSourceString, 10) || 0);
        const allDisplays = require('electron').screen.getAllDisplays();
        const captureDisplay = allDisplays[displayIndex] || allDisplays[0];
        const displayOriginX = captureDisplay.bounds.x;
        const displayOriginY = captureDisplay.bounds.y;
        const dpiScaleFactor = captureDisplay.scaleFactor || 1;

        // Keep the fast path's display cache fresh
        captureDisplayCache.originX = displayOriginX;
        captureDisplayCache.originY = displayOriginY;
        captureDisplayCache.scaleFactor = dpiScaleFactor;

        const physicalBoundsRegions = monitoredRegions.map((region: any) => ({
            ...region,
            bounds: {
                x: Math.round((region.bounds.x - displayOriginX) * dpiScaleFactor),
                y: Math.round((region.bounds.y - displayOriginY) * dpiScaleFactor),
                width: Math.round(region.bounds.width * dpiScaleFactor),
                height: Math.round(region.bounds.height * dpiScaleFactor),
            },
        }));

        // Compute pixel hash per region for skip-if-unchanged
        const regionPixelHashes = new Map<string, number>();
        for (const region of physicalBoundsRegions) {
            const currentHash = computeRegionPixelHash(frame, region.bounds);
            regionPixelHashes.set(region.id, currentHash);
        }

        // Build throttled copies: filter out calcs that are rate-limited or unchanged
        const throttledRegions = physicalBoundsRegions.map((region: any) => {
            const previousHash = regionPixelHashCache.get(region.id);
            const currentHash = regionPixelHashes.get(region.id)!;
            const regionIsUnchanged = previousHash !== undefined && previousHash === currentHash;

            const allowedCalcs = (region.stateCalculations || []).filter((calc: any) => {
                const calcKey = `${region.id}:${calc.id}`;
                const isRateLimited = shouldThrottleCalc(calcKey, nowMs, minCalcIntervalMs);
                if (isRateLimited) return false;
                const shouldSkip = calc.skipIfUnchanged === true && regionIsUnchanged;
                const ollamaSkip = calc.type === 'OllamaLLM'
                    && calc.ollamaConfig?.skipIfUnchanged !== false
                    && regionIsUnchanged;
                if (shouldSkip || ollamaSkip) return false;
                return true;
            });
            return { ...region, stateCalculations: allowedCalcs };
        });

        // Update pixel hash cache
        for (const [regionId, hash] of regionPixelHashes) {
            regionPixelHashCache.set(regionId, hash);
        }

        // Count calc types for metrics
        let medianColorCalcCount = 0;
        let colorThresholdCalcCount = 0;
        let ocrCalcCount = 0;
        let ollamaCalcCount = 0;
        for (const region of throttledRegions) {
            let regionMedian = 0;
            let regionThreshold = 0;
            let regionOcr = 0;
            let regionOllama = 0;
            for (const calc of (region.stateCalculations || [])) {
                if (calc.type === 'MedianPixelColor') { medianColorCalcCount++; regionMedian++; }
                else if (calc.type === 'ColorThreshold') { colorThresholdCalcCount++; regionThreshold++; }
                else if (calc.type === 'OCR') { ocrCalcCount++; regionOcr++; }
                else if (calc.type === 'OllamaLLM') { ollamaCalcCount++; regionOllama++; }
            }
            const existing = perfCounters.regionCalcs.get(region.id) || { medianColor: 0, colorThreshold: 0, ocr: 0, ollama: 0 };
            existing.medianColor += regionMedian;
            existing.colorThreshold += regionThreshold;
            existing.ocr += regionOcr;
            existing.ollama += regionOllama;
            perfCounters.regionCalcs.set(region.id, existing);
        }
        perfCounters.medianColorCalcs += medianColorCalcCount;
        perfCounters.colorThresholdCalcs += colorThresholdCalcCount;
        perfCounters.ocrCalcs += ocrCalcCount;
        perfCounters.ollamaCalcs += ollamaCalcCount;
        perfCounters.activeRegionCount = monitoredRegions.length;

        const enabledOverlayGroups = (currentConfigRef.config.overlayGroups || []).filter((g: any) => g.enabled !== false);
        perfCounters.activeOverlayGroupCount = enabledOverlayGroups.length;

        const physicalRegions = throttledRegions;

        // Feed the frame and region config to the OCR and Ollama services
        ocrService.onFrameCaptured(frame);
        ocrService.setRegions(physicalRegions);
        ollamaService.onFrameCaptured(frame);
        ollamaService.setRegions(physicalRegions);

        // Evaluate state
        const evalStartMs = Date.now();
        const frameState = evaluateFrameState(frame, physicalRegions, ocrService.getAllResults(), ollamaService.getAllResults());
        const evalDurationMs = Date.now() - evalStartMs;

        // Cache fresh results and merge in cached results for throttled calcs
        for (const regionState of frameState.regionStates) {
            for (const calcResult of regionState.calculationResults) {
                const calcKey = `${regionState.monitoredRegionId}:${calcResult.stateCalculationId}`;
                lastCalcResults.set(calcKey, calcResult);
            }

            const originalRegion = monitoredRegions.find((r: any) => r.id === regionState.monitoredRegionId);
            const throttledRegion = throttledRegions.find((r: any) => r.id === regionState.monitoredRegionId);
            if (originalRegion && throttledRegion) {
                const evaluatedCalcIds = new Set((throttledRegion.stateCalculations || []).map((c: any) => c.id));
                for (const calc of (originalRegion.stateCalculations || [])) {
                    const calcWasThrottled = !evaluatedCalcIds.has(calc.id);
                    if (calcWasThrottled) {
                        const calcKey = `${regionState.monitoredRegionId}:${calc.id}`;
                        const cachedResult = lastCalcResults.get(calcKey);
                        if (cachedResult) {
                            regionState.calculationResults.push(cachedResult);
                        }
                    }
                }
            }
        }

        // Record execution timestamps and time-in-calc
        for (const region of throttledRegions) {
            for (const calc of (region.stateCalculations || [])) {
                const calcKey = `${region.id}:${calc.id}`;
                const totalCalcCount = medianColorCalcCount + colorThresholdCalcCount + ocrCalcCount + ollamaCalcCount;
                const perCalcDurationMs = totalCalcCount > 0 ? evalDurationMs / totalCalcCount : 0;
                recordCalcExecution(calcKey, nowMs, perCalcDurationMs);
            }
        }
        perfCounters.stateEvals++;

        // Push state to overlay windows (separate from frame delivery)
        overlayWindowManager.broadcastFrameState(frameState);

        // Push state to the Angular UI
        const uiIsVisible = !uiMinimizedRef.minimized && mainWindow && !mainWindow.isDestroyed();
        if (uiIsVisible) {
            mainWindow!.webContents.send(IpcChannels.STATE_UPDATED, frameState);
        }

        perfCounters.pipelineTotalMs += Date.now() - pipelineStartTime;
        perfCounters.pipelineSamples++;
    };

    // Run the state evaluation loop at the configured frequency
    const maxCalcFrequency = currentConfigRef.config.maxCalcFrequency ?? 10;
    const intervalMs = Math.round(1000 / maxCalcFrequency);
    stateEvalInterval = setInterval(runStateEvaluation, intervalMs);
}

function stopStateEvaluationLoop(): void {
    if (stateEvalInterval) {
        clearInterval(stateEvalInterval);
        stateEvalInterval = null;
    }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
    logger.initFileLogging();
    logger.info(LogCategory.General, 'Fundido Overlays starting up.');

    registerIpcHandlers(configService, captureService, previewService, overlayWindowManager, ocrService, ollamaService, currentConfigRef, workingRegionsRef, globalEnabledRef, pickerActiveRef);

    ipcMain.on(IpcChannels.UI_ACTIVE_PAGE, (_event: any, page: string) => {
        uiActivePageRef.page = page;
    });

    createMainWindow();
    setupCaptureToOverlayPipeline();
    startStateEvaluationLoop();
    startPerfMetricsReporting();

    // Preview frames go to overlay windows for mirror rendering (fast path)
    previewService.setOnPreviewFrameSent((previewData) => {
        perfCounters.previewFrames++;
        const monitoredRegions = workingRegionsRef.regions ?? currentConfigRef.config.monitoredRegions ?? [];
        overlayWindowManager.broadcastPreviewFrame(previewData, monitoredRegions);
    });

    // Create overlay windows for any groups defined in the saved config
    overlayWindowManager.syncOverlayWindows(currentConfigRef.config.overlayGroups);

    // Auto-start capture if it was running when the app last closed
    const shouldAutoStartCapture = currentConfigRef.config.gameCapture.captureEnabled === true;
    if (shouldAutoStartCapture) {
        logger.info(LogCategory.General, 'Auto-starting capture (was enabled on last exit).');
        const captureConfig = currentConfigRef.config.gameCapture;
        captureService.start(captureConfig);

        const captureSourceString = captureConfig.captureSource;
        const displayIndex = captureSourceString === 'primary' ? 0 : (parseInt(captureSourceString, 10) || 0);
        previewService.setCaptureDisplayIndex(displayIndex);
        previewService.start(currentConfigRef.config.preview, currentConfigRef.config.preview.previewFps ?? 10);
        ocrService.start(currentConfigRef.config.ocr);
        ollamaService.start(currentConfigRef.config.ollama);
    }
});

app.on('window-all-closed', () => {
    logger.info(LogCategory.General, 'All windows closed — shutting down.');
    stopStateEvaluationLoop();
    stopPerfMetricsReporting();
    captureService.stop();
    previewService.stop();
    ocrService.shutdown();
    ollamaService.stop();
    overlayWindowManager.closeAll();
    app.quit();
});

app.on('before-quit', () => {
    configService.save(currentConfigRef.config);
    logger.info(LogCategory.General, 'Configuration saved on exit.');
    logger.shutdown();
});