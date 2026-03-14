import { BrowserWindow, screen, ipcMain } from 'electron';
import { logger, LogCategory } from '../shared/logger';

/**
 * Result returned when the user picks a position on screen.
 * Returns null if the user cancelled (pressed Escape).
 */
export interface PickPositionResult {
  x: number;
  y: number;
}

/**
 * Opens a fullscreen transparent overlay on every display with a crosshair
 * cursor. When the user clicks, the screen coordinates are resolved and
 * all picker windows close. Pressing Escape cancels.
 *
 * Returns a Promise that resolves with { x, y } or null if cancelled.
 */
export function pickScreenPosition(): Promise<PickPositionResult | null> {
  return new Promise((resolve) => {
    const allDisplays = screen.getAllDisplays();
    const pickerWindows: BrowserWindow[] = [];
    let hasResolved = false;

    const resolveAndCleanup = (result: PickPositionResult | null) => {
      if (hasResolved) return;
      hasResolved = true;

      for (const window of pickerWindows) {
        if (!window.isDestroyed()) {
          window.close();
        }
      }

      // Remove the one-time IPC listeners
      ipcMain.removeAllListeners('picker:click');
      ipcMain.removeAllListeners('picker:cancel');

      resolve(result);
    };

    // Listen for click/cancel from any picker window
    ipcMain.on('picker:click', (_event, coordinates: { screenX: number; screenY: number }) => {
      logger.info(LogCategory.General, `Position picked: (${coordinates.screenX}, ${coordinates.screenY})`);
      resolveAndCleanup({ x: coordinates.screenX, y: coordinates.screenY });
    });

    ipcMain.on('picker:cancel', () => {
      logger.info(LogCategory.General, 'Position picker cancelled.');
      resolveAndCleanup(null);
    });

    // Create a picker window on each display so multi-monitor setups work
    for (const display of allDisplays) {
      const pickerWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        fullscreen: false,
        webPreferences: {
          contextIsolation: false,
          nodeIntegration: true,
        },
      });

      // Prevent the window from stealing focus from the app
      pickerWindow.setAlwaysOnTop(true, 'screen-saver');

      const pickerHtml = buildPickerHtml();
      pickerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pickerHtml)}`);

      pickerWindows.push(pickerWindow);
    }

    // Safety timeout — if the picker is open for more than 30 seconds, cancel it
    const safetyTimeoutMilliseconds = 30000;
    setTimeout(() => {
      resolveAndCleanup(null);
    }, safetyTimeoutMilliseconds);
  });
}

/**
 * Builds the HTML content for the picker overlay window.
 * This is a self-contained page with crosshair cursor, semi-transparent
 * dark overlay, coordinate display, and click/escape handling.
 */
function buildPickerHtml(): string {
  return `
<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    background: rgba(0, 0, 0, 0.25);
    cursor: crosshair;
    overflow: hidden;
    user-select: none;
    font-family: 'Segoe UI', sans-serif;
  }

  .instructions {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.8);
    color: #fff;
    padding: 16px 24px;
    border-radius: 8px;
    font-size: 16px;
    text-align: center;
    pointer-events: none;
    z-index: 10;
  }

  .instructions .hint {
    font-size: 12px;
    color: #aaa;
    margin-top: 6px;
  }

  .coordinates {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.8);
    color: #e94560;
    padding: 8px 16px;
    border-radius: 6px;
    font-family: 'Cascadia Code', 'Consolas', monospace;
    font-size: 14px;
    pointer-events: none;
    z-index: 10;
  }

  .crosshair-h, .crosshair-v {
    position: fixed;
    background: rgba(233, 69, 96, 0.6);
    pointer-events: none;
    z-index: 5;
  }
  .crosshair-h { left: 0; right: 0; height: 1px; }
  .crosshair-v { top: 0; bottom: 0; width: 1px; }
</style>
</head>
<body>
  <div class="instructions">
    Click anywhere to pick this position
    <div class="hint">Press Escape to cancel</div>
  </div>
  <div class="coordinates" id="coords">X: 0, Y: 0</div>
  <div class="crosshair-h" id="crossH"></div>
  <div class="crosshair-v" id="crossV"></div>

  <script>
    const { ipcRenderer } = require('electron');
    const coordsEl = document.getElementById('coords');
    const crossH = document.getElementById('crossH');
    const crossV = document.getElementById('crossV');

    document.addEventListener('mousemove', (e) => {
      const screenX = e.screenX;
      const screenY = e.screenY;
      coordsEl.textContent = 'X: ' + screenX + ', Y: ' + screenY;
      crossH.style.top = e.clientY + 'px';
      crossV.style.left = e.clientX + 'px';
    });

    document.addEventListener('mousedown', (e) => {
      ipcRenderer.send('picker:click', {
        screenX: e.screenX,
        screenY: e.screenY,
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ipcRenderer.send('picker:cancel');
      }
    });
  </script>
</body>
</html>`;
}
