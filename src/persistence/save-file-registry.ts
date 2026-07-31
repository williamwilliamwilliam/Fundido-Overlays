import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger, LogCategory } from '../shared/logger';

/**
 * Tracks which save file the app is currently using.
 *
 * The pointer deliberately lives in its own small file rather than inside the
 * configuration itself. A config file has to remain openable from anywhere and
 * copyable between machines, so it cannot contain a machine-specific path to
 * itself — and a config that named its own location would disagree with reality
 * the moment the file was moved or copied.
 */

/** The save file used unless the user has opened another one. */
const DEFAULT_SAVE_FILE_NAME = 'fundido-config.json';

/** Stores the path of the save file currently in use. */
const ACTIVE_SAVE_POINTER_FILE_NAME = 'fundido-active-save.json';

interface ActiveSavePointer {
  activeSaveFilePath: string;
}

export function getDefaultSaveFilePath(): string {
  return path.join(app.getPath('userData'), DEFAULT_SAVE_FILE_NAME);
}

function getPointerFilePath(): string {
  return path.join(app.getPath('userData'), ACTIVE_SAVE_POINTER_FILE_NAME);
}

export function isDefaultSaveFile(saveFilePath: string): boolean {
  return path.resolve(saveFilePath) === path.resolve(getDefaultSaveFilePath());
}

/**
 * Returns the save file the app should load.
 *
 * Falls back to the default whenever the pointer is missing, unreadable, or
 * names a file that no longer exists — a user who moves or deletes a save file
 * should get a working app back, not a startup failure.
 */
export function getActiveSaveFilePath(): string {
  const defaultPath = getDefaultSaveFilePath();
  const pointerPath = getPointerFilePath();

  try {
    if (!fs.existsSync(pointerPath)) {
      return defaultPath;
    }

    const parsed = JSON.parse(fs.readFileSync(pointerPath, 'utf-8')) as ActiveSavePointer;
    const recordedPath = parsed?.activeSaveFilePath;
    if (!recordedPath || typeof recordedPath !== 'string') {
      return defaultPath;
    }

    if (!fs.existsSync(recordedPath)) {
      logger.warn(
        LogCategory.Persistence,
        `Active save file "${recordedPath}" no longer exists — falling back to the default save file.`
      );
      return defaultPath;
    }

    return recordedPath;
  } catch (error) {
    logger.error(LogCategory.Persistence, 'Failed to read the active save pointer — using the default save file.', error);
    return defaultPath;
  }
}

/**
 * Records which save file to load next. Writing the default path removes the
 * pointer entirely, so a default-only installation leaves no stray state.
 */
export function setActiveSaveFilePath(saveFilePath: string): void {
  const pointerPath = getPointerFilePath();

  try {
    if (isDefaultSaveFile(saveFilePath)) {
      if (fs.existsSync(pointerPath)) {
        fs.unlinkSync(pointerPath);
      }
      return;
    }

    const pointer: ActiveSavePointer = { activeSaveFilePath: saveFilePath };
    fs.writeFileSync(pointerPath, JSON.stringify(pointer, null, 2), 'utf-8');
  } catch (error) {
    logger.error(LogCategory.Persistence, 'Failed to record the active save file.', error);
    throw error;
  }
}

/** Display name for the active save file, used in the window title. */
export function getSaveFileDisplayName(saveFilePath: string): string {
  if (isDefaultSaveFile(saveFilePath)) {
    return 'Default';
  }
  return path.basename(saveFilePath, path.extname(saveFilePath));
}
