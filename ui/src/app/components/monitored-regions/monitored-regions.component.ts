import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
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
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="page">
      <!-- CPU warning banner when page is open but UI is not focused -->
      <div class="cpu-warning-banner" *ngIf="isUiUnfocused">
        Leaving this page open uses a large amount of CPU. Minimize the app or go to the
        "Capture" tab if you're done configuring your Monitored Regions.
      </div>

      <h2>Monitored Regions</h2>
      <p class="description">
        Define rectangular regions of the capture to monitor.
        Each region can have state calculations that evaluate its pixel content.
      </p>

      <div class="toolbar">
        <button (click)="saveAllRegions()" [disabled]="!hasUnsavedChanges">
          {{ hasUnsavedChanges ? 'Save (Ctrl+S)' : 'Saved' }}
        </button>
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

      <div *ngFor="let region of regions; let regionIndex = index"
        class="region-card"
        [attr.data-highlight-id]="region.id"
        [class.highlight-flash]="highlightId === region.id"
        [class.region-disabled]="region.enabled === false">
        <div class="region-header">
          <label class="enabled-toggle" title="Enable/disable this region">
            <input type="checkbox"
              [ngModel]="region.enabled !== false"
              (ngModelChange)="region.enabled = $event; onFieldChanged()" />
          </label>
          <input [(ngModel)]="region.name" (ngModelChange)="onFieldChanged()" placeholder="Region name" class="name-input" />
          <div class="region-perf-badges" *ngIf="getRegionPerfMetrics(region.id) as rpm">
            <span class="perf-badge"
              [class.perf-warn]="rpm.totalCalcsPerSec > 200"
              title="Total state calculation evaluations per second for this region. Orange when exceeding 200/sec.">
              {{ rpm.totalCalcsPerSec }}/s
            </span>
            <span class="perf-badge perf-detail" *ngIf="rpm.medianColorPerSec > 0"
              title="Median Pixel Color calculations per second — how often this region's median color is sampled and compared against color-state mappings.">
              MC {{ rpm.medianColorPerSec }}
            </span>
            <span class="perf-badge perf-detail" *ngIf="rpm.colorThresholdPerSec > 0"
              title="Color Threshold calculations per second — how often this region's color is evaluated against threshold match percentages.">
              CT {{ rpm.colorThresholdPerSec }}
            </span>
            <span class="perf-badge perf-detail" *ngIf="rpm.ocrPerSec > 0"
              title="OCR (text recognition) calculations per second — how often Tesseract processes this region for text extraction.">
              OCR {{ rpm.ocrPerSec }}
            </span>
            <span class="perf-badge perf-detail" *ngIf="rpm.ollamaPerSec > 0"
              title="Ollama LLM inference calls per second — how often a vision model analyzes this region's image content.">
              LLM {{ rpm.ollamaPerSec }}
            </span>
            <span class="perf-badge perf-time"
              [class.perf-warn]="rpm.timeInCalcMs > 2000"
              title="Total CPU time spent evaluating this region's calculations over the last 10 seconds. Orange when exceeding 2000ms (2 seconds of CPU time per 10 seconds).">
              {{ rpm.timeInCalcMs }}ms / 10s
            </span>
          </div>
          <button class="danger-text" (click)="removeRegion(regionIndex)">Remove</button>
        </div>
        <div class="cross-ref-row" *ngIf="regionCrossRefs.get(region.id)?.length">
          <span class="cross-ref-label">Used by:</span>
          <ng-container *ngFor="let ref of regionCrossRefs.get(region.id)">
            <a *ngIf="ref.source === 'groupRule'"
              class="cross-ref-link cross-ref-group"
              [routerLink]="['/overlays']"
              [queryParams]="{ highlight: ref.groupId }">
              {{ ref.groupName }} (group rule)
            </a>
            <a *ngIf="ref.source !== 'groupRule'"
              class="cross-ref-link"
              [routerLink]="['/overlays']"
              [queryParams]="{ highlight: ref.overlayId }">
              {{ ref.groupName }} → {{ ref.overlayName }}
            </a>
          </ng-container>
        </div>

        <div class="region-content-row">
          <!-- Left: bounds + state calculations -->
          <div class="region-left">
            <div class="region-bounds">
              <label>X <input type="number" [(ngModel)]="region.bounds.x" (ngModelChange)="onFieldChanged()" /></label>
              <label>Y <input type="number" [(ngModel)]="region.bounds.y" (ngModelChange)="onFieldChanged()" /></label>
              <label>W <input type="number" [(ngModel)]="region.bounds.width" (ngModelChange)="onFieldChanged()" /></label>
              <label>H <input type="number" [(ngModel)]="region.bounds.height" (ngModelChange)="onFieldChanged()" /></label>
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
                  <input [(ngModel)]="calc.name" (ngModelChange)="onFieldChanged()" placeholder="Calculation name" class="calc-name-input" />
                  <select [(ngModel)]="calc.type" (ngModelChange)="onCalcTypeChanged(calc)" class="calc-type-select">
                    <option value="MedianPixelColor">Closest to Median Color</option>
                    <option value="ColorThreshold">Color Threshold Match</option>
                    <option value="OCR">OCR (Text Recognition)</option>
                    <option value="OllamaLLM">Ollama LLM Prompt</option>
                  </select>
                  <label class="checkbox-label skip-unchanged-label" title="Skip this calculation if the region's pixels have not changed since the last evaluation. Saves CPU when monitoring static content.">
                    <input type="checkbox"
                      [(ngModel)]="calc.skipIfUnchanged"
                      (ngModelChange)="onFieldChanged()" />
                    Skip if unchanged
                  </label>
                  <label class="default-state-label" title="Fallback value used when the calculation cannot resolve a state (no mapping matches). Leave empty for no default.">
                    Default:
                    <input type="text"
                      class="default-state-input"
                      [placeholder]="'(none)'"
                      [(ngModel)]="calc.defaultStateValue"
                      (ngModelChange)="onFieldChanged()" />
                  </label>
                  <button class="danger-text small" (click)="removeStateCalculation(region, calcIndex)">Remove</button>
                </div>

                <!-- Color-state mappings (MedianPixelColor) -->
                <div class="mappings-list" *ngIf="calc.type === 'MedianPixelColor'">
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
                      (ngModelChange)="onFieldChanged()"
                      placeholder="State value" />
                    <span class="confidence-badge" *ngIf="getConfidenceForMapping(region.id, calc.id, mapping.stateValue) !== null">
                      {{ getConfidenceForMapping(region.id, calc.id, mapping.stateValue) | number:'1.1-1' }}%
                    </span>
                    <button class="danger-text small" (click)="removeMapping(calc, mappingIndex)">×</button>
                  </div>
                  <button class="add-mapping-btn" (click)="addMapping(calc)">+ Add Color Mapping</button>
                </div>

                <!-- Color-threshold mappings (ColorThreshold) -->
                <div class="mappings-list" *ngIf="calc.type === 'ColorThreshold'">
                  <div *ngFor="let mapping of calc.colorThresholdMappings; let mappingIndex = index"
                    class="mapping-row threshold-row"
                    draggable="true"
                    (dragstart)="onThresholdDragStart($event, calc, mappingIndex)"
                    (dragover)="onThresholdDragOver($event, mappingIndex)"
                    (drop)="onThresholdDrop($event, calc)"
                    (dragend)="onThresholdDragEnd()">
                    <span class="drag-handle" title="Drag to reorder">&#9776;</span>
                    <div
                      class="color-swatch"
                      [style.background-color]="rgbToHex(mapping.color.red, mapping.color.green, mapping.color.blue)">
                    </div>
                    <input
                      class="hex-input"
                      [ngModel]="rgbToHex(mapping.color.red, mapping.color.green, mapping.color.blue)"
                      (ngModelChange)="onMappingColorChanged(mapping, $event)"
                      placeholder="#000000" />
                    <span class="mapping-label threshold-label">≥</span>
                    <input
                      type="number"
                      class="threshold-input"
                      [(ngModel)]="mapping.matchThreshold"
                      (ngModelChange)="onFieldChanged()"
                      min="0" max="100" step="1" />
                    <span class="threshold-pct">%</span>
                    <input
                      type="number"
                      class="consecutive-input"
                      [(ngModel)]="mapping.consecutiveRequired"
                      (ngModelChange)="onFieldChanged()"
                      min="1" max="999" step="1" />
                    <span class="consecutive-label">×</span>
                    <span class="mapping-arrow">&rarr;</span>
                    <input
                      class="state-value-input"
                      [(ngModel)]="mapping.stateValue"
                      (ngModelChange)="onFieldChanged()"
                      placeholder="State value" />
                    <span class="confidence-badge" *ngIf="getConfidenceForMapping(region.id, calc.id, mapping.stateValue) !== null">
                      {{ getConfidenceForMapping(region.id, calc.id, mapping.stateValue) | number:'1.1-1' }}%
                    </span>
                    <button class="danger-text small" (click)="removeThresholdMapping(calc, mappingIndex)">×</button>
                  </div>
                  <button class="add-mapping-btn" (click)="addThresholdMapping(calc)">+ Add Color Threshold</button>
                </div>

                <!-- Substring mappings (OCR) -->
                <div class="mappings-list" *ngIf="calc.type === 'OCR'">
                  <div class="ocr-text-readout" *ngIf="getOcrText(region.id, calc.id) !== null">
                    <span class="info-label">OCR Text</span>
                    <span class="ocr-text-value">{{ getOcrText(region.id, calc.id) || '(empty)' }}</span>
                  </div>
                  <div *ngFor="let mapping of calc.substringMappings; let mappingIndex = index" class="mapping-row ocr-mapping-row">
                    <select class="match-mode-select" [(ngModel)]="mapping.matchMode" (ngModelChange)="onFieldChanged()">
                      <option value="contains">Contains</option>
                      <option value="equals">Equals</option>
                      <option value="notEquals">Does Not Equal</option>
                      <option value="startsWith">Starts With</option>
                      <option value="endsWith">Ends With</option>
                      <option value="isEmpty">Is Empty</option>
                    </select>
                    <input *ngIf="mapping.matchMode !== 'isEmpty'"
                      class="substring-input"
                      [(ngModel)]="mapping.substring"
                      (ngModelChange)="onFieldChanged()"
                      placeholder="Text to match" />
                    <label class="duration-label" *ngIf="mapping.minDurationMs > 0 || mapping.showDuration">
                      for
                      <input type="number" class="duration-input"
                        [(ngModel)]="mapping.minDurationMs"
                        (ngModelChange)="onFieldChanged()"
                        min="0" step="100" placeholder="0" />
                      ms
                    </label>
                    <button class="duration-toggle-btn" *ngIf="!mapping.minDurationMs && !mapping.showDuration"
                      (click)="mapping.showDuration = true" title="Add minimum duration">⏱</button>
                    <span class="mapping-arrow">&rarr;</span>
                    <input
                      class="state-value-input"
                      [(ngModel)]="mapping.stateValue"
                      (ngModelChange)="onFieldChanged()"
                      placeholder="State value" />
                    <button class="danger-text small" (click)="removeSubstringMapping(calc, mappingIndex)">×</button>
                  </div>
                  <button class="add-mapping-btn" (click)="addSubstringMapping(calc)">+ Add Text Match</button>

                  <!-- OCR Preprocessing Pipeline -->
                  <div class="ocr-preprocess" *ngIf="calc.ocrPreprocess">
                    <div class="preprocess-header">Preprocessing</div>

                    <div class="config-row">
                      <label>Upscale
                        <input type="range" min="1" max="4" step="1"
                          [(ngModel)]="calc.ocrPreprocess.upscaleFactor"
                          (ngModelChange)="onFieldChanged()" />
                        <span class="slider-value">{{ calc.ocrPreprocess.upscaleFactor }}x</span>
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox"
                          [(ngModel)]="calc.ocrPreprocess.invert"
                          (ngModelChange)="onFieldChanged()" />
                        Invert
                      </label>
                    </div>

                    <div class="config-row">
                      <label>Threshold
                        <input type="range" min="0" max="255" step="1"
                          [(ngModel)]="calc.ocrPreprocess.threshold"
                          (ngModelChange)="onFieldChanged()" />
                        <span class="slider-value">{{ calc.ocrPreprocess.threshold === 0 ? 'Off' : calc.ocrPreprocess.threshold }}</span>
                      </label>
                    </div>

                    <div class="config-row color-filter-row">
                      <label class="checkbox-label"
                        title="Isolates specific colored text from a busy background before OCR runs. When enabled, every pixel in the monitored region is compared to your target color. Pixels that are close to the target (within the tolerance range) are kept as-is, while all other pixels are blacked out. This effectively strips away background noise and leaves only the text you care about.&#10;&#10;Use the Pick button to click directly on a character in your game to sample its exact color, then adjust tolerance until the OCR text readout shows clean results. This works best when the text is a consistent color that's distinct from the background.">
                        <input type="checkbox"
                          [(ngModel)]="calc.ocrPreprocess.colorFilterEnabled"
                          (ngModelChange)="onFieldChanged()" />
                        Color Filter
                      </label>
                      <ng-container *ngIf="calc.ocrPreprocess.colorFilterEnabled">
                        <div
                          class="color-swatch small-swatch"
                          [style.background-color]="rgbToHex(calc.ocrPreprocess.colorFilterTarget.red, calc.ocrPreprocess.colorFilterTarget.green, calc.ocrPreprocess.colorFilterTarget.blue)">
                        </div>
                        <input
                          class="hex-input"
                          [ngModel]="rgbToHex(calc.ocrPreprocess.colorFilterTarget.red, calc.ocrPreprocess.colorFilterTarget.green, calc.ocrPreprocess.colorFilterTarget.blue)"
                          (ngModelChange)="onPreprocessColorChanged(calc.ocrPreprocess, $event)"
                          placeholder="#FFFFFF" />
                        <button class="pick-color-btn" (click)="pickColorForPreprocess(calc.ocrPreprocess)" title="Pick a color from the screen">
                          {{ pickingColorForPreprocess === calc.ocrPreprocess ? 'Picking...' : '🎯 Pick' }}
                        </button>
                        <label
                          title="Controls how strictly pixels must match the target color. Each pixel's red, green, and blue channels are compared independently — a tolerance of 40 means each channel can differ by up to 40 from the target.&#10;&#10;Lower tolerance is stricter (only very similar colors pass through), higher tolerance is more permissive (a wider range of shades are kept). If your text color varies slightly frame to frame, increase the tolerance.">±
                          <input type="range" min="5" max="128" step="1"
                            [(ngModel)]="calc.ocrPreprocess.colorFilterTolerance"
                            (ngModelChange)="onFieldChanged()" />
                          <span class="slider-value">{{ calc.ocrPreprocess.colorFilterTolerance }}</span>
                        </label>
                      </ng-container>
                    </div>

                    <div class="config-row">
                      <label>Char Whitelist
                        <input type="text"
                          [(ngModel)]="calc.ocrPreprocess.charWhitelist"
                          (ngModelChange)="onFieldChanged()"
                          placeholder="e.g. 0123456789"
                          style="width: 200px; font-size: 0.8rem" />
                      </label>
                      <label>PSM
                        <select [(ngModel)]="calc.ocrPreprocess.pageSegMode" (ngModelChange)="onFieldChanged()">
                          <option [ngValue]="7">7 – Single Line</option>
                          <option [ngValue]="8">8 – Single Word</option>
                          <option [ngValue]="10">10 – Single Char</option>
                          <option [ngValue]="6">6 – Block of Text</option>
                          <option [ngValue]="13">13 – Raw Line</option>
                        </select>
                      </label>
                      <label title="Maximum number of characters returned from OCR. The result is trimmed to this length.">Max Chars
                        <input type="number"
                          [(ngModel)]="calc.ocrPreprocess.maxCharacters"
                          (ngModelChange)="onFieldChanged()"
                          min="1" max="100" step="1"
                          style="width: 55px; font-size: 0.8rem; text-align: center" />
                      </label>
                    </div>
                  </div>
                </div>

                <!-- Ollama LLM config -->
                <div class="ollama-config" *ngIf="calc.type === 'OllamaLLM' && calc.ollamaConfig">
                  <div class="config-row">
                    <label>Prompt</label>
                    <input
                      class="wide-input"
                      [(ngModel)]="calc.ollamaConfig.prompt"
                      (ngModelChange)="onFieldChanged()"
                      placeholder="e.g. What number is shown? Only respond with the number." />
                  </div>
                  <div class="config-row">
                    <label>Max Tokens
                      <input type="range" min="1" max="100" step="1"
                        [(ngModel)]="calc.ollamaConfig.numPredict"
                        (ngModelChange)="onFieldChanged()" />
                      <span class="slider-value">{{ calc.ollamaConfig.numPredict }}</span>
                    </label>
                    <label class="checkbox-label">
                      <input type="checkbox"
                        [(ngModel)]="calc.ollamaConfig.think"
                        (ngModelChange)="onFieldChanged()" />
                      Think
                    </label>
                    <label class="checkbox-label">
                      <input type="checkbox"
                        [(ngModel)]="calc.ollamaConfig.skipIfUnchanged"
                        (ngModelChange)="onFieldChanged()" />
                      Skip if unchanged
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Right: live preview + per-calc readouts -->
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

            <!-- Per-calculation readouts -->
            <div *ngFor="let calc of region.stateCalculations" class="calc-readout">

              <!-- Median color (MedianPixelColor and ColorThreshold calcs) -->
              <div class="median-color-row" *ngIf="(calc.type === 'MedianPixelColor' || calc.type === 'ColorThreshold') && getMedianHex(region.id)">
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

              <!-- OCR text readout (OCR calcs only) -->
              <div class="ocr-readout-row" *ngIf="calc.type === 'OCR'">
                <span class="info-label">OCR Text</span>
                <span class="ocr-readout-value">{{ getOcrText(region.id, calc.id) ?? 'Waiting...' }}</span>
                <button *ngIf="getOcrText(region.id, calc.id)" class="copy-icon-btn" (click)="copyToClipboard(getOcrText(region.id, calc.id)!)" title="Copy text">
                  &#x1F4CB;
                </button>
              </div>

              <!-- Ollama readout (OllamaLLM calcs only) -->
              <div class="ollama-readout-row" *ngIf="calc.type === 'OllamaLLM'">
                <span class="info-label">Ollama Response</span>
                <span class="ollama-response-value">{{ getOllamaResponse(region.id, calc.id) ?? 'Waiting...' }}</span>
                <span class="ollama-timing" *ngIf="getOllamaResponseTimeMs(region.id, calc.id) !== null">
                  {{ getOllamaResponseTimeMs(region.id, calc.id) }}ms
                </span>
              </div>

              <!-- Current state (all calc types) -->
              <div class="current-state-row" *ngIf="getCurrentStateValue(region.id, calc.id)">
                <span class="info-label">{{ calc.name }} State</span>
                <span class="current-state-value">{{ getCurrentStateValue(region.id, calc.id) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <button class="primary add-bottom-btn" (click)="addRegion()">+ Add Region</button>
    </div>
  `,
  styles: [`
    .page { max-width: 1100px; }

    .cpu-warning-banner {
      position: sticky;
      top: 0;
      z-index: 100;
      background-color: var(--color-warning);
      color: #000;
      font-weight: 600;
      font-size: 0.9rem;
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      margin-bottom: var(--spacing-md);
      text-align: center;
      line-height: 1.4;
    }
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

    .add-bottom-btn {
      margin-top: var(--spacing-md);
      width: 100%;
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
      gap: var(--spacing-sm);
    }

    .enabled-toggle {
      display: flex;
      align-items: center;
      cursor: pointer;
      flex-shrink: 0;
    }
    .enabled-toggle input[type="checkbox"] {
      width: 18px;
      height: 18px;
      margin: 0;
      accent-color: var(--color-accent);
    }

    .region-disabled {
      opacity: var(--opacity-disabled);
    }

    .region-perf-badges {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .perf-badge {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      background-color: var(--color-bg-panel);
      color: var(--color-text-secondary);
      white-space: nowrap;
    }

    .perf-badge.perf-warn {
      color: var(--color-warning);
      background-color: rgba(255, 152, 0, 0.15);
    }

    .perf-detail {
      font-size: 0.65rem;
      opacity: 0.7;
    }

    .perf-time {
      font-size: 0.65rem;
      color: var(--color-text-secondary);
      border-left: 1px solid var(--color-border);
      padding-left: 6px;
      margin-left: 2px;
    }

    .cross-ref-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
      margin-bottom: var(--spacing-sm);
      padding: 4px var(--spacing-sm);
      background-color: var(--color-bg-primary);
      border-radius: var(--radius-sm);
    }
    .cross-ref-label {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
      white-space: nowrap;
    }
    .cross-ref-link {
      font-size: 0.75rem;
      color: var(--color-accent);
      cursor: pointer;
      text-decoration: underline;
      white-space: nowrap;
    }
    .cross-ref-link:hover { opacity: 0.8; }
    .cross-ref-group { font-style: italic; }

    .name-input {
      font-size: 1rem;
      font-weight: 500;
      background: transparent;
      border: 1px solid transparent;
      padding: var(--spacing-xs);
      flex: 1;
    }
    .name-input:focus { border-color: var(--color-accent); }

    .region-content-row {
      display: flex;
      gap: var(--spacing-lg);
    }

    .region-left {
      flex: 1;
      min-width: 400px;
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
      min-width: 380px;
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

    .skip-unchanged-label {
      font-size: 0.75rem;
      white-space: nowrap;
      flex-shrink: 0;
      color: var(--color-text-secondary);
    }
    .skip-unchanged-label input[type="checkbox"] {
      margin-right: 3px;
    }

    .default-state-label {
      font-size: 0.75rem;
      white-space: nowrap;
      flex-shrink: 0;
      color: var(--color-text-secondary);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .default-state-input {
      width: 80px;
      font-size: 0.75rem;
      padding: 2px 4px;
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

    .threshold-row {
      cursor: grab;
    }
    .threshold-row.drag-over {
      border-top: 2px solid var(--color-accent);
    }

    .drag-handle {
      cursor: grab;
      color: var(--color-text-secondary);
      font-size: 0.85rem;
      user-select: none;
      padding: 0 2px;
    }
    .drag-handle:active { cursor: grabbing; }

    .threshold-input {
      width: 50px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      text-align: center;
    }

    .threshold-pct {
      color: var(--color-text-secondary);
      font-size: 0.8rem;
    }

    .threshold-label {
      font-size: 0.9rem;
      color: var(--color-text-secondary);
    }

    .consecutive-input {
      width: 42px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      text-align: center;
    }

    .consecutive-label {
      color: var(--color-text-secondary);
      font-size: 0.8rem;
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

    .match-mode-select {
      font-size: 0.8rem;
      min-width: 110px;
    }

    .ocr-mapping-row { flex-wrap: wrap; }

    .duration-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 0.8rem;
      color: var(--color-text-secondary);
    }
    .duration-input {
      width: 65px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      text-align: center;
    }
    .duration-toggle-btn {
      background: transparent;
      border: 1px dashed var(--color-border);
      font-size: 0.75rem;
      padding: 1px 6px;
      cursor: pointer;
    }
    .duration-toggle-btn:hover { border-color: var(--color-accent); }

    .pick-color-btn {
      font-size: 0.75rem;
      padding: 2px 8px;
      white-space: nowrap;
    }

    .substring-input {
      width: 140px;
      font-size: 0.85rem;
    }

    .mapping-label {
      font-size: 0.8rem;
      color: var(--color-text-secondary);
      white-space: nowrap;
    }

    .ocr-text-readout {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-xs);
      padding: 2px 0;
    }

    .ocr-text-value {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--color-accent);
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
      background-color: var(--color-bg-canvas);
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
    .calc-readout {
      width: 100%;
      margin-top: var(--spacing-xs);
    }

    .calc-readout + .calc-readout {
      border-top: 1px solid var(--color-border);
      padding-top: var(--spacing-xs);
    }

    .median-color-row, .current-state-row, .ocr-readout-row, .ollama-readout-row {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      width: 100%;
    }

    .ocr-readout-row, .ollama-readout-row {
      flex-direction: row;
      justify-content: center;
      gap: 6px;
    }

    .ollama-response-value {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--color-accent);
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ollama-timing {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text-secondary);
      background-color: var(--color-bg-secondary);
      padding: 1px 6px;
      border-radius: var(--radius-sm);
    }

    /* Ollama config */
    .ollama-config { padding: var(--spacing-xs) 0 var(--spacing-sm) var(--spacing-sm); }
    .ollama-config .config-row { display: flex; gap: var(--spacing-md); align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
    .ollama-config .config-row label { display: flex; align-items: center; gap: var(--spacing-xs); color: var(--color-text-secondary); font-size: 0.8rem; }
    .ollama-config .wide-input { flex: 1; min-width: 250px; font-size: 0.85rem; }
    .ollama-config .slider-value { font-family: var(--font-mono); font-size: 0.8rem; min-width: 30px; }
    .ollama-config .checkbox-label { display: flex; align-items: center; gap: var(--spacing-xs); font-size: 0.8rem; cursor: pointer; }

    /* OCR Preprocessing */
    .ocr-preprocess {
      padding: var(--spacing-sm) 0 var(--spacing-xs) var(--spacing-sm);
      margin-top: var(--spacing-xs);
      border-top: 1px solid var(--color-border);
    }
    .preprocess-header {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--color-text-secondary);
      margin-bottom: var(--spacing-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .ocr-preprocess .config-row {
      display: flex;
      gap: var(--spacing-md);
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 4px;
    }
    .ocr-preprocess .config-row label {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-text-secondary);
      font-size: 0.8rem;
    }
    .ocr-preprocess .slider-value {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      min-width: 30px;
    }
    .ocr-preprocess .checkbox-label {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 0.8rem;
      cursor: pointer;
    }
    .ocr-preprocess .color-filter-row { gap: var(--spacing-sm); }
    .ocr-preprocess .small-swatch { width: 18px; height: 18px; }
    .ocr-preprocess .hex-input { width: 80px; font-size: 0.8rem; }
    .ocr-preprocess select { font-size: 0.8rem; }

    .ocr-readout-value {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--color-accent);
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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

    @keyframes highlight-flash {
      0%, 15% {
        outline: 3px solid var(--color-highlight);
        outline-offset: 2px;
        background-color: var(--color-highlight-bg);
      }
      100% {
        outline: 3px solid transparent;
        outline-offset: 2px;
        background-color: transparent;
      }
    }
    .highlight-flash {
      animation: highlight-flash 2.5s ease-out forwards;
    }
  `],
})
export class MonitoredRegionsComponent implements OnInit, OnDestroy {
  regions: any[] = [];
  overlayGroups: any[] = [];
  showImportDialog = false;
  importJsonText = '';
  pickingRegionId: string | null = null;
  pickingColorForPreprocess: any = null;
  latestPreviewFrame: PreviewFrameData | null = null;
  hasUnsavedChanges = false;
  highlightId: string | null = null;
  isUiUnfocused = false;

  /** Cached cross-references: regionId → overlay groups/overlays that reference it. Built once on load. */
  regionCrossRefs = new Map<string, Array<{ groupId: string; groupName: string; overlayId?: string; overlayName?: string; source: 'groupRule' | 'overlayRule' | 'mirror' }>>();

  /** Maps regionId → { medianHex, calcResults: Map<calcId, { currentValue, confidences }> } */
  private regionStateMap = new Map<string, {
    medianHex: string;
    calcResults: Map<string, { currentValue: string; confidenceByMapping: Record<string, number> }>;
  }>();

  private previewSubscription: Subscription | null = null;
  private pickerUpdateSubscription: Subscription | null = null;
  private stateSubscription: Subscription | null = null;
  private perfSubscription: Subscription | null = null;
  private previewImage: HTMLImageElement | null = null;

  /** Latest perf metrics from main process, updated every second. */
  private latestPerfMetrics: any = null;

  constructor(
    private readonly electronService: ElectronService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
  ) {}

  // Expose helper to template
  rgbToHex = rgbToHex;

  @HostListener('window:focus')
  onWindowFocus(): void {
    this.isUiUnfocused = false;
  }

  @HostListener('window:blur')
  onWindowBlur(): void {
    this.isUiUnfocused = true;
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    const isCtrlS = (event.ctrlKey || event.metaKey) && event.key === 's';
    if (isCtrlS) {
      event.preventDefault();
      if (this.hasUnsavedChanges) {
        this.saveAllRegions();
      }
    }

    const isEnterInInput = event.key === 'Enter' && (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement
    );
    if (isEnterInInput) {
      event.preventDefault();
      (event.target as HTMLElement).blur();
      if (this.hasUnsavedChanges) {
        this.saveAllRegions();
      }
    }
  }

  async ngOnInit(): Promise<void> {
    this.electronService.setActivePage('regions');

    const config = await this.electronService.loadConfig();
    this.regions = config.monitoredRegions || [];
    this.overlayGroups = config.overlayGroups || [];
    this.buildRegionCrossRefs();
    // Push to backend for live evaluation, but don't mark as dirty since nothing changed
    this.electronService.setWorkingRegions(this.regions);

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

    this.perfSubscription = this.electronService.perfMetricsStream.subscribe((metrics: any) => {
      this.latestPerfMetrics = metrics;
    });

    // Scroll to and highlight an element if navigated here with ?highlight=id
    this.route.queryParams.subscribe((params) => {
      const targetId = params['highlight'];
      if (!targetId) return;

      setTimeout(() => {
        const element = document.querySelector(`[data-highlight-id="${targetId}"]`) as HTMLElement;
        if (!element) return;

        element.scrollIntoView({ behavior: 'smooth', block: 'center' });

        const scrollContainer = element.closest('.page') || document.documentElement;
        let scrollTimer: any = null;
        const onScrollEnd = () => {
          clearTimeout(scrollTimer);
          scrollTimer = setTimeout(() => {
            scrollContainer.removeEventListener('scroll', onScrollEnd);
            this.highlightId = targetId;
            setTimeout(() => { this.highlightId = null; }, 2500);
          }, 150);
        };

        scrollContainer.addEventListener('scroll', onScrollEnd);
        scrollTimer = setTimeout(() => {
          scrollContainer.removeEventListener('scroll', onScrollEnd);
          this.highlightId = targetId;
          setTimeout(() => { this.highlightId = null; }, 2500);
        }, 600);
      }, 150);
    });
  }

  ngOnDestroy(): void {
    this.previewSubscription?.unsubscribe();
    this.pickerUpdateSubscription?.unsubscribe();
    this.stateSubscription?.unsubscribe();
    this.perfSubscription?.unsubscribe();
    this.electronService.setActivePage('');
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
      enabled: true,
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
      substringMappings: [],
    };
    region.stateCalculations.push(newCalc);
    this.pushWorkingRegions();
  }

  removeStateCalculation(region: any, index: number): void {
    region.stateCalculations.splice(index, 1);
    this.pushWorkingRegions();
  }

  onCalcTypeChanged(calc: any): void {
    if (!calc.colorStateMappings) calc.colorStateMappings = [];
    if (!calc.colorThresholdMappings) calc.colorThresholdMappings = [];
    if (!calc.substringMappings) calc.substringMappings = [];
    if (calc.type === 'OCR' && !calc.ocrPreprocess) {
      calc.ocrPreprocess = {
        upscaleFactor: 2,
        invert: false,
        threshold: 0,
        colorFilterEnabled: false,
        colorFilterTarget: { red: 255, green: 255, blue: 255 },
        colorFilterTolerance: 40,
        charWhitelist: '',
        pageSegMode: 7,
        maxCharacters: 10,
      };
    }
    if (calc.type === 'OllamaLLM' && !calc.ollamaConfig) {
      calc.ollamaConfig = {
        prompt: '',
        numPredict: 5,
        think: false,
        skipIfUnchanged: true,
      };
    }
    this.pushWorkingRegions();
  }

  // -- ColorThreshold mapping CRUD --------------------------------------------

  addThresholdMapping(calc: any): void {
    if (!calc.colorThresholdMappings) calc.colorThresholdMappings = [];
    calc.colorThresholdMappings.push({
      color: { red: 0, green: 0, blue: 0 },
      matchThreshold: 80,
      consecutiveRequired: 1,
      stateValue: '',
    });
    this.pushWorkingRegions();
  }

  removeThresholdMapping(calc: any, index: number): void {
    calc.colorThresholdMappings.splice(index, 1);
    this.pushWorkingRegions();
  }

  // -- ColorThreshold drag-and-drop reorder -----------------------------------

  private thresholdDragSourceIndex: number = -1;
  private thresholdDragOverIndex: number = -1;

  onThresholdDragStart(event: DragEvent, calc: any, index: number): void {
    this.thresholdDragSourceIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  }

  onThresholdDragOver(event: DragEvent, index: number): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.thresholdDragOverIndex = index;
  }

  onThresholdDrop(event: DragEvent, calc: any): void {
    event.preventDefault();
    const sourceIndex = this.thresholdDragSourceIndex;
    const targetIndex = this.thresholdDragOverIndex;

    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;

    const mappings = calc.colorThresholdMappings;
    const [movedItem] = mappings.splice(sourceIndex, 1);
    mappings.splice(targetIndex, 0, movedItem);

    this.thresholdDragSourceIndex = -1;
    this.thresholdDragOverIndex = -1;
    this.pushWorkingRegions();
  }

  onThresholdDragEnd(): void {
    this.thresholdDragSourceIndex = -1;
    this.thresholdDragOverIndex = -1;
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

  addSubstringMapping(calc: any): void {
    if (!calc.substringMappings) calc.substringMappings = [];
    calc.substringMappings.push({ substring: '', matchMode: 'contains', minDurationMs: 0, stateValue: '' });
    this.pushWorkingRegions();
  }

  removeSubstringMapping(calc: any, index: number): void {
    calc.substringMappings.splice(index, 1);
    this.pushWorkingRegions();
  }

  onMappingColorChanged(mapping: any, hexValue: string): void {
    const rgb = hexToRgb(hexValue);
    if (rgb) {
      mapping.color = rgb;
      this.pushWorkingRegions();
    }
  }

  onPreprocessColorChanged(ocrPreprocess: any, hexValue: string): void {
    const rgb = hexToRgb(hexValue);
    if (rgb) {
      ocrPreprocess.colorFilterTarget = rgb;
      this.pushWorkingRegions();
    }
  }

  async pickColorForPreprocess(ocrPreprocess: any): Promise<void> {
    this.pickingColorForPreprocess = ocrPreprocess;
    const result = await this.electronService.pickColor();
    this.pickingColorForPreprocess = null;
    if (result) {
      ocrPreprocess.colorFilterTarget = result;
      this.pushWorkingRegions();
    }
  }

  getOcrText(regionId: string, calcId: string): string | null {
    const regionState = this.regionStateMap.get(regionId);
    if (!regionState) return null;
    const calcResult = regionState.calcResults.get(calcId);
    if (!calcResult) return null;
    return (calcResult as any).ocrText ?? null;
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  async saveAllRegions(): Promise<void> {
    // Load the current config so we preserve non-region fields, then replace regions
    const config = await this.electronService.loadConfig();
    config.monitoredRegions = JSON.parse(JSON.stringify(this.regions));
    await this.electronService.saveConfig(config);
    this.hasUnsavedChanges = false;
  }

  /**
   * Called by ngModelChange on text/number inputs to mark the form dirty
   * and push updated regions to the backend for live evaluation.
   */
  onFieldChanged(): void {
    this.pushWorkingRegions();
  }

  /**
   * Pushes the current in-memory regions to the backend so the evaluation
   * pipeline uses them immediately, without requiring a save first.
   */
  private pushWorkingRegions(): void {
    this.hasUnsavedChanges = true;
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
      const calcResults = new Map<string, {
        currentValue: string;
        confidenceByMapping: Record<string, number>;
        ocrText?: string;
        ollamaResponse?: string;
        ollamaResponseTimeMs?: number;
      }>();

      for (const calcResult of regionState.calculationResults) {
        calcResults.set(calcResult.stateCalculationId, {
          currentValue: calcResult.currentValue,
          confidenceByMapping: calcResult.confidenceByMapping,
          ocrText: calcResult.ocrText,
          ollamaResponse: calcResult.ollamaResponse,
          ollamaResponseTimeMs: calcResult.ollamaResponseTimeMs,
        });
      }

      let medianHex = '';
      if (regionState.medianColor) {
        const mc = regionState.medianColor;
        medianHex = rgbToHex(mc.red, mc.green, mc.blue);
      }

      this.regionStateMap.set(regionState.monitoredRegionId, { medianHex, calcResults });
    }
  }

  getOllamaResponse(regionId: string, calcId: string): string | null {
    const regionState = this.regionStateMap.get(regionId);
    if (!regionState) return null;
    const calcResult = regionState.calcResults.get(calcId);
    if (!calcResult) return null;
    return (calcResult as any).ollamaResponse ?? null;
  }

  getOllamaResponseTimeMs(regionId: string, calcId: string): number | null {
    const regionState = this.regionStateMap.get(regionId);
    if (!regionState) return null;
    const calcResult = regionState.calcResults.get(calcId);
    if (!calcResult) return null;
    const ms = (calcResult as any).ollamaResponseTimeMs;
    return ms !== undefined && ms > 0 ? ms : null;
  }

  // ---------------------------------------------------------------------------
  // Per-region performance metrics
  // ---------------------------------------------------------------------------

  getRegionPerfMetrics(regionId: string): { medianColorPerSec: number; colorThresholdPerSec: number; ocrPerSec: number; ollamaPerSec: number; totalCalcsPerSec: number; timeInCalcMs: number } | null {
    if (!this.latestPerfMetrics || !this.latestPerfMetrics.regionMetrics) return null;
    return this.latestPerfMetrics.regionMetrics[regionId] || null;
  }

  // ---------------------------------------------------------------------------
  // Cross-references
  // ---------------------------------------------------------------------------

  private buildRegionCrossRefs(): void {
    this.regionCrossRefs.clear();
    for (const group of this.overlayGroups) {
      // Collect from group-level rules
      const groupRuleRegionIds = new Set<string>();
      for (const rule of (group.rules || [])) {
        for (const cond of (rule.conditions || [])) {
          if (cond.monitoredRegionId) groupRuleRegionIds.add(cond.monitoredRegionId);
        }
      }
      for (const regionId of groupRuleRegionIds) {
        const existing = this.regionCrossRefs.get(regionId) || [];
        existing.push({ groupId: group.id, groupName: group.name, source: 'groupRule' });
        this.regionCrossRefs.set(regionId, existing);
      }

      // Collect from individual overlays
      for (const overlay of (group.overlays || [])) {
        const rulesRegionIds = new Set<string>();
        for (const rule of (overlay.rules || [])) {
          for (const cond of (rule.conditions || [])) {
            if (cond.monitoredRegionId) rulesRegionIds.add(cond.monitoredRegionId);
          }
        }
        for (const regionId of rulesRegionIds) {
          const existing = this.regionCrossRefs.get(regionId) || [];
          existing.push({ groupId: group.id, groupName: group.name, overlayId: overlay.id, overlayName: overlay.name, source: 'overlayRule' });
          this.regionCrossRefs.set(regionId, existing);
        }

        const mirrorRegionId = overlay.contentType === 'regionMirror'
          ? overlay.regionMirrorConfig?.monitoredRegionId : null;
        if (mirrorRegionId) {
          const existing = this.regionCrossRefs.get(mirrorRegionId) || [];
          existing.push({ groupId: group.id, groupName: group.name, overlayId: overlay.id, overlayName: overlay.name, source: 'mirror' });
          this.regionCrossRefs.set(mirrorRegionId, existing);
        }
      }
    }
  }

  navigateToOverlay(overlayId: string): void {
    this.router.navigate(['/overlays'], { queryParams: { highlight: overlayId } });
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

      // Skip rendering for canvases not visible in the viewport
      const canvasIsVisible = this.isElementInViewport(canvas);
      if (!canvasIsVisible) continue;

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

  /** Returns true if the element is at least partially visible in the viewport. */
  private isElementInViewport(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    // Add a generous margin so elements just about to scroll into view are pre-rendered
    const margin = 200;
    const isAboveViewport = rect.bottom < -margin;
    const isBelowViewport = rect.top > viewportHeight + margin;
    return !isAboveViewport && !isBelowViewport;
  }
}
