import { app, BrowserWindow, screen, Menu, shell, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { ConfigPersistenceService } from './persistence/config-persistence.service';
import { GameCaptureService, CapturedFrame } from './capture/game-capture.service';
import { PreviewFrameService } from './capture/preview-frame.service';
import { OverlayWindowManager } from './overlay/overlay-window-manager';
import { DirtyRegionOverlayManager } from './overlay/dirty-region-overlay-manager';
import { evaluateFrameState } from './state/state-calculation.service';
import { OcrService } from './state/ocr.service';
import { OllamaService } from './state/ollama.service';
import { SoundLibraryService } from './sound/sound-library.service';
import { registerIpcHandlers } from './ipc/ipc-handlers';
import { logger, LogCategory, WorkerLogMessage } from './shared/logger';
import { computeRegionPixelHash } from './shared/pixel-hash';
import {
  applyProfileRulesToConfig,
  FundidoConfig,
  getProfileActivatedOverlayGroups,
  getRegionIdsReferencedByProfileRules,
  getRuntimeMonitoredRegions,
  PreviewConfig,
} from './shared';
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
const dirtyRegionOverlayManager = new DirtyRegionOverlayManager();
const ocrService = new OcrService();
const ollamaService = new OllamaService();
const soundLibraryService = new SoundLibraryService();

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

type PreviewUsageMode = 'capture' | 'regions' | 'inactive';

function getRequestedPreviewConfig(): PreviewConfig {
  return currentConfigRef.config.preview ?? {
    previewScale: 0.5,
    downsampleMethod: 'nearestNeighbor',
    jpegQuality: 60,
    previewFps: 12,
  };
}

function buildEffectivePreviewConfig(userConfig: PreviewConfig, mode: PreviewUsageMode): PreviewConfig {
  if (mode === 'capture') {
    return {
      ...userConfig,
      previewScale: Math.min(userConfig.previewScale ?? 0.75, 0.75),
      downsampleMethod: userConfig.downsampleMethod === 'bilinear' ? 'nearestNeighbor' : userConfig.downsampleMethod,
      jpegQuality: Math.min(userConfig.jpegQuality ?? 60, 60),
    };
  }

  return {
    ...userConfig,
    previewScale: Math.min(userConfig.previewScale ?? 0.45, 0.45),
    downsampleMethod: 'skip',
    jpegQuality: Math.min(userConfig.jpegQuality ?? 45, 45),
  };
}

function resolvePreviewUsageMode(): PreviewUsageMode {
  if (!mainWindow || mainWindow.isDestroyed()) return 'inactive';
  if (!captureService.getIsCapturing()) return 'inactive';
  if (uiMinimizedRef.minimized) return 'inactive';

  if (pickerActiveRef.active) return 'regions';

  if (uiActivePageRef.page === 'regions' || uiActivePageRef.page === 'profiles') return 'regions';
  if (uiActivePageRef.page === 'capture' && mainWindow.isFocused()) return 'capture';
  return 'inactive';
}

function syncPreviewRuntimeState(): void {
  const userConfig = getRequestedPreviewConfig();
  const mode = resolvePreviewUsageMode();
  const effectiveConfig = buildEffectivePreviewConfig(userConfig, mode);

  let effectiveFps = userConfig.previewFps ?? 10;
  if (mode === 'capture') {
    effectiveFps = Math.min(effectiveFps, 12);
  } else if (mode === 'regions') {
    effectiveFps = Math.min(effectiveFps, 6);
  } else {
    effectiveFps = Math.min(effectiveFps, 8);
  }

  previewService.updateRuntimeConfig(effectiveConfig, effectiveFps, mode);
  previewService.setPaused(mode === 'inactive');
}

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
      const runtimeRegionId = calcKey.split(':')[0];
      const regionId = latestRuntimeRegionIdToSourceRegionId.get(runtimeRegionId) || runtimeRegionId;
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
let allowMainWindowClose = false;
let pendingCloseRequest = false;

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

  ipcMain.on(IpcChannels.APP_CLOSE_RESPONSE, (_event, allowClose: boolean) => {
    pendingCloseRequest = false;
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    if (allowClose) {
      allowMainWindowClose = true;
      mainWindow.close();
      return;
    }

    allowMainWindowClose = false;
    mainWindow.focus();
  });

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
    allowMainWindowClose = false;
    pendingCloseRequest = false;
    mainWindow = null;
    // Close all overlay windows so the app can fully exit
    captureService.stop();
    previewService.stop();
    ocrService.shutdown();
    ollamaService.stop();
    overlayWindowManager.closeAll();
    dirtyRegionOverlayManager.closeAll();
  });

  mainWindow.on('minimize', () => {
    uiMinimizedRef.minimized = true;
    syncPreviewRuntimeState();
  });
  mainWindow.on('restore', () => {
    uiMinimizedRef.minimized = false;
    syncPreviewRuntimeState();
  });
  mainWindow.on('focus', () => {
    syncPreviewRuntimeState();
  });
  mainWindow.on('blur', () => {
    syncPreviewRuntimeState();
    startPerfDiagWindow();
  });

  mainWindow.on('close', (event) => {
    if (allowMainWindowClose) {
      return;
    }

    if (pendingCloseRequest) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    pendingCloseRequest = true;
    mainWindow?.webContents.send(IpcChannels.APP_CLOSE_REQUESTED);
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
  const overlayGroups = getProfileActivatedOverlayGroups(currentConfigRef.config);

  for (const group of overlayGroups) {
    const groupIsDisabled = group.enabled === false;
    if (groupIsDisabled) continue;

    // Collect from group-level rules
    for (const rule of ((group as any).rules || [])) {
      for (const cond of (rule.conditions || [])) {
        if (cond.monitoredRegionId) {
          referencedIds.add(cond.monitoredRegionId);
        }
      }
    }

    for (const overlay of (group.overlays || [])) {
      // Collect from overlay rules
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

function getRegionIdsRequiredForRuntimeAutomation(): Set<string> {
  const referencedIds = getRegionIdsReferencedByEnabledOverlays();
  for (const regionId of getRegionIdsReferencedByProfileRules(currentConfigRef.config)) {
    referencedIds.add(regionId);
  }
  return referencedIds;
}

function applyProfileRuleResults(frameState: any): void {
  const profileStateChanged = applyProfileRulesToConfig(currentConfigRef.config, frameState);
  frameState.profileStates = (currentConfigRef.config.profiles || []).map((profile) => ({
    id: profile.id,
    active: profile.active,
  }));

  if (!profileStateChanged) {
    return;
  }

  overlayWindowManager.syncOverlayWindows(
    getProfileActivatedOverlayGroups(currentConfigRef.config),
    currentConfigRef.config.soundVolume ?? 0.5,
  );
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

/**
 * Remaining forced-evaluation passes per region after a pixel hash change.
 * Mirrors the same countdown used in the state-eval worker. See that file for
 * the full explanation of why this is needed.
 */
const regionPostChangeEvalCountdown = new Map<string, number>();
const FALLBACK_EXTRA_EVAL_PASSES_AFTER_CHANGE = 2;

/**
 * Computes the required post-change evaluation window for a region.
 * Mirrors the same function in state-eval.worker.ts — see that file for the
 * full explanation. Short version:
 *   - ColorThreshold calcs with consecutiveRequired > N need at least N forced
 *     passes on a stable pixel or the consecutive counter never reaches its target.
 *   - OCR calcs with minDurationMs > 0 need the window to stay open long enough
 *     for the OCR service to accumulate the full duration. The OCR service is fed
 *     the throttled region list, so if skipIfUnchanged fires too early the duration
 *     clock stalls and the state never transitions.
 *
 * @param evalIntervalMs  The effective per-region evaluation interval — used to
 *                        convert OCR minDurationMs into a pass count.
 */
function computePostChangeEvalPassesForRegion(region: any, basePasses: number, evalIntervalMs: number): number {
  let requiredPasses = basePasses;
  for (const calc of (region.stateCalculations || [])) {
    if (calc.type === 'ColorThreshold') {
      for (const mapping of (calc.colorThresholdMappings || [])) {
        const consecutiveRequired = (mapping.consecutiveRequired as number) || 1;
        if (consecutiveRequired > requiredPasses) {
          requiredPasses = consecutiveRequired;
        }
      }
    } else if (calc.type === 'OCR') {
      for (const mapping of (calc.substringMappings || [])) {
        const minDurationMs = (mapping.minDurationMs as number) || 0;
        if (minDurationMs > 0) {
          const passesNeededForDuration = Math.ceil(minDurationMs / evalIntervalMs);
          if (passesNeededForDuration > requiredPasses) {
            requiredPasses = passesNeededForDuration;
          }
        }
      }
    }
  }
  return requiredPasses;
}

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

function getRegionEvaluationIntervalMs(region: any, globalMinCalcIntervalMs: number): number {
  const regionIntervalMs = Number(region.evaluationIntervalMs);
  if (Number.isFinite(regionIntervalMs) && regionIntervalMs > 0) {
    return Math.max(20, Math.round(regionIntervalMs));
  }

  return globalMinCalcIntervalMs;
}

function getStateEvaluationLoopIntervalMs(): number {
  const maxCalcFrequency = currentConfigRef.config.maxCalcFrequency ?? 10;
  const globalIntervalMs = Math.round(1000 / maxCalcFrequency);
  const regions = workingRegionsRef.regions ?? currentConfigRef.config.monitoredRegions ?? [];
  let fastestIntervalMs = globalIntervalMs;

  for (const region of regions) {
    if (region.enabled === false) {
      continue;
    }

    const regionIntervalMs = Number(region.evaluationIntervalMs);
    if (Number.isFinite(regionIntervalMs) && regionIntervalMs > 0) {
      fastestIntervalMs = Math.min(fastestIntervalMs, Math.max(20, Math.round(regionIntervalMs)));
    }
  }

  return fastestIntervalMs;
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

/**
 * Tracks when the last STATE_UPDATED IPC message was sent to the renderer UI.
 * State eval may run at 30-50Hz for responsive overlay control, but the UI
 * only needs ~10Hz — profiles, regions, and overlay rule displays don't
 * require faster than that. Overlays get their updates via a separate path
 * (overlayWindowManager.broadcastFrameState) which is unaffected by this.
 */
let lastStateUpdateSentToUiAt = 0;
const STATE_UPDATE_UI_RATE_HZ = 10;
const stateUpdateUiMinIntervalMs = Math.round(1000 / STATE_UPDATE_UI_RATE_HZ);

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

function getDirtyMonitoredRegionIds(workingRegions: any[] | null, savedRegions: any[] | undefined): Set<string> {
  if (!workingRegions || !savedRegions) {
    return new Set<string>();
  }

  const savedById = new Map<string, string>(
    savedRegions.map((region: any) => [region.id, JSON.stringify(region)])
  );
  const dirtyIds = new Set<string>();

  for (const region of workingRegions) {
    const savedSnapshot = savedById.get(region.id);
    if (savedSnapshot === undefined || savedSnapshot !== JSON.stringify(region)) {
      dirtyIds.add(region.id);
    }
  }

  return dirtyIds;
}

function applyLastKnownValueFallbacks(
  calculationResults: any[],
  runtimeRegion: any,
  runtimeRegionId: string,
): void {
  for (const calcResult of calculationResults) {
    if (calcResult.currentValue !== '') {
      continue;
    }

    const calc = (runtimeRegion.stateCalculations || []).find((c: any) => c.id === calcResult.stateCalculationId);
    if (calc?.defaultValueMode !== 'lastKnownValue') {
      continue;
    }

    const lastKnownResult = lastCalcResults.get(`${runtimeRegionId}:${calc.id}`);
    if (lastKnownResult?.currentValue) {
      calcResult.currentValue = lastKnownResult.currentValue;
    }
  }
}

/** Timestamp when performance diagnostic logging should stop. 0 = inactive. */
let perfDiagEndTime = 0;
const PERF_DIAG_DURATION_MS = 10_000;

function startPerfDiagWindow(): void {
  perfDiagEndTime = Date.now() + PERF_DIAG_DURATION_MS;
  logger.info(LogCategory.General, '[PERF DIAG] Starting 10-second capture performance diagnostic window.');
}

function setupCaptureToOverlayPipeline(): void {
  refreshCaptureDisplayCache();
  let diagFrameCount = 0;
  let lastFrameTimestamp = 0;

  captureService.setFrameCapturedCallback((frame) => {
    const callbackEntryTime = Date.now();
    const timeSinceLastFrame = lastFrameTimestamp > 0 ? callbackEntryTime - lastFrameTimestamp : 0;

    // Throttle to the configured target FPS. The native addon pushes frames at the
    // display refresh rate regardless of this setting, so we drop frames here when
    // they arrive faster than the target interval. Reading the config each callback
    // means setting changes take effect immediately without restarting capture.
    const targetFps = currentConfigRef.config.gameCapture?.targetFps ?? 30;
    const minFrameIntervalMs = 1000 / targetFps;
    const frameArrivedBeforeTargetInterval = lastFrameTimestamp > 0 && timeSinceLastFrame < minFrameIntervalMs;
    if (frameArrivedBeforeTargetInterval) {
      return;
    }

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

    // Performance diagnostic logging — only active for 10s after UI loses focus
    const isDiagActive = perfDiagEndTime > 0 && callbackEntryTime <= perfDiagEndTime;
    if (isDiagActive && diagFrameCount % 30 === 0) {
      logger.info(LogCategory.General,
        `[PERF DIAG] gap=${timeSinceLastFrame}ms callback=${totalCallbackTime}ms mirrors=${mirrorElapsed}ms visible=${overlayWindowManager.getVisibleMirrorCount()} frame#${diagFrameCount}`
      );
    }
    if (perfDiagEndTime > 0 && callbackEntryTime > perfDiagEndTime) {
      logger.info(LogCategory.General, '[PERF DIAG] Diagnostic window ended.');
      perfDiagEndTime = 0;
    }
  });
}

/**
 * SLOW PATH — state evaluation runs in a worker thread.
 * The main thread sends frame data + config to the worker on a timer.
 * The worker does all CPU-intensive work (pixel hashing, median color, evaluateFrameState).
 * Results are posted back to the main thread for IPC broadcasting.
 */
let stateEvalWorker: Worker | null = null;
let workerBusy = false;
let latestEvaluatedRuntimeRegions: any[] = [];
const latestRuntimeRegionIdToSourceRegionId = new Map<string, string>();

function fallbackFromWorkerFailure(error: unknown): void {
  workerBusy = false;
  logger.error(LogCategory.General, 'State eval worker error — falling back to main thread.', error);

  if (stateEvalInterval) {
    clearInterval(stateEvalInterval);
    stateEvalInterval = null;
  }

  if (stateEvalWorker) {
    const workerToTerminate = stateEvalWorker;
    stateEvalWorker = null;
    workerToTerminate.removeAllListeners();
    workerToTerminate.terminate().catch(() => {
      // Ignore termination failures during fallback cleanup.
    });
  }

  startStateEvaluationLoopFallback();
}

function startStateEvaluationLoop(): void {
  if (stateEvalInterval) return;

  // Resolve the worker path — in dev it's the .ts compiled to .js in dist/electron
  const workerPath = path.join(__dirname, 'state', 'state-eval.worker.js');
  logger.info(LogCategory.General, `Starting state evaluation worker: ${workerPath}`);

  try {
    stateEvalWorker = new Worker(workerPath);
  } catch (err) {
    logger.error(LogCategory.General, 'Failed to start state eval worker — falling back to main thread.', err);
    startStateEvaluationLoopFallback();
    return;
  }

  stateEvalWorker.on('message', (result: any) => {
    if (result.type === 'worker-log') {
      logger.logFromWorker((result as WorkerLogMessage).entry);
      return;
    }
    if (result.type !== 'result') return;
    workerBusy = false;

    const frameState = result.frameState;
    const evalDurationMs = result.evalDurationMs;
    const metrics = result.metrics;

    // Cache fresh results and merge cached results for throttled calcs
    const instanceStates = frameState.regionInstanceStates || frameState.regionStates;
    for (const regionState of instanceStates as any[]) {
      const runtimeRegionId = regionState.runtimeMonitoredRegionId || regionState.monitoredRegionId;
      const runtimeRegion = latestEvaluatedRuntimeRegions.find((r: any) => r.id === runtimeRegionId);
      if (runtimeRegion) {
        applyLastKnownValueFallbacks(regionState.calculationResults, runtimeRegion, runtimeRegionId);
      }
      for (const calcResult of regionState.calculationResults) {
        const calcKey = `${runtimeRegionId}:${calcResult.stateCalculationId}`;
        lastCalcResults.set(calcKey, calcResult);
      }

      // Inject cached results for calcs the worker throttled
      const evaluatedCalcIds = new Set(
        (result.throttledCalcIdsByRegion[runtimeRegionId] || [])
      );
      if (runtimeRegion) {
        for (const calc of (runtimeRegion.stateCalculations || [])) {
          const calcWasThrottled = !evaluatedCalcIds.has(calc.id);
          if (calcWasThrottled) {
            const calcKey = `${runtimeRegionId}:${calc.id}`;
            const cachedResult = lastCalcResults.get(calcKey);
            if (cachedResult) {
              regionState.calculationResults.push(cachedResult);
            }
          }
        }
      }
    }

    // Record per-calc timing
    const nowMs = Date.now();
    const totalCalcCount = metrics.medianColorCalcCount + metrics.colorThresholdCalcCount + metrics.ocrCalcCount + metrics.ollamaCalcCount;
    const perCalcDurationMs = totalCalcCount > 0 ? evalDurationMs / totalCalcCount : 0;
    for (const regionId of result.throttledRegionIds) {
      const calcIds = result.throttledCalcIdsByRegion[regionId] || [];
      for (const calcId of calcIds) {
        recordCalcExecution(`${regionId}:${calcId}`, nowMs, perCalcDurationMs);
      }
    }

    // Update perf counters
    perfCounters.medianColorCalcs += metrics.medianColorCalcCount;
    perfCounters.colorThresholdCalcs += metrics.colorThresholdCalcCount;
    perfCounters.ocrCalcs += metrics.ocrCalcCount;
    perfCounters.ollamaCalcs += metrics.ollamaCalcCount;
    for (const [regionId, counts] of Object.entries(metrics.regionCalcCounts) as any) {
      const existing = perfCounters.regionCalcs.get(regionId) || { medianColor: 0, colorThreshold: 0, ocr: 0, ollama: 0 };
      existing.medianColor += counts.medianColor;
      existing.colorThreshold += counts.colorThreshold;
      existing.ocr += counts.ocr;
      existing.ollama += counts.ollama;
      perfCounters.regionCalcs.set(regionId, existing);
    }
    perfCounters.stateEvals++;
    perfCounters.pipelineTotalMs += evalDurationMs;
    perfCounters.pipelineSamples++;

    // Broadcast to overlay windows and UI
    applyProfileRuleResults(frameState);
    overlayWindowManager.broadcastFrameState(frameState);
    const uiIsVisible = !uiMinimizedRef.minimized && mainWindow && !mainWindow.isDestroyed();
    if (uiIsVisible) {
      const nowMs = Date.now();
      const uiUpdateIsOverdue = nowMs - lastStateUpdateSentToUiAt >= stateUpdateUiMinIntervalMs;
      if (uiUpdateIsOverdue) {
        lastStateUpdateSentToUiAt = nowMs;
        mainWindow!.webContents.send(IpcChannels.STATE_UPDATED, frameState);
      }
    }
  });

  stateEvalWorker.on('error', (err) => {
    fallbackFromWorkerFailure(err);
  });

  const sendEvalRequest = () => {
    if (workerBusy || !stateEvalWorker) return;

    const frame = latestFrameRef.frame;
    if (!frame) return;

    // Region filtering (stays on main thread — needs access to config refs)
    const allMonitoredRegions = workingRegionsRef.regions ?? currentConfigRef.config.monitoredRegions;
    const enabledRegions = allMonitoredRegions.filter((region: any) => region.enabled !== false);

    const userIsActivelyConfiguringRegions =
      (uiActivePageRef.page === 'regions' || uiActivePageRef.page === 'profiles') && !uiMinimizedRef.minimized;
    let monitoredRegions: any[];
    if (userIsActivelyConfiguringRegions) {
      monitoredRegions = enabledRegions;
    } else {
      const referencedRegionIds = getRegionIdsRequiredForRuntimeAutomation();
      monitoredRegions = enabledRegions.filter(
        (region: any) => referencedRegionIds.has(region.id)
      );
    }

    if (monitoredRegions.length === 0) return;

    const runtimeRegions = getRuntimeMonitoredRegions(monitoredRegions);
    if (runtimeRegions.length === 0) return;
    const dirtyRegionIds = getDirtyMonitoredRegionIds(
      workingRegionsRef.regions,
      currentConfigRef.config.monitoredRegions,
    );
    latestEvaluatedRuntimeRegions = runtimeRegions;
    latestRuntimeRegionIdToSourceRegionId.clear();
    for (const runtimeRegion of runtimeRegions) {
      latestRuntimeRegionIdToSourceRegionId.set(runtimeRegion.id, runtimeRegion.sourceMonitoredRegionId);
    }

    perfCounters.activeRegionCount = runtimeRegions.length;
    const enabledOverlayGroups = getProfileActivatedOverlayGroups(currentConfigRef.config).filter((g: any) => g.enabled !== false);
    perfCounters.activeOverlayGroupCount = enabledOverlayGroups.length;

    // Convert to physical pixel coordinates using the cached display metrics.
    // captureDisplayCache is populated at startup and refreshed whenever the
    // capture source changes — no need to call getDisplayMetrics() here.
    const displayOriginX = captureDisplayCache.originX;
    const displayOriginY = captureDisplayCache.originY;
    const dpiScaleFactor = captureDisplayCache.scaleFactor;

    const physicalBoundsRegions = runtimeRegions.map((region: any) => ({
      ...region,
      alwaysEvaluate: dirtyRegionIds.has(region.sourceMonitoredRegionId ?? region.id),
      bounds: {
        x: Math.round((region.bounds.x - displayOriginX) * dpiScaleFactor),
        y: Math.round((region.bounds.y - displayOriginY) * dpiScaleFactor),
        width: Math.round(region.bounds.width * dpiScaleFactor),
        height: Math.round(region.bounds.height * dpiScaleFactor),
      },
    }));

    // Feed OCR/Ollama services (these stay on main thread — they have their own async loops)
    ocrService.onFrameCaptured(frame);
    ocrService.setRegions(physicalBoundsRegions);
    ollamaService.onFrameCaptured(frame);
    ollamaService.setRegions(physicalBoundsRegions);

    // Send to worker — transfer the frame buffer instead of structured-cloning it.
    //
    // Structured clone (the postMessage default) would copy the entire 8MB+ pixel
    // buffer across the thread boundary. The worker then called Buffer.from() on the
    // received Buffer, producing a second copy. Two full-frame copies per state eval.
    //
    // Fix: slice() the backing ArrayBuffer once to produce a standalone, transferable
    // copy. Passing it in the transferList moves ownership to the worker in O(1) with
    // no further copy. In the worker, Buffer.from(ArrayBuffer) wraps the memory
    // in-place — so we go from 2 copies down to 1.
    //
    // We use slice() rather than transferring frame.buffer.buffer directly because
    // the main thread still holds references to the same buffer (previewService, etc.)
    // and detaching it would corrupt those reads.
    // slice() is typed as returning ArrayBuffer | SharedArrayBuffer, but frame.buffer
    // is always backed by a plain ArrayBuffer — the cast is safe here.
    const frameArrayBufferForWorker = frame.buffer.buffer.slice(
      frame.buffer.byteOffset,
      frame.buffer.byteOffset + frame.buffer.byteLength,
    ) as ArrayBuffer;

    workerBusy = true;
    stateEvalWorker!.postMessage(
      {
        type: 'evaluate',
        frameBuffer: frameArrayBufferForWorker,
        frameWidth: frame.width,
        frameHeight: frame.height,
        frameCapturedAt: frame.capturedAt,
        physicalBoundsRegions,
        monitoredRegions: runtimeRegions,
        throttleConfig: {
          maxCalcFrequency: currentConfigRef.config.maxCalcFrequency ?? 10,
          lastCalcTimestamps: {},
          regionPixelHashCache: {},
        },
        ocrResults: Array.from(ocrService.getAllResults().entries()),
        ollamaResults: Array.from(ollamaService.getAllResults().entries()),
      },
      [frameArrayBufferForWorker], // transfer list — moves ownership, no structured clone
    );
  };

  stateEvalInterval = setInterval(sendEvalRequest, getStateEvaluationLoopIntervalMs());
}

/**
 * Fallback: runs state evaluation on the main thread if the worker fails to start.
 */
function startStateEvaluationLoopFallback(): void {
  const runStateEvaluation = () => {
    const frame = latestFrameRef.frame;
    if (!frame) return;

    const pipelineStartTime = Date.now();
    const allMonitoredRegions = workingRegionsRef.regions ?? currentConfigRef.config.monitoredRegions;
    const enabledRegions = allMonitoredRegions.filter((region: any) => region.enabled !== false);

    const userIsActivelyConfiguringRegions =
      (uiActivePageRef.page === 'regions' || uiActivePageRef.page === 'profiles') && !uiMinimizedRef.minimized;
    let monitoredRegions: any[];
    if (userIsActivelyConfiguringRegions) {
      monitoredRegions = enabledRegions;
    } else {
      const referencedRegionIds = getRegionIdsRequiredForRuntimeAutomation();
      monitoredRegions = enabledRegions.filter((region: any) => referencedRegionIds.has(region.id));
    }

    if (monitoredRegions.length === 0) return;

    const runtimeRegions = getRuntimeMonitoredRegions(monitoredRegions);
    if (runtimeRegions.length === 0) return;
    const dirtyRegionIds = getDirtyMonitoredRegionIds(
      workingRegionsRef.regions,
      currentConfigRef.config.monitoredRegions,
    );
    latestEvaluatedRuntimeRegions = runtimeRegions;
    latestRuntimeRegionIdToSourceRegionId.clear();
    for (const runtimeRegion of runtimeRegions) {
      latestRuntimeRegionIdToSourceRegionId.set(runtimeRegion.id, runtimeRegion.sourceMonitoredRegionId);
    }

    const maxCalcFrequency = currentConfigRef.config.maxCalcFrequency ?? 10;
    const minCalcIntervalMs = Math.round(1000 / maxCalcFrequency);
    const nowMs = Date.now();

    const physicalBoundsRegions = runtimeRegions.map((region: any) => ({
      ...region,
      alwaysEvaluate: dirtyRegionIds.has(region.sourceMonitoredRegionId ?? region.id),
      bounds: {
        x: Math.round((region.bounds.x - captureDisplayCache.originX) * captureDisplayCache.scaleFactor),
        y: Math.round((region.bounds.y - captureDisplayCache.originY) * captureDisplayCache.scaleFactor),
        width: Math.round(region.bounds.width * captureDisplayCache.scaleFactor),
        height: Math.round(region.bounds.height * captureDisplayCache.scaleFactor),
      },
    }));

    const regionPixelHashes = new Map<string, number>();
    for (const region of physicalBoundsRegions) {
      regionPixelHashes.set(region.id, computeRegionPixelHash(frame, region.bounds));
    }

    // Phase 1: advance the post-change countdown before building throttled regions.
    const regionIsInPostChangeWindow = new Map<string, boolean>();
    for (const region of physicalBoundsRegions) {
      const previousHash = regionPixelHashCache.get(region.id);
      const currentHash = regionPixelHashes.get(region.id)!;
      const hashChanged = previousHash === undefined || previousHash !== currentHash;

      if (hashChanged) {
        const regionEvalIntervalMs = getRegionEvaluationIntervalMs(region, minCalcIntervalMs);
        const requiredPostChangePasses = computePostChangeEvalPassesForRegion(region, FALLBACK_EXTRA_EVAL_PASSES_AFTER_CHANGE, regionEvalIntervalMs);
        regionPostChangeEvalCountdown.set(region.id, requiredPostChangePasses);
        regionIsInPostChangeWindow.set(region.id, false);
      } else {
        const remainingPasses = regionPostChangeEvalCountdown.get(region.id) ?? 0;
        if (remainingPasses > 0) {
          regionPostChangeEvalCountdown.set(region.id, remainingPasses - 1);
          regionIsInPostChangeWindow.set(region.id, true);
        } else {
          regionIsInPostChangeWindow.set(region.id, false);
        }
      }
    }

    // Phase 2: build throttled regions using updated post-change flags.
    const throttledRegions = physicalBoundsRegions.map((region: any) => {
      const prev = regionPixelHashCache.get(region.id);
      const curr = regionPixelHashes.get(region.id)!;
      const unchanged = prev !== undefined && prev === curr;
      const isInPostChangeWindow = regionIsInPostChangeWindow.get(region.id) ?? false;
      const allowed = (region.stateCalculations || []).filter((calc: any) => {
        const key = `${region.id}:${calc.id}`;
        const regionMinCalcIntervalMs = getRegionEvaluationIntervalMs(region, minCalcIntervalMs);
        const shouldSkipIfUnchanged = calc.skipIfUnchanged !== false;
        const isSettledAndWindowExpired = unchanged && !isInPostChangeWindow;
        return !shouldThrottleCalc(key, nowMs, regionMinCalcIntervalMs) &&
          !(shouldSkipIfUnchanged && isSettledAndWindowExpired && region.alwaysEvaluate !== true);
      });
      return { ...region, stateCalculations: allowed };
    });

    for (const [id, hash] of regionPixelHashes) regionPixelHashCache.set(id, hash);

    ocrService.onFrameCaptured(frame);
    ocrService.setRegions(throttledRegions);
    ollamaService.onFrameCaptured(frame);
    ollamaService.setRegions(throttledRegions);

    const frameState = evaluateFrameState(frame, throttledRegions, ocrService.getAllResults(), ollamaService.getAllResults());

    const instanceStates = frameState.regionInstanceStates || frameState.regionStates;
    for (const rs of instanceStates as any[]) {
      const runtimeRegionId = rs.runtimeMonitoredRegionId || rs.monitoredRegionId;
      const orig = runtimeRegions.find((r: any) => r.id === runtimeRegionId);
      if (orig) {
        applyLastKnownValueFallbacks(rs.calculationResults, orig, runtimeRegionId);
      }
      for (const cr of rs.calculationResults) lastCalcResults.set(`${runtimeRegionId}:${cr.stateCalculationId}`, cr);
      const throt = throttledRegions.find((r: any) => r.id === runtimeRegionId);
      if (orig && throt) {
        const evalIds = new Set((throt.stateCalculations || []).map((c: any) => c.id));
        for (const calc of (orig.stateCalculations || [])) {
          if (!evalIds.has(calc.id)) {
            const cached = lastCalcResults.get(`${runtimeRegionId}:${calc.id}`);
            if (cached) rs.calculationResults.push(cached);
          }
        }
      }
    }

    perfCounters.stateEvals++;
    applyProfileRuleResults(frameState);
    overlayWindowManager.broadcastFrameState(frameState);
    const uiIsVisible = !uiMinimizedRef.minimized && mainWindow && !mainWindow.isDestroyed();
    if (uiIsVisible) {
      const nowMs = Date.now();
      const uiUpdateIsOverdue = nowMs - lastStateUpdateSentToUiAt >= stateUpdateUiMinIntervalMs;
      if (uiUpdateIsOverdue) {
        lastStateUpdateSentToUiAt = nowMs;
        mainWindow!.webContents.send(IpcChannels.STATE_UPDATED, frameState);
      }
    }
    perfCounters.pipelineTotalMs += Date.now() - pipelineStartTime;
    perfCounters.pipelineSamples++;
  };

  stateEvalInterval = setInterval(runStateEvaluation, getStateEvaluationLoopIntervalMs());
}

function stopStateEvaluationLoop(): void {
  if (stateEvalInterval) {
    clearInterval(stateEvalInterval);
    stateEvalInterval = null;
  }
  if (stateEvalWorker) {
    stateEvalWorker.terminate();
    stateEvalWorker = null;
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  logger.initFileLogging();
  logger.info(LogCategory.General, 'Fundido Overlays starting up.');

  registerIpcHandlers(
    configService,
    captureService,
    previewService,
    overlayWindowManager,
    dirtyRegionOverlayManager,
    ocrService,
    ollamaService,
    soundLibraryService,
    currentConfigRef,
    workingRegionsRef,
    globalEnabledRef,
    pickerActiveRef,
    syncPreviewRuntimeState,
    refreshCaptureDisplayCache,
  );

  // Keep the display-metrics cache current if the user connects/disconnects a
  // monitor or changes resolution while the app is running.
  screen.on('display-added', refreshCaptureDisplayCache);
  screen.on('display-removed', refreshCaptureDisplayCache);
  screen.on('display-metrics-changed', refreshCaptureDisplayCache);

  ipcMain.on(IpcChannels.UI_ACTIVE_PAGE, (_event: any, page: string) => {
    uiActivePageRef.page = page;
    syncPreviewRuntimeState();
  });

  // Forward diagnostic logs sent from the overlay renderer back to the main process logger
  ipcMain.on('debug:overlay-renderer', (_event: any, message: string) => {
    logger.info(LogCategory.Overlay, `[RENDERER] ${message}`);
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
  overlayWindowManager.syncOverlayWindows(
    getProfileActivatedOverlayGroups(currentConfigRef.config),
    currentConfigRef.config.soundVolume ?? 0.5,
  );

  // Apply the saved cursor frequency so the interval is correct from first launch
  const initialCursorFrequencyHz = currentConfigRef.config.overlay?.cursorFrequencyHz ?? 60;
  overlayWindowManager.setCursorFrequencyHz(initialCursorFrequencyHz);

  // Index sound library folders from saved config on startup (silent — no UI modal on startup)
  const startupSoundFolderPaths = currentConfigRef.config.soundLibraryFolderPaths ?? [];
  const hasSoundFoldersConfigured = startupSoundFolderPaths.length > 0;
  if (hasSoundFoldersConfigured) {
    logger.info(LogCategory.General, `Auto-indexing ${startupSoundFolderPaths.length} sound library folder(s) on startup.`);
    soundLibraryService.indexFolders(startupSoundFolderPaths, () => {}).catch((error) => {
      logger.error(LogCategory.General, 'Startup sound indexing failed', error);
    });
  }

  // Auto-start capture if it was running when the app last closed
  const shouldAutoStartCapture = currentConfigRef.config.gameCapture.captureEnabled === true;
  if (shouldAutoStartCapture) {
    logger.info(LogCategory.General, 'Auto-starting capture (was enabled on last exit).');
    const captureConfig = currentConfigRef.config.gameCapture;
    captureService.start(captureConfig);

    const captureSourceString = captureConfig.captureSource;
    const displayIndex = captureSourceString === 'primary' ? 0 : (parseInt(captureSourceString, 10) || 0);
    previewService.setCaptureDisplayMetrics(captureService.getDisplayMetrics(displayIndex));
    previewService.start(currentConfigRef.config.preview, currentConfigRef.config.preview.previewFps ?? 10);
    syncPreviewRuntimeState();
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
  dirtyRegionOverlayManager.closeAll();
  app.quit();
});

app.on('before-quit', () => {
  configService.save(currentConfigRef.config);
  logger.info(LogCategory.General, 'Configuration saved on exit.');
  logger.shutdown();
});
