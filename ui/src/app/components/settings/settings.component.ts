import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="page">
      <div class="page-title">
        <span class="page-title-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="m19.14 12.94.04-.94-.04-.94 2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.4 7.4 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54a7.4 7.4 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.48a.5.5 0 0 0 .12.64l2.03 1.58-.04.94.04.94-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.69 1.63.94l.36 2.54a.5.5 0 0 0 .49.42h3.8a.5.5 0 0 0 .49-.42l.36-2.54c.58-.25 1.13-.56 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64ZM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"/>
          </svg>
        </span>
        <h2>Settings</h2>
      </div>
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
        <h3>Overlays</h3>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Cursor Frequency</label>
            <span class="setting-hint">
              How often cursor-following overlays update their position.
              60Hz is recommended for most setups. 120Hz reduces visible
              lag on high-refresh-rate displays at the cost of extra CPU.
            </span>
          </div>
          <div class="setting-control">
            <select [(ngModel)]="cursorFrequencyHz" (ngModelChange)="onSettingChanged()">
              <option [ngValue]="60">60 Hz</option>
              <option [ngValue]="120">120 Hz</option>
            </select>
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

      <div class="settings-section">
        <h3>Sound Library</h3>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Playback Volume</label>
            <span class="setting-hint">
              Global volume for overlay sounds. Applies when an overlay transitions from hidden to visible.
            </span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="0" max="100" step="1"
              [(ngModel)]="soundVolumePercent"
              (ngModelChange)="onSettingChanged()" />
            <span class="setting-value">{{ soundVolumePercent }}%</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">Sound Folders</label>
            <span class="setting-hint">
              Add folders to scan for .ogg and .mp3 files. Subfolders are included.
              The indexed files appear in the sound picker when configuring overlay sounds.
            </span>
          </div>
          <div class="setting-control setting-control-vertical">
            <div *ngFor="let folderPath of soundLibraryFolderPaths; let i = index" class="sound-folder-row">
              <span class="sound-folder-path" [title]="folderPath">{{ folderPath }}</span>
              <button class="danger-text small" (click)="removeSoundFolder(i)">Remove</button>
            </div>
            <div *ngIf="soundLibraryFolderPaths.length === 0" class="sound-folder-empty">
              No folders configured.
            </div>
            <button class="refresh-btn" (click)="addSoundFolder()">+ Add Folder</button>
            <button class="refresh-btn" [disabled]="soundLibraryFolderPaths.length === 0 || soundIndexingInProgress" (click)="reindexSoundFolders()">
              {{ soundIndexingInProgress ? 'Indexing...' : 'Re-index' }}
            </button>
          </div>
        </div>

        <div class="setting-row" *ngIf="soundFileIndex.length > 0 || soundIndexingInProgress">
          <div class="setting-info">
            <label class="setting-label">Indexed Files</label>
          </div>
          <div class="setting-control">
            <span class="setting-value" style="min-width: auto">{{ soundFileIndex.length }} file(s) indexed</span>
          </div>
        </div>
      </div>

      <!-- Indexing progress modal -->
      <div *ngIf="soundIndexingInProgress" class="modal-backdrop">
        <div class="modal-dialog">
          <h3>Indexing Sound Files</h3>
          <p class="modal-description">
            Scanning your folders for .ogg and .mp3 files&hellip;
          </p>
          <p class="modal-progress">
            {{ soundIndexProgressFilesFound }} file(s) found
            <ng-container *ngIf="soundIndexProgressCurrentFolder">
              &mdash; {{ soundIndexProgressCurrentFolder }}
            </ng-container>
          </p>
          <div class="modal-actions">
            <button (click)="cancelSoundIndexing()">Cancel</button>
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

    .setting-control-vertical {
      flex-direction: column;
      align-items: flex-start;
    }

    .sound-folder-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      width: 100%;
    }

    .sound-folder-path {
      flex: 1;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--color-text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sound-folder-empty {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal-dialog {
      background: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-lg);
      min-width: 360px;
      max-width: 560px;
    }

    .modal-dialog h3 {
      margin-bottom: var(--spacing-sm);
    }

    .modal-description {
      color: var(--color-text-secondary);
      font-size: 0.9rem;
      margin-bottom: var(--spacing-sm);
    }

    .modal-progress {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--color-text-primary);
      margin-bottom: var(--spacing-md);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .modal-actions {
      display: flex;
      gap: var(--spacing-sm);
    }
  `],
})
export class SettingsComponent implements OnInit, OnDestroy {
  // Overlay settings
  cursorFrequencyHz: 60 | 120 = 60;

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

  // Sound Library settings
  soundLibraryFolderPaths: string[] = [];
  soundVolumePercent = 50;
  soundFileIndex: string[] = [];
  soundIndexingInProgress = false;
  soundIndexProgressFilesFound = 0;
  soundIndexProgressCurrentFolder = '';

  saveMessage = '';
  private saveDebounceTimer: any = null;
  private static readonly SAVE_DEBOUNCE_MS = 500;
  private soundProgressSubscription: Subscription | null = null;

  constructor(private readonly electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electronService.loadConfig();

    this.cursorFrequencyHz = (config.overlay?.cursorFrequencyHz ?? 60) as 60 | 120;

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

    this.soundLibraryFolderPaths = [...(config.soundLibraryFolderPaths ?? [])];
    this.soundVolumePercent = Math.round((config.soundVolume ?? 0.5) * 100);
    this.soundFileIndex = await this.electronService.soundGetIndex();

    this.soundProgressSubscription = this.electronService.soundIndexProgressStream.subscribe((progress) => {
      this.soundIndexProgressFilesFound = progress.filesFound;
      this.soundIndexProgressCurrentFolder = progress.currentFolder;

      const scanFinished = progress.complete;
      if (scanFinished) {
        this.soundIndexingInProgress = false;
        if (!progress.cancelled) {
          this.electronService.soundGetIndex().then((index) => {
            this.soundFileIndex = index;
          });
        }
      }
    });

    await this.refreshDisplays();
    await this.refreshOllamaModels();
  }

  ngOnDestroy(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveSettingsNow();
    }
    this.soundProgressSubscription?.unsubscribe();
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

    config.overlay = {
      cursorFrequencyHz: this.cursorFrequencyHz,
    };

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

    config.soundLibraryFolderPaths = [...this.soundLibraryFolderPaths];
    config.soundVolume = this.soundVolumePercent / 100;

    await this.electronService.saveConfig(config);
    await this.electronService.restartCaptureIfRunning();
    this.saveMessage = 'Saved';
  }

  // -- Sound Library methods -------------------------------------------------

  async addSoundFolder(): Promise<void> {
    const selectedFolderPath = await this.electronService.openFileDialog({
      properties: ['openDirectory'],
    });

    const folderWasSelected = !!selectedFolderPath;
    if (!folderWasSelected) return;

    const folderAlreadyAdded = this.soundLibraryFolderPaths.includes(selectedFolderPath);
    if (folderAlreadyAdded) return;

    this.soundLibraryFolderPaths = [...this.soundLibraryFolderPaths, selectedFolderPath];
    await this.saveSoundFoldersAndReindex();
  }

  async removeSoundFolder(folderIndex: number): Promise<void> {
    this.soundLibraryFolderPaths = this.soundLibraryFolderPaths.filter((_, index) => index !== folderIndex);
    await this.saveSoundFoldersAndReindex();
  }

  async reindexSoundFolders(): Promise<void> {
    await this.startSoundIndexing();
  }

  async cancelSoundIndexing(): Promise<void> {
    await this.electronService.soundCancelIndex();
    // Modal will close when the progress event arrives with complete: true, cancelled: true
  }

  private async saveSoundFoldersAndReindex(): Promise<void> {
    const config = await this.electronService.loadConfig();
    config.soundLibraryFolderPaths = [...this.soundLibraryFolderPaths];
    await this.electronService.saveConfig(config);

    const hasFolders = this.soundLibraryFolderPaths.length > 0;
    if (hasFolders) {
      await this.startSoundIndexing();
    } else {
      // No folders left — clear the index display
      this.soundFileIndex = [];
    }
  }

  private async startSoundIndexing(): Promise<void> {
    this.soundIndexingInProgress = true;
    this.soundIndexProgressFilesFound = 0;
    this.soundIndexProgressCurrentFolder = '';
    await this.electronService.soundIndexFolders(this.soundLibraryFolderPaths);
  }

  /** Helper for template - converts number to string for select binding. */
  String(value: number): string {
    return String(value);
  }
}
