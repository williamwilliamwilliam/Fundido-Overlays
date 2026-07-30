import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import type { PreviewFrameData, PerfMetrics, ProcessCpuSample, StageTiming } from '../../models/electron-api';

interface StageTimingRow {
  label: string;
  timing: StageTiming;
}

/** Human-readable names for the pipeline stages reported by the main process. */
const STAGE_LABELS: Record<string, string> = {
  captureCallback: 'Capture callback',
  previewFeed: 'Preview feed',
  mirrorBroadcast: 'Mirror crops → overlay',
  evalPrep: 'Eval prep (regions)',
  frameBufferAlloc: 'Frame copy (allocated)',
  frameBufferReuse: 'Frame copy (recycled)',
  stateEval: 'State eval (pixels)',
  workerRoundTrip: 'Worker round trip',
  evalResultHandling: 'Result handling',
  overlayStateBroadcast: 'State broadcast',
};

/** Electron process type codes mapped to something recognizable. */
const PROCESS_TYPE_LABELS: Record<string, string> = {
  Browser: 'Main process',
  GPU: 'GPU process',
  Tab: 'Renderer',
  Utility: 'Utility',
};

type PreviewMeta = Pick<
  PreviewFrameData,
  'originalWidth' | 'originalHeight' | 'previewWidth' | 'previewHeight' | 'displayOriginX' | 'displayOriginY' | 'displayScaleFactor'
>;

interface CaptureRegionOverlay {
  id: string;
  name: string;
  active: boolean;
  leftPercent: number;
  topPercent: number;
  widthPercent: number;
  heightPercent: number;
}

@Component({
  selector: 'app-capture-preview',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-title">
        <span class="page-title-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6l1.5 2h2.5v1H6v-1h2.5L10 18H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 2v9h16V7Z"/>
          </svg>
        </span>
        <h2>Game Capture</h2>
      </div>
      <p class="description">Preview your capture source and control the capture loop.</p>

      <div class="controls">
        <div class="control-group">
          <label class="control-label">Display</label>
          <select
            [(ngModel)]="selectedDisplayIndex"
            (ngModelChange)="onDisplaySelectionChanged($event)"
            class="display-select">
            <option *ngFor="let display of availableDisplays; let i = index" [ngValue]="i">
              {{ display.name }} ({{ display.width }}x{{ display.height }})
            </option>
          </select>
        </div>

        <span class="status-indicator" [class.active]="isCapturing">
          {{ isCapturing ? 'Capturing' : 'Stopped' }}
        </span>

        <span *ngIf="isCapturing && previewMeta" class="resolution-info">
          {{ previewMeta.originalWidth }}x{{ previewMeta.originalHeight }}
          -> {{ previewMeta.previewWidth }}x{{ previewMeta.previewHeight }} preview
        </span>
      </div>

      <div class="preview-area">
        <div
          #previewStage
          class="preview-stage"
          *ngIf="hasPreviewFrame"
          [style.transform]="'scale(' + previewZoom + ')'"
          [style.transform-origin]="previewTransformOrigin"
          (wheel)="onPreviewWheel($event)">
          <img
            #previewImage
            class="preview-image"
            [class.preview-visible]="hasPreviewFrame"
            [class.preview-dimmed]="isPreviewPaused"
            alt="Capture preview" />
          <div class="region-overlay-layer" *ngIf="captureRegionOverlays.length > 0">
            <div
              *ngFor="let overlay of captureRegionOverlays"
              class="region-overlay-box"
              [class.region-overlay-box-active]="overlay.active"
              [style.left.%]="overlay.leftPercent"
              [style.top.%]="overlay.topPercent"
              [style.width.%]="overlay.widthPercent"
              [style.height.%]="overlay.heightPercent"
              [title]="overlay.name">
            </div>
          </div>
        </div>
        <div *ngIf="!hasPreviewFrame && !isCapturing" class="placeholder">
          Click "Start Capture" to begin previewing your display.
        </div>
        <div *ngIf="!hasPreviewFrame && isCapturing" class="placeholder">
          Waiting for first frame...
        </div>

        <div class="paused-overlay" *ngIf="isPreviewPaused && hasPreviewFrame">
          <span class="paused-text">Preview paused while you're not working in this window</span>
        </div>

        <div class="metrics-overlay" *ngIf="isCapturing && metrics">
          <div class="metrics-row">
            <span class="metric-label">Capture</span>
            <span class="metric-value" [class.metric-warn]="metrics.captureFps < 20" [class.metric-good]="metrics.captureFps >= 50">{{ metrics.captureFps }} fps</span>
          </div>
          <div class="metrics-row">
            <span class="metric-label">Preview</span>
            <span class="metric-value">{{ metrics.previewFps }} fps</span>
          </div>
          <div class="metrics-row">
            <span class="metric-label">Pipeline</span>
            <span class="metric-value" [class.metric-warn]="metrics.pipelineAvgMs > 16">{{ metrics.pipelineAvgMs }} ms</span>
          </div>
          <div class="metrics-row">
            <span class="metric-label">State Evals</span>
            <span class="metric-value">{{ metrics.stateEvalPerSec }}/s</span>
          </div>
          <div class="metrics-divider"></div>
          <div class="metrics-row" *ngIf="metrics.medianColorCalcsPerSec > 0">
            <span class="metric-label">Median Color</span>
            <span class="metric-value">{{ metrics.medianColorCalcsPerSec }}/s</span>
          </div>
          <!-- Always rendered, unlike the other calc rows: color threshold counts
               fluctuate to zero constantly, and hiding the row made every panel
               below it jump up and down. -->
          <div class="metrics-row">
            <span class="metric-label">Color Threshold</span>
            <span class="metric-value">{{ metrics.colorThresholdCalcsPerSec }}/s</span>
          </div>
          <div class="metrics-row" *ngIf="metrics.ocrCalcsPerSec > 0">
            <span class="metric-label">OCR</span>
            <span class="metric-value">{{ metrics.ocrCalcsPerSec }}/s</span>
          </div>
          <div class="metrics-row" *ngIf="metrics.ollamaCalcsPerSec > 0">
            <span class="metric-label">Ollama</span>
            <span class="metric-value">{{ metrics.ollamaCalcsPerSec }}/s</span>
          </div>
          <div class="metrics-divider"></div>
          <div class="metrics-row">
            <span class="metric-label">Regions</span>
            <span class="metric-value">{{ metrics.activeRegionCount }}</span>
          </div>
          <div class="metrics-row">
            <span class="metric-label">Overlay Groups</span>
            <span class="metric-value">{{ metrics.activeOverlayGroupCount }}</span>
          </div>

          <div class="metrics-divider"></div>
          <button type="button" class="metrics-toggle" (click)="toggleDiagnostics()">
            {{ showDiagnostics ? '▾' : '▸' }} Diagnostics
            <span class="metric-value">{{ metrics.diagnostics?.totalCpuPercent | number: '1.0-0' }}% CPU</span>
          </button>

          <div class="metrics-diagnostics" *ngIf="showDiagnostics && metrics.diagnostics">
            <div class="metrics-row">
              <span class="metric-label">Eval mode</span>
              <span class="metric-value">{{ metrics.diagnostics.evalMode }}</span>
            </div>

            <div class="metrics-subheading">CPU by process</div>
            <div class="metrics-row" *ngFor="let process of sortedProcesses">
              <span class="metric-label">{{ describeProcess(process) }}</span>
              <span class="metric-value" [class.metric-warn]="process.cpuPercent >= 25">
                {{ process.cpuPercent | number: '1.0-1' }}% · {{ process.memoryMb }} MB
              </span>
            </div>

            <div class="metrics-subheading">Main thread lag (mean · p99)</div>
            <div class="metrics-row" *ngIf="metrics.diagnostics.mainThreadLag as lag">
              <span class="metric-label">Event loop blocked</span>
              <span class="metric-value"
                    [class.metric-warn]="lag.p99Ms >= 16"
                    [class.metric-good]="lag.p99Ms < 8">
                {{ lag.meanMs | number: '1.0-1' }} · {{ lag.p99Ms | number: '1.0-1' }} ms
              </span>
            </div>

            <div class="metrics-subheading">Worker busy (event loop)</div>
            <div class="metrics-row" *ngFor="let thread of metrics.diagnostics.threads">
              <span class="metric-label">{{ thread.name }}</span>
              <span class="metric-value"
                    [class.metric-warn]="thread.utilization >= 0.7"
                    [class.metric-good]="thread.utilization < 0.4">
                {{ thread.utilization * 100 | number: '1.0-1' }}%
              </span>
            </div>

            <div class="metrics-subheading">Pipeline stages (ms/sec · avg · max)</div>
            <div class="metrics-row" *ngFor="let stage of sortedStages">
              <span class="metric-label">{{ stage.label }}</span>
              <span class="metric-value" [class.metric-warn]="stage.timing.totalMs > 200">
                {{ stage.timing.totalMs | number: '1.0-0' }} · {{ stage.timing.avgMs | number: '1.0-2' }} · {{ stage.timing.maxMs | number: '1.0-1' }}
              </span>
            </div>
            <div class="metrics-note" *ngIf="sortedStages.length === 0">
              No stage samples yet.
            </div>
            <div class="metrics-note">
              Native capture-thread CPU is included in the main process figure —
              it has no event loop of its own.
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 1100px; }
    .page-title {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
    }
    h2 { margin: 0; }
    .page-title-icon {
      width: 20px;
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--color-accent);
      flex: 0 0 auto;
    }
    .page-title-icon svg {
      width: 20px;
      height: 20px;
      display: block;
      fill: currentColor;
    }
    .description { color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }

    .controls {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-lg);
      flex-wrap: wrap;
    }

    .control-group {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .control-label {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
    }

    .display-select {
      min-width: 200px;
    }

    .status-indicator {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
    }

    .status-indicator.active {
      color: var(--color-success);
    }

    .resolution-info {
      font-size: 0.8rem;
      color: var(--color-text-secondary);
      font-family: var(--font-mono);
    }

    .preview-area {
      position: relative;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background-color: var(--color-bg-canvas);
      min-height: 300px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .preview-stage {
      position: relative;
      width: 100%;
      display: flex;
      transition: transform 80ms ease-out;
      will-change: transform;
    }

    .preview-image {
      width: 100%;
      height: auto;
      display: none;
      image-rendering: auto;
    }

    .preview-image.preview-visible {
      display: block;
    }

    .region-overlay-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .region-overlay-box {
      position: absolute;
      border: 2px solid rgba(255, 64, 64, 0.95);
      background: rgba(255, 64, 64, 0.08);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
      pointer-events: auto;
      box-sizing: border-box;
      min-width: 2px;
      min-height: 2px;
    }

    .region-overlay-box-active {
      border-color: rgba(76, 175, 80, 0.98);
      background: rgba(76, 175, 80, 0.12);
    }

    .placeholder {
      color: var(--color-text-secondary);
      font-style: italic;
    }

    .metrics-overlay {
      position: absolute;
      top: var(--spacing-sm);
      right: var(--spacing-sm);
      background-color: rgba(0, 0, 0, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      line-height: 1.5;
      min-width: 160px;
      max-width: 340px;
      pointer-events: none;
    }

    /* The panel itself stays click-through so it never blocks the preview;
       only the toggle and the scrollable diagnostics body take pointer events. */
    .metrics-toggle {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-md);
      width: 100%;
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      color: rgba(255, 255, 255, 0.6);
      pointer-events: auto;
    }

    .metrics-toggle:hover { color: rgba(255, 255, 255, 0.9); }

    .metrics-diagnostics {
      max-height: 45vh;
      overflow-y: auto;
      pointer-events: auto;
    }

    .metrics-subheading {
      margin-top: 6px;
      color: rgba(255, 255, 255, 0.45);
      text-transform: uppercase;
      font-size: 0.65rem;
      letter-spacing: 0.05em;
    }

    .metrics-note {
      margin-top: 6px;
      color: rgba(255, 255, 255, 0.35);
      font-size: 0.65rem;
      line-height: 1.35;
      white-space: normal;
    }

    .metrics-row {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-md);
    }

    .metric-label {
      color: rgba(255, 255, 255, 0.6);
    }

    .metric-value {
      color: rgba(255, 255, 255, 0.9);
      text-align: right;
    }

    .metric-good { color: #4caf50; }
    .metric-warn { color: #ff9800; }

    .metrics-divider {
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      margin: 3px 0;
    }

    .preview-dimmed {
      opacity: 0.3;
      filter: grayscale(0.5);
    }

    .paused-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    .paused-text {
      font-size: 1.4rem;
      font-weight: 600;
      color: var(--color-text-secondary);
      text-align: center;
      padding: var(--spacing-lg);
      background-color: rgba(0, 0, 0, 0.5);
      border-radius: var(--radius-md);
    }
  `],
})
export class CapturePreviewComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('previewStage') private previewStageRef?: ElementRef<HTMLDivElement>;
  @ViewChild('previewImage') private previewImageRef?: ElementRef<HTMLImageElement>;

  isCapturing = false;
  selectedDisplayIndex = 0;
  availableDisplays: Array<{ name: string; width: number; height: number }> = [];
  previewMeta: PreviewMeta | null = null;
  metrics: PerfMetrics | null = null;
  showDiagnostics = false;
  /** Stage timings sorted by total time consumed — the biggest cost is first. */
  sortedStages: StageTimingRow[] = [];
  /** Processes sorted by CPU, so the busiest one is always at the top. */
  sortedProcesses: ProcessCpuSample[] = [];
  isPreviewPaused = false;
  hasPreviewFrame = false;
  captureRegionOverlays: CaptureRegionOverlay[] = [];
  previewZoom = 1;
  previewTransformOrigin = '50% 50%';
  private monitoredRegions: any[] = [];
  private activeMonitoredRegionIds = new Set<string>();
  private requiredMonitoredRegionIds = new Set<string>();
  private hasInitializedDisplaySelection = false;

  private previewSubscription: Subscription | null = null;
  private stateSubscription: Subscription | null = null;
  private metricsSubscription: Subscription | null = null;
  private pausedSubscription: Subscription | null = null;
  private latestPreviewSrc: string | null = null;

  constructor(
    private readonly electronService: ElectronService,
    private readonly changeDetectorRef: ChangeDetectorRef,
    private readonly ngZone: NgZone,
  ) {}

  async ngOnInit(): Promise<void> {
    this.electronService.setActivePage('capture');

    const config = await this.electronService.loadConfig();
    this.monitoredRegions = (config.monitoredRegions || []).filter((region: any) => region.enabled !== false);
    this.requiredMonitoredRegionIds = this.getRegionIdsRequiredForRuntimeAutomation(config);
    this.availableDisplays = await this.electronService.listDisplays();

    const configuredDisplayIndex = config.gameCapture?.captureSource === 'primary'
      ? 0
      : parseInt(config.gameCapture?.captureSource ?? '0', 10);
    const hasValidConfiguredDisplay =
      !isNaN(configuredDisplayIndex) &&
      configuredDisplayIndex >= 0 &&
      configuredDisplayIndex < this.availableDisplays.length;
    this.selectedDisplayIndex = hasValidConfiguredDisplay ? configuredDisplayIndex : 0;

    const status = await this.electronService.getCaptureStatus();
    this.isCapturing = status.isCapturing;
    this.hasInitializedDisplaySelection = true;

    if (this.availableDisplays.length > 0 && !this.isCapturing) {
      await this.applySelectedDisplay(true);
    }

    this.changeDetectorRef.markForCheck();

    this.ngZone.runOutsideAngular(() => {
      this.previewSubscription = this.electronService.previewFrameStream.subscribe((previewData) => {
        this.applyPreviewFrame(previewData);
      });
    });

    this.metricsSubscription = this.electronService.perfMetricsStream.subscribe((metrics) => {
      this.metrics = metrics;
      this.rebuildDiagnosticsRows(metrics);
      this.changeDetectorRef.markForCheck();
    });

    this.stateSubscription = this.electronService.stateUpdateStream.subscribe((frameState: any) => {
      this.activeMonitoredRegionIds = this.extractActiveMonitoredRegionIds(frameState);
      this.captureRegionOverlays = this.buildCaptureRegionOverlays();
      this.changeDetectorRef.markForCheck();
    });

    this.pausedSubscription = this.electronService.previewPausedStream.subscribe((paused) => {
      this.isPreviewPaused = paused;
      this.changeDetectorRef.markForCheck();
    });
  }

  ngAfterViewInit(): void {
    if (this.latestPreviewSrc && this.previewImageRef?.nativeElement) {
      this.previewImageRef.nativeElement.src = this.latestPreviewSrc;
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.changeDetectorRef.markForCheck();
  }

  ngOnDestroy(): void {
    this.previewSubscription?.unsubscribe();
    this.stateSubscription?.unsubscribe();
    this.metricsSubscription?.unsubscribe();
    this.pausedSubscription?.unsubscribe();
    this.electronService.setActivePage('');
  }

  toggleDiagnostics(): void {
    this.showDiagnostics = !this.showDiagnostics;
  }

  describeProcess(process: ProcessCpuSample): string {
    const typeLabel = PROCESS_TYPE_LABELS[process.type] ?? process.type;
    const hasDistinctName = process.name && process.name !== process.type;
    const suffix = hasDistinctName ? ` (${process.name})` : '';
    return `${typeLabel}${suffix}`;
  }

  /**
   * Precomputes the sorted diagnostic rows once per metrics tick rather than
   * re-sorting inside template getters on every change detection pass.
   */
  private rebuildDiagnosticsRows(metrics: PerfMetrics): void {
    const diagnostics = metrics.diagnostics;
    if (!diagnostics) {
      this.sortedStages = [];
      this.sortedProcesses = [];
      return;
    }

    this.sortedStages = Object.entries(diagnostics.stages ?? {})
      .map(([stageName, timing]) => ({
        label: STAGE_LABELS[stageName] ?? stageName,
        timing,
      }))
      .sort((a, b) => b.timing.totalMs - a.timing.totalMs);

    this.sortedProcesses = [...(diagnostics.processes ?? [])].sort(
      (a, b) => b.cpuPercent - a.cpuPercent
    );
  }

  async onDisplaySelectionChanged(displayIndex: number): Promise<void> {
    this.selectedDisplayIndex = displayIndex;
    if (!this.hasInitializedDisplaySelection) {
      return;
    }

    await this.applySelectedDisplay(false);
    this.changeDetectorRef.markForCheck();
  }

  private applyPreviewFrame(previewData: PreviewFrameData): void {
    this.latestPreviewSrc = previewData.imageDataUrl;

    const previewImage = this.previewImageRef?.nativeElement;
    if (previewImage) {
      previewImage.src = previewData.imageDataUrl;
    }

    const previewMetaChanged =
      !this.previewMeta ||
      this.previewMeta.originalWidth !== previewData.originalWidth ||
      this.previewMeta.originalHeight !== previewData.originalHeight ||
      this.previewMeta.previewWidth !== previewData.previewWidth ||
      this.previewMeta.previewHeight !== previewData.previewHeight;

    if (!this.hasPreviewFrame || previewMetaChanged) {
      this.hasPreviewFrame = true;
      this.previewMeta = {
        originalWidth: previewData.originalWidth,
        originalHeight: previewData.originalHeight,
        previewWidth: previewData.previewWidth,
        previewHeight: previewData.previewHeight,
        displayOriginX: previewData.displayOriginX,
        displayOriginY: previewData.displayOriginY,
        displayScaleFactor: previewData.displayScaleFactor,
      };
    }

    this.captureRegionOverlays = this.buildCaptureRegionOverlays();
    this.changeDetectorRef.detectChanges();
  }

  private clearPreview(): void {
    this.latestPreviewSrc = null;
    this.previewMeta = null;
    this.hasPreviewFrame = false;
    this.captureRegionOverlays = [];
    this.previewZoom = 1;
    this.previewTransformOrigin = '50% 50%';

    const previewImage = this.previewImageRef?.nativeElement;
    if (previewImage) {
      previewImage.src = '';
    }
  }

  private async applySelectedDisplay(skipRestartIfAlreadyCapturing: boolean): Promise<void> {
    if (this.availableDisplays.length === 0) {
      return;
    }

    const config = await this.electronService.loadConfig();
    config.gameCapture.captureSource = String(this.selectedDisplayIndex);
    config.gameCapture.captureEnabled = true;
    await this.electronService.saveConfig(config);
    this.monitoredRegions = (config.monitoredRegions || []).filter((region: any) => region.enabled !== false);
    this.requiredMonitoredRegionIds = this.getRegionIdsRequiredForRuntimeAutomation(config);

    if (!this.isCapturing) {
      await this.electronService.startCapture();
      this.isCapturing = true;
      return;
    }

    if (!skipRestartIfAlreadyCapturing) {
      this.clearPreview();
      this.metrics = null;
      await this.electronService.restartCaptureIfRunning();
      this.isCapturing = true;
    }
  }

  onPreviewWheel(event: WheelEvent): void {
    event.preventDefault();

    const previewStage = this.previewStageRef?.nativeElement;
    if (!previewStage) {
      return;
    }

    const bounds = previewStage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const pointerXPercent = ((event.clientX - bounds.left) / bounds.width) * 100;
    const pointerYPercent = ((event.clientY - bounds.top) / bounds.height) * 100;
    const clampedXPercent = Math.max(0, Math.min(100, pointerXPercent));
    const clampedYPercent = Math.max(0, Math.min(100, pointerYPercent));
    this.previewTransformOrigin = `${clampedXPercent}% ${clampedYPercent}%`;

    const zoomDelta = event.deltaY < 0 ? 0.2 : -0.2;
    this.previewZoom = Math.max(1, Math.min(8, Math.round((this.previewZoom + zoomDelta) * 100) / 100));
    this.changeDetectorRef.markForCheck();
  }

  private buildCaptureRegionOverlays(): CaptureRegionOverlay[] {
    if (!this.previewMeta) {
      return [];
    }

    const previewScaleX = this.previewMeta.previewWidth / this.previewMeta.originalWidth;
    const previewScaleY = this.previewMeta.previewHeight / this.previewMeta.originalHeight;
    const displayOriginX = this.previewMeta.displayOriginX || 0;
    const displayOriginY = this.previewMeta.displayOriginY || 0;
    const displayScaleFactor = this.previewMeta.displayScaleFactor || 1;

    const overlays: CaptureRegionOverlay[] = [];
    for (const region of this.monitoredRegions) {
      for (const instanceBounds of this.expandRegionOverlayBounds(region)) {
        const physicalX = (instanceBounds.x - displayOriginX) * displayScaleFactor;
        const physicalY = (instanceBounds.y - displayOriginY) * displayScaleFactor;
        const physicalWidth = instanceBounds.width * displayScaleFactor;
        const physicalHeight = instanceBounds.height * displayScaleFactor;

        const sourceX = physicalX * previewScaleX;
        const sourceY = physicalY * previewScaleY;
        const sourceWidth = physicalWidth * previewScaleX;
        const sourceHeight = physicalHeight * previewScaleY;

        const right = sourceX + sourceWidth;
        const bottom = sourceY + sourceHeight;
        if (right <= 0 || bottom <= 0 || sourceX >= this.previewMeta.previewWidth || sourceY >= this.previewMeta.previewHeight) {
          continue;
        }

        const clippedLeft = Math.max(0, sourceX);
        const clippedTop = Math.max(0, sourceY);
        const clippedRight = Math.min(this.previewMeta.previewWidth, right);
        const clippedBottom = Math.min(this.previewMeta.previewHeight, bottom);
        const clippedWidth = clippedRight - clippedLeft;
        const clippedHeight = clippedBottom - clippedTop;
        if (clippedWidth <= 0 || clippedHeight <= 0) {
          continue;
        }

        overlays.push({
          id: `${region.id}:${instanceBounds.repeatIndexX}:${instanceBounds.repeatIndexY}`,
          name: region.name || 'Unnamed Region',
          active: this.activeMonitoredRegionIds.has(region.id) || this.requiredMonitoredRegionIds.has(region.id),
          leftPercent: (clippedLeft / this.previewMeta.previewWidth) * 100,
          topPercent: (clippedTop / this.previewMeta.previewHeight) * 100,
          widthPercent: (clippedWidth / this.previewMeta.previewWidth) * 100,
          heightPercent: (clippedHeight / this.previewMeta.previewHeight) * 100,
        });
      }
    }

    return overlays;
  }

  private expandRegionOverlayBounds(region: any): Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    repeatIndexX: number;
    repeatIndexY: number;
  }> {
    if (!region?.bounds || region.bounds.width <= 0 || region.bounds.height <= 0) {
      return [];
    }

    const repeat = this.normalizeRepeatConfig(region.repeat);
    const xCount = repeat.enabled && repeat.x.enabled ? this.normalizeRepeatCount(repeat.x.count) : 1;
    const yCount = repeat.enabled && repeat.y.enabled ? this.normalizeRepeatCount(repeat.y.count) : 1;
    const overlays: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      repeatIndexX: number;
      repeatIndexY: number;
    }> = [];

    for (let repeatIndexY = 0; repeatIndexY < yCount; repeatIndexY += 1) {
      for (let repeatIndexX = 0; repeatIndexX < xCount; repeatIndexX += 1) {
        overlays.push({
          x: region.bounds.x + (repeat.enabled && repeat.x.enabled ? repeat.x.every * repeatIndexX : 0),
          y: region.bounds.y + (repeat.enabled && repeat.y.enabled ? repeat.y.every * repeatIndexY : 0),
          width: region.bounds.width,
          height: region.bounds.height,
          repeatIndexX,
          repeatIndexY,
        });
      }
    }

    return overlays;
  }

  private normalizeRepeatConfig(repeat: any): any {
    return {
      enabled: repeat?.enabled === true,
      x: {
        enabled: repeat?.x?.enabled === true,
        every: Number.isFinite(repeat?.x?.every) ? repeat.x.every : 0,
        count: this.normalizeRepeatCount(repeat?.x?.count),
      },
      y: {
        enabled: repeat?.y?.enabled === true,
        every: Number.isFinite(repeat?.y?.every) ? repeat.y.every : 0,
        count: this.normalizeRepeatCount(repeat?.y?.count),
      },
    };
  }

  private normalizeRepeatCount(value: any): number {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return 1;
    }

    return Math.max(1, Math.floor(numericValue));
  }

  private extractActiveMonitoredRegionIds(frameState: any): Set<string> {
    const activeIds = new Set<string>();

    for (const regionState of frameState?.regionStates || []) {
      if (regionState.monitoredRegionId) {
        activeIds.add(regionState.monitoredRegionId);
      }
    }

    for (const instanceState of frameState?.regionInstanceStates || []) {
      if (instanceState.monitoredRegionId) {
        activeIds.add(instanceState.monitoredRegionId);
      }
      if (instanceState.sourceMonitoredRegionId) {
        activeIds.add(instanceState.sourceMonitoredRegionId);
      }
    }

    return activeIds;
  }

  private getRegionIdsRequiredForRuntimeAutomation(config: any): Set<string> {
    const referencedIds = new Set<string>();

    for (const group of this.getProfileActivatedOverlayGroups(config)) {
      if (group.enabled === false) {
        continue;
      }

      for (const rule of group.rules || []) {
        this.addConditionRegionIds(referencedIds, rule.conditions);
      }

      for (const overlay of group.overlays || []) {
        for (const rule of overlay.rules || []) {
          this.addConditionRegionIds(referencedIds, rule.conditions);
        }

        if (overlay.contentType === 'regionMirror' && overlay.regionMirrorConfig?.monitoredRegionId) {
          referencedIds.add(overlay.regionMirrorConfig.monitoredRegionId);
        }
      }
    }

    for (const profile of config.profiles || []) {
      for (const rule of profile.rules || []) {
        this.addConditionRegionIds(referencedIds, rule.conditions);
      }
    }

    return referencedIds;
  }

  private getProfileActivatedOverlayGroups(config: any): any[] {
    const profiles = config.profiles || [];
    if (profiles.length === 0) {
      return config.overlayGroups || [];
    }

    const activeProfileIds = new Set(profiles.filter((profile: any) => profile.active).map((profile: any) => profile.id));
    return (config.overlayGroups || []).map((group: any) => {
      const profileIds = group.profileIds || [];
      if (profileIds.length === 0) {
        return group;
      }

      return {
        ...group,
        enabled: profileIds.some((profileId: string) => activeProfileIds.has(profileId)),
      };
    });
  }

  private addConditionRegionIds(referencedIds: Set<string>, conditions: any[] | undefined): void {
    for (const condition of conditions || []) {
      if (condition.monitoredRegionId) {
        referencedIds.add(condition.monitoredRegionId);
      }
    }
  }
}
