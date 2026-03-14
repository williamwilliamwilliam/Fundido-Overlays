import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { FundidoConfig, GameCaptureConfig, PreviewConfig } from '../shared';
import { logger, LogCategory } from '../shared/logger';

const CONFIG_FILE_NAME = 'fundido-config.json';

/**
 * Builds a default configuration used when no saved config exists yet.
 */
function buildDefaultConfig(): FundidoConfig {
  const defaultGameCapture: GameCaptureConfig = {
    captureSource: 'primary',
    targetFps: 30,
    captureEnabled: false,
  };

  const defaultPreview: PreviewConfig = {
    previewFps: 10,
    previewScale: 0.5,
    downsampleMethod: 'bilinear',
    jpegQuality: 70,
  };

  return {
    gameCapture: defaultGameCapture,
    preview: defaultPreview,
    monitoredRegions: [],
    overlayGroups: [],
  };
}

/**
 * Handles reading and writing the user's configuration to a JSON file
 * in the Electron userData directory.
 */
export class ConfigPersistenceService {
  private readonly configFilePath: string;

  constructor() {
    const userDataDirectory = app.getPath('userData');
    this.configFilePath = path.join(userDataDirectory, CONFIG_FILE_NAME);
    logger.info(LogCategory.Persistence, `Config file path: ${this.configFilePath}`);
  }

  /**
   * Loads the configuration from disk. Returns a default config if the
   * file does not exist or cannot be parsed.
   */
  public load(): FundidoConfig {
    const fileExists = fs.existsSync(this.configFilePath);

    if (!fileExists) {
      logger.info(LogCategory.Persistence, 'No config file found — using defaults.');
      return buildDefaultConfig();
    }

    try {
      const rawJson = fs.readFileSync(this.configFilePath, 'utf-8');
      const parsed = JSON.parse(rawJson) as FundidoConfig;

      // Backfill any fields that were added after the config was first saved.
      const defaults = buildDefaultConfig();
      const configIsMissingPreviewSettings = !parsed.preview;
      if (configIsMissingPreviewSettings) {
        parsed.preview = defaults.preview;
        logger.info(LogCategory.Persistence, 'Backfilled missing preview config with defaults.');
      }

      logger.info(LogCategory.Persistence, 'Configuration loaded from disk.');
      return parsed;
    } catch (error) {
      logger.error(LogCategory.Persistence, 'Failed to read config file — using defaults.', error);
      return buildDefaultConfig();
    }
  }

  /**
   * Persists the full configuration to disk.
   */
  public save(config: FundidoConfig): void {
    try {
      const jsonString = JSON.stringify(config, null, 2);
      fs.writeFileSync(this.configFilePath, jsonString, 'utf-8');
      logger.info(LogCategory.Persistence, 'Configuration saved to disk.');
    } catch (error) {
      logger.error(LogCategory.Persistence, 'Failed to write config file.', error);
    }
  }

  /**
   * Exports monitored regions (with their state calculations) as a JSON string
   * suitable for sharing.
   */
  public exportMonitoredRegionsAsJson(config: FundidoConfig): string {
    return JSON.stringify(config.monitoredRegions, null, 2);
  }

  /**
   * Exports overlay groups as a JSON string suitable for sharing.
   */
  public exportOverlayGroupsAsJson(config: FundidoConfig): string {
    return JSON.stringify(config.overlayGroups, null, 2);
  }
}
