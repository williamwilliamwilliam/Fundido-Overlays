import { Component, OnInit, OnDestroy } from '@angular/core';
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
              min="1" max="120" step="1"
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
        <h3>Performance</h3>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Max Calculation Frequency</label>
            <span class="setting-hint">
              Maximum number of times each state calculation evaluates per second.
              Lower values reduce CPU usage. Higher values give faster overlay response.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="1" max="50" step="1"
              [(ngModel)]="maxCalcFrequency"
              (ngModelChange)="onSettingChanged()" />
            <span class="setting-value">{{ maxCalcFrequency }}/sec</span>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Preview</h3>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Preview FPS</label>
            <span class="setting-hint">
              How often the capture preview image updates in the UI.
              Lower values free up CPU for the capture pipeline.
              Does not affect overlay mirror rendering.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="1" max="30" step="1"
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

      <div class="settings-section">
        <h3>OCR (Text Recognition)</h3>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">OCR Interval</label>
            <span class="setting-hint">
              How often OCR runs on monitored regions with OCR calculations.
              Lower values are more responsive but use significantly more CPU.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="100" max="2000" step="50"
              [(ngModel)]="ocrIntervalMs"
              (ngModelChange)="onSettingChanged()" />
            <span class="setting-value">{{ ocrIntervalMs }} ms</span>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Ollama LLM</h3>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Ollama URL</label>
            <span class="setting-hint">
              Base URL of the Ollama API. Default is http://localhost:11434
            </span>
          </div>
          <div class="setting-control">
            <input
              type="text"
              [(ngModel)]="ollamaBaseUrl"
              (ngModelChange)="onSettingChanged()"
              style="width: 220px" />
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Model</label>
            <span class="setting-hint">
              Vision-capable model to use. Recommended: <strong>qwen3.5:0.8b</strong>
            </span>
            <span class="setting-hint" *ngIf="ollamaModels.length === 0" style="margin-top: 4px">
              No models found. Install with:
              <code class="copyable-command" (click)="copyToClipboard('ollama run qwen3.5:0.8b')" title="Click to copy">
                ollama run qwen3.5:0.8b
              </code>
            </span>
          </div>
          <div class="setting-control">
            <select [(ngModel)]="ollamaModelName" (ngModelChange)="onSettingChanged()" *ngIf="ollamaModels.length > 0">
              <option *ngFor="let m of ollamaModels" [ngValue]="m.name">{{ m.name }}</option>
            </select>
            <input *ngIf="ollamaModels.length === 0"
              type="text"
              [(ngModel)]="ollamaModelName"
              (ngModelChange)="onSettingChanged()"
              placeholder="qwen3.5:0.8b"
              style="width: 180px" />
            <button class="refresh-btn" (click)="refreshOllamaModels()">Refresh</button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Inference Interval</label>
            <span class="setting-hint">
              How often Ollama runs on monitored regions. Lower = more responsive but higher load.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="100" max="5000" step="50"
              [(ngModel)]="ollamaIntervalMs"
              (ngModelChange)="onSettingChanged()" />
            <span class="setting-value">{{ ollamaIntervalMs }} ms</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Keep Alive</label>
            <span class="setting-hint">
              How long Ollama keeps the model loaded in memory. Use "-1" for forever.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="text"
              [(ngModel)]="ollamaKeepAlive"
              (ngModelChange)="onSettingChanged()"
              style="width: 80px" />
          </div>
        </div>
      </div>

      <div class="save-bar" *ngIf="saveMessage">
        <span class="save-message">{{ saveMessage }}</span>
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

    .copyable-command {
      display: inline-block;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      background-color: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px 8px;
      cursor: pointer;
    }
    .copyable-command:hover { background-color: var(--color-bg-panel); }
  `],
})
export class SettingsComponent implements OnInit, OnDestroy {
  // Capture settings
  captureTargetFps = 30;
  captureSource = '0';
  availableDisplays: Array<{ name: string; width: number; height: number }> = [];

  // Performance settings
  maxCalcFrequency = 10;

  // Preview settings
  previewFps = 10;
  previewScalePercent = 25;
  downsampleMethod = 'bilinear';
  jpegQuality = 60;

  // OCR settings
  ocrIntervalMs = 200;

  // Ollama settings
  ollamaBaseUrl = 'http://localhost:11434';
  ollamaModelName = 'qwen3.5:0.8b';
  ollamaIntervalMs = 500;
  ollamaKeepAlive = '5m';
  ollamaModels: Array<{ name: string; size: number }> = [];

  saveMessage = '';
  private saveDebounceTimer: any = null;
  private static readonly SAVE_DEBOUNCE_MS = 500;

  constructor(private readonly electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electronService.loadConfig();

    this.captureTargetFps = config.gameCapture?.targetFps ?? 30;
    this.captureSource = config.gameCapture?.captureSource ?? 'primary';
    this.maxCalcFrequency = config.maxCalcFrequency ?? 10;

    const preview = config.preview;
    if (preview) {
      this.previewFps = preview.previewFps ?? 10;
      this.previewScalePercent = Math.round((preview.previewScale ?? 0.25) * 100);
      this.downsampleMethod = preview.downsampleMethod ?? 'bilinear';
      this.jpegQuality = preview.jpegQuality ?? 60;
    }

    const ocr = config.ocr;
    if (ocr) {
      this.ocrIntervalMs = ocr.ocrIntervalMs ?? 200;
    }

    const ollama = config.ollama;
    if (ollama) {
      this.ollamaBaseUrl = ollama.baseUrl ?? 'http://localhost:11434';
      this.ollamaModelName = ollama.modelName ?? 'qwen3.5:0.8b';
      this.ollamaIntervalMs = ollama.intervalMs ?? 500;
      this.ollamaKeepAlive = ollama.keepAlive ?? '5m';
    }

    await this.refreshDisplays();
    await this.refreshOllamaModels();
  }

  ngOnDestroy(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveSettingsNow();
    }
  }

  async refreshDisplays(): Promise<void> {
    this.availableDisplays = await this.electronService.listDisplays();
  }

  async refreshOllamaModels(): Promise<void> {
    this.ollamaModels = await this.electronService.listOllamaModels();
    // Ensure the recommended model appears even if not installed
    const hasRecommended = this.ollamaModels.some(m => m.name === 'qwen3.5:0.8b');
    if (!hasRecommended && this.ollamaModelName === 'qwen3.5:0.8b') {
      // Model not installed — dropdown will be hidden, text input shown instead
    }
  }

  async copyToClipboard(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
  }

  onSettingChanged(): void {
    this.saveMessage = '';
    this.debounceSave();
  }

  private debounceSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveSettingsNow();
    }, SettingsComponent.SAVE_DEBOUNCE_MS);
  }

  private async saveSettingsNow(): Promise<void> {
    this.saveDebounceTimer = null;

    const config = await this.electronService.loadConfig();

    config.gameCapture.targetFps = this.captureTargetFps;
    config.gameCapture.captureSource = this.captureSource;
    config.maxCalcFrequency = this.maxCalcFrequency;

    config.preview = {
      previewFps: this.previewFps,
      previewScale: this.previewScalePercent / 100,
      downsampleMethod: this.downsampleMethod,
      jpegQuality: this.jpegQuality,
    };

    config.ocr = {
      ocrIntervalMs: this.ocrIntervalMs,
      maxCharacters: config.ocr?.maxCharacters ?? 10,
    };

    config.ollama = {
      baseUrl: this.ollamaBaseUrl,
      modelName: this.ollamaModelName,
      intervalMs: this.ollamaIntervalMs,
      keepAlive: this.ollamaKeepAlive,
    };

    await this.electronService.saveConfig(config);
    await this.electronService.restartCaptureIfRunning();
    this.saveMessage = 'Saved';
  }

  /** Helper for template - converts number to string for select binding. */
  String(value: number): string {
    return String(value);
  }
}
