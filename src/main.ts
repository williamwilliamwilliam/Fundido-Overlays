import { app, BrowserWindow, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigPersistenceService } from './persistence/config-persistence.service';
import { GameCaptureService } from './capture/game-capture.service';
import { PreviewFrameService } from './capture/preview-frame.service';
import { OverlayWindowManager } from './overlay/overlay-window-manager';
import { evaluateFrameState } from './state/state-calculation.service';
import { OcrService } from './state/ocr.service';
import { registerIpcHandlers } from './ipc/ipc-handlers';
import { logger, LogCategory } from './shared/logger';
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
    const angularDistPath = path.join(__dirname, '..', 'dist', 'ui', 'browser', 'index.html');
    mainWindow.loadFile(angularDistPath);
    logger.info(LogCategory.General, 'Production mode — loading bundled Angular app.');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Capture → Preview + State → Overlay pipeline
// ---------------------------------------------------------------------------

function setupCaptureToOverlayPipeline(): void {
  captureService.setFrameCapturedCallback((frame) => {
    // Feed frame to preview service (it picks up the latest at its own FPS)
    previewService.onFrameCaptured(frame);

    // Use working regions from the UI if available, otherwise fall back to saved config.
    // This lets the UI see median colors and state results for unsaved regions.
    const monitoredRegions = workingRegionsRef.regions ?? currentConfigRef.config.monitoredRegions;

    const hasNoRegionsToEvaluate = monitoredRegions.length === 0;
    if (hasNoRegionsToEvaluate) {
      return;
    }

    // Region bounds are stored in screen-absolute logical coordinates.
    // The frame buffer is in native physical pixels starting at (0,0) for
    // the captured display. We need to convert before evaluating.
    const captureSourceString = currentConfigRef.config.gameCapture.captureSource;
    const displayIndex = captureSourceString === 'primary' ? 0 : (parseInt(captureSourceString, 10) || 0);
    const allDisplays = require('electron').screen.getAllDisplays();
    const captureDisplay = allDisplays[displayIndex] || allDisplays[0];
    const displayOriginX = captureDisplay.bounds.x;
    const displayOriginY = captureDisplay.bounds.y;
    const dpiScaleFactor = captureDisplay.scaleFactor || 1;

    const physicalRegions = monitoredRegions.map((region: any) => ({
      ...region,
      bounds: {
        x: Math.round((region.bounds.x - displayOriginX) * dpiScaleFactor),
        y: Math.round((region.bounds.y - displayOriginY) * dpiScaleFactor),
        width: Math.round(region.bounds.width * dpiScaleFactor),
        height: Math.round(region.bounds.height * dpiScaleFactor),
      },
    }));

    // Feed the frame and region config to the OCR service
    ocrService.onFrameCaptured(frame);
    ocrService.setRegions(physicalRegions);

    // Merge any available OCR results into the frame state
    const frameState = evaluateFrameState(frame, physicalRegions, ocrService.getAllResults());

    // Push state to overlay windows
    overlayWindowManager.broadcastFrameState(frameState);

    // Push state to the Angular UI for the debug console / live preview
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannels.STATE_UPDATED, frameState);
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  logger.info(LogCategory.General, 'Fundido Overlays starting up.');

  registerIpcHandlers(configService, captureService, previewService, overlayWindowManager, ocrService, currentConfigRef, workingRegionsRef, globalEnabledRef);
  createMainWindow();
  setupCaptureToOverlayPipeline();

  // Pipe preview frames to overlay windows for region mirror rendering
  previewService.setOnPreviewFrameSent((previewData) => {
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
    previewService.start(currentConfigRef.config.preview, currentConfigRef.config.gameCapture.targetFps);
    ocrService.start(currentConfigRef.config.ocr);
  }
});

app.on('window-all-closed', () => {
  logger.info(LogCategory.General, 'All windows closed — shutting down.');
  captureService.stop();
  previewService.stop();
  ocrService.shutdown();
  overlayWindowManager.closeAll();
  app.quit();
});

app.on('before-quit', () => {
  configService.save(currentConfigRef.config);
  logger.info(LogCategory.General, 'Configuration saved on exit.');
});
