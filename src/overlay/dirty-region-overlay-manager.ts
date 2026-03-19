import { BrowserWindow, screen } from 'electron';

export interface DirtyRegionOverlayItem {
  id: string;
  name: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Renders temporary non-interactive screen overlays for unsaved monitored regions.
 * One transparent window is created per display and receives only the region
 * outlines that intersect that display.
 */
export class DirtyRegionOverlayManager {
  private windowsByDisplayId = new Map<number, BrowserWindow>();
  private currentRegions: DirtyRegionOverlayItem[] = [];

  public showRegions(regions: DirtyRegionOverlayItem[]): void {
    this.currentRegions = regions.filter((region) =>
      region.bounds.width > 0 && region.bounds.height > 0
    );

    if (this.currentRegions.length === 0) {
      this.closeAll();
      return;
    }

    const displays = screen.getAllDisplays();
    const activeDisplayIds = new Set(displays.map((display) => display.id));

    for (const [displayId, window] of this.windowsByDisplayId) {
      if (!activeDisplayIds.has(displayId)) {
        if (!window.isDestroyed()) {
          window.close();
        }
        this.windowsByDisplayId.delete(displayId);
      }
    }

    for (const display of displays) {
      let overlayWindow = this.windowsByDisplayId.get(display.id);
      if (!overlayWindow || overlayWindow.isDestroyed()) {
        overlayWindow = this.createWindowForDisplay(display);
        this.windowsByDisplayId.set(display.id, overlayWindow);
      }

      overlayWindow.setBounds(display.bounds);
      overlayWindow.webContents.send('dirty-region-overlay:update', {
        displayBounds: display.bounds,
        regions: this.currentRegions,
      });
      overlayWindow.showInactive();
    }
  }

  public closeAll(): void {
    for (const [_displayId, window] of this.windowsByDisplayId) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    this.windowsByDisplayId.clear();
    this.currentRegions = [];
  }

  private createWindowForDisplay(display: Electron.Display): BrowserWindow {
    const overlayWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
      },
    });

    overlayWindow.setIgnoreMouseEvents(true);
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.buildOverlayHtml())}`);

    overlayWindow.on('closed', () => {
      this.windowsByDisplayId.delete(display.id);
    });

    overlayWindow.webContents.once('did-finish-load', () => {
      overlayWindow.webContents.send('dirty-region-overlay:update', {
        displayBounds: display.bounds,
        regions: this.currentRegions,
      });
    });

    return overlayWindow;
  }

  private buildOverlayHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
    pointer-events: none;
    font-family: 'Segoe UI', sans-serif;
  }
  #root {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .region-box {
    position: absolute;
    outline: 5px solid #000000;
    outline-offset: 0;
    background: transparent;
  }
  .region-label {
    position: absolute;
    left: -2px;
    bottom: calc(100% + 6px);
    max-width: min(580px, calc(100vw - 50px));
    padding: 3px 8px;
    border-radius: 5px;
    background: #000000;
    color: #fff;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }
</style>
</head>
<body>
  <div id="root"></div>
  <script>
    const { ipcRenderer } = require('electron');
    const root = document.getElementById('root');

    function clamp(value, min, max) {
      return Math.max(min, Math.min(value, max));
    }

    ipcRenderer.on('dirty-region-overlay:update', (_event, payload) => {
      if (!payload || !payload.displayBounds || !Array.isArray(payload.regions)) {
        root.innerHTML = '';
        return;
      }

      const displayBounds = payload.displayBounds;
      root.innerHTML = '';

      for (const region of payload.regions) {
        const overlayPadding = 18;
        const right = region.bounds.x + region.bounds.width;
        const bottom = region.bounds.y + region.bounds.height;
        const displayRight = displayBounds.x + displayBounds.width;
        const displayBottom = displayBounds.y + displayBounds.height;

        const intersectLeft = Math.max(region.bounds.x, displayBounds.x);
        const intersectTop = Math.max(region.bounds.y, displayBounds.y);
        const intersectRight = Math.min(right, displayRight);
        const intersectBottom = Math.min(bottom, displayBottom);

        if (intersectRight <= intersectLeft || intersectBottom <= intersectTop) {
          continue;
        }

        const box = document.createElement('div');
        box.className = 'region-box';
        box.style.left = (intersectLeft - displayBounds.x - overlayPadding) + 'px';
        box.style.top = (intersectTop - displayBounds.y - overlayPadding) + 'px';
        box.style.width = (intersectRight - intersectLeft + (overlayPadding * 2)) + 'px';
        box.style.height = (intersectBottom - intersectTop + (overlayPadding * 2)) + 'px';

        const label = document.createElement('div');
        label.className = 'region-label';
        label.textContent = region.name || 'Unnamed Region';
        const availableWidth = intersectRight - intersectLeft;
        label.style.maxWidth = '580px';

        box.appendChild(label);
        root.appendChild(box);
      }
    });
  </script>
</body>
</html>`;
  }
}
