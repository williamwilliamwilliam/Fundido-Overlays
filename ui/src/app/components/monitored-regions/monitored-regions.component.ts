import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import type { PreviewFrameData } from '../../models/electron-api';

/** Helper to convert RGB to hex string. */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Helper to parse hex string to RGB. Returns null if invalid. */
function hexToRgb(hex: string): { red: number; green: number; blue: number } | null {
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length !== 6) return null;
  const parsed = parseInt(cleaned, 16);
  if (isNaN(parsed)) return null;
  return {
    red: (parsed >> 16) & 255,
    green: (parsed >> 8) & 255,
    blue: parsed & 255,
  };
}

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
        <button (click)="saveAllRegions()">Save</button>
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

        <div class="region-content-row">
          <!-- Left: bounds + state calculations -->
          <div class="region-left">
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

            <!-- State Calculations -->
            <div class="state-calcs-section">
              <div class="section-header">
                <span class="section-label">State Calculations</span>
                <button class="add-btn" (click)="addStateCalculation(region)">+ Add</button>
              </div>

              <div *ngFor="let calc of region.stateCalculations; let calcIndex = index" class="calc-card">
                <div class="calc-header">
                  <input [(ngModel)]="calc.name" placeholder="Calculation name" class="calc-name-input" />
                  <select [(ngModel)]="calc.type" class="calc-type-select">
                    <option value="MedianPixelColor">Closest to Median Color</option>
                  </select>
                  <button class="danger-text small" (click)="removeStateCalculation(region, calcIndex)">Remove</button>
                </div>

                <!-- Color-state mappings -->
                <div class="mappings-list">
                  <div *ngFor="let mapping of calc.colorStateMappings; let mappingIndex = index" class="mapping-row">
                    <div
                      class="color-swatch"
                      [style.background-color]="rgbToHex(mapping.color.red, mapping.color.green, mapping.color.blue)">
                    </div>
                    <input
                      class="hex-input"
                      [ngModel]="rgbToHex(mapping.color.red, mapping.color.green, mapping.color.blue)"
                      (ngModelChange)="onMappingColorChanged(mapping, $event)"
                      placeholder="#000000" />
                    <span class="mapping-arrow">&rarr;</span>
                    <input
                      class="state-value-input"
                      [(ngModel)]="mapping.stateValue"
                      placeholder="State value" />
                    <span class="confidence-badge" *ngIf="getConfidenceForMapping(region.id, calc.id, mapping.stateValue) !== null">
                      {{ getConfidenceForMapping(region.id, calc.id, mapping.stateValue) | number:'1.1-1' }}%
                    </span>
                    <button class="danger-text small" (click)="removeMapping(calc, mappingIndex)">×</button>
                  </div>
                  <button class="add-mapping-btn" (click)="addMapping(calc)">+ Add Color Mapping</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Right: live preview + median color + current state -->
          <div class="region-right">
            <div class="region-preview" *ngIf="hasValidBounds(region) && latestPreviewFrame">
              <canvas
                [id]="'preview-' + region.id"
                class="preview-canvas"
                [width]="getPreviewCanvasWidth(region)"
                [height]="getPreviewCanvasHeight(region)">
              </canvas>
            </div>
            <div class="region-preview placeholder-preview" *ngIf="!latestPreviewFrame || !hasValidBounds(region)">
              <span class="preview-label">{{ !latestPreviewFrame ? 'Start capture' : 'Set bounds' }}</span>
            </div>

            <!-- Median color readout -->
            <div class="median-color-row" *ngIf="getMedianHex(region.id)">
              <span class="info-label">Median Color</span>
              <div class="median-display">
                <div
                  class="color-swatch"
                  [style.background-color]="getMedianHex(region.id)">
                </div>
                <span class="median-hex">{{ getMedianHex(region.id) }}</span>
                <button class="copy-icon-btn" (click)="copyToClipboard(getMedianHex(region.id)!)" title="Copy hex">
                  &#x1F4CB;
                </button>
              </div>
            </div>

            <!-- Current state display -->
            <div
              class="current-state-row"
              *ngFor="let calc of region.stateCalculations">
              <span class="info-label">Current State</span>
              <span class="current-state-value">{{ getCurrentStateValue(region.id, calc.id) || '—' }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 1100px; }
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

    .region-content-row {
      display: flex;
      gap: var(--spacing-lg);
    }

    .region-left {
      flex: 1;
      min-width: 0;
    }

    .region-right {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-sm);
      flex-shrink: 0;
      min-width: 170px;
    }

    .region-bounds {
      display: flex;
      gap: var(--spacing-md);
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: var(--spacing-md);
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
    .pick-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* State calculations section */
    .state-calcs-section { margin-top: var(--spacing-sm); }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
    }

    .section-label {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .add-btn {
      font-size: 0.8rem;
      padding: 2px 10px;
    }

    .calc-card {
      background-color: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
    }

    .calc-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
    }

    .calc-name-input {
      flex: 1;
      font-size: 0.9rem;
      background: transparent;
      border: 1px solid var(--color-border);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
    }
    .calc-name-input:focus { border-color: var(--color-accent); }

    .calc-type-select {
      font-size: 0.8rem;
      min-width: 180px;
    }

    .mappings-list {
      padding-left: var(--spacing-sm);
    }

    .mapping-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: 4px;
    }

    .color-swatch {
      width: 22px;
      height: 22px;
      border-radius: 3px;
      border: 1px solid var(--color-border);
      flex-shrink: 0;
    }

    .hex-input {
      width: 85px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      text-align: center;
    }

    .mapping-arrow {
      color: var(--color-text-secondary);
      font-size: 0.85rem;
    }

    .state-value-input {
      flex: 1;
      font-size: 0.85rem;
      min-width: 100px;
    }

    .confidence-badge {
      font-size: 0.75rem;
      font-family: var(--font-mono);
      color: var(--color-text-secondary);
      background-color: var(--color-bg-secondary);
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      white-space: nowrap;
    }

    .add-mapping-btn {
      font-size: 0.75rem;
      background: transparent;
      border: 1px dashed var(--color-border);
      width: 100%;
      padding: 4px;
      margin-top: 4px;
    }

    /* Preview area */
    .region-preview { display: flex; flex-direction: column; align-items: center; }

    .preview-canvas {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background-color: #000;
      max-width: 160px;
      max-height: 120px;
    }

    .placeholder-preview {
      width: 160px;
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

    /* Median color display */
    .median-color-row, .current-state-row {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      width: 100%;
    }

    .info-label {
      font-size: 0.7rem;
      color: var(--color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .median-display {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .median-hex {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--color-text-primary);
    }

    .copy-icon-btn {
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 0.85rem;
      padding: 0 2px;
      opacity: 0.6;
    }
    .copy-icon-btn:hover { opacity: 1; }

    .current-state-value {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--color-accent);
    }

    .danger-text {
      background: transparent;
      border: none;
      color: var(--color-error);
      font-size: 0.85rem;
    }
    .danger-text.small { font-size: 0.8rem; }
    .danger-text:hover { text-decoration: underline; }
  `],
})
export class MonitoredRegionsComponent implements OnInit, OnDestroy {
  regions: any[] = [];
  showImportDialog = false;
  importJsonText = '';
  pickingRegionId: string | null = null;
  latestPreviewFrame: PreviewFrameData | null = null;

  /** Maps regionId → { medianHex, calcResults: Map<calcId, { currentValue, confidences }> } */
  private regionStateMap = new Map<string, {
    medianHex: string;
    calcResults: Map<string, { currentValue: string; confidenceByMapping: Record<string, number> }>;
  }>();

  private previewSubscription: Subscription | null = null;
  private pickerUpdateSubscription: Subscription | null = null;
  private stateSubscription: Subscription | null = null;
  private previewImage: HTMLImageElement | null = null;

  constructor(private readonly electronService: ElectronService) {}

  // Expose helper to template
  rgbToHex = rgbToHex;

  async ngOnInit(): Promise<void> {
    const config = await this.electronService.loadConfig();
    this.regions = config.monitoredRegions || [];
    this.pushWorkingRegions();

    this.previewSubscription = this.electronService.previewFrameStream.subscribe((frame) => {
      this.latestPreviewFrame = frame;
      this.updatePreviewImage(frame);
      this.renderAllRegionPreviews();
    });

    this.pickerUpdateSubscription = this.electronService.pickerRegionUpdateStream.subscribe((region) => {
      const pickingRegion = this.regions.find((r: any) => r.id === this.pickingRegionId);
      if (pickingRegion) {
        pickingRegion.bounds.x = region.x;
        pickingRegion.bounds.y = region.y;
        pickingRegion.bounds.width = region.width;
        pickingRegion.bounds.height = region.height;
        this.pushWorkingRegions();
      }
    });

    this.stateSubscription = this.electronService.stateUpdateStream.subscribe((frameState: any) => {
      this.processFrameState(frameState);
    });
  }

  ngOnDestroy(): void {
    this.previewSubscription?.unsubscribe();
    this.pickerUpdateSubscription?.unsubscribe();
    this.stateSubscription?.unsubscribe();
    // Clear working regions so the pipeline falls back to saved config
    this.electronService.setWorkingRegions(null as any);
  }

  // ---------------------------------------------------------------------------
  // Region CRUD
  // ---------------------------------------------------------------------------

  addRegion(): void {
    const newRegion = {
      id: crypto.randomUUID(),
      name: 'New Region',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      stateCalculations: [],
    };
    this.regions.push(newRegion);
    this.pushWorkingRegions();
  }

  removeRegion(index: number): void {
    this.regions.splice(index, 1);
    this.pushWorkingRegions();
  }

  hasValidBounds(region: any): boolean {
    return region.bounds.width > 0 && region.bounds.height > 0;
  }

  // ---------------------------------------------------------------------------
  // State Calculation CRUD
  // ---------------------------------------------------------------------------

  addStateCalculation(region: any): void {
    const newCalc = {
      id: crypto.randomUUID(),
      name: 'New Calculation',
      type: 'MedianPixelColor',
      colorStateMappings: [],
    };
    region.stateCalculations.push(newCalc);
    this.pushWorkingRegions();
  }

  removeStateCalculation(region: any, index: number): void {
    region.stateCalculations.splice(index, 1);
    this.pushWorkingRegions();
  }

  addMapping(calc: any): void {
    calc.colorStateMappings.push({
      color: { red: 0, green: 0, blue: 0 },
      stateValue: '',
    });
    this.pushWorkingRegions();
  }

  removeMapping(calc: any, index: number): void {
    calc.colorStateMappings.splice(index, 1);
    this.pushWorkingRegions();
  }

  onMappingColorChanged(mapping: any, hexValue: string): void {
    const rgb = hexToRgb(hexValue);
    if (rgb) {
      mapping.color = rgb;
      this.pushWorkingRegions();
    }
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  async saveAllRegions(): Promise<void> {
    const config = await this.electronService.loadConfig();
    config.monitoredRegions = this.regions;
    await this.electronService.saveConfig(config);
    this.pushWorkingRegions();
  }

  /**
   * Pushes the current in-memory regions to the backend so the evaluation
   * pipeline uses them immediately, without requiring a save first.
   */
  private pushWorkingRegions(): void {
    this.electronService.setWorkingRegions(this.regions);
  }

  // ---------------------------------------------------------------------------
  // State display helpers
  // ---------------------------------------------------------------------------

  getMedianHex(regionId: string): string | null {
    return this.regionStateMap.get(regionId)?.medianHex || null;
  }

  getCurrentStateValue(regionId: string, calcId: string): string | null {
    const regionState = this.regionStateMap.get(regionId);
    if (!regionState) return null;
    return regionState.calcResults.get(calcId)?.currentValue || null;
  }

  getConfidenceForMapping(regionId: string, calcId: string, stateValue: string): number | null {
    const regionState = this.regionStateMap.get(regionId);
    if (!regionState) return null;
    const calcResult = regionState.calcResults.get(calcId);
    if (!calcResult) return null;
    const confidence = calcResult.confidenceByMapping[stateValue];
    return confidence !== undefined ? confidence : null;
  }

  async copyToClipboard(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
  }

  private processFrameState(frameState: any): void {
    if (!frameState || !frameState.regionStates) return;

    for (const regionState of frameState.regionStates) {
      const calcResults = new Map<string, { currentValue: string; confidenceByMapping: Record<string, number> }>();

      for (const calcResult of regionState.calculationResults) {
        calcResults.set(calcResult.stateCalculationId, {
          currentValue: calcResult.currentValue,
          confidenceByMapping: calcResult.confidenceByMapping,
        });
      }

      // Use the region-level median color (always computed, even with no calcs)
      let medianHex = '';
      if (regionState.medianColor) {
        const mc = regionState.medianColor;
        medianHex = rgbToHex(mc.red, mc.green, mc.blue);
      }

      this.regionStateMap.set(regionState.monitoredRegionId, { medianHex, calcResults });
    }
  }

  // ---------------------------------------------------------------------------
  // Region picker
  // ---------------------------------------------------------------------------

  async pickRegion(region: any): Promise<void> {
    this.pickingRegionId = region.id;
    const result = await this.electronService.pickRegion();

    if (result !== null) {
      region.bounds.x = result.x;
      region.bounds.y = result.y;
      region.bounds.width = result.width;
      region.bounds.height = result.height;
      this.pushWorkingRegions();
    }

    this.pickingRegionId = null;
  }

  // ---------------------------------------------------------------------------
  // Import / Export
  // ---------------------------------------------------------------------------

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
      this.pushWorkingRegions();
    }
  }

  // ---------------------------------------------------------------------------
  // Preview rendering
  // ---------------------------------------------------------------------------

  getPreviewCanvasWidth(region: any): number {
    const maxPreviewWidth = 160;
    const maxPreviewHeight = 120;
    const regionAspectRatio = region.bounds.width / region.bounds.height;
    const widthIfConstrainedByHeight = maxPreviewHeight * regionAspectRatio;
    return widthIfConstrainedByHeight <= maxPreviewWidth
      ? Math.round(widthIfConstrainedByHeight)
      : maxPreviewWidth;
  }

  getPreviewCanvasHeight(region: any): number {
    const maxPreviewWidth = 160;
    const maxPreviewHeight = 120;
    const regionAspectRatio = region.bounds.width / region.bounds.height;
    const heightIfConstrainedByWidth = maxPreviewWidth / regionAspectRatio;
    return heightIfConstrainedByWidth <= maxPreviewHeight
      ? Math.round(heightIfConstrainedByWidth)
      : maxPreviewHeight;
  }

  private updatePreviewImage(frame: PreviewFrameData): void {
    const image = new Image();
    image.onload = () => { this.previewImage = image; };
    image.src = frame.imageDataUrl;
  }

  private renderAllRegionPreviews(): void {
    if (!this.previewImage || !this.latestPreviewFrame) return;

    const displayOriginX = this.latestPreviewFrame.displayOriginX || 0;
    const displayOriginY = this.latestPreviewFrame.displayOriginY || 0;
    const dpiScaleFactor = this.latestPreviewFrame.displayScaleFactor || 1;

    for (const region of this.regions) {
      if (region.bounds.width <= 0 || region.bounds.height <= 0) continue;

      const canvas = document.getElementById('preview-' + region.id) as HTMLCanvasElement;
      if (!canvas) continue;

      const context = canvas.getContext('2d');
      if (!context) continue;

      const physicalX = (region.bounds.x - displayOriginX) * dpiScaleFactor;
      const physicalY = (region.bounds.y - displayOriginY) * dpiScaleFactor;
      const physicalWidth = region.bounds.width * dpiScaleFactor;
      const physicalHeight = region.bounds.height * dpiScaleFactor;

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
