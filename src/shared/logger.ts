import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
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

const MAX_LOG_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_OLD_LOG_FILES = 3;

/**
 * Centralized logger that writes to:
 *   1. A log file in the user data directory (persists across restarts)
 *   2. stdout/stderr (visible when running from terminal)
 *   3. The Angular UI's debug console over IPC
 *
 * Log file location:
 *   Windows: %APPDATA%/fundido-overlays/fundido.log
 *   (shown in the first log line on startup)
 */
class DebugLogger {
  private mainWindow: BrowserWindow | null = null;
  private logFilePath: string | null = null;
  private logStream: fs.WriteStream | null = null;
  private earlyBuffer: string[] = [];

  /**
   * Initialize file logging. Call this as early as possible.
   * Before this is called, log lines are buffered in memory.
   */
  public initFileLogging(): void {
    try {
      const userDataPath = app.getPath('userData');
      this.logFilePath = path.join(userDataPath, 'fundido.log');

      this.rotateLogIfNeeded();

      this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });

      // Write startup header
      const startupHeader = [
        '',
        '='.repeat(80),
        `Fundido Overlays — Starting at ${new Date().toISOString()}`,
        `  App version:   ${app.getVersion()}`,
        `  Electron:      ${process.versions.electron}`,
        `  Chrome:        ${process.versions.chrome}`,
        `  Node:          ${process.versions.node}`,
        `  Platform:      ${process.platform} ${process.arch}`,
        `  User data:     ${userDataPath}`,
        `  App path:      ${app.getAppPath()}`,
        `  __dirname:     ${__dirname}`,
        `  Packaged:      ${app.isPackaged}`,
        `  Argv:          ${process.argv.join(' ')}`,
        `  Log file:      ${this.logFilePath}`,
        '='.repeat(80),
      ].join('\n');
      this.logStream.write(startupHeader + '\n');

      // Flush any buffered early log lines
      for (const line of this.earlyBuffer) {
        this.logStream.write(line + '\n');
      }
      this.earlyBuffer = [];

      // Register global error handlers
      this.registerGlobalErrorHandlers();

    } catch (err) {
      console.error('Failed to initialize file logging:', err);
    }
  }

  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;

    // Capture renderer process errors
    window.webContents.on('crashed', (_event: any, killed: boolean) => {
      this.error(LogCategory.General, `Renderer process crashed (killed=${killed})`);
    });

    window.webContents.on('render-process-gone', (_event: any, details: any) => {
      this.error(LogCategory.General, `Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    });

    window.webContents.on('did-fail-load', (_event: any, errorCode: number, errorDescription: string, validatedURL: string) => {
      this.error(LogCategory.General, `Page failed to load: ${errorDescription} (code ${errorCode}) URL: ${validatedURL}`);
    });

    window.webContents.on('console-message', (_event: any, level: number, message: string, line: number, sourceId: string) => {
      const levelMap: Record<number, string> = { 0: 'DEBUG', 1: 'INFO', 2: 'WARN', 3: 'ERROR' };
      const levelStr = levelMap[level] || 'LOG';
      this.writeToFile(`[${new Date().toISOString()}][${levelStr}][Renderer] ${message} (${sourceId}:${line})`);
    });
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

  /**
   * Returns the path to the log file, or null if file logging isn't initialized.
   */
  public getLogFilePath(): string | null {
    return this.logFilePath;
  }

  /**
   * Flushes and closes the log file. Call on app shutdown.
   */
  public shutdown(): void {
    this.info(LogCategory.General, 'Fundido Overlays shutting down.');
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

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

    // Format for file and stdout
    const timestamp = new Date(entry.timestamp).toISOString();
    const prefix = `[${timestamp}][${level.toUpperCase()}][${category}]`;
    const dataString = data !== undefined ? ` ${this.serializeData(data)}` : '';
    const formattedLine = `${prefix} ${message}${dataString}`;

    // Write to stdout
    if (level === 'error') {
      console.error(formattedLine);
    } else {
      console.log(formattedLine);
    }

    // Write to log file
    this.writeToFile(formattedLine);

    // Forward to the UI if the window is available
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send(IpcChannels.DEBUG_LOG, entry);
      } catch {
        // Window might be in a bad state during shutdown
      }
    }
  }

  private writeToFile(line: string): void {
    if (this.logStream) {
      this.logStream.write(line + '\n');
    } else {
      // Buffer early log lines before file logging is initialized
      this.earlyBuffer.push(line);
    }
  }

  private serializeData(data: unknown): string {
    try {
      if (data instanceof Error) {
        return `${data.message}\n${data.stack || ''}`;
      }
      if (typeof data === 'string') return data;
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  private rotateLogIfNeeded(): void {
    if (!this.logFilePath) return;
    try {
      const fileExists = fs.existsSync(this.logFilePath);
      if (!fileExists) return;

      const stats = fs.statSync(this.logFilePath);
      const fileIsOverSizeLimit = stats.size > MAX_LOG_FILE_SIZE_BYTES;
      if (!fileIsOverSizeLimit) return;

      // Rotate: fundido.log → fundido.1.log → fundido.2.log → ...
      for (let i = MAX_OLD_LOG_FILES - 1; i >= 1; i--) {
        const older = this.logFilePath.replace('.log', `.${i}.log`);
        const newer = i === 1 ? this.logFilePath : this.logFilePath.replace('.log', `.${i - 1}.log`);
        if (fs.existsSync(newer)) {
          try { fs.renameSync(newer, older); } catch { /* ignore rotation errors */ }
        }
      }

      // Rename current log to .1.log
      const rotatedPath = this.logFilePath.replace('.log', '.1.log');
      try { fs.renameSync(this.logFilePath, rotatedPath); } catch { /* ignore */ }
    } catch {
      // If rotation fails, just continue — we'll append to the existing file
    }
  }

  private registerGlobalErrorHandlers(): void {
    process.on('uncaughtException', (error: Error) => {
      this.error(LogCategory.General, `UNCAUGHT EXCEPTION: ${error.message}`, error);
    });

    process.on('unhandledRejection', (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      const data = reason instanceof Error ? reason : undefined;
      this.error(LogCategory.General, `UNHANDLED REJECTION: ${message}`, data);
    });
  }
}

/** Singleton logger instance used throughout the main process. */
export const logger = new DebugLogger();
