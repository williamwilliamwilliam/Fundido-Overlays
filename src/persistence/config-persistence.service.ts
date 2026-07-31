import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { FundidoConfig, GameCaptureConfig, PreviewConfig, OcrConfig, OllamaConfig, OverlayConfig } from '../shared';
import { logger, LogCategory } from '../shared/logger';
import { getActiveSaveFilePath } from './save-file-registry';

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
    previewScale: 0.25,
    downsampleMethod: 'nearestNeighbor',
    jpegQuality: 60,
    previewFps: 10,
  };

  const defaultOcr: OcrConfig = {
    ocrIntervalMs: 200,
    maxCharacters: 10,
  };

  const defaultOllama: OllamaConfig = {
    baseUrl: 'http://localhost:11434',
    modelName: 'qwen3.5:0.8b',
    intervalMs: 500,
    keepAlive: '5m',
  };

  const defaultOverlay: OverlayConfig = {
    cursorFrequencyHz: 60,
  };

  return {
    gameCapture: defaultGameCapture,
    preview: defaultPreview,
    ocr: defaultOcr,
    ollama: defaultOllama,
    overlay: defaultOverlay,
    monitoredRegions: [],
    overlayGroups: [],
    profiles: [],
    profileRulesEnabled: false,
  };
}

/**
 * Handles reading and writing the user's configuration to a JSON file
 * in the Electron userData directory.
 */
export class ConfigPersistenceService {
  private readonly configFilePath: string;

  constructor() {
    // Resolved once at construction. The active save file is only ever changed
    // as part of a restart, so a long-lived process always reads and writes the
    // same file — there is no window in which a save could land in the wrong one.
    this.configFilePath = getActiveSaveFilePath();
    logger.info(LogCategory.Persistence, `Config file path: ${this.configFilePath}`);
  }

  /** Absolute path of the save file this instance reads and writes. */
  public getConfigFilePath(): string {
    return this.configFilePath;
  }

  /**
   * Creates a new save file containing only defaults.
   *
   * Refuses to overwrite an existing file: the caller obtains the path from a
   * save dialog, which has already asked about replacing a file the user picked
   * deliberately — but an accidental overwrite here would destroy a save
   * outright, so it is worth being explicit rather than trusting the dialog.
   */
  public createSaveFile(saveFilePath: string, overwriteExisting: boolean): void {
    if (!overwriteExisting && fs.existsSync(saveFilePath)) {
      throw new Error(`Save file already exists: ${saveFilePath}`);
    }

    const jsonString = JSON.stringify(buildDefaultConfig(), null, 2);
    fs.writeFileSync(saveFilePath, jsonString, 'utf-8');
    logger.info(LogCategory.Persistence, `Created new save file: ${saveFilePath}`);
  }

  /**
   * Checks that a file is usable as a save file before the app restarts into
   * it. Opening a non-config JSON would otherwise leave the user in a
   * defaults-only app with no explanation of what went wrong.
   */
  public static validateSaveFile(saveFilePath: string): { valid: boolean; reason?: string } {
    try {
      const parsed = JSON.parse(fs.readFileSync(saveFilePath, 'utf-8'));
      const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      if (!isObject) {
        return { valid: false, reason: 'The file does not contain a configuration object.' };
      }

      // A save file always carries these collections. Requiring at least one of
      // them rejects unrelated JSON without rejecting older or partial saves,
      // which load() is already able to backfill.
      const hasRecognizableShape =
        Array.isArray((parsed as any).monitoredRegions) ||
        Array.isArray((parsed as any).overlayGroups) ||
        Array.isArray((parsed as any).profiles) ||
        typeof (parsed as any).gameCapture === 'object';
      if (!hasRecognizableShape) {
        return { valid: false, reason: 'The file is valid JSON but not a Fundido save file.' };
      }

      return { valid: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, reason: `The file could not be read as JSON. ${message}` };
    }
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
      } else {
        parsed.preview.previewScale ??= defaults.preview.previewScale;
        parsed.preview.downsampleMethod ??= defaults.preview.downsampleMethod;
        parsed.preview.jpegQuality ??= defaults.preview.jpegQuality;
        parsed.preview.previewFps ??= defaults.preview.previewFps;
      }

      const configIsMissingOcrSettings = !parsed.ocr;
      if (configIsMissingOcrSettings) {
        parsed.ocr = defaults.ocr;
        logger.info(LogCategory.Persistence, 'Backfilled missing OCR config with defaults.');
      }

      const configIsMissingOllamaSettings = !parsed.ollama;
      if (configIsMissingOllamaSettings) {
        parsed.ollama = defaults.ollama;
        logger.info(LogCategory.Persistence, 'Backfilled missing Ollama config with defaults.');
      }

      const configIsMissingCaptureEnabled = parsed.gameCapture && parsed.gameCapture.captureEnabled === undefined;
      if (configIsMissingCaptureEnabled) {
        parsed.gameCapture.captureEnabled = false;
      }

      if (!parsed.overlay) {
        parsed.overlay = defaults.overlay;
        logger.info(LogCategory.Persistence, 'Backfilled missing overlay config with defaults.');
      } else {
        parsed.overlay.cursorFrequencyHz ??= defaults.overlay!.cursorFrequencyHz;
      }

      if (!Array.isArray(parsed.profiles)) {
        parsed.profiles = defaults.profiles;
        logger.info(LogCategory.Persistence, 'Backfilled missing profiles config with defaults.');
      }
      for (const profile of parsed.profiles) {
        if (!Array.isArray(profile.rules)) {
          profile.rules = [];
        }
      }
      parsed.profileRulesEnabled ??= defaults.profileRulesEnabled;

      if (!Array.isArray(parsed.overlayGroups)) {
        parsed.overlayGroups = defaults.overlayGroups;
      }
      for (const group of parsed.overlayGroups) {
        if (!Array.isArray(group.profileIds)) {
          group.profileIds = [];
        }
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
