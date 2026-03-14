import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import type { PreviewFrameData } from '../../models/electron-api';

@Component({
  selector: 'app-monitored-regions',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="page">
      <h2>Monitored Regions</h2>
      <p class="description">
        Define rectangular regions of the capture to monitor.
        Each region can have state calculations that evaluate its pixel content.
      </p>

      <div class="toolbar">
        <button class="primary" (click)="addRegion()">+ Add Region</button>
        <button (click)="exportRegions()">Export</button>
        <button (click)="showImportDialog = true">Import</button>
      </div>

      <div *ngIf="showImportDialog" class="import-dialog">
        <textarea
          [(ngModel)]="importJsonText"
          placeholder="Paste region JSON here..."
          rows="6">
        </textarea>
        <div class="import-actions">
          <button class="primary" (click)="importRegions()">Import</button>
          <button (click)="showImportDialog = false">Cancel</button>
        </div>
      </div>

      <div *ngIf="regions.length === 0" class="empty-state">
        No monitored regions defined yet. Click "+ Add Region" to get started.
      </div>

      <div *ngFor="let region of regions; let regionIndex = index" class="region-card">
        <div class="region-header">
          <input [(ngModel)]="region.name" placeholder="Region name" class="name-input" />
          <button class="danger-text" (click)="removeRegion(regionIndex)">Remove</button>
        </div>

        <div class="region-bounds-row">
          <div class="region-bounds">
            <label>X <input type="number" [(ngModel)]="region.bounds.x" /></label>
            <label>Y <input type="number" [(ngModel)]="region.bounds.y" /></label>
            <label>W <input type="number" [(ngModel)]="region.bounds.width" /></label>
            <label>H <input type="number" [(ngModel)]="region.bounds.height" /></label>
            <button
              class="pick-btn"
              (click)="pickRegion(region)"
              [disabled]="pickingRegionId !== null">
              {{ pickingRegionId === region.id ? 'Picking...' : 'Pick Region' }}
            </button>
          </div>

          <div class="region-preview" *ngIf="hasValidBounds(region) && latestPreviewFrame">
            <canvas
              [id]="'preview-' + region.id"
              class="preview-canvas"
              [width]="getPreviewCanvasWidth(region)"
              [height]="getPreviewCanvasHeight(region)">
            </canvas>
            <span class="preview-label">Live preview</span>
          </div>
          <div class="region-preview placeholder-preview" *ngIf="!latestPreviewFrame || !hasValidBounds(region)">
            <span class="preview-label">{{ !latestPreviewFrame ? 'Start capture for preview' : 'Set bounds' }}</span>
          </div>
        </div>

        <p class="section-label">State Calculations</p>
        <div *ngFor="let calc of region.stateCalculations; let calcIndex = index" class="calc-card">
          <input [(ngModel)]="calc.name" placeholder="Calculation name" class="name-input" />
          <span class="calc-type">{{ calc.type }}</span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 1000px; }
    h2 { margin-bottom: var(--spacing-sm); }
    .description { color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }

    .toolbar {
      display: flex;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-lg);
    }

    .import-dialog {
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      margin-bottom: var(--spacing-lg);
    }

    .import-dialog textarea {
      width: 100%;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      margin-bottom: var(--spacing-sm);
    }

    .import-actions { display: flex; gap: var(--spacing-sm); }

    .empty-state {
      color: var(--color-text-secondary);
      font-style: italic;
      padding: var(--spacing-lg);
      text-align: center;
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-md);
    }

    .region-card {
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .region-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-sm);
    }

    .name-input {
      font-size: 1rem;
      font-weight: 500;
      background: transparent;
      border: 1px solid transparent;
      padding: var(--spacing-xs);
    }

    .name-input:focus { border-color: var(--color-accent); }

    .region-bounds-row {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-lg);
      margin-bottom: var(--spacing-md);
    }

    .region-bounds {
      display: flex;
      gap: var(--spacing-md);
      align-items: center;
      flex-wrap: wrap;
    }

    .region-bounds label {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-text-secondary);
      font-size: 0.85rem;
    }

    .region-bounds input[type="number"] { width: 70px; }

    .pick-btn {
      font-size: 0.8rem;
      padding: 4px 12px;
      background-color: var(--color-bg-panel);
      border: 1px solid var(--color-accent);
      color: var(--color-accent);
      border-radius: var(--radius-sm);
      white-space: nowrap;
    }

    .pick-btn:hover:not(:disabled) {
      background-color: var(--color-accent);
      color: var(--color-text-primary);
    }

    .pick-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .region-preview {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      margin-left: auto;
      flex-shrink: 0;
    }

    .preview-canvas {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background-color: #000;
      max-width: 160px;
      max-height: 120px;
    }

    .placeholder-preview {
      width: 120px;
      height: 80px;
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .preview-label {
      font-size: 0.7rem;
      color: var(--color-text-secondary);
      text-align: center;
    }

    .section-label {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
      margin-bottom: var(--spacing-sm);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .calc-card {
      background-color: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .calc-type {
      font-size: 0.75rem;
      color: var(--color-accent);
      background-color: var(--color-bg-secondary);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
    }

    .danger-text {
      background: transparent;
      border: none;
      color: var(--color-error);
      font-size: 0.85rem;
    }

    .danger-text:hover { text-decoration: underline; }
  `],
})
export class MonitoredRegionsComponent implements OnInit, OnDestroy {
  regions: any[] = [];
  showImportDialog = false;
  importJsonText = '';
  pickingRegionId: string | null = null;
  latestPreviewFrame: PreviewFrameData | null = null;

  private previewSubscription: Subscription | null = null;
  private pickerUpdateSubscription: Subscription | null = null;
  private previewImage: HTMLImageElement | null = null;

  constructor(private readonly electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electronService.loadConfig();
    this.regions = config.monitoredRegions || [];

    // Subscribe to preview frames for rendering region thumbnails
    this.previewSubscription = this.electronService.previewFrameStream.subscribe((frame) => {
      this.latestPreviewFrame = frame;
      this.updatePreviewImage(frame);
      this.renderAllRegionPreviews();
    });

    // Subscribe to live picker region updates
    this.pickerUpdateSubscription = this.electronService.pickerRegionUpdateStream.subscribe((region) => {
      const pickingRegion = this.regions.find((r: any) => r.id === this.pickingRegionId);
      if (pickingRegion) {
        pickingRegion.bounds.x = region.x;
        pickingRegion.bounds.y = region.y;
        pickingRegion.bounds.width = region.width;
        pickingRegion.bounds.height = region.height;
      }
    });
  }

  ngOnDestroy(): void {
    this.previewSubscription?.unsubscribe();
    this.pickerUpdateSubscription?.unsubscribe();
  }

  addRegion(): void {
    const newRegion = {
      id: crypto.randomUUID(),
      name: 'New Region',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      stateCalculations: [],
    };
    this.regions.push(newRegion);
  }

  removeRegion(index: number): void {
    this.regions.splice(index, 1);
  }

  hasValidBounds(region: any): boolean {
    return region.bounds.width > 0 && region.bounds.height > 0;
  }

  /**
   * Computes the canvas width for a region's preview, maintaining the
   * picked region's aspect ratio while fitting within a max bounding box.
   */
  getPreviewCanvasWidth(region: any): number {
    const maxPreviewWidth = 160;
    const maxPreviewHeight = 120;
    const regionAspectRatio = region.bounds.width / region.bounds.height;

    const widthIfConstrainedByHeight = maxPreviewHeight * regionAspectRatio;
    const fitsWithinWidthConstraint = widthIfConstrainedByHeight <= maxPreviewWidth;

    if (fitsWithinWidthConstraint) {
      return Math.round(widthIfConstrainedByHeight);
    }
    return maxPreviewWidth;
  }

  getPreviewCanvasHeight(region: any): number {
    const maxPreviewWidth = 160;
    const maxPreviewHeight = 120;
    const regionAspectRatio = region.bounds.width / region.bounds.height;

    const heightIfConstrainedByWidth = maxPreviewWidth / regionAspectRatio;
    const fitsWithinHeightConstraint = heightIfConstrainedByWidth <= maxPreviewHeight;

    if (fitsWithinHeightConstraint) {
      return Math.round(heightIfConstrainedByWidth);
    }
    return maxPreviewHeight;
  }

  async pickRegion(region: any): Promise<void> {
    this.pickingRegionId = region.id;
    const result = await this.electronService.pickRegion();

    if (result !== null) {
      region.bounds.x = result.x;
      region.bounds.y = result.y;
      region.bounds.width = result.width;
      region.bounds.height = result.height;
    }

    this.pickingRegionId = null;
  }

  async exportRegions(): Promise<void> {
    const json = await this.electronService.exportRegions();
    await navigator.clipboard.writeText(json);
  }

  async importRegions(): Promise<void> {
    const result = await this.electronService.importRegions(this.importJsonText);
    if (result.success) {
      const config = await this.electronService.loadConfig();
      this.regions = config.monitoredRegions || [];
      this.showImportDialog = false;
      this.importJsonText = '';
    }
  }

  /**
   * Keeps an in-memory Image object loaded with the latest preview frame
   * so we can draw cropped regions from it onto canvases.
   */
  private updatePreviewImage(frame: PreviewFrameData): void {
    const image = new Image();
    image.onload = () => {
      this.previewImage = image;
    };
    image.src = frame.imageDataUrl;
  }

  /**
   * For each region, draws the corresponding cropped area of the preview
   * frame onto its canvas element.
   *
   * Coordinate conversion:
   * 1. Region bounds are in screen-absolute logical pixels (from the picker / Electron's screen API).
   * 2. Subtract the display's logical origin to get display-relative logical coords.
   * 3. Multiply by the display's DPI scale factor to get physical pixel coords
   *    (matching the DXGI capture buffer which is at native resolution).
   * 4. Scale from native capture resolution to the downsampled preview image.
   */
  private renderAllRegionPreviews(): void {
    if (!this.previewImage || !this.latestPreviewFrame) return;

    const displayOriginX = this.latestPreviewFrame.displayOriginX || 0;
    const displayOriginY = this.latestPreviewFrame.displayOriginY || 0;
    const dpiScaleFactor = this.latestPreviewFrame.displayScaleFactor || 1;

    for (const region of this.regions) {
      const hasNoBounds = region.bounds.width <= 0 || region.bounds.height <= 0;
      if (hasNoBounds) continue;

      const canvas = document.getElementById('preview-' + region.id) as HTMLCanvasElement;
      if (!canvas) continue;

      const context = canvas.getContext('2d');
      if (!context) continue;

      // Step 1-2: Convert screen-absolute logical coords to display-relative logical coords
      const displayRelativeLogicalX = region.bounds.x - displayOriginX;
      const displayRelativeLogicalY = region.bounds.y - displayOriginY;

      // Step 3: Convert logical coords to physical (native) pixel coords
      const physicalX = displayRelativeLogicalX * dpiScaleFactor;
      const physicalY = displayRelativeLogicalY * dpiScaleFactor;
      const physicalWidth = region.bounds.width * dpiScaleFactor;
      const physicalHeight = region.bounds.height * dpiScaleFactor;

      // Step 4: Scale from native capture resolution to the downsampled preview image
      const previewScaleX = this.previewImage.naturalWidth / this.latestPreviewFrame.originalWidth;
      const previewScaleY = this.previewImage.naturalHeight / this.latestPreviewFrame.originalHeight;

      const sourceX = physicalX * previewScaleX;
      const sourceY = physicalY * previewScaleY;
      const sourceWidth = physicalWidth * previewScaleX;
      const sourceHeight = physicalHeight * previewScaleY;

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        this.previewImage,
        sourceX, sourceY, sourceWidth, sourceHeight,
        0, 0, canvas.width, canvas.height
      );
    }
  }
}
