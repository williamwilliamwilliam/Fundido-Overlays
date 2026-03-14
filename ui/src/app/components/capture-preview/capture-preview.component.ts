import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import type { PreviewFrameData } from '../../models/electron-api';

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
        <img
          *ngIf="latestPreview"
          [src]="latestPreview.imageDataUrl"
          class="preview-image"
          alt="Capture preview" />
        <div *ngIf="!latestPreview && !isCapturing" class="placeholder">
          Click "Start Capture" to begin previewing your display.
        </div>
        <div *ngIf="!latestPreview && isCapturing" class="placeholder">
          Waiting for first frame...
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
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background-color: #000;
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
  `],
})
export class CapturePreviewComponent implements OnInit, OnDestroy {
  isCapturing = false;
  selectedDisplayIndex = 0;
  availableDisplays: Array<{ name: string; width: number; height: number }> = [];
  latestPreview: PreviewFrameData | null = null;

  private previewSubscription: Subscription | null = null;

  constructor(private readonly electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const status = await this.electronService.getCaptureStatus();
    this.isCapturing = status.isCapturing;

    this.availableDisplays = await this.electronService.listDisplays();

    this.previewSubscription = this.electronService.previewFrameStream.subscribe((previewData) => {
      this.latestPreview = previewData;
    });
  }

  ngOnDestroy(): void {
    this.previewSubscription?.unsubscribe();
  }

  async toggleCapture(): Promise<void> {
    if (this.isCapturing) {
      await this.electronService.stopCapture();
      this.latestPreview = null;
    } else {
      // Save selected display to config before starting
      const config = await this.electronService.loadConfig();
      config.gameCapture.captureSource = String(this.selectedDisplayIndex);
      await this.electronService.saveConfig(config);

      await this.electronService.startCapture();
    }
    this.isCapturing = !this.isCapturing;
  }
}
