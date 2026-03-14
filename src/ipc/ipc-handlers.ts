import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as IpcChannels from '../shared/ipc-channels';
import { FundidoConfig, MonitoredRegion, OverlayGroup } from '../shared';
import { ConfigPersistenceService } from '../persistence/config-persistence.service';
import { GameCaptureService } from '../capture/game-capture.service';
import { PreviewFrameService } from '../capture/preview-frame.service';
import { logger, LogCategory } from '../shared/logger';

/**
 * Registers all IPC handlers that the Angular UI (renderer process) can invoke.
 *
 * This is the glue layer between the UI and the main-process services.
 * Each handler is a thin adapter — it validates the incoming request,
 * delegates to the appropriate service, and returns a result.
 */
export function registerIpcHandlers(
  configService: ConfigPersistenceService,
  captureService: GameCaptureService,
  previewService: PreviewFrameService,
  currentConfigRef: { config: FundidoConfig }
): void {

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
    captureService.start(currentConfigRef.config.gameCapture);
    previewService.start(currentConfigRef.config.preview);
    return { success: true };
  });

  ipcMain.handle(IpcChannels.CAPTURE_STOP, (_event: IpcMainInvokeEvent) => {
    logger.debug(LogCategory.Ipc, 'CAPTURE_STOP invoked');
    captureService.stop();
    previewService.stop();
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
}
