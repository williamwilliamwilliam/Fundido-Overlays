import { BrowserWindow, screen, ipcMain, IpcMainEvent } from 'electron';
import { logger, LogCategory } from '../shared/logger';

/**
 * Result returned when the user confirms a region selection.
 * Returns null if the user cancelled (pressed Escape).
 */
export interface PickRegionResult {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Callback fired each time the user adjusts the selection before confirming. */
export type RegionUpdateCallback = (region: PickRegionResult) => void;

/**
 * Opens a fullscreen transparent overlay for selecting a screen region.
 *
 * Interaction modes:
 *   - Single click → 1×1 region at that point
 *   - Click + drag → rectangle from start to end
 *   - After selection, drag edges/corners to resize
 *   - Enter → confirm
 *   - Escape → cancel
 *
 * The `onRegionUpdate` callback fires on every adjustment so the Angular
 * UI can show a live preview of the selected area.
 */
export function pickScreenRegion(
  onRegionUpdate: RegionUpdateCallback
): Promise<PickRegionResult | null> {
  return new Promise((resolve) => {
    const allDisplays = screen.getAllDisplays();
    const pickerWindows: BrowserWindow[] = [];
    let hasResolved = false;

    const resolveAndCleanup = (result: PickRegionResult | null) => {
      if (hasResolved) return;
      hasResolved = true;

      for (const win of pickerWindows) {
        if (!win.isDestroyed()) {
          win.close();
        }
      }

      ipcMain.removeAllListeners('picker:internal-update');
      ipcMain.removeAllListeners('picker:internal-confirm');
      ipcMain.removeAllListeners('picker:internal-cancel');

      resolve(result);
    };

    ipcMain.on('picker:internal-update', (_event: IpcMainEvent, region: PickRegionResult) => {
      onRegionUpdate(region);
    });

    ipcMain.on('picker:internal-confirm', (_event: IpcMainEvent, region: PickRegionResult) => {
      logger.info(LogCategory.General, `Region confirmed: (${region.x}, ${region.y}) ${region.width}×${region.height}`);
      resolveAndCleanup(region);
    });

    ipcMain.on('picker:internal-cancel', () => {
      logger.info(LogCategory.General, 'Region picker cancelled.');
      resolveAndCleanup(null);
    });

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

      pickerWindow.setAlwaysOnTop(true, 'screen-saver');

      const pickerHtml = buildRegionPickerHtml(display.bounds.x, display.bounds.y);
      pickerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pickerHtml)}`);

      pickerWindows.push(pickerWindow);
    }

    const safetyTimeoutMilliseconds = 120000;
    setTimeout(() => resolveAndCleanup(null), safetyTimeoutMilliseconds);
  });
}

function buildRegionPickerHtml(displayOffsetX: number, displayOffsetY: number): string {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    background: rgba(0, 0, 0, 0.3);
    cursor: crosshair;
    overflow: hidden;
    user-select: none;
    font-family: 'Segoe UI', sans-serif;
  }

  .instructions {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 14px;
    text-align: center;
    pointer-events: none;
    z-index: 100;
    white-space: nowrap;
  }

  .instructions .hint {
    font-size: 11px;
    color: #aaa;
    margin-top: 4px;
  }

  .coords-bar {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.85);
    color: #e94560;
    padding: 6px 14px;
    border-radius: 6px;
    font-family: 'Cascadia Code', 'Consolas', monospace;
    font-size: 13px;
    pointer-events: none;
    z-index: 100;
  }

  #selection {
    position: fixed;
    border: 2px solid #e94560;
    background: rgba(233, 69, 96, 0.1);
    display: none;
    z-index: 50;
    pointer-events: none;
  }

  #selection.active {
    display: block;
    pointer-events: auto;
  }

  /* Edge handles — invisible hit areas on each edge and corner */
  .handle {
    position: absolute;
    z-index: 60;
  }
  .handle-n  { top: -5px; left: 5px; right: 5px; height: 10px; cursor: ns-resize; }
  .handle-s  { bottom: -5px; left: 5px; right: 5px; height: 10px; cursor: ns-resize; }
  .handle-w  { left: -5px; top: 5px; bottom: 5px; width: 10px; cursor: ew-resize; }
  .handle-e  { right: -5px; top: 5px; bottom: 5px; width: 10px; cursor: ew-resize; }
  .handle-nw { top: -5px; left: -5px; width: 12px; height: 12px; cursor: nwse-resize; }
  .handle-ne { top: -5px; right: -5px; width: 12px; height: 12px; cursor: nesw-resize; }
  .handle-sw { bottom: -5px; left: -5px; width: 12px; height: 12px; cursor: nesw-resize; }
  .handle-se { bottom: -5px; right: -5px; width: 12px; height: 12px; cursor: nwse-resize; }

  /* Visible corner dots */
  .corner-dot {
    position: absolute;
    width: 8px; height: 8px;
    background: #e94560;
    border-radius: 50%;
    pointer-events: none;
    z-index: 70;
  }
  .corner-dot.nw { top: -4px; left: -4px; }
  .corner-dot.ne { top: -4px; right: -4px; }
  .corner-dot.sw { bottom: -4px; left: -4px; }
  .corner-dot.se { bottom: -4px; right: -4px; }

  /* Crosshair lines */
  .crosshair-h, .crosshair-v {
    position: fixed;
    background: rgba(233, 69, 96, 0.4);
    pointer-events: none;
    z-index: 10;
  }
  .crosshair-h { left: 0; right: 0; height: 1px; }
  .crosshair-v { top: 0; bottom: 0; width: 1px; }
</style>
</head>
<body>
  <div class="instructions" id="instructions">
    Click and drag to select a region, or click for a single point
    <div class="hint">Drag edges to resize &middot; Enter to confirm &middot; Escape to cancel</div>
  </div>
  <div class="coords-bar" id="coordsBar">X: 0, Y: 0</div>

  <div class="crosshair-h" id="crossH"></div>
  <div class="crosshair-v" id="crossV"></div>

  <div id="selection">
    <div class="handle handle-n" data-handle="n"></div>
    <div class="handle handle-s" data-handle="s"></div>
    <div class="handle handle-w" data-handle="w"></div>
    <div class="handle handle-e" data-handle="e"></div>
    <div class="handle handle-nw" data-handle="nw"></div>
    <div class="handle handle-ne" data-handle="ne"></div>
    <div class="handle handle-sw" data-handle="sw"></div>
    <div class="handle handle-se" data-handle="se"></div>
    <div class="corner-dot nw"></div>
    <div class="corner-dot ne"></div>
    <div class="corner-dot sw"></div>
    <div class="corner-dot se"></div>
  </div>

<script>
  const { ipcRenderer } = require('electron');
  const DISPLAY_OFFSET_X = ${displayOffsetX};
  const DISPLAY_OFFSET_Y = ${displayOffsetY};

  const selectionEl = document.getElementById('selection');
  const coordsBar = document.getElementById('coordsBar');
  const instructionsEl = document.getElementById('instructions');
  const crossH = document.getElementById('crossH');
  const crossV = document.getElementById('crossV');

  // --- State machine ---
  // Phases: 'idle' → 'drawing' → 'adjusting'
  let phase = 'idle';

  // Selection in screen coordinates
  let selX = 0, selY = 0, selW = 0, selH = 0;

  // Drawing state
  let drawStartClientX = 0, drawStartClientY = 0;
  let drawStartScreenX = 0, drawStartScreenY = 0;

  // Resize handle dragging state
  let activeHandle = null;
  let handleStartClientX = 0, handleStartClientY = 0;
  let handleStartSelX = 0, handleStartSelY = 0, handleStartSelW = 0, handleStartSelH = 0;

  function clientToScreen(clientX, clientY) {
    return { x: clientX + DISPLAY_OFFSET_X, y: clientY + DISPLAY_OFFSET_Y };
  }

  function screenToClient(screenX, screenY) {
    return { x: screenX - DISPLAY_OFFSET_X, y: screenY - DISPLAY_OFFSET_Y };
  }

  function updateSelectionElement() {
    const topLeft = screenToClient(selX, selY);
    selectionEl.style.left   = topLeft.x + 'px';
    selectionEl.style.top    = topLeft.y + 'px';
    selectionEl.style.width  = selW + 'px';
    selectionEl.style.height = selH + 'px';
  }

  function sendRegionUpdate() {
    ipcRenderer.send('picker:internal-update', {
      x: selX, y: selY, width: selW, height: selH
    });
  }

  function updateCoordsDisplay(screenX, screenY) {
    if (phase === 'idle') {
      coordsBar.textContent = 'X: ' + screenX + ', Y: ' + screenY;
    } else {
      coordsBar.textContent =
        'X: ' + selX + ', Y: ' + selY +
        '  W: ' + selW + ', H: ' + selH;
    }
  }

  // --- Crosshair ---
  document.addEventListener('mousemove', (e) => {
    const screen = clientToScreen(e.clientX, e.clientY);

    if (phase === 'idle') {
      crossH.style.display = 'block';
      crossV.style.display = 'block';
      crossH.style.top = e.clientY + 'px';
      crossV.style.left = e.clientX + 'px';
      updateCoordsDisplay(screen.x, screen.y);
    } else {
      crossH.style.display = 'none';
      crossV.style.display = 'none';
    }

    if (phase === 'drawing') {
      const startX = Math.min(drawStartScreenX, screen.x);
      const startY = Math.min(drawStartScreenY, screen.y);
      const endX   = Math.max(drawStartScreenX, screen.x);
      const endY   = Math.max(drawStartScreenY, screen.y);

      selX = startX;
      selY = startY;
      selW = Math.max(1, endX - startX);
      selH = Math.max(1, endY - startY);

      updateSelectionElement();
      updateCoordsDisplay(screen.x, screen.y);
      sendRegionUpdate();
    }

    if (phase === 'adjusting' && activeHandle) {
      const deltaX = e.clientX - handleStartClientX;
      const deltaY = e.clientY - handleStartClientY;
      resizeByHandle(activeHandle, deltaX, deltaY);
      updateSelectionElement();
      updateCoordsDisplay(screen.x, screen.y);
      sendRegionUpdate();
    }
  });

  // --- Drawing ---
  document.addEventListener('mousedown', (e) => {
    if (e.target.dataset && e.target.dataset.handle) {
      // Starting a resize drag on an existing selection
      activeHandle = e.target.dataset.handle;
      handleStartClientX = e.clientX;
      handleStartClientY = e.clientY;
      handleStartSelX = selX;
      handleStartSelY = selY;
      handleStartSelW = selW;
      handleStartSelH = selH;
      e.stopPropagation();
      return;
    }

    if (phase === 'adjusting') {
      // Clicking outside the selection while adjusting — start a new selection
    }

    // Start drawing a new selection
    phase = 'drawing';
    const screen = clientToScreen(e.clientX, e.clientY);
    drawStartClientX = e.clientX;
    drawStartClientY = e.clientY;
    drawStartScreenX = screen.x;
    drawStartScreenY = screen.y;

    selX = screen.x;
    selY = screen.y;
    selW = 1;
    selH = 1;

    selectionEl.classList.add('active');
    instructionsEl.style.display = 'none';
    updateSelectionElement();
  });

  document.addEventListener('mouseup', (e) => {
    if (activeHandle) {
      activeHandle = null;
      return;
    }

    if (phase === 'drawing') {
      phase = 'adjusting';
      // Ensure minimum 1x1
      selW = Math.max(1, selW);
      selH = Math.max(1, selH);
      updateSelectionElement();
      sendRegionUpdate();
    }
  });

  // --- Handle resizing ---
  function resizeByHandle(handle, deltaX, deltaY) {
    let newX = handleStartSelX;
    let newY = handleStartSelY;
    let newW = handleStartSelW;
    let newH = handleStartSelH;

    const movesNorth = handle.includes('n');
    const movesSouth = handle.includes('s');
    const movesWest  = handle.includes('w');
    const movesEast  = handle.includes('e');

    if (movesNorth) {
      newY = handleStartSelY + deltaY;
      newH = handleStartSelH - deltaY;
    }
    if (movesSouth) {
      newH = handleStartSelH + deltaY;
    }
    if (movesWest) {
      newX = handleStartSelX + deltaX;
      newW = handleStartSelW - deltaX;
    }
    if (movesEast) {
      newW = handleStartSelW + deltaX;
    }

    // Prevent negative dimensions by flipping
    if (newW < 1) { newX = newX + newW; newW = Math.abs(newW) || 1; }
    if (newH < 1) { newY = newY + newH; newH = Math.abs(newH) || 1; }

    selX = newX;
    selY = newY;
    selW = newW;
    selH = newH;
  }

  // --- Keyboard ---
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ipcRenderer.send('picker:internal-cancel');
    }
    if (e.key === 'Enter' && (phase === 'adjusting' || phase === 'drawing')) {
      ipcRenderer.send('picker:internal-confirm', {
        x: selX, y: selY, width: selW, height: selH
      });
    }
  });
</script>
</body>
</html>`;
}
