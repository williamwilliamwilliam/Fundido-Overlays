import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import type { PreviewFrameData, PerfMetrics } from '../../models/electron-api';

type PreviewMeta = Pick<
  PreviewFrameData,
  'originalWidth' | 'originalHeight' | 'previewWidth' | 'previewHeight'
>;

@Component({
  selector: 'app-capture-preview',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <h2>Game Capture</h2>
      <p class="description">Preview your capture source and control the capture loop.</p>

      <div class="controls">
        <div class="control-group">
          <label class="control-label">Display</label>
          <select [(ngModel)]="selectedDisplayIndex" class="display-select">
            <option *ngFor="let display of availableDisplays; let i = index" [ngValue]="i">
              {{ display.name }} ({{ display.width }}x{{ display.height }})
            </option>
          </select>
        </div>

        <button
          [class.primary]="!isCapturing"
          (click)="toggleCapture()">
          {{ isCapturing ? 'Stop Capture' : 'Start Capture' }}
        </button>

        <span class="status-indicator" [class.active]="isCapturing">
          {{ isCapturing ? 'Capturing' : 'Stopped' }}
        </span>

        <span *ngIf="isCapturing && previewMeta" class="resolution-info">
          {{ previewMeta.originalWidth }}x{{ previewMeta.originalHeight }}
          -> {{ previewMeta.previewWidth }}x{{ previewMeta.previewHeight }} preview
        </span>
      </div>

      <div class="preview-area">
        <img
          #previewImage
          class="preview-image"
          [class.preview-visible]="hasPreviewFrame"
          [class.preview-dimmed]="isPreviewPaused"
          alt="Capture preview" />
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
          <div class="metrics-row" *ngIf="metrics.colorThresholdCalcsPerSec > 0">
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
        </div>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 1100px; }
    h2 { margin-bottom: var(--spacing-sm); }
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

    .preview-image {
      width: 100%;
      height: auto;
      display: none;
      image-rendering: auto;
    }

    .preview-image.preview-visible {
      display: block;
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
      pointer-events: none;
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
  @ViewChild('previewImage') private previewImageRef?: ElementRef<HTMLImageElement>;

  isCapturing = false;
  selectedDisplayIndex = 0;
  availableDisplays: Array<{ name: string; width: number; height: number }> = [];
  previewMeta: PreviewMeta | null = null;
  metrics: PerfMetrics | null = null;
  isPreviewPaused = false;
  hasPreviewFrame = false;

  private previewSubscription: Subscription | null = null;
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

    const status = await this.electronService.getCaptureStatus();
    this.isCapturing = status.isCapturing;

    this.availableDisplays = await this.electronService.listDisplays();
    this.changeDetectorRef.markForCheck();

    this.ngZone.runOutsideAngular(() => {
      this.previewSubscription = this.electronService.previewFrameStream.subscribe((previewData) => {
        this.applyPreviewFrame(previewData);
      });
    });

    this.metricsSubscription = this.electronService.perfMetricsStream.subscribe((metrics) => {
      this.metrics = metrics;
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

  ngOnDestroy(): void {
    this.previewSubscription?.unsubscribe();
    this.metricsSubscription?.unsubscribe();
    this.pausedSubscription?.unsubscribe();
    this.electronService.setActivePage('');
  }

  async toggleCapture(): Promise<void> {
    if (this.isCapturing) {
      await this.electronService.stopCapture();
      this.clearPreview();
      this.metrics = null;
    } else {
      const config = await this.electronService.loadConfig();
      config.gameCapture.captureSource = String(this.selectedDisplayIndex);
      await this.electronService.saveConfig(config);

      await this.electronService.startCapture();
    }

    this.isCapturing = !this.isCapturing;
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
      };
      this.changeDetectorRef.detectChanges();
    }
  }

  private clearPreview(): void {
    this.latestPreviewSrc = null;
    this.previewMeta = null;
    this.hasPreviewFrame = false;

    const previewImage = this.previewImageRef?.nativeElement;
    if (previewImage) {
      previewImage.src = '';
    }
  }
}
