import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-capture-preview',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page">
      <h2>Game Capture</h2>
      <p class="description">Preview your capture source and control the capture loop.</p>

      <div class="controls">
        <button
          [class.primary]="!isCapturing"
          (click)="toggleCapture()">
          {{ isCapturing ? 'Stop Capture' : 'Start Capture' }}
        </button>
        <span class="status-indicator" [class.active]="isCapturing">
          {{ isCapturing ? 'Capturing' : 'Stopped' }}
        </span>
      </div>

      <div class="preview-area">
        <div class="placeholder">
          Capture preview will render here once the DXGI addon is connected.
        </div>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 900px; }
    h2 { margin-bottom: var(--spacing-sm); }
    .description { color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }

    .controls {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-lg);
    }

    .status-indicator {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
    }

    .status-indicator.active {
      color: var(--color-success);
    }

    .preview-area {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background-color: var(--color-bg-secondary);
      min-height: 400px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .placeholder {
      color: var(--color-text-secondary);
      font-style: italic;
    }
  `],
})
export class CapturePreviewComponent implements OnInit {
  isCapturing = false;

  constructor(private readonly electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const status = await this.electronService.getCaptureStatus();
    this.isCapturing = status.isCapturing;
  }

  async toggleCapture(): Promise<void> {
    if (this.isCapturing) {
      await this.electronService.stopCapture();
    } else {
      await this.electronService.startCapture();
    }
    this.isCapturing = !this.isCapturing;
  }
}
