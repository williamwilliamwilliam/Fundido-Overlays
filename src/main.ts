import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { ConfigPersistenceService } from './persistence/config-persistence.service';
import { GameCaptureService } from './capture/game-capture.service';
import { OverlayWindowManager } from './overlay/overlay-window-manager';
import { evaluateFrameState } from './state/state-calculation.service';
import { registerIpcHandlers } from './ipc/ipc-handlers';
import { logger, LogCategory } from './shared/logger';
import { FundidoConfig } from './shared';
import * as IpcChannels from './shared/ipc-channels';

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const configService = new ConfigPersistenceService();
const captureService = new GameCaptureService();
const overlayWindowManager = new OverlayWindowManager();

/** Mutable reference so IPC handlers can read/write the active config. */
const currentConfigRef: { config: FundidoConfig } = {
    config: configService.load(),
};

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
    const isDevelopmentMode = process.argv.includes('--dev');

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: 'Fundido Overlays',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    logger.setMainWindow(mainWindow);

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
// Capture → State → Overlay pipeline
// ---------------------------------------------------------------------------

function setupCaptureToOverlayPipeline(): void {
    captureService.setFrameCapturedCallback((frame) => {
        const monitoredRegions = currentConfigRef.config.monitoredRegions;

        const hasNoRegionsToEvaluate = monitoredRegions.length === 0;
        if (hasNoRegionsToEvaluate) {
            return;
        }

        const frameState = evaluateFrameState(frame, monitoredRegions);

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

    registerIpcHandlers(configService, captureService, currentConfigRef);
    createMainWindow();
    setupCaptureToOverlayPipeline();

    // Create overlay windows for any groups defined in the saved config
    overlayWindowManager.syncOverlayWindows(currentConfigRef.config.overlayGroups);
});

app.on('window-all-closed', () => {
    logger.info(LogCategory.General, 'All windows closed — shutting down.');
    captureService.stop();
    overlayWindowManager.closeAll();
    app.quit();
});

app.on('before-quit', () => {
    configService.save(currentConfigRef.config);
    logger.info(LogCategory.General, 'Configuration saved on exit.');
});