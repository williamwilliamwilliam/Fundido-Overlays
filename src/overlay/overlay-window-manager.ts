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

  /** Tracks which mirror region IDs are currently visible, updated when frame state arrives. */
  private visibleMirrorRegionIds = new Set<string>();

  /** Last frame state used for visibility evaluation. */
  private lastFrameState: FrameState | null = null;

  /** Returns the number of currently visible mirror regions (for diagnostics). */
  public getVisibleMirrorCount(): number {
    return this.visibleMirrorRegionIds.size;
  }

  /**
   * Creates, updates, or removes overlay windows to match the given groups.
   * Call this whenever the overlay group configuration changes.
   */
  public syncOverlayWindows(overlayGroups: OverlayGroup[]): void {
    const enabledGroups = overlayGroups.filter((group) => group.enabled !== false);
    const enabledGroupIds = new Set(enabledGroups.map((group) => group.id));

    // Close windows for groups that no longer exist or are disabled
    for (const [groupId, window] of this.overlayWindowsByGroupId) {
      const groupShouldClose = !enabledGroupIds.has(groupId);
      if (groupShouldClose) {
        logger.info(LogCategory.Overlay, `Closing overlay window for removed/disabled group: ${groupId}`);
        if (!window.isDestroyed()) window.close();
        this.overlayWindowsByGroupId.delete(groupId);
        this.overlayGroupConfigs.delete(groupId);
      }
    }

    // Create or update windows for each enabled group
    for (const group of enabledGroups) {
      this.overlayGroupConfigs.set(group.id, group);
      const existingWindow = this.overlayWindowsByGroupId.get(group.id);
      if (existingWindow && !existingWindow.isDestroyed()) {
        existingWindow.webContents.send('overlay:init', group);
      } else {
        this.createOverlayWindow(group);
      }
    }

    // Start or stop cursor tracking based on whether any enabled group uses relativeToCursor
    this.hasCursorFollowingGroups = enabledGroups.some(
      (group) => group.position.mode === 'relativeToCursor'
    );
    this.updateCursorTracking();
  }

  /**
   * Pushes updated frame state to all overlay windows so they can
   * re-evaluate rules and update their display.
   */
  public broadcastFrameState(frameState: FrameState): void {
    this.lastFrameState = frameState;
    this.updateVisibleMirrorRegionIds(frameState);

    for (const [_groupId, window] of this.overlayWindowsByGroupId) {
      if (!window.isDestroyed()) {
        window.webContents.send('overlay:frame-state', frameState);
      }
    }
  }

  /**
   * Evaluates overlay rules in the main process to determine which mirror
   * region IDs are currently visible. This avoids sending crop data for
   * hidden overlays on every frame.
   */
  private updateVisibleMirrorRegionIds(frameState: FrameState): void {
    const visibleIds = new Set<string>();

    for (const [_groupId, groupConfig] of this.overlayGroupConfigs) {
      // Evaluate group-level rules first
      const defaultMode = (groupConfig as any).defaultVisibilityMode || 'visible';
      let groupOverrideAction: string | null = defaultMode === 'hidden' ? 'hide' : 'show';
      let groupOverrideOpacity: number = defaultMode === 'opacity'
        ? ((groupConfig as any).defaultOpacity ?? 1)
        : 1;
      const groupRules = (groupConfig as any).rules || [];
      for (const rule of groupRules) {
        const conditionsMatch = this.evaluateConditions(
          rule.conditions || [],
          rule.logicMode || 'AND',
          frameState,
        );
        if (conditionsMatch) {
          groupOverrideAction = rule.action;
          groupOverrideOpacity = rule.opacityValue ?? 1;
        }
      }

      // If the group itself is hidden, nothing in it can render.
      if (groupOverrideAction === 'hide') continue;
      if (groupOverrideAction === 'opacity' && groupOverrideOpacity <= 0) continue;

      for (const overlay of (groupConfig.overlays || [])) {
        const isMirrorOverlay = overlay.contentType === 'regionMirror'
          && overlay.regionMirrorConfig?.monitoredRegionId;
        if (!isMirrorOverlay) continue;

        const regionId = overlay.regionMirrorConfig!.monitoredRegionId;

        // Group-level show/opacity affects only the group container.
        // Individual overlay rules still determine whether this overlay renders.
        const defaultVisible = overlay.defaultVisible !== false;
        let isVisible = defaultVisible;

        const rules = overlay.rules || [];
        for (const rule of rules) {
          const conditionsMatch = this.evaluateConditions(
            rule.conditions || [],
            rule.logicMode || 'AND',
            frameState,
          );
          if (conditionsMatch) {
            if (rule.action === 'show') isVisible = true;
            else if (rule.action === 'hide') isVisible = false;
            else if (rule.action === 'opacity') {
              const opacityIsEffectivelyHidden = (rule.opacityValue ?? 1) <= 0;
              isVisible = !opacityIsEffectivelyHidden;
            }
          }
        }

        if (isVisible) {
          visibleIds.add(regionId);
        }
      }
    }

    this.visibleMirrorRegionIds = visibleIds;
  }

  private evaluateConditions(
    conditions: any[],
    logicMode: string,
    frameState: FrameState,
  ): boolean {
    if (!conditions || conditions.length === 0) return true;

    for (const cond of conditions) {
      const regionState = frameState.regionStates.find(
        (rs: any) => rs.monitoredRegionId === cond.monitoredRegionId
      );
      if (!regionState) {
        // Missing region state means condition can't be evaluated
        if (logicMode === 'AND') return false;
        continue;
      }

      const calcResult = regionState.calculationResults.find(
        (cr: any) => cr.stateCalculationId === cond.stateCalculationId
      );
      if (!calcResult) {
        if (logicMode === 'AND') return false;
        continue;
      }

      let result = this.evaluateConditionOperator(cond, calcResult, frameState);
      if (cond.negate) result = !result;

      if (logicMode === 'OR' && result) return true;
      if (logicMode === 'AND' && !result) return false;
    }

    return logicMode === 'AND';
  }

  private evaluateConditionOperator(cond: any, calcResult: any, frameState: FrameState): boolean {
    if (cond.operator === 'equals') {
      return calcResult.currentValue === cond.value;
    }

    if (cond.operator === 'notEquals') {
      return calcResult.currentValue !== cond.value;
    }

    const instanceStates = (frameState as any).regionInstanceStates || [];
    const matchingInstances = instanceStates.filter(
      (instanceState: any) => instanceState.monitoredRegionId === cond.monitoredRegionId
    );

    if (matchingInstances.length === 0) {
      return false;
    }

    const matchingValues = matchingInstances.map((instanceState: any) =>
      instanceState.calculationResults.find(
        (instanceCalcResult: any) => instanceCalcResult.stateCalculationId === cond.stateCalculationId
      )?.currentValue
    );

    if (cond.operator === 'equalsAtLeastOnceAcrossRepeatedRegions') {
      return matchingValues.some((value: string | undefined) => value === cond.value);
    }

    if (cond.operator === 'equalsInEveryRepeatedRegion') {
      return matchingValues.every((value: string | undefined) => value === cond.value);
    }

    return true;
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

  /** Pre-allocated buffer for batching mirror crops. Grows as needed, never shrinks. */
  private batchedCropBuffer: Buffer = Buffer.alloc(0);

  /**
   * Extracts BGRA pixel crops for visible mirrored regions into a single
   * contiguous buffer and sends it with metadata to overlay windows.
   * One IPC message per overlay window with one Buffer — minimizes
   * structured clone overhead compared to many separate Buffers.
   */
  public broadcastMirrorCrops(
    frameBuffer: Buffer,
    frameWidth: number,
    frameHeight: number,
    monitoredRegions: any[],
    displayOriginX: number,
    displayOriginY: number,
    dpiScaleFactor: number,
  ): void {
    if (this.overlayWindowsByGroupId.size === 0) return;
    if (this.visibleMirrorRegionIds.size === 0) return;

    const regionById = new Map<string, any>();
    for (const region of monitoredRegions) {
      regionById.set(region.id, region);
    }

    const bytesPerPixel = 4;
    const frameRowBytes = frameWidth * bytesPerPixel;

    // First pass: compute total bytes needed and collect crop metadata
    const cropInfos: Array<{ id: string; clampedX: number; clampedY: number; clampedW: number; clampedH: number; cropBytes: number }> = [];
    let totalBytes = 0;

    for (const regionId of this.visibleMirrorRegionIds) {
      const region = regionById.get(regionId);
      if (!region || !region.bounds) continue;

      const physX = Math.round((region.bounds.x - displayOriginX) * dpiScaleFactor);
      const physY = Math.round((region.bounds.y - displayOriginY) * dpiScaleFactor);
      const physW = Math.round(region.bounds.width * dpiScaleFactor);
      const physH = Math.round(region.bounds.height * dpiScaleFactor);

      const clampedX = Math.max(0, Math.min(physX, frameWidth));
      const clampedY = Math.max(0, Math.min(physY, frameHeight));
      const clampedW = Math.min(physW, frameWidth - clampedX);
      const clampedH = Math.min(physH, frameHeight - clampedY);

      if (clampedW <= 0 || clampedH <= 0) continue;

      const cropBytes = clampedW * clampedH * bytesPerPixel;
      cropInfos.push({ id: regionId, clampedX, clampedY, clampedW, clampedH, cropBytes });
      totalBytes += cropBytes;
    }

    if (cropInfos.length === 0) return;

    // Grow the pre-allocated buffer if needed (never shrinks — avoids GC churn)
    if (this.batchedCropBuffer.length < totalBytes) {
      this.batchedCropBuffer = Buffer.allocUnsafe(totalBytes);
    }

    // Second pass: pack all crops into the pre-allocated buffer
    const cropMeta: Array<{ id: string; offset: number; width: number; height: number }> = [];
    let writeOffset = 0;

    for (const info of cropInfos) {
      const cropRowBytes = info.clampedW * bytesPerPixel;
      for (let row = 0; row < info.clampedH; row++) {
        const srcRowStart = (info.clampedY + row) * frameRowBytes + info.clampedX * bytesPerPixel;
        frameBuffer.copy(this.batchedCropBuffer, writeOffset + row * cropRowBytes, srcRowStart, srcRowStart + cropRowBytes);
      }
      cropMeta.push({ id: info.id, offset: writeOffset, width: info.clampedW, height: info.clampedH });
      writeOffset += info.cropBytes;
    }

    // Send a slice of the pre-allocated buffer (only the bytes we wrote)
    const message = { buffer: this.batchedCropBuffer.subarray(0, totalBytes), crops: cropMeta };
    for (const [_groupId, window] of this.overlayWindowsByGroupId) {
      if (!window.isDestroyed()) {
        window.webContents.send('overlay:mirror-batch', message);
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
        webSecurity: false,
      },
    });

    overlayWindow.setIgnoreMouseEvents(true);
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');

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
    transition: transform 30ms linear;
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
    if (overlayGroup.position.mode === 'relativeToCursor') {
      updateContainerTransform(overlayGroup, cursor.x, cursor.y);
    }
  });

  function getGroupScale(group) {
    return group && group.scale !== undefined ? group.scale : 1;
  }

  function updateContainerTransform(group, cursorX, cursorY) {
    const c = document.getElementById('overlay-container');
    if (!c || !group) return;

    const scale = getGroupScale(group);
    const p = group.position;
    const x = p.mode === 'relativeToCursor' ? cursorX + (p.offsetX || 0) : (p.x || 0);
    const y = p.mode === 'relativeToCursor' ? cursorY + (p.offsetY || 0) : (p.y || 0);
    c.style.transformOrigin = 'top left';
    c.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + scale + ')';
  }

  function applyGroupLayout(group) {
    const c = document.getElementById('overlay-container');
    const p = group.position;
    c.style.left = '0px';
    c.style.top = '0px';
    const dirMap = { right: 'row', left: 'row-reverse', down: 'column', up: 'column-reverse' };
    c.style.flexDirection = dirMap[group.growDirection] || 'row';
    const alMap = { start: 'flex-start', center: 'center', end: 'flex-end' };
    c.style.alignItems = alMap[group.alignment] || 'flex-start';
    c.style.gap = (group.gap !== undefined && group.gap !== null ? group.gap : 0) + 'px';
    updateContainerTransform(group, 0, 0);
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

  // ---- FAST PATH: Single batched buffer with all visible mirror crops ----
  ipcRenderer.on('overlay:mirror-batch', (_event, message) => {
    if (!message || !message.buffer || !message.crops) return;

    const batchedData = new Uint8Array(message.buffer.buffer || message.buffer);
    const canvases = document.querySelectorAll('canvas[data-mirror-region-id]');

    for (const canvas of canvases) {
      const regionId = canvas.dataset.mirrorRegionId;
      if (!regionId) continue;

      const meta = message.crops.find(function(m) { return m.id === regionId; });
      if (!meta) continue;

      const cropW = meta.width;
      const cropH = meta.height;
      const pixelCount = cropW * cropH;

      const mirrorScale = parseFloat(canvas.dataset.mirrorScale) || 1;
      const mirrorMaxW = parseInt(canvas.dataset.mirrorMaxWidth) || 0;
      const mirrorMaxH = parseInt(canvas.dataset.mirrorMaxHeight) || 0;

      var displayW = Math.round(cropW * mirrorScale);
      var displayH = Math.round(cropH * mirrorScale);
      if (mirrorMaxW > 0 && displayW > mirrorMaxW) {
        const r = mirrorMaxW / displayW;
        displayW = mirrorMaxW;
        displayH = Math.round(displayH * r);
      }
      if (mirrorMaxH > 0 && displayH > mirrorMaxH) {
        const r = mirrorMaxH / displayH;
        displayH = mirrorMaxH;
        displayW = Math.round(displayW * r);
      }

      canvas.style.width = displayW + 'px';
      canvas.style.height = displayH + 'px';
      canvas.width = cropW;
      canvas.height = cropH;

      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      // Read BGRA from the batched buffer at this crop's offset, convert to RGBA
      const rgba = new Uint8ClampedArray(pixelCount * 4);
      for (var i = 0; i < pixelCount; i++) {
        var px = i * 4;
        var sp = meta.offset + px;
        rgba[px]     = batchedData[sp + 2]; // R ← B
        rgba[px + 1] = batchedData[sp + 1]; // G
        rgba[px + 2] = batchedData[sp];     // B ← R
        rgba[px + 3] = 255;                 // A
      }

      const imgData = new ImageData(rgba, cropW, cropH);
      ctx.putImageData(imgData, 0, 0);
    }
  });

  // ---- LEGACY handlers (no-op, kept to avoid errors from stale messages) ----
  ipcRenderer.on('overlay:mirror-crops', function() {});
  ipcRenderer.on('overlay:mirror-meta', function() {});
  ipcRenderer.on('overlay:preview-frame', function() {});

  function applyDefaults(group) {
    const container = document.getElementById('overlay-container');
    if (container) {
      const groupDefaultMode = group.defaultVisibilityMode || 'visible';
      const groupDefaultOpacity = group.defaultOpacity !== undefined ? group.defaultOpacity : 1;
      container.style.display = groupDefaultMode === 'hidden' ? 'none' : '';
      container.style.opacity = groupDefaultMode === 'opacity' ? String(groupDefaultOpacity) : '1';
    }
    for (const ov of group.overlays) {
      const el = document.querySelector('[data-overlay-id="' + ov.id + '"]');
      if (!el) continue;
      el.style.display = (ov.defaultVisible !== false) ? '' : 'none';
      el.style.opacity = String(ov.defaultOpacity !== undefined ? ov.defaultOpacity : 1);
    }
  }

  function evaluateRules(group, frameState) {
    // --- Group-level rules: evaluated first and applied to the group container ---
    const groupDefaultMode = group.defaultVisibilityMode || 'visible';
    const groupDefaultOpacity = group.defaultOpacity !== undefined ? group.defaultOpacity : 1;
    let groupOverride = {
      action: groupDefaultMode === 'hidden' ? 'hide' : (groupDefaultMode === 'opacity' ? 'opacity' : 'show'),
      opacityValue: groupDefaultMode === 'opacity' ? groupDefaultOpacity : 1,
    };
    var groupRules = group.rules || [];
    for (var gi = 0; gi < groupRules.length; gi++) {
      var groupRule = groupRules[gi];
      if (evalConds(groupRule.conditions, groupRule.logicMode || 'AND', frameState)) {
        groupOverride = groupRule;
      }
    }

    const container = document.getElementById('overlay-container');
    if (container) {
      if (groupOverride.action === 'hide') {
        container.style.display = 'none';
        return;
      }

      if (groupOverride.action === 'opacity') {
        container.style.display = '';
        container.style.opacity = String(groupOverride.opacityValue !== undefined ? groupOverride.opacityValue : 1);
      } else if (groupOverride.action === 'show') {
        container.style.display = '';
        container.style.opacity = '1';
      }
    }

    for (const ov of group.overlays) {
      const el = document.querySelector('[data-overlay-id="' + ov.id + '"]');
      if (!el) continue;

      const defVis = ov.defaultVisible !== false;
      const defOp = ov.defaultOpacity !== undefined ? ov.defaultOpacity : 1;
      let vis = defVis, op = defOp;
      const rules = ov.rules || [];
      for (const rule of rules) {
        if (evalConds(rule.conditions, rule.logicMode || 'AND', frameState)) {
          if (rule.action === 'show') { vis = true; op = 1; }
          else if (rule.action === 'hide') { vis = false; }
          else if (rule.action === 'opacity') { vis = true; op = rule.opacityValue !== undefined ? rule.opacityValue : 1; }
        }
      }
      el.style.display = vis ? '' : 'none';
      el.style.opacity = String(op);
    }
  }

  function evalSingleCondition(c, fs) {
    const rs = fs.regionStates.find(r => r.monitoredRegionId === c.monitoredRegionId);
    if (!rs) return false;
    const cr = rs.calculationResults.find(r => r.stateCalculationId === c.stateCalculationId);
    if (!cr) return false;
    let result = evalConditionOperator(c, cr, fs);
    if (c.negate) result = !result;
    return result;
  }

  function evalConditionOperator(c, cr, fs) {
    if (c.operator === 'equals') return cr.currentValue === c.value;
    if (c.operator === 'notEquals') return cr.currentValue !== c.value;

    const instanceStates = fs.regionInstanceStates || [];
    const matchingInstances = instanceStates.filter((instanceState) =>
      instanceState.monitoredRegionId === c.monitoredRegionId
    );
    if (matchingInstances.length === 0) return false;

    const matchingValues = matchingInstances.map((instanceState) => {
      const instanceCalcResult = instanceState.calculationResults.find((r) => r.stateCalculationId === c.stateCalculationId);
      return instanceCalcResult ? instanceCalcResult.currentValue : undefined;
    });

    if (c.operator === 'equalsAtLeastOnceAcrossRepeatedRegions') {
      return matchingValues.some((value) => value === c.value);
    }
    if (c.operator === 'equalsInEveryRepeatedRegion') {
      return matchingValues.every((value) => value === c.value);
    }

    return true;
  }

  function evalConds(conds, logicMode, fs) {
    if (!conds || conds.length === 0) return true;
    if (logicMode === 'OR') {
      for (const c of conds) {
        if (evalSingleCondition(c, fs)) return true;
      }
      return false;
    }
    // AND (default)
    for (const c of conds) {
      if (!evalSingleCondition(c, fs)) return false;
    }
    return true;
  }
</script>
</body>
</html>`;
}
