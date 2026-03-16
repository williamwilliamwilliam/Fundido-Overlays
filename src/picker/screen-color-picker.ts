import { BrowserWindow, screen, ipcMain, IpcMainEvent } from 'electron';
import { GameCaptureService } from '../capture/game-capture.service';
import { logger, LogCategory } from '../shared/logger';

export interface PickColorResult {
  red: number;
  green: number;
  blue: number;
}

/**
 * Opens a fullscreen transparent overlay with a crosshair cursor.
 * When the user clicks, samples the pixel color from the latest captured
 * frame at that screen position. Press Escape to cancel.
 *
 * Uses ipcMain.on / ipcRenderer.send for communication (same pattern
 * as the region picker).
 */
export function pickScreenColor(
  captureService: GameCaptureService
): Promise<PickColorResult | null> {
  return new Promise((resolve) => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const displayBounds = primaryDisplay.bounds;
    const scaleFactor = primaryDisplay.scaleFactor || 1;
    let hasResolved = false;

    const resolveAndCleanup = (result: PickColorResult | null) => {
      if (hasResolved) return;
      hasResolved = true;

      // Remove IPC listeners
      ipcMain.removeAllListeners('color-picker:internal-click');
      ipcMain.removeAllListeners('color-picker:internal-cancel');

      // Close picker window
      if (!pickerWindow.isDestroyed()) {
        pickerWindow.close();
      }

      resolve(result);
    };

    const pickerWindow = new BrowserWindow({
      x: displayBounds.x,
      y: displayBounds.y,
      width: displayBounds.width,
      height: displayBounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
      },
    });

    pickerWindow.setAlwaysOnTop(true, 'screen-saver');

    // Listen for click from the picker renderer
    ipcMain.on('color-picker:internal-click', (_event: IpcMainEvent, screenX: number, screenY: number) => {
      const physicalX = Math.round((screenX - displayBounds.x) * scaleFactor);
      const physicalY = Math.round((screenY - displayBounds.y) * scaleFactor);

      const latestFrame = captureService.getLatestFrame();
      if (!latestFrame) {
        logger.warn(LogCategory.General, 'Color picker: no captured frame available.');
        resolveAndCleanup(null);
        return;
      }

      const bytesPerPixel = 4;
      const frameRowBytes = latestFrame.width * bytesPerPixel;
      const xInBounds = physicalX >= 0 && physicalX < latestFrame.width;
      const yInBounds = physicalY >= 0 && physicalY < latestFrame.height;

      if (!xInBounds || !yInBounds) {
        logger.warn(LogCategory.General, `Color picker: click at (${physicalX}, ${physicalY}) out of frame bounds.`);
        resolveAndCleanup(null);
        return;
      }

      const offset = physicalY * frameRowBytes + physicalX * bytesPerPixel;
      // Frame is BGRA
      const blue = latestFrame.buffer[offset];
      const green = latestFrame.buffer[offset + 1];
      const red = latestFrame.buffer[offset + 2];

      logger.info(LogCategory.General, `Color picker: sampled RGB(${red}, ${green}, ${blue}) at screen (${screenX}, ${screenY})`);
      resolveAndCleanup({ red, green, blue });
    });

    // Listen for cancel from the picker renderer
    ipcMain.on('color-picker:internal-cancel', () => {
      logger.info(LogCategory.General, 'Color picker: cancelled by user.');
      resolveAndCleanup(null);
    });

    // If the window is closed externally (e.g. main window closes), clean up
    pickerWindow.on('closed', () => {
      resolveAndCleanup(null);
    });

    const html = buildColorPickerHtml();
    pickerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    pickerWindow.webContents.once('did-finish-load', () => {
      pickerWindow.focus();
    });
  });
}

function buildColorPickerHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%;
    background: rgba(0, 0, 0, 0.15);
    cursor: crosshair;
    overflow: hidden;
    user-select: none;
  }
  .hint {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.75);
    color: #fff;
    padding: 8px 20px;
    border-radius: 6px;
    font-family: 'Segoe UI', sans-serif;
    font-size: 14px;
    pointer-events: none;
  }
</style>
</head>
<body>
<div class="hint">Click a pixel to pick its color — Escape to cancel</div>
<script>
  const { ipcRenderer } = require('electron');

  document.addEventListener('mousedown', (e) => {
    ipcRenderer.send('color-picker:internal-click', e.screenX, e.screenY);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ipcRenderer.send('color-picker:internal-cancel');
    }
  });
</script>
</body>
</html>`;
}
