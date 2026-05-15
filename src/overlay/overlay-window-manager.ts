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
  /** Hidden renderer used only for sound preview when no overlay window is active. */
  private soundPreviewWindow: BrowserWindow | null = null;

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

  /** Current global sound volume (0.0–1.0). Sent to the overlay renderer with every groups-sync. */
  private currentSoundVolume: number = 0.5;

  /**
   * Synchronises the overlay window to match the given list of groups.
   * Creates the window on first call, sends `overlay:groups-sync` to update
   * the renderer when it already exists, and closes it when no groups remain.
   * One BrowserWindow is reused across all groups — no per-group compositor pass.
   */
  public syncOverlayWindows(overlayGroups: OverlayGroup[], soundVolume: number = 0.5): void {
    this.currentSoundVolume = soundVolume;
    const enabledGroups = overlayGroups.filter((group) => group.enabled !== false);

    logger.info(LogCategory.Overlay, `[DIAG] syncOverlayWindows called — total groups: ${overlayGroups.length}, enabled: ${enabledGroups.length}, soundVolume: ${soundVolume}`);

    // Keep the main-process config map in sync for mirror-visibility evaluation.
    this.overlayGroupConfigs.clear();
    for (const group of enabledGroups) {
      this.overlayGroupConfigs.set(group.id, group);
    }

    if (enabledGroups.length === 0) {
      // Capture the call stack to identify which code path is sending 0 enabled groups
      const callStack = new Error().stack?.split('\n').slice(2, 6).join(' | ') || 'no stack';
      logger.info(LogCategory.Overlay, `[DIAG] 0 enabled groups — would close window. Call stack: ${callStack}`);
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
    logger.info(LogCategory.Overlay, `[DIAG] windowNeedsCreation: ${windowNeedsCreation}`);
    if (windowNeedsCreation) {
      this.createOverlayWindow(enabledGroups, soundVolume);
    } else {
      // Window already exists — send the updated group list; renderer diffs and patches the DOM.
      const payload = { groups: enabledGroups, soundVolume };
      logger.info(LogCategory.Overlay, `[DIAG] Sending overlay:groups-sync to existing window — groups: ${enabledGroups.length}, payloadIsArray: ${Array.isArray(payload)}`);
      this.overlayWindow!.webContents.send('overlay:groups-sync', payload);
    }

    this.hasCursorFollowingGroups = enabledGroups.some(
      (group) => group.position.mode === 'relativeToCursor',
    );
    this.updateCursorTracking();
  }

  /**
   * Instructs the overlay renderer to play a sound file at the given volume.
   * Used for both live hidden→visible transitions and settings-page preview.
   */
  public playSound(filePath: string, volume: number): void {
    const windowIsOpen = this.overlayWindow && !this.overlayWindow.isDestroyed();
    if (windowIsOpen) {
      this.overlayWindow!.webContents.send('overlay:play-sound', { filePath, volume });
      return;
    }

    const previewWindow = this.ensureSoundPreviewWindow();
    const sendPlayRequest = () => {
      previewWindow.webContents.send('sound-preview:play', { filePath, volume });
    };

    if (previewWindow.webContents.isLoading()) {
      previewWindow.webContents.once('did-finish-load', sendPlayRequest);
      return;
    }

    sendPlayRequest();
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

    const matchingInstances = this.getMatchingRegionInstances(frameState, cond.monitoredRegionId);

    if (matchingInstances.length === 0) {
      return false;
    }

    const matchingValues = this.getInstanceValues(matchingInstances, cond.stateCalculationId);

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

    if (cond.operator === 'repeatingRegionOccurrenceComparison') {
      const otherMatchingInstances = this.getMatchingRegionInstances(frameState, cond.secondMonitoredRegionId || '');
      if (otherMatchingInstances.length === 0 || !cond.secondStateCalculationId) {
        return false;
      }

      const leftCount = matchingValues.filter((value: string | undefined) => value === cond.value).length;
      const rightValues = this.getInstanceValues(otherMatchingInstances, cond.secondStateCalculationId);
      const rightCount = rightValues.filter((value: string | undefined) => value === cond.value).length;
      return this.compareOccurrenceCounts(leftCount, rightCount, cond.occurrenceComparisonOperator);
    }

    return true;
  }

  private getMatchingRegionInstances(frameState: FrameState, regionId: string): any[] {
    const instanceStates = (frameState as any).regionInstanceStates || [];
    return instanceStates.filter(
      (instanceState: any) => instanceState.monitoredRegionId === regionId
    );
  }

  private getInstanceValues(instanceStates: any[], calcId: string): Array<string | undefined> {
    return instanceStates.map((instanceState: any) =>
      instanceState.calculationResults.find(
        (instanceCalcResult: any) => instanceCalcResult.stateCalculationId === calcId
      )?.currentValue
    );
  }

  private compareOccurrenceCounts(leftCount: number, rightCount: number, operator: string | undefined): boolean {
    switch (operator) {
      case 'gt':
        return leftCount > rightCount;
      case 'lt':
        return leftCount < rightCount;
      case 'ne':
        return leftCount !== rightCount;
      case 'lte':
        return leftCount <= rightCount;
      case 'gte':
        return leftCount >= rightCount;
      case 'eq':
      default:
        return leftCount === rightCount;
    }
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

  private createOverlayWindow(initialGroups: OverlayGroup[], soundVolume: number = 0.5): void {
    logger.info(LogCategory.Overlay, `[DIAG] createOverlayWindow — ${initialGroups.length} group(s), soundVolume: ${soundVolume}`);

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

    // Relay all overlay renderer console output to the main log so we can see
    // script errors, diagLog calls, and uncaught exceptions without needing DevTools.
    const levelToLogFn: Record<number, 'debug' | 'info' | 'warn' | 'error'> = {
      0: 'debug',
      1: 'info',
      2: 'warn',
      3: 'error',
    };
    overlayWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const logFn = levelToLogFn[level] ?? 'info';
      logger[logFn](LogCategory.Overlay, `[OVERLAY-RENDERER-CONSOLE] ${message} (${sourceId}:${line})`);
    });

    overlayWindow.webContents.on('render-process-gone', (_event, details) => {
      logger.error(LogCategory.Overlay, `[OVERLAY-RENDERER] render-process-gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    });

    overlayWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      logger.error(LogCategory.Overlay, `[OVERLAY-RENDERER] did-fail-load: ${errorDescription} (code ${errorCode}) URL: ${validatedURL}`);
    });

    const html = buildOverlayRendererHtml();
    overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    overlayWindow.webContents.once('did-finish-load', () => {
      logger.info(LogCategory.Overlay, `[DIAG] did-finish-load fired — sending initial groups-sync with ${initialGroups.length} group(s)`);
      overlayWindow.webContents.send('overlay:groups-sync', { groups: initialGroups, soundVolume });
    });

    this.overlayWindow = overlayWindow;
  }

  private ensureSoundPreviewWindow(): BrowserWindow {
    const existingWindowIsOpen = this.soundPreviewWindow && !this.soundPreviewWindow.isDestroyed();
    if (existingWindowIsOpen) {
      return this.soundPreviewWindow!;
    }

    const previewWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        webSecurity: false,
        backgroundThrottling: false,
      },
    });

    previewWindow.on('closed', () => {
      if (this.soundPreviewWindow === previewWindow) {
        this.soundPreviewWindow = null;
      }
    });

    previewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildSoundPreviewRendererHtml())}`);
    this.soundPreviewWindow = previewWindow;
    return previewWindow;
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

  // Diagnostic helper — writes to both the main process log (via IPC) and a temp file
  // as a double-redundant fallback. The temp file path is written to the console so
  // the user can find it even if IPC fails.
  var _diagLogPath = null;
  function diagLog(msg) {
    console.log('[OVERLAY-RENDERER]', msg);
    try { ipcRenderer.send('debug:overlay-renderer', msg); } catch(e) {}
    try {
      if (!_diagLogPath) {
        _diagLogPath = require('path').join(require('os').tmpdir(), 'fundido-renderer-debug.log');
        console.log('[OVERLAY-RENDERER] Writing renderer debug log to:', _diagLogPath);
      }
      require('fs').appendFileSync(_diagLogPath, new Date().toISOString() + ' ' + msg + '\\n');
    } catch(e) {}
  }

  diagLog('Renderer script started — ipcRenderer type: ' + typeof ipcRenderer);

  // All active groups, keyed by group ID
  const overlayGroupsById = new Map();
  // The root container element for each group, keyed by group ID
  const groupContainerElementById = new Map();

  // Tracks last known visibility per overlay ID (true = visible, false = hidden).
  // undefined means the overlay has not been evaluated yet (first frame is not considered a transition).
  const overlayPreviousVisibilityById = new Map();

  // Global sound volume (0.0–1.0). Updated with every groups-sync.
  var currentSoundVolume = 0.5;

  // ---------------------------------------------------------------------------
  // overlay:play-sound — direct play request (used for preview from settings)
  // Wrapped in try/catch so any registration failure does NOT prevent the
  // overlay:groups-sync handler below from being set up.
  // ---------------------------------------------------------------------------

  try {
    ipcRenderer.on('overlay:play-sound', function(_event, message) {
      if (!message || !message.filePath) return;
      try { playSoundFile(message.filePath, message.volume !== undefined ? message.volume : currentSoundVolume); } catch(e) {}
    });
    diagLog('overlay:play-sound listener registered');
  } catch(e) {
    diagLog('ERROR: Failed to register overlay:play-sound listener: ' + String(e));
  }

  // ---------------------------------------------------------------------------
  // Sound playback helpers
  // ---------------------------------------------------------------------------

  // Re-use one Audio element per overlay ID to avoid creating unbounded elements
  const soundAudioElementById = new Map();

  function buildSoundFileSrc(filePath) {
    if (!filePath) return '';
    try {
      const { pathToFileURL } = require('url');
      const fs = require('fs');
      const fileUrl = pathToFileURL(filePath);
      const fileStat = fs.statSync(filePath);
      fileUrl.searchParams.set('v', String(Math.round(fileStat.mtimeMs)));
      return fileUrl.href;
    } catch (_error) {
      return filePath;
    }
  }

  function playSoundFile(filePath, volume) {
    var audioEl = new Audio();
    audioEl.src = buildSoundFileSrc(filePath);
    audioEl.volume = Math.max(0, Math.min(1, volume));
    audioEl.play().catch(function(err) {
      console.error('[overlay] Failed to play sound:', err, filePath);
    });
  }

  function playSoundForOverlay(overlayId, soundFilePath, volume) {
    if (!soundFilePath) return;
    playSoundFile(soundFilePath, volume);
  }

  // ---------------------------------------------------------------------------
  // overlay:groups-sync — full diff/patch of the active group set
  // ---------------------------------------------------------------------------

  ipcRenderer.on('overlay:groups-sync', (_event, payload) => {
    // Accept both the new { groups, soundVolume } format and the legacy plain array format
    // for backward compatibility during any rolling updates.
    var isLegacyArrayPayload = Array.isArray(payload);
    var groups = isLegacyArrayPayload ? payload : (payload && payload.groups ? payload.groups : []);
    var soundVolume = isLegacyArrayPayload ? 0.5 : (payload && payload.soundVolume !== undefined ? payload.soundVolume : 0.5);
    currentSoundVolume = soundVolume;

    diagLog('overlay:groups-sync received — isArray: ' + isLegacyArrayPayload + ', payloadType: ' + typeof payload + ', groupCount: ' + (groups ? groups.length : 'null/undefined groups'));

    if (!groups || groups.length === 0) {
      diagLog('WARNING: groups is empty or null — no containers will be created');
    }

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
        diagLog('Refreshing existing container for group: ' + group.name + ' (' + group.id + ')');
        applyGroupLayout(group, existingContainerEl);
        renderOverlayElements(group, existingContainerEl);
        applyDefaults(group, existingContainerEl);
      } else {
        diagLog('Creating new container for group: ' + group.name + ' (' + group.id + '), overlays: ' + (group.overlays ? group.overlays.length : 0));
        const newContainerEl = createGroupContainer(group);
        document.body.appendChild(newContainerEl);
        groupContainerElementById.set(group.id, newContainerEl);
        diagLog('Container appended to body. Body child count: ' + document.body.children.length);
      }
    }
    diagLog('groups-sync complete — overlayGroupsById size: ' + overlayGroupsById.size + ', containerElementById size: ' + groupContainerElementById.size);
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
      // Mark every overlay in this group as hidden so that if/when the group becomes
      // visible again, the hidden→visible transition is correctly detected and sounds play.
      for (const ov of group.overlays) {
        overlayPreviousVisibilityById.set(ov.id, false);
      }
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

      // Detect hidden → visible transition and play the configured sound
      const previouslyVisible = overlayPreviousVisibilityById.get(ov.id);
      const isFirstEvaluation = previouslyVisible === undefined;
      const transitionedFromHiddenToVisible = !isFirstEvaluation && previouslyVisible === false && isVisible === true;
      if (transitionedFromHiddenToVisible && ov.soundFileOnBecomeVisible) {
        playSoundForOverlay(ov.id, ov.soundFileOnBecomeVisible, currentSoundVolume);
      }
      overlayPreviousVisibilityById.set(ov.id, isVisible);
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

    const matchingInstances = getMatchingRegionInstances(fs, c.monitoredRegionId);
    if (matchingInstances.length === 0) return false;

    const matchingValues = getInstanceValues(matchingInstances, c.stateCalculationId);

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

    if (c.operator === 'repeatingRegionOccurrenceComparison') {
      const otherMatchingInstances = getMatchingRegionInstances(fs, c.secondMonitoredRegionId || '');
      if (otherMatchingInstances.length === 0 || !c.secondStateCalculationId) return false;
      const leftCount = matchingValues.filter(function(value) { return value === c.value; }).length;
      const rightValues = getInstanceValues(otherMatchingInstances, c.secondStateCalculationId);
      const rightCount = rightValues.filter(function(value) { return value === c.value; }).length;
      return compareOccurrenceCounts(leftCount, rightCount, c.occurrenceComparisonOperator);
    }

    return true;
  }

  function getMatchingRegionInstances(fs, regionId) {
    const instanceStates = fs.regionInstanceStates || [];
    return instanceStates.filter(function(instanceState) {
      return instanceState.monitoredRegionId === regionId;
    });
  }

  function getInstanceValues(instanceStates, calcId) {
    return instanceStates.map(function(instanceState) {
      const instanceCalcResult = instanceState.calculationResults.find(function(r) {
        return r.stateCalculationId === calcId;
      });
      return instanceCalcResult ? instanceCalcResult.currentValue : undefined;
    });
  }

  function compareOccurrenceCounts(leftCount, rightCount, operator) {
    switch (operator) {
      case 'gt': return leftCount > rightCount;
      case 'lt': return leftCount < rightCount;
      case 'ne': return leftCount !== rightCount;
      case 'lte': return leftCount <= rightCount;
      case 'gte': return leftCount >= rightCount;
      case 'eq':
      default:
        return leftCount === rightCount;
    }
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

function buildSoundPreviewRendererHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
</head>
<body>
<script>
  const { ipcRenderer } = require('electron');

  function buildSoundFileSrc(filePath) {
    if (!filePath) return '';
    try {
      const { pathToFileURL } = require('url');
      const fs = require('fs');
      const fileUrl = pathToFileURL(filePath);
      const fileStat = fs.statSync(filePath);
      fileUrl.searchParams.set('v', String(Math.round(fileStat.mtimeMs)));
      return fileUrl.href;
    } catch (_error) {
      return filePath;
    }
  }

  function playSoundFile(filePath, volume) {
    if (!filePath) return;
    var audioEl = new Audio();
    audioEl.src = buildSoundFileSrc(filePath);
    audioEl.volume = Math.max(0, Math.min(1, volume));
    audioEl.play().catch(function(err) {
      console.error('[sound-preview] Failed to play sound:', err, filePath);
    });
  }

  ipcRenderer.on('sound-preview:play', function(_event, message) {
    if (!message || !message.filePath) return;
    playSoundFile(message.filePath, message.volume !== undefined ? message.volume : 0.5);
  });
</script>
</body>
</html>`;
}
