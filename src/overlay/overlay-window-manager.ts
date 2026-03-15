import { BrowserWindow, screen } from 'electron';
import {
    OverlayGroup,
    OverlayGroupId,
    FrameState,
} from '../shared';
import { logger, LogCategory } from '../shared/logger';

/**
 * Manages the lifecycle of transparent, click-through overlay windows.
 *
 * Each overlay group gets its own BrowserWindow. This keeps rendering
 * isolated and makes it straightforward to position groups independently.
 */
export class OverlayWindowManager {
    private overlayWindowsByGroupId = new Map<OverlayGroupId, BrowserWindow>();
    private overlayGroupConfigs = new Map<OverlayGroupId, OverlayGroup>();
    private hasCursorFollowingGroups = false;

    /**
     * Creates, updates, or removes overlay windows to match the given groups.
     * Call this whenever the overlay group configuration changes.
     */
    public syncOverlayWindows(overlayGroups: OverlayGroup[]): void {
        const activeGroupIds = new Set(overlayGroups.map((group) => group.id));

        // Close windows for groups that no longer exist
        for (const [groupId, window] of this.overlayWindowsByGroupId) {
            const groupWasRemoved = !activeGroupIds.has(groupId);
            if (groupWasRemoved) {
                logger.info(LogCategory.Overlay, `Closing overlay window for removed group: ${groupId}`);
                if (!window.isDestroyed()) window.close();
                this.overlayWindowsByGroupId.delete(groupId);
                this.overlayGroupConfigs.delete(groupId);
            }
        }

        // Create or update windows for each group
        for (const group of overlayGroups) {
            this.overlayGroupConfigs.set(group.id, group);
            const existingWindow = this.overlayWindowsByGroupId.get(group.id);
            if (existingWindow && !existingWindow.isDestroyed()) {
                existingWindow.webContents.send('overlay:init', group);
            } else {
                this.createOverlayWindow(group);
            }
        }

        // Start or stop cursor tracking based on whether any group uses relativeToCursor
        this.hasCursorFollowingGroups = overlayGroups.some(
            (group) => group.position.mode === 'relativeToCursor'
        );
        this.updateCursorTracking();
    }

    /**
     * Pushes updated frame state to all overlay windows so they can
     * re-evaluate rules and update their display.
     */
    public broadcastFrameState(frameState: FrameState): void {
        for (const [_groupId, window] of this.overlayWindowsByGroupId) {
            if (!window.isDestroyed()) {
                window.webContents.send('overlay:frame-state', frameState);
            }
        }
    }

    /**
     * Sends preview frame data to overlay windows for region mirror rendering.
     * Includes monitored regions so mirrors can crop to specific region bounds.
     */
    public broadcastPreviewFrame(previewData: any, monitoredRegions: any[]): void {
        for (const [_groupId, window] of this.overlayWindowsByGroupId) {
            if (!window.isDestroyed()) {
                window.webContents.send('overlay:preview-frame', {
                    ...previewData,
                    monitoredRegions,
                });
            }
        }
    }

    /**
     * Closes all overlay windows. Called on app shutdown.
     */
    public closeAll(): void {
        this.stopCursorTracking();
        for (const [_groupId, window] of this.overlayWindowsByGroupId) {
            if (!window.isDestroyed()) {
                window.close();
            }
        }
        this.overlayWindowsByGroupId.clear();
        this.overlayGroupConfigs.clear();
    }

    private cursorTrackingActive = false;

    private updateCursorTracking(): void {
        const shouldTrack = this.hasCursorFollowingGroups;
        if (shouldTrack && !this.cursorTrackingActive) {
            this.startCursorTracking();
        } else if (!shouldTrack) {
            this.stopCursorTracking();
        }
    }

    private startCursorTracking(): void {
        this.cursorTrackingActive = true;

        const pollCursor = () => {
            if (!this.cursorTrackingActive) return;

            const cursorPoint = screen.getCursorScreenPoint();
            for (const [_groupId, window] of this.overlayWindowsByGroupId) {
                if (!window.isDestroyed()) {
                    window.webContents.send('overlay:cursor-position', {
                        x: cursorPoint.x,
                        y: cursorPoint.y,
                    });
                }
            }

            setImmediate(pollCursor);
        };

        setImmediate(pollCursor);
    }

    private stopCursorTracking(): void {
        this.cursorTrackingActive = false;
    }

    private createOverlayWindow(group: OverlayGroup): void {
        logger.info(LogCategory.Overlay, `Creating overlay window for group: "${group.name}" (${group.id})`);

        const primaryDisplay = screen.getPrimaryDisplay();
        const displayBounds = primaryDisplay.bounds;

        const overlayWindow = new BrowserWindow({
            x: displayBounds.x,
            y: displayBounds.y,
            width: displayBounds.width,
            height: displayBounds.height,
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
                webSecurity: false, // Allow loading local file:// images from data URL origin
            },
        });

        overlayWindow.setIgnoreMouseEvents(true);
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');

        // Load inline HTML as a data URL to avoid file path issues between src/ and dist/
        const html = buildOverlayRendererHtml();
        overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

        overlayWindow.webContents.once('did-finish-load', () => {
            overlayWindow.webContents.send('overlay:init', group);
        });

        this.overlayWindowsByGroupId.set(group.id, overlayWindow);
    }
}

// ---------------------------------------------------------------------------
// Inline overlay renderer HTML
// ---------------------------------------------------------------------------

function buildOverlayRendererHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    background: transparent;
    overflow: hidden;
    user-select: none;
  }
  #overlay-container {
    position: absolute;
    display: flex;
    will-change: transform;
    transition: transform 5ms linear;
  }
  .overlay-item {
    transition: opacity 0.15s ease;
  }
</style>
</head>
<body>
<div id="overlay-container"></div>
<script>
  const { ipcRenderer } = require('electron');

  let overlayGroup = null;

  ipcRenderer.on('overlay:init', (_event, group) => {
    overlayGroup = group;
    applyGroupLayout(group);
    renderOverlayElements(group);
    applyDefaults(group);
  });

  ipcRenderer.on('overlay:frame-state', (_event, frameState) => {
    if (overlayGroup) evaluateRules(overlayGroup, frameState);
  });

  // Cursor tracking: main process polls at ~120Hz and sends position via IPC.
  // We apply it directly via GPU-composited transform — no lerp, no rAF delay.
  ipcRenderer.on('overlay:cursor-position', (_event, cursor) => {
    if (!overlayGroup) return;
    const p = overlayGroup.position;
    if (p.mode === 'relativeToCursor') {
      const x = cursor.x + (p.offsetX || 0);
      const y = cursor.y + (p.offsetY || 0);
      const c = document.getElementById('overlay-container');
      c.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    }
  });

  function applyGroupLayout(group) {
    const c = document.getElementById('overlay-container');
    const p = group.position;
    if (p.mode === 'absolute') {
      c.style.left = p.x + 'px';
      c.style.top = p.y + 'px';
    } else if (p.mode === 'relativeToCursor') {
      // Position is set by the renderer's requestAnimationFrame cursor loop via transform
      c.style.left = '0px';
      c.style.top = '0px';
    }
    const dirMap = { right: 'row', left: 'row-reverse', down: 'column', up: 'column-reverse' };
    c.style.flexDirection = dirMap[group.growDirection] || 'row';
    const alMap = { start: 'flex-start', center: 'center', end: 'flex-end' };
    c.style.alignItems = alMap[group.alignment] || 'flex-start';
    c.style.gap = (group.gap !== undefined && group.gap !== null ? group.gap : 0) + 'px';
  }

  function renderOverlayElements(group) {
    const c = document.getElementById('overlay-container');
    c.innerHTML = '';
    for (const ov of group.overlays) {
      const el = document.createElement('div');
      el.classList.add('overlay-item');
      el.dataset.overlayId = ov.id;
      if (ov.contentType === 'text' && ov.textConfig) renderText(el, ov.textConfig);
      else if (ov.contentType === 'image' && ov.imageConfig) renderImage(el, ov.imageConfig);
      else if (ov.contentType === 'regionMirror') renderMirror(el, ov.regionMirrorConfig);
      c.appendChild(el);
    }
  }

  function renderText(el, cfg) {
    el.style.fontFamily = cfg.fontFamily || 'Segoe UI';
    el.style.fontSize = (cfg.fontSize || 16) + 'px';
    el.style.fontWeight = cfg.fontWeight || 'normal';
    el.style.fontStyle = cfg.fontStyle || 'normal';
    el.style.color = cfg.color || '#ffffff';
    el.style.backgroundColor = cfg.backgroundColor || 'rgba(0,0,0,0.6)';
    el.style.padding = (cfg.padding || 4) + 'px';
    el.style.borderRadius = '4px';
    el.style.whiteSpace = 'nowrap';
    el.textContent = cfg.text || '';
  }

  function renderImage(el, cfg) {
    if (!cfg || !cfg.filePath) return;
    const img = document.createElement('img');
    // Convert Windows path to file:// URL
    let fileSrc = cfg.filePath;
    const isAbsoluteWindowsPath = /^[A-Za-z]:/.test(fileSrc);
    if (isAbsoluteWindowsPath) {
      fileSrc = 'file:///' + fileSrc.replace(/\\\\/g, '/');
    }
    img.src = fileSrc;
    img.alt = '';
    img.onerror = function() { el.textContent = '[Image not found]'; el.style.color = '#ff4444'; el.style.fontSize = '12px'; };
    const s = cfg.size || {};
    if (s.scale && s.scale !== 1.0) { img.style.transform = 'scale(' + s.scale + ')'; img.style.transformOrigin = 'top left'; }
    if (s.width) img.style.width = s.width + 'px';
    if (s.height) img.style.height = s.height + 'px';
    if (s.maxWidth) img.style.maxWidth = s.maxWidth + 'px';
    if (s.maxHeight) img.style.maxHeight = s.maxHeight + 'px';
    el.appendChild(img);
  }

  function renderMirror(el, cfg) {
    if (!cfg) return;
    const s = cfg.size || {};
    const canvas = document.createElement('canvas');
    canvas.dataset.mirrorRegionId = cfg.monitoredRegionId || '';
    canvas.dataset.mirrorScale = String(s.scale || 1);
    canvas.dataset.mirrorMaxWidth = String(s.maxWidth || 0);
    canvas.dataset.mirrorMaxHeight = String(s.maxHeight || 0);
    canvas.style.imageRendering = 'auto';
    canvas.style.display = 'block';
    // Internal resolution set when first frame arrives; CSS size controls layout
    canvas.width = 2;
    canvas.height = 2;
    el.appendChild(canvas);
  }

  // Shared Image object for decoding preview frames
  let previewImg = null;
  let previewImgReady = false;

  // Update mirror overlays by cropping the preview frame to each region's bounds
  ipcRenderer.on('overlay:preview-frame', (_event, previewData) => {
    if (!previewData || !previewData.imageDataUrl) return;

    const regions = previewData.monitoredRegions || [];
    const originX = previewData.displayOriginX || 0;
    const originY = previewData.displayOriginY || 0;
    const dpiScale = previewData.displayScaleFactor || 1;
    const origW = previewData.originalWidth;
    const origH = previewData.originalHeight;
    const prevW = previewData.previewWidth;
    const prevH = previewData.previewHeight;

    const img = new Image();
    img.onload = function() {
      const canvases = document.querySelectorAll('canvas[data-mirror-region-id]');
      for (const canvas of canvases) {
        const regionId = canvas.dataset.mirrorRegionId;
        if (!regionId) continue;

        const region = regions.find(function(r) { return r.id === regionId; });
        if (!region || !region.bounds) continue;

        const bounds = region.bounds;
        const mirrorScale = parseFloat(canvas.dataset.mirrorScale) || 1;
        const mirrorMaxW = parseInt(canvas.dataset.mirrorMaxWidth) || 0;
        const mirrorMaxH = parseInt(canvas.dataset.mirrorMaxHeight) || 0;

        // Compute the display size based on the region's logical pixel size and scale
        var displayW = Math.round(bounds.width * mirrorScale);
        var displayH = Math.round(bounds.height * mirrorScale);

        // Apply max constraints
        if (mirrorMaxW > 0 && displayW > mirrorMaxW) {
          const constrainRatio = mirrorMaxW / displayW;
          displayW = mirrorMaxW;
          displayH = Math.round(displayH * constrainRatio);
        }
        if (mirrorMaxH > 0 && displayH > mirrorMaxH) {
          const constrainRatio = mirrorMaxH / displayH;
          displayH = mirrorMaxH;
          displayW = Math.round(displayW * constrainRatio);
        }

        // Set canvas internal resolution to display size (good enough for overlays)
        canvas.width = displayW;
        canvas.height = displayH;
        // Set CSS size to match so layout uses the correct dimensions
        canvas.style.width = displayW + 'px';
        canvas.style.height = displayH + 'px';

        // Convert screen-absolute logical coords to physical then to preview coords
        const physX = (bounds.x - originX) * dpiScale;
        const physY = (bounds.y - originY) * dpiScale;
        const physW = bounds.width * dpiScale;
        const physH = bounds.height * dpiScale;

        const scaleToPreviewX = prevW / origW;
        const scaleToPreviewY = prevH / origH;

        const srcX = physX * scaleToPreviewX;
        const srcY = physY * scaleToPreviewY;
        const srcW = physW * scaleToPreviewX;
        const srcH = physH * scaleToPreviewY;

        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
      }
    };
    img.src = previewData.imageDataUrl;
  });

  function applyDefaults(group) {
    for (const ov of group.overlays) {
      const el = document.querySelector('[data-overlay-id="' + ov.id + '"]');
      if (!el) continue;
      el.style.display = (ov.defaultVisible !== false) ? '' : 'none';
      el.style.opacity = String(ov.defaultOpacity !== undefined ? ov.defaultOpacity : 1);
    }
  }

  function evaluateRules(group, frameState) {
    for (const ov of group.overlays) {
      const el = document.querySelector('[data-overlay-id="' + ov.id + '"]');
      if (!el) continue;
      const defVis = ov.defaultVisible !== false;
      const defOp = ov.defaultOpacity !== undefined ? ov.defaultOpacity : 1;
      let vis = defVis, op = defOp;
      const rules = ov.rules || [];
      for (const rule of rules) {
        if (evalConds(rule.conditions, frameState)) {
          if (rule.action === 'show') { vis = true; op = 1; }
          else if (rule.action === 'hide') { vis = false; }
          else if (rule.action === 'opacity') { vis = true; op = rule.opacityValue !== undefined ? rule.opacityValue : 1; }
          break;
        }
      }
      el.style.display = vis ? '' : 'none';
      el.style.opacity = String(op);
    }
  }

  function evalConds(conds, fs) {
    if (!conds || conds.length === 0) return true;
    for (const c of conds) {
      const rs = fs.regionStates.find(r => r.monitoredRegionId === c.monitoredRegionId);
      if (!rs) return false;
      const cr = rs.calculationResults.find(r => r.stateCalculationId === c.stateCalculationId);
      if (!cr) return false;
      if (c.operator === 'equals' && cr.currentValue !== c.value) return false;
      if (c.operator === 'notEquals' && cr.currentValue === c.value) return false;
    }
    return true;
  }
</script>
</body>
</html>`;
}