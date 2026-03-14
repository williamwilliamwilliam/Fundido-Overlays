import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="page">
      <h2>Settings</h2>
      <p class="description">Configure capture and preview behavior.</p>

      <div class="settings-section">
        <h3>Capture</h3>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Capture FPS</label>
            <span class="setting-hint">
              How often the screen is captured for state evaluation.
              Higher values are more responsive but use more CPU.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="1" max="60" step="1"
              [(ngModel)]="captureTargetFps"
              (ngModelChange)="onSettingChanged()" />
            <span class="setting-value">{{ captureTargetFps }} fps</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Capture Source</label>
            <span class="setting-hint">
              Which display to capture. Reload the display list if you've changed monitors.
            </span>
          </div>
          <div class="setting-control">
            <select [(ngModel)]="captureSource" (ngModelChange)="onSettingChanged()">
              <option *ngFor="let display of availableDisplays; let i = index" [ngValue]="String(i)">
                {{ display.name }} ({{ display.width }}×{{ display.height }})
              </option>
            </select>
            <button class="refresh-btn" (click)="refreshDisplays()">Refresh</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Preview</h3>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Preview FPS</label>
            <span class="setting-hint">
              How often the preview image updates in the UI.
              Independent of capture FPS. Lower values reduce UI load.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="1" max="60" step="1"
              [(ngModel)]="previewFps"
              (ngModelChange)="onSettingChanged()" />
            <span class="setting-value">{{ previewFps }} fps</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Preview Scale</label>
            <span class="setting-hint">
              Size of the preview image relative to the captured resolution.
              Lower values transfer less data over IPC.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="10" max="100" step="5"
              [(ngModel)]="previewScalePercent"
              (ngModelChange)="onSettingChanged()" />
            <span class="setting-value">{{ previewScalePercent }}%</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Downsample Method</label>
            <span class="setting-hint">
              How the preview image is shrunk. Bilinear is smooth,
              nearest neighbor is fast, skip is fastest but roughest.
            </span>
          </div>
          <div class="setting-control">
            <select [(ngModel)]="downsampleMethod" (ngModelChange)="onSettingChanged()">
              <option value="bilinear">Bilinear (smooth)</option>
              <option value="nearestNeighbor">Nearest Neighbor (fast)</option>
              <option value="skip">Skip (fastest)</option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">JPEG Quality</label>
            <span class="setting-hint">
              Quality of the preview image encoding. Higher is sharper
              but sends more data. 60–80 is a good range.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="10" max="100" step="5"
              [(ngModel)]="jpegQuality"
              (ngModelChange)="onSettingChanged()" />
            <span class="setting-value">{{ jpegQuality }}%</span>
          </div>
        </div>
      </div>

      <div class="save-bar">
        <button class="primary" (click)="saveSettings()" [disabled]="!hasUnsavedChanges">
          {{ hasUnsavedChanges ? 'Save Settings' : 'Settings Saved' }}
        </button>
        <span *ngIf="saveMessage" class="save-message">{{ saveMessage }}</span>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 800px; }
    h2 { margin-bottom: var(--spacing-sm); }
    h3 {
      font-size: 0.95rem;
      color: var(--color-accent);
      margin-bottom: var(--spacing-md);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .description { color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }

    .settings-section {
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      margin-bottom: var(--spacing-lg);
    }

    .setting-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--spacing-lg);
      padding: var(--spacing-sm) 0;
      border-bottom: 1px solid var(--color-border);
    }

    .setting-row:last-child {
      border-bottom: none;
    }

    .setting-info {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .setting-label {
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--color-text-primary);
    }

    .setting-hint {
      font-size: 0.8rem;
      color: var(--color-text-secondary);
      line-height: 1.4;
    }

    .setting-control {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-width: 250px;
    }

    .setting-control input[type="range"] {
      flex: 1;
      accent-color: var(--color-accent);
    }

    .setting-control select {
      flex: 1;
    }

    .setting-value {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--color-text-primary);
      min-width: 60px;
      text-align: right;
    }

    .refresh-btn {
      font-size: 0.8rem;
      padding: 2px 10px;
    }

    .save-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .save-message {
      font-size: 0.85rem;
      color: var(--color-success);
    }
  `],
})
export class SettingsComponent implements OnInit {
  // Capture settings
  captureTargetFps = 30;
  captureSource = '0';
  availableDisplays: Array<{ name: string; width: number; height: number }> = [];

  // Preview settings
  previewFps = 10;
  previewScalePercent = 50;
  downsampleMethod = 'bilinear';
  jpegQuality = 70;

  hasUnsavedChanges = false;
  saveMessage = '';

  constructor(private readonly electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electronService.loadConfig();

    this.captureTargetFps = config.gameCapture?.targetFps ?? 30;
    this.captureSource = config.gameCapture?.captureSource ?? 'primary';

    const preview = config.preview;
    if (preview) {
      this.previewFps = preview.previewFps ?? 10;
      this.previewScalePercent = Math.round((preview.previewScale ?? 0.5) * 100);
      this.downsampleMethod = preview.downsampleMethod ?? 'bilinear';
      this.jpegQuality = preview.jpegQuality ?? 70;
    }

    await this.refreshDisplays();
  }

  async refreshDisplays(): Promise<void> {
    this.availableDisplays = await this.electronService.listDisplays();
  }

  onSettingChanged(): void {
    this.hasUnsavedChanges = true;
    this.saveMessage = '';
  }

  async saveSettings(): Promise<void> {
    const config = await this.electronService.loadConfig();

    config.gameCapture.targetFps = this.captureTargetFps;
    config.gameCapture.captureSource = this.captureSource;

    config.preview = {
      previewFps: this.previewFps,
      previewScale: this.previewScalePercent / 100,
      downsampleMethod: this.downsampleMethod,
      jpegQuality: this.jpegQuality,
    };

    await this.electronService.saveConfig(config);
    this.hasUnsavedChanges = false;
    this.saveMessage = 'Saved! Changes take effect on next capture start.';
  }

  /** Helper for template - converts number to string for select binding. */
  String(value: number): string {
    return String(value);
  }
}
