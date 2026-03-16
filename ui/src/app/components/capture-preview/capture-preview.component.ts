import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import type { PreviewFrameData, PerfMetrics } from '../../models/electron-api';

@Component({
  selector: 'app-capture-preview',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="page">
      <h2>Game Capture</h2>
      <p class="description">Preview your capture source and control the capture loop.</p>

      <div class="controls">
        <div class="control-group">
          <label class="control-label">Display</label>
          <select [(ngModel)]="selectedDisplayIndex" class="display-select">
            <option *ngFor="let display of availableDisplays; let i = index" [ngValue]="i">
              {{ display.name }} ({{ display.width }}×{{ display.height }})
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

        <span *ngIf="isCapturing && latestPreview" class="resolution-info">
          {{ latestPreview.originalWidth }}×{{ latestPreview.originalHeight }}
          → {{ latestPreview.previewWidth }}×{{ latestPreview.previewHeight }} preview
        </span>
      </div>

      <div class="preview-area">
        <canvas
          #previewCanvas
          *ngIf="latestPreview"
          class="preview-image">
        </canvas>
        <div *ngIf="!latestPreview && !isCapturing" class="placeholder">
          Click "Start Capture" to begin previewing your display.
        </div>
        <div *ngIf="!latestPreview && isCapturing" class="placeholder">
          Waiting for first frame...
        </div>

        <!-- FPS / metrics overlay -->
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
      display: block;
      image-rendering: auto;
    }

    .placeholder {
      color: var(--color-text-secondary);
      font-style: italic;
    }

    /* Metrics overlay */
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
  `],
})
export class CapturePreviewComponent implements OnInit, OnDestroy {
  isCapturing = false;
  selectedDisplayIndex = 0;
  availableDisplays: Array<{ name: string; width: number; height: number }> = [];
  latestPreview: PreviewFrameData | null = null;
  metrics: PerfMetrics | null = null;

  @ViewChild('previewCanvas') previewCanvasRef!: ElementRef<HTMLCanvasElement>;

  private previewSubscription: Subscription | null = null;
  private metricsSubscription: Subscription | null = null;

  constructor(private readonly electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    this.electronService.setActivePage('capture');

    const status = await this.electronService.getCaptureStatus();
    this.isCapturing = status.isCapturing;

    this.availableDisplays = await this.electronService.listDisplays();

    this.previewSubscription = this.electronService.previewFrameStream.subscribe((previewData) => {
      this.latestPreview = previewData;
      this.renderPreviewToCanvas(previewData);
    });

    this.metricsSubscription = this.electronService.perfMetricsStream.subscribe((metrics) => {
      this.metrics = metrics;
    });
  }

  private renderPreviewToCanvas(previewData: PreviewFrameData): void {
    // Wait for Angular to create the canvas element after latestPreview becomes truthy
    setTimeout(() => {
      const canvas = this.previewCanvasRef?.nativeElement;
      if (!canvas || !previewData.bgraBuffer) return;

      const width = previewData.previewWidth;
      const height = previewData.previewHeight;

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Convert BGRA → RGBA in the renderer process
      const src = new Uint8Array(previewData.bgraBuffer as any);
      const pixelCount = width * height;
      const rgba = new Uint8ClampedArray(pixelCount * 4);
      for (let i = 0; i < pixelCount; i++) {
        const offset = i * 4;
        rgba[offset]     = src[offset + 2]; // R ← B
        rgba[offset + 1] = src[offset + 1]; // G
        rgba[offset + 2] = src[offset];     // B ← R
        rgba[offset + 3] = 255;             // A
      }

      const imgData = new ImageData(rgba, width, height);
      ctx.putImageData(imgData, 0, 0);
    }, 0);
  }

  ngOnDestroy(): void {
    this.previewSubscription?.unsubscribe();
    this.metricsSubscription?.unsubscribe();
    this.electronService.setActivePage('');
  }

  async toggleCapture(): Promise<void> {
    if (this.isCapturing) {
      await this.electronService.stopCapture();
      this.latestPreview = null;
      this.metrics = null;
    } else {
      const config = await this.electronService.loadConfig();
      config.gameCapture.captureSource = String(this.selectedDisplayIndex);
      await this.electronService.saveConfig(config);

      await this.electronService.startCapture();
    }
    this.isCapturing = !this.isCapturing;
  }
}
