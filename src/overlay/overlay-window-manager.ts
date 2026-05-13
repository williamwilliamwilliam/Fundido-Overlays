import { BrowserWindow, screen } from 'electron';
import {
  OverlayGroup,
  OverlayGroupId,
  FrameState,
} from '../shared';
import { logger, LogCategory } from '../shared/logger';

/**
 * Manages a single transparent, click-through overlay BrowserWindow that
 * renders all enabled overlay groups. Using one window instead of one per
 * group eliminates N-1 extra GPU compositor passes — a meaningful performance
 * win when multiple groups are active simultaneously.
 */
export class OverlayWindowManager {
  /** The single shared overlay window. Null when no groups are enabled. */
  private overlayWindow: BrowserWindow | null = null;

  /** Config map used by the main process for rule evaluation (mirror visibility). */
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
   * Synchronises the overlay window to match the given list of groups.
   * Creates the window on first call, sends `overlay:groups-sync` to update
   * the renderer when it already exists, and closes it when no groups remain.
   * One BrowserWindow is reused across all groups — no per-group compositor pass.
   */
  public syncOverlayWindows(overlayGroups: OverlayGroup[]): void {
    const enabledGroups = overlayGroups.filter((group) => group.enabled !== false);

    // Keep the main-process config map in sync for mirror-visibility evaluation.
    this.overlayGroupConfigs.clear();
    for (const group of enabledGroups) {
      this.overlayGroupConfigs.set(group.id, group);
    }

    if (enabledGroups.length === 0) {
      const windowExistsAndIsOpen = this.overlayWindow && !this.overlayWindow.isDestroyed();
      if (windowExistsAndIsOpen) {
        logger.info(LogCategory.Overlay, 'No enabled overlay groups — closing overlay window.');
        this.overlayWindow!.close();
        this.overlayWindow = null;
      }
      this.hasCursorFollowingGroups = false;
      this.updateCursorTracking();
      return;
    }

    const windowNeedsCreation = !this.overlayWindow || this.overlayWindow.isDestroyed();
    if (windowNeedsCreation) {
      this.createOverlayWindow(enabledGroups);
    } else {
      // Window already exists — send the updated group list; renderer diffs and patches the DOM.
      this.overlayWindow!.webContents.send('overlay:groups-sync', enabledGroups);
    }

    this.hasCursorFollowingGroups = enabledGroups.some(
      (group) => group.position.mode === 'relativeToCursor',
    );
    this.updateCursorTracking();
  }

  /**
   * Pushes updated frame state to the overlay window so it can
   * re-evaluate rules and update its display.
   */
  public broadcastFrameState(frameState: FrameState): void {
    this.lastFrameState = frameState;
    this.updateVisibleMirrorRegionIds(frameState);

    const windowIsOpen = this.overlayWindow && !this.overlayWindow.isDestroyed();
    if (windowIsOpen) {
      this.overlayWindow!.webContents.send('overlay:frame-state', frameState);
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

    if (cond.operator === 'equalsAtLeastNTimesAcrossRepeatedRegions') {
      const minCount = cond.minimumCount ?? 1;
      return matchingValues.filter((value: string | undefined) => value === cond.value).length >= minCount;
    }

    if (cond.operator === 'equalsInEverySelectedRepeatedRegion' || cond.operator === 'equalsAtLeastOnceInSelectedRepeatedRegions') {
      const selectedKeys: string[] = cond.selectedRepeatInstances || [];
      const selectedInstances = matchingInstances.filter(
        (instanceState: any) => selectedKeys.includes(`${instanceState.repeatIndexX}_${instanceState.repeatIndexY}`),
      );
      if (selectedInstances.length === 0) return false;
      const selectedValues = selectedInstances.map((instanceState: any) =>
        instanceState.calculationResults.find((r: any) => r.stateCalculationId === cond.stateCalculationId)?.currentValue,
      );
      if (cond.operator === 'equalsInEverySelectedRepeatedRegion') {
        return selectedValues.every((value: string | undefined) => value === cond.value);
      }
      return selectedValues.some((value: string | undefined) => value === cond.value);
    }

    return true;
  }

  /**
   * Sends preview frame data to the overlay window for region mirror rendering.
   * Includes monitored regions so mirrors can crop to specific region bounds.
   */
  public broadcastPreviewFrame(previewData: any, monitoredRegions: any[]): void {
    const windowIsOpen = this.overlayWindow && !this.overlayWindow.isDestroyed();
    if (windowIsOpen) {
      this.overlayWindow!.webContents.send('overlay:preview-frame', {
        ...previewData,
        monitoredRegions,
      });
    }
  }

  /** Pre-allocated buffer for batching mirror crops. Grows as needed, never shrinks. */
  private batchedCropBuffer: Buffer = Buffer.alloc(0);

  /**
   * Extracts BGRA pixel crops for visible mirrored regions into a single
   * contiguous buffer and sends it to the overlay window.
   * One IPC message, one Buffer — minimizes structured clone overhead.
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
    const windowIsOpen = this.overlayWindow && !this.overlayWindow.isDestroyed();
    if (!windowIsOpen) return;
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
    this.overlayWindow!.webContents.send('overlay:mirror-batch', message);
  }

  /**
   * Closes the overlay window. Called on global disable and app shutdown.
   */
  public closeAll(): void {
    this.stopCursorTracking();
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
    }
    this.overlayWindow = null;
    this.overlayGroupConfigs.clear();
  }

  private cursorFrequencyHz: 60 | 120 = 60;
  private cursorIntervalHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Updates the cursor polling rate. If tracking is already active, restarts
   * the interval immediately so the change takes effect without a config reload.
   */
  public setCursorFrequencyHz(hz: 60 | 120): void {
    this.cursorFrequencyHz = hz;
    const isCurrentlyTracking = this.cursorIntervalHandle !== null;
    if (isCurrentlyTracking) {
      this.stopCursorTracking();
      this.startCursorTracking();
    }
  }

  private updateCursorTracking(): void {
    const shouldTrack = this.hasCursorFollowingGroups;
    const isCurrentlyTracking = this.cursorIntervalHandle !== null;
    if (shouldTrack && !isCurrentlyTracking) {
      this.startCursorTracking();
    } else if (!shouldTrack && isCurrentlyTracking) {
      this.stopCursorTracking();
    }
  }

  private startCursorTracking(): void {
    const intervalMs = Math.round(1000 / this.cursorFrequencyHz);
    this.cursorIntervalHandle = setInterval(() => {
      const windowIsOpen = this.overlayWindow && !this.overlayWindow.isDestroyed();
      if (windowIsOpen) {
        const cursorPoint = screen.getCursorScreenPoint();
        this.overlayWindow!.webContents.send('overlay:cursor-position', {
          x: cursorPoint.x,
          y: cursorPoint.y,
        });
      }
    }, intervalMs);
  }

  private stopCursorTracking(): void {
    if (this.cursorIntervalHandle !== null) {
      clearInterval(this.cursorIntervalHandle);
      this.cursorIntervalHandle = null;
    }
  }

  private createOverlayWindow(initialGroups: OverlayGroup[]): void {
    logger.info(LogCategory.Overlay, `Creating shared overlay window for ${initialGroups.length} group(s).`);

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
        // The overlay window is focusable: false and can never receive OS focus,
        // so Chromium permanently classifies it as a background page and throttles
        // its renderer task queue — causing IPC messages to stall for up to ~1s
        // before being processed, which manifests as the overlay freezing.
        backgroundThrottling: false,
      },
    });

    overlayWindow.setIgnoreMouseEvents(true);
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');

    const html = buildOverlayRendererHtml();
    overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    overlayWindow.webContents.once('did-finish-load', () => {
      overlayWindow.webContents.send('overlay:groups-sync', initialGroups);
    });

    this.overlayWindow = overlayWindow;
  }
}

// ---------------------------------------------------------------------------
// Inline overlay renderer HTML — manages ALL groups in one document
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
  .group-overlay-container {
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
<script>
  const { ipcRenderer } = require('electron');

  // All active groups, keyed by group ID
  const overlayGroupsById = new Map();
  // The root container element for each group, keyed by group ID
  const groupContainerElementById = new Map();

  // ---------------------------------------------------------------------------
  // overlay:groups-sync — full diff/patch of the active group set
  // ---------------------------------------------------------------------------

  ipcRenderer.on('overlay:groups-sync', (_event, groups) => {
    const incomingGroupIds = new Set(groups.map(function(g) { return g.id; }));

    // Remove containers for groups that are no longer in the list
    for (const [groupId, containerEl] of groupContainerElementById) {
      const groupWasRemoved = !incomingGroupIds.has(groupId);
      if (groupWasRemoved) {
        containerEl.remove();
        groupContainerElementById.delete(groupId);
        overlayGroupsById.delete(groupId);
      }
    }

    // Add new groups or refresh existing ones
    for (const group of groups) {
      overlayGroupsById.set(group.id, group);
      const existingContainerEl = groupContainerElementById.get(group.id);
      if (existingContainerEl) {
        // Group already has a container — update layout and overlay elements
        applyGroupLayout(group, existingContainerEl);
        renderOverlayElements(group, existingContainerEl);
        applyDefaults(group, existingContainerEl);
      } else {
        // New group — create its container and add it to the document
        const newContainerEl = createGroupContainer(group);
        document.body.appendChild(newContainerEl);
        groupContainerElementById.set(group.id, newContainerEl);
      }
    }
  });

  function createGroupContainer(group) {
    const containerEl = document.createElement('div');
    containerEl.classList.add('group-overlay-container');
    containerEl.dataset.groupId = group.id;
    applyGroupLayout(group, containerEl);
    renderOverlayElements(group, containerEl);
    applyDefaults(group, containerEl);
    return containerEl;
  }

  // ---------------------------------------------------------------------------
  // Frame state — evaluate rules for every active group
  // ---------------------------------------------------------------------------

  ipcRenderer.on('overlay:frame-state', (_event, frameState) => {
    for (const [groupId, group] of overlayGroupsById) {
      const containerEl = groupContainerElementById.get(groupId);
      if (containerEl) evaluateRules(group, frameState, containerEl);
    }
  });

  // ---------------------------------------------------------------------------
  // Cursor tracking — update all relativeToCursor groups from one IPC message
  // ---------------------------------------------------------------------------

  ipcRenderer.on('overlay:cursor-position', (_event, cursor) => {
    for (const [groupId, group] of overlayGroupsById) {
      if (group.position.mode === 'relativeToCursor') {
        const containerEl = groupContainerElementById.get(groupId);
        if (containerEl) updateContainerTransform(group, containerEl, cursor.x, cursor.y);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Mirror batch — querySelectorAll spans the whole document naturally
  // ---------------------------------------------------------------------------

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

  // Legacy no-ops: kept to avoid errors if stale messages arrive
  ipcRenderer.on('overlay:mirror-crops', function() {});
  ipcRenderer.on('overlay:mirror-meta', function() {});
  ipcRenderer.on('overlay:preview-frame', function() {});
  // overlay:init is no longer sent; guard against stale messages from old builds
  ipcRenderer.on('overlay:init', function() {});

  // ---------------------------------------------------------------------------
  // Layout helpers
  // ---------------------------------------------------------------------------

  function getGroupScale(group) {
    return group && group.scale !== undefined ? group.scale : 1;
  }

  function updateContainerTransform(group, containerEl, cursorX, cursorY) {
    if (!containerEl || !group) return;
    const scale = getGroupScale(group);
    const p = group.position;
    const x = p.mode === 'relativeToCursor' ? cursorX + (p.offsetX || 0) : (p.x || 0);
    const y = p.mode === 'relativeToCursor' ? cursorY + (p.offsetY || 0) : (p.y || 0);

    // transformOrigin is intentionally NOT set here — it is fixed for the
    // lifetime of the element and set once in applyGroupLayout. Writing it
    // here would be a wasted style mutation on every cursor tick at 60–120 Hz.
    //
    // The translate direction depends on which edge is the anchor:
    //   right / down → translate from top-left (left:0, top:0 baseline)
    //   left          → translate from top-right (right:0 baseline); x represents
    //                   the right edge, so tx = x - 100vw places right edge at x
    //   up            → translate from bottom-left (bottom:0 baseline); y represents
    //                   the bottom edge, so ty = y - 100vh places bottom edge at y
    const growsLeft = group.growDirection === 'left';
    const growsUp   = group.growDirection === 'up';
    const tx = growsLeft ? 'calc(' + x + 'px - 100vw)' : x + 'px';
    const ty = growsUp   ? 'calc(' + y + 'px - 100vh)' : y + 'px';
    containerEl.style.transform = 'translate(' + tx + ', ' + ty + ') scale(' + scale + ')';
  }

  function applyGroupLayout(group, containerEl) {
    // Anchor edge depends on the grow direction so that the configured x,y
    // coordinate always represents the corner where items START, not where
    // the container's top-left corner happens to land.
    //   right / down → anchor top-left  (items grow right / down from x,y)
    //   left          → anchor top-right (items grow left  from x,y)
    //   up            → anchor bottom-left (items grow up  from x,y)
    const growsLeft = group.growDirection === 'left';
    const growsUp   = group.growDirection === 'up';

    containerEl.style.left   = growsLeft ? 'auto' : '0px';
    containerEl.style.right  = growsLeft ? '0px'  : 'auto';
    containerEl.style.top    = growsUp   ? 'auto' : '0px';
    containerEl.style.bottom = growsUp   ? '0px'  : 'auto';

    // Match the scale origin to the anchor corner so scale(n) zooms in/out
    // from the position coordinate rather than from some other corner.
    const originH = growsLeft ? 'right' : 'left';
    const originV = growsUp   ? 'bottom' : 'top';
    containerEl.style.transformOrigin = originV + ' ' + originH;

    const dirMap = { right: 'row', left: 'row-reverse', down: 'column', up: 'column-reverse' };
    containerEl.style.flexDirection = dirMap[group.growDirection] || 'row';
    const alMap = { start: 'flex-start', center: 'center', end: 'flex-end' };
    containerEl.style.alignItems = alMap[group.alignment] || 'flex-start';
    containerEl.style.gap = (group.gap !== undefined && group.gap !== null ? group.gap : 0) + 'px';
    updateContainerTransform(group, containerEl, 0, 0);
  }

  function renderOverlayElements(group, containerEl) {
    containerEl.innerHTML = '';
    for (const ov of group.overlays) {
      const el = document.createElement('div');
      el.classList.add('overlay-item');
      el.dataset.overlayId = ov.id;
      if (ov.contentType === 'text' && ov.textConfig) renderText(el, ov.textConfig);
      else if (ov.contentType === 'image' && ov.imageConfig) renderImage(el, ov.imageConfig);
      else if (ov.contentType === 'regionMirror') renderMirror(el, ov.regionMirrorConfig);
      containerEl.appendChild(el);
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
    canvas.width = 2;
    canvas.height = 2;
    el.appendChild(canvas);
  }

  // ---------------------------------------------------------------------------
  // Visibility / rule evaluation — scoped to a single group's container element
  // ---------------------------------------------------------------------------

  function applyDefaults(group, containerEl) {
    const groupDefaultMode = group.defaultVisibilityMode || 'visible';
    const groupDefaultOpacity = group.defaultOpacity !== undefined ? group.defaultOpacity : 1;
    containerEl.style.display = groupDefaultMode === 'hidden' ? 'none' : '';
    containerEl.style.opacity = groupDefaultMode === 'opacity' ? String(groupDefaultOpacity) : '1';

    for (const ov of group.overlays) {
      const el = containerEl.querySelector('[data-overlay-id="' + ov.id + '"]');
      if (!el) continue;
      el.style.display = (ov.defaultVisible !== false) ? '' : 'none';
      el.style.opacity = String(ov.defaultOpacity !== undefined ? ov.defaultOpacity : 1);
    }
  }

  function evaluateRules(group, frameState, containerEl) {
    // Group-level rules applied to the container element
    const groupDefaultMode = group.defaultVisibilityMode || 'visible';
    const groupDefaultOpacity = group.defaultOpacity !== undefined ? group.defaultOpacity : 1;
    let groupOverride = {
      action: groupDefaultMode === 'hidden' ? 'hide' : (groupDefaultMode === 'opacity' ? 'opacity' : 'show'),
      opacityValue: groupDefaultMode === 'opacity' ? groupDefaultOpacity : 1,
    };
    const groupRules = group.rules || [];
    for (var gi = 0; gi < groupRules.length; gi++) {
      const groupRule = groupRules[gi];
      if (evalConds(groupRule.conditions, groupRule.logicMode || 'AND', frameState)) {
        groupOverride = groupRule;
      }
    }

    if (groupOverride.action === 'hide') {
      containerEl.style.display = 'none';
      return;
    }

    if (groupOverride.action === 'opacity') {
      containerEl.style.display = '';
      containerEl.style.opacity = String(groupOverride.opacityValue !== undefined ? groupOverride.opacityValue : 1);
    } else {
      containerEl.style.display = '';
      containerEl.style.opacity = '1';
    }

    // Per-overlay rules scoped to this group's container
    for (const ov of group.overlays) {
      const el = containerEl.querySelector('[data-overlay-id="' + ov.id + '"]');
      if (!el) continue;

      const defaultVisible = ov.defaultVisible !== false;
      const defaultOpacity = ov.defaultOpacity !== undefined ? ov.defaultOpacity : 1;
      let isVisible = defaultVisible;
      let opacity = defaultOpacity;

      const rules = ov.rules || [];
      for (const rule of rules) {
        if (evalConds(rule.conditions, rule.logicMode || 'AND', frameState)) {
          if (rule.action === 'show') { isVisible = true; opacity = 1; }
          else if (rule.action === 'hide') { isVisible = false; }
          else if (rule.action === 'opacity') { isVisible = true; opacity = rule.opacityValue !== undefined ? rule.opacityValue : 1; }
        }
      }
      el.style.display = isVisible ? '' : 'none';
      el.style.opacity = String(opacity);
    }
  }

  // ---------------------------------------------------------------------------
  // Condition evaluation helpers
  // ---------------------------------------------------------------------------

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
    const matchingInstances = instanceStates.filter(function(instanceState) {
      return instanceState.monitoredRegionId === c.monitoredRegionId;
    });
    if (matchingInstances.length === 0) return false;

    const matchingValues = matchingInstances.map(function(instanceState) {
      const instanceCalcResult = instanceState.calculationResults.find(function(r) {
        return r.stateCalculationId === c.stateCalculationId;
      });
      return instanceCalcResult ? instanceCalcResult.currentValue : undefined;
    });

    if (c.operator === 'equalsAtLeastOnceAcrossRepeatedRegions') {
      return matchingValues.some(function(value) { return value === c.value; });
    }
    if (c.operator === 'equalsInEveryRepeatedRegion') {
      return matchingValues.every(function(value) { return value === c.value; });
    }
    if (c.operator === 'equalsAtLeastNTimesAcrossRepeatedRegions') {
      const minCount = c.minimumCount !== undefined ? c.minimumCount : 1;
      return matchingValues.filter(function(value) { return value === c.value; }).length >= minCount;
    }
    if (c.operator === 'equalsInEverySelectedRepeatedRegion' || c.operator === 'equalsAtLeastOnceInSelectedRepeatedRegions') {
      const selectedKeys = c.selectedRepeatInstances || [];
      const selectedInstances = matchingInstances.filter(function(instanceState) {
        return selectedKeys.includes(instanceState.repeatIndexX + '_' + instanceState.repeatIndexY);
      });
      if (selectedInstances.length === 0) return false;
      const selectedValues = selectedInstances.map(function(instanceState) {
        const r = instanceState.calculationResults.find(function(r) { return r.stateCalculationId === c.stateCalculationId; });
        return r ? r.currentValue : undefined;
      });
      if (c.operator === 'equalsInEverySelectedRepeatedRegion') {
        return selectedValues.every(function(value) { return value === c.value; });
      }
      return selectedValues.some(function(value) { return value === c.value; });
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
