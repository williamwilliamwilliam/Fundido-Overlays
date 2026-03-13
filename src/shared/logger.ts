import { BrowserWindow } from 'electron';
import * as IpcChannels from '../shared/ipc-channels';

/**
 * Log categories that can be independently filtered in the debug console.
 * Add new categories here as the app grows.
 */
export enum LogCategory {
  Capture = 'Capture',
  StateCalculation = 'StateCalculation',
  Overlay = 'Overlay',
  Persistence = 'Persistence',
  Ipc = 'Ipc',
  General = 'General',
}

export interface LogEntry {
  timestamp: number;
  category: LogCategory;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

/**
 * Centralized logger that both writes to stdout and forwards log entries
 * to the Angular UI's debug console over IPC.
 */
class DebugLogger {
  private mainWindow: BrowserWindow | null = null;

  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  public debug(category: LogCategory, message: string, data?: unknown): void {
    this.emit('debug', category, message, data);
  }

  public info(category: LogCategory, message: string, data?: unknown): void {
    this.emit('info', category, message, data);
  }

  public warn(category: LogCategory, message: string, data?: unknown): void {
    this.emit('warn', category, message, data);
  }

  public error(category: LogCategory, message: string, data?: unknown): void {
    this.emit('error', category, message, data);
  }

  private emit(
    level: LogEntry['level'],
    category: LogCategory,
    message: string,
    data?: unknown
  ): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      category,
      level,
      message,
      data,
    };

    // Always log to stdout for developer convenience
    const prefix = `[${level.toUpperCase()}][${category}]`;
    console.log(`${prefix} ${message}`, data ?? '');

    // Forward to the UI if the window is available
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IpcChannels.DEBUG_LOG, entry);
    }
  }
}

/** Singleton logger instance used throughout the main process. */
export const logger = new DebugLogger();
