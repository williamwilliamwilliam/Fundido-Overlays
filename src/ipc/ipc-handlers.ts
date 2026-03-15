import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron';
import * as IpcChannels from '../shared/ipc-channels';
import { FundidoConfig, MonitoredRegion, OverlayGroup } from '../shared';
import { ConfigPersistenceService } from '../persistence/config-persistence.service';
import { GameCaptureService } from '../capture/game-capture.service';
import { PreviewFrameService } from '../capture/preview-frame.service';
import { OverlayWindowManager } from '../overlay/overlay-window-manager';
import { OcrService } from '../state/ocr.service';
import { logger, LogCategory } from '../shared/logger';

/**
 * Registers all IPC handlers that the Angular UI (renderer process) can invoke.
 */
export function registerIpcHandlers(
  configService: ConfigPersistenceService,
  captureService: GameCaptureService,
  previewService: PreviewFrameService,
  overlayWindowManager: OverlayWindowManager,
  ocrService: OcrService,
  currentConfigRef: { config: FundidoConfig },
  workingRegionsRef: { regions: any[] | null },
  globalEnabledRef: { enabled: boolean }
): void {

  // -------------------------------------------------------------------------
  // Global toggle
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.GLOBAL_ENABLE, (_event: IpcMainInvokeEvent) => {
    logger.info(LogCategory.General, 'Global enable — starting capture and overlays.');
    globalEnabledRef.enabled = true;

    // Start capture if it was enabled in config
    const captureWasEnabled = currentConfigRef.config.gameCapture.captureEnabled;
    if (captureWasEnabled && !captureService.getIsCapturing()) {
      const captureConfig = currentConfigRef.config.gameCapture;
      captureService.start(captureConfig);
      const captureSourceString = captureConfig.captureSource;
      const displayIndex = captureSourceString === 'primary' ? 0 : (parseInt(captureSourceString, 10) || 0);
      previewService.setCaptureDisplayIndex(displayIndex);
      previewService.start(currentConfigRef.config.preview, currentConfigRef.config.gameCapture.targetFps);
      ocrService.start(currentConfigRef.config.ocr);
    }

    // Restore overlay windows
    overlayWindowManager.syncOverlayWindows(currentConfigRef.config.overlayGroups || []);
    return { success: true };
  });

  ipcMain.handle(IpcChannels.GLOBAL_DISABLE, (_event: IpcMainInvokeEvent) => {
    logger.info(LogCategory.General, 'Global disable — stopping capture and hiding overlays.');
    globalEnabledRef.enabled = false;

    captureService.stop();
    previewService.stop();
    ocrService.stop();

    // Close all overlay windows
    overlayWindowManager.closeAll();
    return { success: true };
  });

  ipcMain.handle(IpcChannels.GLOBAL_STATUS, (_event: IpcMainInvokeEvent) => {
    return { enabled: globalEnabledRef.enabled };
  });

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.CONFIG_LOAD, (_event: IpcMainInvokeEvent) => {
    logger.debug(LogCategory.Ipc, 'CONFIG_LOAD invoked');
    return currentConfigRef.config;
  });

  ipcMain.handle(IpcChannels.CONFIG_SAVE, (_event: IpcMainInvokeEvent, config: FundidoConfig) => {
    logger.debug(LogCategory.Ipc, 'CONFIG_SAVE invoked');
    currentConfigRef.config = config;
    configService.save(config);
    // Sync overlay windows whenever config is saved
    overlayWindowManager.syncOverlayWindows(config.overlayGroups || []);
    return { success: true };
  });

  ipcMain.handle(IpcChannels.CONFIG_EXPORT_REGIONS, (_event: IpcMainInvokeEvent) => {
    logger.debug(LogCategory.Ipc, 'CONFIG_EXPORT_REGIONS invoked');
    return configService.exportMonitoredRegionsAsJson(currentConfigRef.config);
  });

  ipcMain.handle(
    IpcChannels.CONFIG_IMPORT_REGIONS,
    (_event: IpcMainInvokeEvent, jsonString: string) => {
      logger.debug(LogCategory.Ipc, 'CONFIG_IMPORT_REGIONS invoked');
      try {
        const importedRegions = JSON.parse(jsonString) as MonitoredRegion[];
        currentConfigRef.config.monitoredRegions = importedRegions;
        configService.save(currentConfigRef.config);
        return { success: true, regionCount: importedRegions.length };
      } catch (error) {
        logger.error(LogCategory.Ipc, 'Failed to import regions', error);
        return { success: false, error: 'Invalid JSON' };
      }
    }
  );

  ipcMain.handle(IpcChannels.CONFIG_EXPORT_OVERLAY_GROUPS, (_event: IpcMainInvokeEvent) => {
    logger.debug(LogCategory.Ipc, 'CONFIG_EXPORT_OVERLAY_GROUPS invoked');
    return configService.exportOverlayGroupsAsJson(currentConfigRef.config);
  });

  ipcMain.handle(
    IpcChannels.CONFIG_IMPORT_OVERLAY_GROUPS,
    (_event: IpcMainInvokeEvent, jsonString: string) => {
      logger.debug(LogCategory.Ipc, 'CONFIG_IMPORT_OVERLAY_GROUPS invoked');
      try {
        const importedGroups = JSON.parse(jsonString) as OverlayGroup[];
        currentConfigRef.config.overlayGroups = importedGroups;
        configService.save(currentConfigRef.config);
        return { success: true, groupCount: importedGroups.length };
      } catch (error) {
        logger.error(LogCategory.Ipc, 'Failed to import overlay groups', error);
        return { success: false, error: 'Invalid JSON' };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Game Capture
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.CAPTURE_START, (_event: IpcMainInvokeEvent) => {
    logger.debug(LogCategory.Ipc, 'CAPTURE_START invoked');
    const captureConfig = currentConfigRef.config.gameCapture;
    captureService.start(captureConfig);

    // Tell the preview service which display we're capturing so it can
    // include the display origin for coordinate mapping.
    const captureSourceString = captureConfig.captureSource;
    const displayIndex = captureSourceString === 'primary' ? 0 : (parseInt(captureSourceString, 10) || 0);
    previewService.setCaptureDisplayIndex(displayIndex);
    previewService.start(currentConfigRef.config.preview, currentConfigRef.config.gameCapture.targetFps);
    ocrService.start(currentConfigRef.config.ocr);

    // Persist so capture auto-starts on next launch
    currentConfigRef.config.gameCapture.captureEnabled = true;
    configService.save(currentConfigRef.config);
    return { success: true };
  });

  ipcMain.handle(IpcChannels.CAPTURE_STOP, (_event: IpcMainInvokeEvent) => {
    logger.debug(LogCategory.Ipc, 'CAPTURE_STOP invoked');
    captureService.stop();
    previewService.stop();
    ocrService.stop();

    currentConfigRef.config.gameCapture.captureEnabled = false;
    configService.save(currentConfigRef.config);
    return { success: true };
  });

  ipcMain.handle(IpcChannels.CAPTURE_STATUS, (_event: IpcMainInvokeEvent) => {
    return {
      isCapturing: captureService.getIsCapturing(),
      isNativeAvailable: captureService.getIsNativeAvailable(),
    };
  });

  ipcMain.handle(IpcChannels.CAPTURE_LIST_DISPLAYS, (_event: IpcMainInvokeEvent) => {
    logger.debug(LogCategory.Ipc, 'CAPTURE_LIST_DISPLAYS invoked');
    return captureService.listDisplays();
  });

  // -------------------------------------------------------------------------
  // Screen Region Picker
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.PICKER_START, async (_event: IpcMainInvokeEvent) => {
    logger.debug(LogCategory.Ipc, 'PICKER_START invoked');
    const { pickScreenRegion } = require('../picker/screen-position-picker');

    // Forward live region updates to the renderer so the UI can show a preview
    const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const onRegionUpdate = (region: any) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannels.PICKER_REGION_UPDATE, region);
      }
    };

    const result = await pickScreenRegion(onRegionUpdate);
    return result;
  });

  // -------------------------------------------------------------------------
  // Working Regions (unsaved, for live evaluation)
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.REGIONS_SET_WORKING, (_event: IpcMainInvokeEvent, regions: any[] | null) => {
    workingRegionsRef.regions = regions;
    return { success: true };
  });

  ipcMain.handle(IpcChannels.GROUPS_SET_WORKING, (_event: IpcMainInvokeEvent, groups: any[] | null) => {
    return { success: true };
  });

  // -------------------------------------------------------------------------
  // File Dialogs
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.DIALOG_OPEN_FILE, async (_event: IpcMainInvokeEvent, options: any) => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: options?.filters || [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    const wasCancelled = result.canceled || result.filePaths.length === 0;
    if (wasCancelled) return null;
    return result.filePaths[0];
  });
}
