import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChildren,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { PendingChangesComponent } from '../../guards/pending-changes.guard';
import { ElectronService } from '../../services/electron.service';
import { PendingChangesService } from '../../services/pending-changes.service';
import type { RegionsPreviewFrameData } from '../../models/electron-api';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
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
        <button (click)="openImportRegionDialog()">Import a Monitored Region</button>
      </div>
      <div class="toolbar-secondary">
        <button class="tertiary-btn" (click)="expandAllRegions()"><span class="tertiary-icon">&#9662;</span>Expand All</button>
        <button class="tertiary-btn" (click)="collapseAllRegions()"><span class="tertiary-icon">&#9656;</span>Collapse All</button>
      </div>

      <div *ngIf="showImportRegionDialog" class="modal-backdrop" (click)="closeImportRegionDialog()">
        <div class="modal-dialog" (click)="$event.stopPropagation()">
          <h3>Import Monitored Region</h3>
          <p class="modal-description">Paste a shared Monitored Region JSON export.</p>
          <textarea
            [(ngModel)]="importRegionJsonText"
            placeholder="Paste Monitored Region JSON here..."
            rows="12"
            class="modal-textarea">
          </textarea>
          <div *ngIf="importRegionErrorMessage" class="modal-error">{{ importRegionErrorMessage }}</div>
          <div *ngIf="importRegionConflictRegionName" class="modal-conflict">
            You already have "{{ importRegionConflictRegionName }}".
            Do you want to update that region, or create a copy?
          </div>
          <div class="import-actions">
            <button
              *ngIf="!importRegionConflictRegionName"
              class="primary"
              (click)="importSharedRegion()">Import</button>
            <button
              *ngIf="importRegionConflictRegionName"
              class="primary"
              (click)="resolveImportedRegionConflict('update')">Update Existing</button>
            <button
              *ngIf="importRegionConflictRegionName"
              (click)="resolveImportedRegionConflict('copy')">Create Copy</button>
            <button (click)="closeImportRegionDialog()">Cancel</button>
          </div>
        </div>
      </div>

      <div *ngIf="shareRegionJson" class="modal-backdrop" (click)="closeShareRegionDialog()">
        <div class="modal-dialog" (click)="$event.stopPropagation()">
          <h3>Share Monitored Region</h3>
          <p class="modal-description">Copy this JSON and share it with another user. They will likely need to adjust the region with the "Pick Region" button.</p>
          <textarea
            [ngModel]="shareRegionJson"
            readonly
            rows="12"
            class="modal-textarea">
          </textarea>
          <div class="import-actions">
            <button class="primary" (click)="copySharedRegionJson()">{{ shareRegionCopied ? 'Copied!' : 'Copy to Clipboard' }}</button>
            <button (click)="closeShareRegionDialog()">Close</button>
          </div>
        </div>
      </div>

      <div *ngIf="showUnsavedChangesDialog" class="modal-backdrop" (click)="stayOnPage()">
        <div class="modal-dialog" (click)="$event.stopPropagation()">
          <h3>Unsaved Changes</h3>
          <p class="modal-description">You have unsaved changes in Monitored Regions.</p>
          <div class="unsaved-actions">
            <button
              class="primary"
              [disabled]="isResolvingUnsavedChanges"
              (click)="saveAndContinueNavigation()">
              Save and Continue
            </button>
            <button
              class="danger-btn"
              [disabled]="isResolvingUnsavedChanges"
              (click)="leaveWithoutSaving()">
              Leave without Saving
            </button>
            <button
              class="tertiary-btn"
              [disabled]="isResolvingUnsavedChanges"
              (click)="stayOnPage()">
              Stay Here
            </button>
          </div>
        </div>
      </div>

      <div *ngIf="regions.length === 0" class="empty-state">
        No monitored regions defined yet. Click "+ Add Region" to get started.
      </div>

      <div *ngFor="let region of regions; let regionIndex = index; trackBy: trackByRegionId"
        class="region-card"
        [attr.data-highlight-id]="region.id"
        [class.highlight-flash]="highlightId === region.id"
        [class.region-card-collapsed]="!isRegionExpanded(region.id)"
        [class.region-disabled]="region.enabled === false">
        <div class="region-header">
          <button
            class="collapse-toggle"
            (click)="toggleRegionExpanded(region.id)"
            [attr.aria-label]="isRegionExpanded(region.id) ? 'Collapse region' : 'Expand region'"
            [title]="isRegionExpanded(region.id) ? 'Collapse' : 'Expand'">
            {{ isRegionExpanded(region.id) ? '▾' : '▸' }}
          </button>
          <label class="enabled-toggle" title="Enable/disable this region">
            <input type="checkbox"
              [ngModel]="region.enabled !== false"
              (ngModelChange)="region.enabled = $event; onFieldChanged()" />
          </label>
          <div class="region-name-stack">
            <input
              [(ngModel)]="region.name"
              (ngModelChange)="onFieldChanged()"
              placeholder="Region name"
              class="name-input"
              [attr.data-region-name-id]="region.id" />
            <button class="share-link" (click)="openShareRegionDialog(region)">Share</button>
          </div>
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
          <div
            class="collapsed-region-preview"
            *ngIf="!isRegionExpanded(region.id) && hasValidBounds(region) && hasPreviewFrame">
            <canvas
              #previewCanvas
              [attr.data-region-id]="region.id"
              class="preview-canvas preview-canvas-collapsed"
              [width]="getCollapsedPreviewCanvasWidth(region)"
              [height]="getCollapsedPreviewCanvasHeight(region)">
            </canvas>
          </div>
          <div
            class="collapsed-state-summary"
            *ngIf="!isRegionExpanded(region.id)"
            [title]="getCollapsedStateCalculationName(region) || ''">
            <div
              class="collapsed-state-label"
              [title]="getCollapsedStateCalculationName(region) || ''">
              {{ getCollapsedStateCalculationName(region) || '' }}
            </div>
            <div
              class="collapsed-state-value"
              [title]="getCollapsedStateValue(region) || ''">
              {{ getCollapsedStateValue(region) || '' }}
            </div>
          </div>
          <button class="danger-text" (click)="removeRegion(regionIndex)">Remove</button>
        </div>
        <ng-container *ngIf="isRegionExpanded(region.id)">
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
            <div class="repeat-section">
              <div class="section-header repeat-header">
                <span class="section-label">Repeat?</span>
                <label class="checkbox-label repeat-toggle">
                  <input
                    type="checkbox"
                    [ngModel]="region.repeat?.enabled === true"
                    (ngModelChange)="onRegionRepeatEnabledChanged(region, $event)" />
                </label>
              </div>
              <div *ngIf="region.repeat?.enabled" class="region-repeat">
                <div class="repeat-settings">
                <div class="repeat-axis-row">
                  <label class="checkbox-label">
                    <input
                      type="checkbox"
                      [(ngModel)]="region.repeat.x.enabled"
                      (ngModelChange)="onFieldChanged()" />
                    Repeat X
                  </label>
                  <label *ngIf="region.repeat.x.enabled">Every X
                    <input
                      type="number"
                      [(ngModel)]="region.repeat.x.every"
                      (ngModelChange)="onFieldChanged()" />
                  </label>
                  <label *ngIf="region.repeat.x.enabled">Times
                    <input
                      type="number"
                      min="1"
                      [(ngModel)]="region.repeat.x.count"
                      (ngModelChange)="onFieldChanged()" />
                  </label>
                </div>
                <div class="repeat-axis-row">
                  <label class="checkbox-label">
                    <input
                      type="checkbox"
                      [(ngModel)]="region.repeat.y.enabled"
                      (ngModelChange)="onFieldChanged()" />
                    Repeat Y
                  </label>
                  <label *ngIf="region.repeat.y.enabled">Every Y
                    <input
                      type="number"
                      [(ngModel)]="region.repeat.y.every"
                      (ngModelChange)="onFieldChanged()" />
                  </label>
                  <label *ngIf="region.repeat.y.enabled">Times
                    <input
                      type="number"
                      min="1"
                      [(ngModel)]="region.repeat.y.count"
                      (ngModelChange)="onFieldChanged()" />
                  </label>
                </div>
                <div class="repeat-summary">
                  Total Regions: {{ getRepeatInstanceCount(region) }}
                </div>
              </div>
            </div>
            </div>

            <!-- State Calculations -->
            <div class="state-calcs-section">
              <div class="section-header">
                <span class="section-label">State Calculations</span>
                <div class="section-actions">
                  <button class="add-btn" (click)="addStateCalculation(region)">+ Add</button>
                  <button class="add-btn" (click)="openCopyStateCalculationDialog(region)">+ Copy</button>
                </div>
              </div>

              <div *ngIf="copyStateCalculationRegionId === region.id" class="copy-calc-dialog">
                <input
                  [(ngModel)]="copyStateCalculationSearchText"
                  placeholder="Search calculations"
                  class="copy-calc-search" />
                <div class="copy-calc-list">
                  <button
                    *ngFor="let option of getFilteredCopyStateCalculations()"
                    type="button"
                    class="copy-calc-option"
                    (mousedown)="selectCopyStateCalculationOption($event, region, option.calc)">
                    <span class="copy-calc-name">{{ option.calc.name }}</span>
                    <span class="copy-calc-meta">{{ option.regionName }} · {{ option.calc.type }}</span>
                  </button>
                  <div *ngIf="getFilteredCopyStateCalculations().length === 0" class="copy-calc-empty">
                    No calculations match your search.
                  </div>
                </div>
                <div class="copy-calc-actions">
                  <button (click)="closeCopyStateCalculationDialog()">Cancel</button>
                </div>
              </div>

              <div *ngFor="let calc of region.stateCalculations; let calcIndex = index; trackBy: trackByCalcId" class="calc-card">
                <div class="calc-header">
                  <input
                    [(ngModel)]="calc.name"
                    (ngModelChange)="onFieldChanged()"
                    placeholder="Calculation name"
                    class="calc-name-input"
                    [attr.data-calc-name-id]="calc.id" />
                  <select [(ngModel)]="calc.type" (ngModelChange)="onCalcTypeChanged(calc)" class="calc-type-select">
                    <option value="MedianPixelColor">Closest to Median Color</option>
                    <option value="ColorThreshold">Color Threshold Match</option>
                    <option value="OCR">OCR (Text Recognition)</option>
                    <option value="OllamaLLM">Ollama LLM Prompt</option>
                  </select>
                  <label class="checkbox-label skip-unchanged-label" title="Only evaluate this calculation when the region's pixels have changed since the last evaluation. Saves CPU when monitoring static content.">
                    <input type="checkbox"
                      [(ngModel)]="calc.skipIfUnchanged"
                      (ngModelChange)="onFieldChanged()" />
                    Only Evaluate on Changes
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
                      (focus)="selectAllInputText($event)"
                      (mouseup)="preserveSelectedInputText($event)"
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
                      (focus)="selectAllInputText($event)"
                      (mouseup)="preserveSelectedInputText($event)"
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
                      <option value="containsAnyValue">Contains Any Value</option>
                      <option value="equals">Equals</option>
                      <option value="notEquals">Does Not Equal</option>
                      <option value="startsWith">Starts With</option>
                      <option value="endsWith">Ends With</option>
                      <option value="noValueDetected">No Value Detected</option>
                    </select>
                    <input *ngIf="ocrMatchModeRequiresTextInput(mapping.matchMode)"
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
                      <input type="range" min="1" max="5000" step="1"
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
                      Only Evaluate on Changes
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Right: live preview + per-calc readouts -->
          <div class="region-right">
            <div class="region-preview" *ngIf="hasValidBounds(region) && hasPreviewFrame">
              <canvas
                #previewCanvas
                [attr.data-region-id]="region.id"
                class="preview-canvas"
                [width]="getPreviewCanvasWidth(region)"
                [height]="getPreviewCanvasHeight(region)">
              </canvas>
            </div>
            <div class="region-preview placeholder-preview" *ngIf="!hasPreviewFrame || !hasValidBounds(region)">
              <span class="preview-label">{{ !hasPreviewFrame ? 'Start capture' : 'Set bounds' }}</span>
            </div>

            <!-- Per-calculation readouts -->
            <div *ngFor="let calc of region.stateCalculations; trackBy: trackByCalcId" class="calc-readout">

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

              <div class="repeat-instance-list" *ngIf="getRegionInstanceStates(region.id).length > 1">
                <div class="repeat-instance-header">
                  <span>Base/Coordinate</span>
                  <span>Median Color</span>
                  <span>State Value</span>
                </div>
                <div class="repeat-instance-row" *ngFor="let instanceState of getRegionInstanceStates(region.id); trackBy: trackByRegionInstanceStateId">
                  <span class="repeat-instance-label">{{ getRegionInstanceLabel(instanceState) }}</span>
                  <span class="repeat-instance-median">{{ instanceState.medianHex || '(n/a)' }}</span>
                  <span class="repeat-instance-value">
                    <ng-container *ngIf="getRegionInstanceDisplayParts(instanceState, calc) as parts">
                      <span>{{ parts.primary }}</span>
                      <span *ngIf="parts.secondary" class="repeat-instance-secondary">{{ parts.secondary }}</span>
                    </ng-container>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="region-save-row" *ngIf="hasUnsavedChanges && isRegionDirty(region)">
          <button class="primary" (click)="saveAllRegions()">Save (Ctrl+S)</button>
        </div>
        </ng-container>
      </div>

      <button class="primary add-bottom-btn" (click)="addRegion()">+ Add Region</button>
    </div>
  `,
  styles: [`
    .page { max-width: 1100px; }

    .cpu-warning-banner {
      position: fixed;
      top: 44px;
      left: 50%;
      transform: translateX(-50%);
      width: 100%;
      z-index: 200;
      background-color: var(--color-warning);
      color: #000;
      font-weight: 600;
      font-size: 0.9rem;
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      text-align: center;
      line-height: 1.4;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
    }
    h2 { margin-bottom: var(--spacing-sm); }
    .description { color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }

    .toolbar {
      display: flex;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      flex-wrap: wrap;
    }
    .toolbar-secondary {
      display: flex;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-sm); 
      margin-top: var(--spacing-lg);
      flex-wrap: wrap;
    }
    .tertiary-btn {
      background: transparent;
      border: none;
      padding: 0;
      color: var(--color-text-secondary);
      font-size: 0.85rem;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .tertiary-btn:hover {
      color: var(--color-accent);
    }
    .tertiary-icon {
      display: inline-block;
      margin-right: 6px;
      font-size: 0.8rem;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-lg);
      z-index: 1000;
    }
    .modal-dialog {
      width: min(760px, 100%);
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
    }
    .modal-description {
      color: var(--color-text-secondary);
      margin-bottom: var(--spacing-sm);
    }
    .unsaved-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-md);
      flex-wrap: wrap;
    }
    .danger-btn {
      background-color: #7f1d1d;
      border-color: #7f1d1d;
      color: #fff;
    }
    .danger-btn:hover {
      background-color: #991b1b;
      border-color: #991b1b;
    }
    .modal-textarea {
      width: 100%;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      margin-bottom: var(--spacing-sm);
    }
    .modal-error {
      color: var(--color-error);
      font-size: 0.85rem;
      margin-bottom: var(--spacing-sm);
    }
    .modal-conflict {
      color: var(--color-text-secondary);
      font-size: 0.85rem;
      margin-bottom: var(--spacing-sm);
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

    .collapse-toggle {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-secondary);
      border-radius: var(--radius-sm);
      width: 28px;
      height: 28px;
      padding: 0;
      font-size: 1.25rem;
      line-height: 1;
      flex-shrink: 0;
    }
    .collapse-toggle:hover {
      color: var(--color-text-primary);
      border-color: var(--color-accent);
      background-color: var(--color-bg-panel);
    }

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

    .region-card-collapsed {
      padding-top: 5px;
      padding-bottom: 5px;
    }

    .region-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--spacing-sm);
    }
    .region-name-stack {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      flex: 1;
      min-width: 0;
    }
    .share-link {
      background: transparent;
      border: none;
      padding: 0;
      margin-left: var(--spacing-xs);
      margin-top: -5px;
      color: var(--color-text-secondary);
      font-size: 0.75rem;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .share-link:hover {
      color: var(--color-accent);
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
      margin-top: var(--spacing-sm);
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
      min-width: 0;
    }
    .name-input:focus { border-color: var(--color-accent); }

    .collapsed-region-preview {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    .collapsed-state-summary {
      width: 100px;
      min-width: 100px;
      max-width: 100px;
      max-height: 56px;
      padding: 0 8px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 2px;
      overflow: hidden;
      flex-shrink: 0;
    }

    .collapsed-state-label {
      color: var(--color-text-secondary);
      font-size: 0.68rem;
      line-height: 1.1;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .collapsed-state-value {
      display: flex;
      align-items: center;
      color: var(--color-text-secondary);
      font-size: .8rem;
      font-weight: 500;
      line-height: 1.2;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .region-content-row {
      display: flex;
      margin-top: var(--spacing-md);
      gap: var(--spacing-lg);
    }

    .region-save-row {
      display: flex;
      justify-content: flex-end;
      margin-top: var(--spacing-md);
      padding-top: var(--spacing-sm);
      border-top: 1px solid var(--color-border);
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

    .repeat-section {
      margin-bottom: var(--spacing-md);
    }

    .repeat-header {
      margin-bottom: var(--spacing-sm);
    }

    .repeat-toggle {
      margin-left: auto;
    }

    .region-repeat {
      padding: var(--spacing-sm);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background-color: var(--color-bg-primary);
    }

    .repeat-settings {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-sm);
    }

    .repeat-axis-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex-wrap: wrap;
    }

    .repeat-axis-row input[type="number"] {
      width: 90px;
    }

    .repeat-summary {
      color: var(--color-text-secondary);
      font-size: 0.8rem;
    }

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

    .section-actions {
      display: flex;
      gap: var(--spacing-xs);
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

    .copy-calc-dialog {
      background-color: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
    }

    .copy-calc-search {
      width: 100%;
      margin-bottom: var(--spacing-sm);
    }

    .copy-calc-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      max-height: 220px;
      overflow-y: auto;
    }

    .copy-calc-option {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      width: 100%;
      text-align: left;
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 8px 10px;
    }

    .copy-calc-name {
      font-size: 0.85rem;
      font-weight: 600;
    }

    .copy-calc-meta {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }

    .copy-calc-empty {
      color: var(--color-text-secondary);
      font-size: 0.8rem;
      padding: 6px 0;
    }

    .copy-calc-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: var(--spacing-sm);
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

    .preview-canvas-collapsed {
      max-width: 96px;
      max-height: 56px;
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

    .repeat-instance-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: var(--spacing-sm);
      padding-top: var(--spacing-sm);
      border-top: 1px dashed var(--color-border);
    }

    .repeat-instance-header,
    .repeat-instance-row {
      display: grid;
      grid-template-columns: minmax(90px, 1.1fr) minmax(90px, 1fr) minmax(100px, 1.2fr);
      gap: var(--spacing-sm);
      font-size: 0.78rem;
      align-items: center;
    }

    .repeat-instance-header {
      color: var(--color-text-secondary);
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .repeat-instance-label {
      color: var(--color-text-secondary);
      white-space: nowrap;
      text-align: left;
    }

    .repeat-instance-median {
      font-family: var(--font-mono);
      text-align: left;
    }

    .repeat-instance-value {
      text-align: left;
      word-break: break-word;
    }

    .repeat-instance-secondary {
      opacity: 0.7;
      margin-left: 4px;
    }

    .ollama-response-value {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--color-accent);
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: wrap;
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
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
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
export class MonitoredRegionsComponent implements OnInit, AfterViewInit, OnDestroy, PendingChangesComponent {
  private static readonly STORAGE_KEY_COLLAPSED_REGIONS = 'fundido:collapsedRegions';
  private static readonly SHARED_REGION_EXPORT_TYPE = 'FundidoMonitoredRegion';

  @ViewChildren('previewCanvas') private previewCanvasRefs!: QueryList<ElementRef<HTMLCanvasElement>>;

  regions: any[] = [];
  overlayGroups: any[] = [];
  showImportRegionDialog = false;
  showUnsavedChangesDialog = false;
  importRegionJsonText = '';
  importRegionErrorMessage = '';
  importRegionConflictRegionName = '';
  shareRegionJson = '';
  shareRegionCopied = false;
  isResolvingUnsavedChanges = false;
  pickingRegionId: string | null = null;
  pickingColorForPreprocess: any = null;
  hasPreviewFrame = false;
  hasUnsavedChanges = false;
  highlightId: string | null = null;
  isUiUnfocused = false;
  copyStateCalculationRegionId: string | null = null;
  copyStateCalculationSearchText = '';

  /** Cached cross-references: regionId → overlay groups/overlays that reference it. Built once on load. */
  regionCrossRefs = new Map<string, Array<{ groupId: string; groupName: string; overlayId?: string; overlayName?: string; source: 'groupRule' | 'overlayRule' | 'mirror' }>>();
  private collapsedRegionIds = new Set<string>();
  private savedRegionSnapshots = new Map<string, string>();
  private regionComparableSnapshots = new Map<string, string>();
  private pendingImportedRegion: any | null = null;
  private pendingNavigationPromise: Promise<boolean> | null = null;
  private pendingNavigationResolve: ((allowNavigation: boolean) => void) | null = null;

  /** Maps regionId → { medianHex, calcResults: Map<calcId, { currentValue, confidences }> } */
  private regionStateMap = new Map<string, {
    medianHex: string;
    calcResults: Map<string, { currentValue: string; confidenceByMapping: Record<string, number> }>;
  }>();
  private regionInstanceStateMap = new Map<string, Array<{
    runtimeMonitoredRegionId: string;
    repeatIndexX: number;
    repeatIndexY: number;
    medianHex: string;
    calcResults: Map<string, {
      currentValue: string;
      confidenceByMapping: Record<string, number>;
      ocrText?: string;
      ollamaResponse?: string;
      ollamaResponseTimeMs?: number;
    }>;
  }>>();
  private regionStateDisplaySnapshot = '';

  private previewSubscription: Subscription | null = null;
  private pickerUpdateSubscription: Subscription | null = null;
  private stateSubscription: Subscription | null = null;
  private perfSubscription: Subscription | null = null;
  private previewCanvasChangesSubscription: Subscription | null = null;
  private latestPreviewFrame: RegionsPreviewFrameData | null = null;
  private previewCanvasByRegionId = new Map<string, HTMLCanvasElement>();
  private visiblePreviewRegionIds = new Set<string>();
  private previewVisibilityObserver: IntersectionObserver | null = null;
  private previewRenderScheduled = false;
  private viewRefreshScheduled = false;
  private rawPreviewCanvas: HTMLCanvasElement | null = null;
  private rawPreviewContext: CanvasRenderingContext2D | null = null;
  private rawPreviewRgbaBuffer: Uint8ClampedArray | null = null;

  /** Latest perf metrics from main process, updated every second. */
  private latestPerfMetrics: any = null;

  constructor(
    private readonly electronService: ElectronService,
    private readonly pendingChangesService: PendingChangesService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly changeDetectorRef: ChangeDetectorRef,
    private readonly ngZone: NgZone,
  ) {}

  // Expose helper to template
  rgbToHex = rgbToHex;

  @HostListener('window:focus')
  onWindowFocus(): void {
    this.isUiUnfocused = false;
    this.changeDetectorRef.markForCheck();
  }

  @HostListener('window:blur')
  onWindowBlur(): void {
    this.isUiUnfocused = true;
    this.changeDetectorRef.markForCheck();
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
    this.pendingChangesService.register(this);
    this.electronService.setActivePage('regions');

    const config = await this.electronService.loadConfig();
    this.regions = config.monitoredRegions || [];
    this.normalizeRepeatConfigs();
    this.normalizeOcrMatchModes();
    this.normalizeCalculationEvaluationDefaults();
    this.refreshSavedRegionSnapshots();
    this.refreshRegionComparableSnapshots();
    this.loadCollapsedRegionState();
    this.syncCollapsedRegionState();
    this.overlayGroups = config.overlayGroups || [];
    this.buildRegionCrossRefs();
    // Push to backend for live evaluation, but don't mark as dirty since nothing changed
    this.electronService.setWorkingRegions(this.regions);
    this.electronService.setDirtyRegionOverlays([]);
    this.changeDetectorRef.markForCheck();

    this.ngZone.runOutsideAngular(() => {
      this.previewSubscription = this.electronService.regionsPreviewFrameStream.subscribe((frame) => {
        this.handlePreviewFrame(frame);
      });
    });

    this.pickerUpdateSubscription = this.electronService.pickerRegionUpdateStream.subscribe((region) => {
      const pickingRegion = this.regions.find((r: any) => r.id === this.pickingRegionId);
      if (pickingRegion) {
        pickingRegion.bounds.x = region.x;
        pickingRegion.bounds.y = region.y;
        pickingRegion.bounds.width = region.width;
        pickingRegion.bounds.height = region.height;
        this.pushWorkingRegions();
        this.scheduleRegionPreviewRender();
        this.changeDetectorRef.markForCheck();
      }
    });

    this.ngZone.runOutsideAngular(() => {
      this.stateSubscription = this.electronService.stateUpdateStream.subscribe((frameState: any) => {
        if (this.processFrameState(frameState)) {
          this.scheduleViewRefresh();
        }
      });
    });

    this.perfSubscription = this.electronService.perfMetricsStream.subscribe((metrics: any) => {
      this.latestPerfMetrics = metrics;
      this.changeDetectorRef.markForCheck();
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
            setTimeout(() => {
              this.highlightId = null;
              this.changeDetectorRef.markForCheck();
            }, 2500);
            this.changeDetectorRef.markForCheck();
          }, 150);
        };

        scrollContainer.addEventListener('scroll', onScrollEnd);
        scrollTimer = setTimeout(() => {
          scrollContainer.removeEventListener('scroll', onScrollEnd);
          this.highlightId = targetId;
          setTimeout(() => {
            this.highlightId = null;
            this.changeDetectorRef.markForCheck();
          }, 2500);
          this.changeDetectorRef.markForCheck();
        }, 600);
      }, 150);
    });
  }

  ngAfterViewInit(): void {
    this.ngZone.runOutsideAngular(() => {
      this.previewVisibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLCanvasElement;
          const regionId = target.dataset['regionId'];
          if (!regionId) continue;

          if (entry.isIntersecting) {
            this.visiblePreviewRegionIds.add(regionId);
          } else {
            this.visiblePreviewRegionIds.delete(regionId);
          }
        }

        this.scheduleRegionPreviewRender();
      }, {
        root: null,
        rootMargin: '200px 0px 200px 0px',
        threshold: 0,
      });

      this.previewCanvasChangesSubscription = this.previewCanvasRefs.changes.subscribe(() => {
        this.refreshPreviewCanvasTracking();
      });

      this.refreshPreviewCanvasTracking();
    });
  }

  ngOnDestroy(): void {
    this.pendingChangesService.unregister(this);
    this.previewSubscription?.unsubscribe();
    this.pickerUpdateSubscription?.unsubscribe();
    this.stateSubscription?.unsubscribe();
    this.perfSubscription?.unsubscribe();
    this.previewCanvasChangesSubscription?.unsubscribe();
    this.previewVisibilityObserver?.disconnect();
    this.electronService.setActivePage('');
    // Clear working regions so the pipeline falls back to saved config
    this.electronService.setWorkingRegions(null as any);
    this.electronService.setDirtyRegionOverlays([]);
    this.resolvePendingNavigation(false);
  }

  canDeactivate(): boolean | Promise<boolean> {
    if (!this.hasUnsavedChanges) {
      return true;
    }

    if (this.pendingNavigationPromise) {
      return this.pendingNavigationPromise;
    }

    this.showUnsavedChangesDialog = true;
    this.changeDetectorRef.markForCheck();
    this.pendingNavigationPromise = new Promise<boolean>((resolve) => {
      this.pendingNavigationResolve = resolve;
    });
    return this.pendingNavigationPromise;
  }

  async saveAndContinueNavigation(): Promise<void> {
    if (!this.pendingNavigationResolve || this.isResolvingUnsavedChanges) {
      return;
    }

    this.isResolvingUnsavedChanges = true;
    this.changeDetectorRef.markForCheck();

    try {
      await this.saveAllRegions();
      this.resolvePendingNavigation(true);
    } catch {
      this.isResolvingUnsavedChanges = false;
      this.changeDetectorRef.markForCheck();
    }
  }

  leaveWithoutSaving(): void {
    this.resolvePendingNavigation(true);
  }

  stayOnPage(): void {
    this.resolvePendingNavigation(false);
  }

  // ---------------------------------------------------------------------------
  // Region CRUD
  // ---------------------------------------------------------------------------

  addRegion(): void {
    const newRegion = {
      id: crypto.randomUUID(),
      name: 'New Region',
      enabled: true,
      lastUpdatedAt: Date.now(),
      repeat: this.createDefaultRepeatConfig(),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      stateCalculations: [],
    };
    this.regions.push(newRegion);
    this.collapsedRegionIds.delete(newRegion.id);
    this.saveCollapsedRegionState();
    this.pushWorkingRegions();
    this.changeDetectorRef.markForCheck();
    setTimeout(() => {
      const input = document.querySelector(`[data-region-name-id="${newRegion.id}"]`) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    }, 0);
  }

  async removeRegion(index: number): Promise<void> {
    const [removedRegion] = this.regions.splice(index, 1);
    if (removedRegion?.id) {
      this.collapsedRegionIds.delete(removedRegion.id);
      this.saveCollapsedRegionState();
    }
    this.pushWorkingRegions();
    this.changeDetectorRef.markForCheck();
    await this.saveAllRegions();
  }

  isRegionExpanded(regionId: string): boolean {
    return !this.collapsedRegionIds.has(regionId);
  }

  toggleRegionExpanded(regionId: string): void {
    if (this.collapsedRegionIds.has(regionId)) {
      this.collapsedRegionIds.delete(regionId);
    } else {
      this.collapsedRegionIds.add(regionId);
    }
    this.saveCollapsedRegionState();
    this.changeDetectorRef.markForCheck();
  }

  expandAllRegions(): void {
    this.collapsedRegionIds.clear();
    this.saveCollapsedRegionState();
    this.changeDetectorRef.markForCheck();
  }

  collapseAllRegions(): void {
    this.collapsedRegionIds = new Set(this.regions.map((region) => region.id));
    this.saveCollapsedRegionState();
    this.changeDetectorRef.markForCheck();
  }

  hasValidBounds(region: any): boolean {
    return region.bounds.width > 0 && region.bounds.height > 0;
  }

  onRegionRepeatEnabledChanged(region: any, enabled: boolean): void {
    this.ensureRepeatConfig(region);
    region.repeat.enabled = enabled === true;
    this.onFieldChanged();
  }

  getRepeatInstanceCount(region: any): number {
    this.ensureRepeatConfig(region);
    if (!region.repeat.enabled) {
      return 1;
    }

    const xCount = region.repeat.x.enabled ? this.normalizeRepeatCount(region.repeat.x.count) : 1;
    const yCount = region.repeat.y.enabled ? this.normalizeRepeatCount(region.repeat.y.count) : 1;
    return xCount * yCount;
  }

  getRegionInstanceStates(regionId: string): Array<{
    runtimeMonitoredRegionId: string;
    repeatIndexX: number;
    repeatIndexY: number;
    medianHex: string;
    calcResults: Map<string, {
      currentValue: string;
      confidenceByMapping: Record<string, number>;
      ocrText?: string;
      ollamaResponse?: string;
      ollamaResponseTimeMs?: number;
    }>;
  }> {
    return this.regionInstanceStateMap.get(regionId) || [];
  }

  getRegionInstanceLabel(instanceState: { repeatIndexX: number; repeatIndexY: number }): string {
    const isBaseInstance = instanceState.repeatIndexX === 0 && instanceState.repeatIndexY === 0;
    if (isBaseInstance) {
      return 'Base';
    }

    return `X${instanceState.repeatIndexX + 1}, Y${instanceState.repeatIndexY + 1}`;
  }

  trackByRegionInstanceStateId(_index: number, instanceState: { runtimeMonitoredRegionId: string }): string {
    return instanceState.runtimeMonitoredRegionId;
  }

  getRegionInstanceDisplayParts(instanceState: {
    calcResults: Map<string, {
      currentValue: string;
      confidenceByMapping: Record<string, number>;
      ocrText?: string;
      ollamaResponse?: string;
    }>;
  }, calc: any): { primary: string; secondary?: string } {
    const calcResult = instanceState.calcResults.get(calc.id);
    if (!calcResult) {
      return { primary: '(empty)' };
    }

    if (calc.type === 'OCR') {
      return { primary: calcResult.ocrText ?? calcResult.currentValue ?? '(empty)' };
    }

    if (calc.type === 'OllamaLLM') {
      return { primary: calcResult.ollamaResponse ?? calcResult.currentValue ?? 'Waiting...' };
    }

    if (calc.type === 'ColorThreshold' && calcResult.currentValue) {
      const confidence = calcResult.confidenceByMapping?.[calcResult.currentValue];
      if (confidence !== undefined) {
        return {
          primary: calcResult.currentValue,
          secondary: `(${confidence.toFixed(1)}%)`,
        };
      }
    }

    return { primary: calcResult.currentValue || '(empty)' };
  }

  // ---------------------------------------------------------------------------
  // State Calculation CRUD
  // ---------------------------------------------------------------------------

  addStateCalculation(region: any): void {
    const newCalc = {
      id: crypto.randomUUID(),
      name: 'New Calculation',
      type: 'MedianPixelColor',
      skipIfUnchanged: true,
      colorStateMappings: [],
      substringMappings: [],
    };
    region.stateCalculations.push(newCalc);
    this.pushWorkingRegions();
    this.focusCalculationName(newCalc.id);
  }

  removeStateCalculation(region: any, index: number): void {
    region.stateCalculations.splice(index, 1);
    this.pushWorkingRegions();
  }

  onCalcTypeChanged(calc: any): void {
    if (calc.skipIfUnchanged === undefined) {
      calc.skipIfUnchanged = true;
    }
    if (!calc.colorStateMappings) calc.colorStateMappings = [];
    if (!calc.colorThresholdMappings) calc.colorThresholdMappings = [];
    if (!calc.substringMappings) calc.substringMappings = [];
    if (calc.type === 'OCR' && !calc.ocrPreprocess) {
      calc.ocrPreprocess = {
        upscaleFactor: 1,
        invert: false,
        threshold: 100,
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

  openCopyStateCalculationDialog(region: any): void {
    this.copyStateCalculationRegionId = region.id;
    this.copyStateCalculationSearchText = '';
  }

  closeCopyStateCalculationDialog(): void {
    this.copyStateCalculationRegionId = null;
    this.copyStateCalculationSearchText = '';
  }

  getFilteredCopyStateCalculations(): Array<{ regionId: string; regionName: string; calc: any }> {
    const search = this.copyStateCalculationSearchText.trim().toLowerCase();
    const options: Array<{ regionId: string; regionName: string; calc: any }> = [];

    for (const region of this.regions) {
      for (const calc of region.stateCalculations || []) {
        options.push({
          regionId: region.id,
          regionName: region.name || 'Unnamed Region',
          calc,
        });
      }
    }

    if (!search) {
      return options;
    }

    return options.filter((option) =>
      (option.calc.name || '').toLowerCase().includes(search) ||
      option.regionName.toLowerCase().includes(search) ||
      (option.calc.type || '').toLowerCase().includes(search)
    );
  }

  copyStateCalculationToRegion(region: any, sourceCalc: any): void {
    const copiedCalc = JSON.parse(JSON.stringify(sourceCalc));
    copiedCalc.id = crypto.randomUUID();
    this.normalizeOcrMatchModesOnCalculation(copiedCalc);
    this.normalizeCalculationEvaluationDefaultsOnRegion({ stateCalculations: [copiedCalc] });
    if (copiedCalc.type === 'OCR') {
      copiedCalc.ocrPreprocess = copiedCalc.ocrPreprocess || {
        upscaleFactor: 1,
        invert: false,
        threshold: 100,
        colorFilterEnabled: false,
        colorFilterTarget: { red: 255, green: 255, blue: 255 },
        colorFilterTolerance: 40,
        charWhitelist: '',
        pageSegMode: 7,
        maxCharacters: 10,
      };
    }

    region.stateCalculations.push(copiedCalc);
    this.closeCopyStateCalculationDialog();
    this.pushWorkingRegions();
    this.focusCalculationName(copiedCalc.id);
  }

  selectCopyStateCalculationOption(event: MouseEvent, region: any, sourceCalc: any): void {
    event.preventDefault();
    this.copyStateCalculationToRegion(region, sourceCalc);
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

  ocrMatchModeRequiresTextInput(matchMode: string | undefined): boolean {
    return matchMode !== 'containsAnyValue' && matchMode !== 'noValueDetected' && matchMode !== 'isEmpty';
  }

  isRegionDirty(region: any): boolean {
    return this.savedRegionSnapshots.get(region.id) !== this.serializeRegion(region);
  }

  private getDirtyRegionOverlayItems(): Array<{ id: string; name: string; showLabel?: boolean; bounds: { x: number; y: number; width: number; height: number } }> {
    return this.regions.flatMap((region) =>
      this.isRegionDirty(region) && this.hasValidBounds(region)
        ? this.expandRegionInstances(region).map((instance, index) => ({
            id: `${region.id}:${index}`,
            name: region.name || 'Unnamed Region',
            showLabel: index === 0,
            bounds: instance.bounds,
          }))
        : []
    );
  }

  private async syncDirtyRegionOverlays(): Promise<void> {
    await this.electronService.setDirtyRegionOverlays(this.getDirtyRegionOverlayItems());
  }

  private createDefaultRepeatConfig(): any {
    return {
      enabled: false,
      x: {
        enabled: false,
        every: 0,
        count: 1,
      },
      y: {
        enabled: false,
        every: 0,
        count: 1,
      },
    };
  }

  private normalizeRepeatCount(value: any): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 1;
    }
    return Math.max(1, Math.floor(parsed));
  }

  private ensureRepeatConfig(region: any): void {
    const defaults = this.createDefaultRepeatConfig();
    const repeat = region.repeat || {};
    region.repeat = {
      enabled: repeat.enabled === true,
      x: {
        enabled: repeat.x?.enabled === true,
        every: Number.isFinite(repeat.x?.every) ? repeat.x.every : defaults.x.every,
        count: this.normalizeRepeatCount(repeat.x?.count),
      },
      y: {
        enabled: repeat.y?.enabled === true,
        every: Number.isFinite(repeat.y?.every) ? repeat.y.every : defaults.y.every,
        count: this.normalizeRepeatCount(repeat.y?.count),
      },
    };
  }

  private normalizeRepeatConfigs(): void {
    for (const region of this.regions) {
      this.ensureRepeatConfig(region);
    }
  }

  private expandRegionInstances(region: any): Array<{ bounds: { x: number; y: number; width: number; height: number }; repeatIndexX: number; repeatIndexY: number }> {
    this.ensureRepeatConfig(region);

    const xCount = region.repeat.enabled && region.repeat.x.enabled
      ? this.normalizeRepeatCount(region.repeat.x.count)
      : 1;
    const yCount = region.repeat.enabled && region.repeat.y.enabled
      ? this.normalizeRepeatCount(region.repeat.y.count)
      : 1;

    const instances: Array<{ bounds: { x: number; y: number; width: number; height: number }; repeatIndexX: number; repeatIndexY: number }> = [];
    for (let repeatIndexY = 0; repeatIndexY < yCount; repeatIndexY += 1) {
      for (let repeatIndexX = 0; repeatIndexX < xCount; repeatIndexX += 1) {
        instances.push({
          repeatIndexX,
          repeatIndexY,
          bounds: {
            x: region.bounds.x + (region.repeat.enabled && region.repeat.x.enabled ? region.repeat.x.every * repeatIndexX : 0),
            y: region.bounds.y + (region.repeat.enabled && region.repeat.y.enabled ? region.repeat.y.every * repeatIndexY : 0),
            width: region.bounds.width,
            height: region.bounds.height,
          },
        });
      }
    }

    return instances;
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
    this.refreshSavedRegionSnapshots();
    this.refreshRegionComparableSnapshots();
    await this.syncDirtyRegionOverlays();
  }

  /**
   * Called by ngModelChange on text/number inputs to mark the form dirty
   * and push updated regions to the backend for live evaluation.
   */
  onFieldChanged(): void {
    this.pushWorkingRegions();
    this.scheduleRegionPreviewRender();
  }

  /**
   * Pushes the current in-memory regions to the backend so the evaluation
   * pipeline uses them immediately, without requiring a save first.
   */
  private pushWorkingRegions(): void {
    this.updateRegionLastUpdatedTimestamps();
    this.hasUnsavedChanges = true;
    this.electronService.setWorkingRegions(this.regions);
    this.electronService.setDirtyRegionOverlays(this.getDirtyRegionOverlayItems());
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

  getCollapsedStateValue(region: any): string | null {
    if (!region?.stateCalculations?.length) {
      return null;
    }

    for (let index = region.stateCalculations.length - 1; index >= 0; index -= 1) {
      const calc = region.stateCalculations[index];
      const value = this.getCurrentStateValue(region.id, calc.id);
      if (value) {
        return value;
      }
    }

    return null;
  }

  getCollapsedStateCalculationName(region: any): string | null {
    if (!region?.stateCalculations?.length) {
      return null;
    }

    for (let index = region.stateCalculations.length - 1; index >= 0; index -= 1) {
      const calc = region.stateCalculations[index];
      const value = this.getCurrentStateValue(region.id, calc.id);
      if (value) {
        return calc.name || null;
      }
    }

    return null;
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

  selectAllInputText(event: FocusEvent): void {
    const input = event.target as HTMLInputElement | null;
    input?.select();
  }

  preserveSelectedInputText(event: MouseEvent): void {
    const input = event.target as HTMLInputElement | null;
    if (!input) {
      return;
    }

    if (input.selectionStart === 0 && input.selectionEnd === input.value.length) {
      event.preventDefault();
    }
  }

  private resolvePendingNavigation(allowNavigation: boolean): void {
    this.showUnsavedChangesDialog = false;
    this.isResolvingUnsavedChanges = false;

    const resolve = this.pendingNavigationResolve;
    this.pendingNavigationResolve = null;
    this.pendingNavigationPromise = null;

    resolve?.(allowNavigation);
    this.changeDetectorRef.markForCheck();
  }

  private processFrameState(frameState: any): boolean {
    if (!frameState || !frameState.regionStates) return false;

    const nextRegionStateMap = new Map<string, {
      medianHex: string;
      calcResults: Map<string, {
        currentValue: string;
        confidenceByMapping: Record<string, number>;
        ocrText?: string;
        ollamaResponse?: string;
        ollamaResponseTimeMs?: number;
      }>;
    }>();
    const nextRegionInstanceStateMap = new Map<string, Array<{
      runtimeMonitoredRegionId: string;
      repeatIndexX: number;
      repeatIndexY: number;
      medianHex: string;
      calcResults: Map<string, {
        currentValue: string;
        confidenceByMapping: Record<string, number>;
        ocrText?: string;
        ollamaResponse?: string;
        ollamaResponseTimeMs?: number;
      }>;
    }>>();
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

      nextRegionStateMap.set(regionState.monitoredRegionId, { medianHex, calcResults });
    }

    const instanceStates = frameState.regionInstanceStates || frameState.regionStates;
    for (const regionState of instanceStates) {
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

      const sourceRegionId = regionState.monitoredRegionId;
      const entries = nextRegionInstanceStateMap.get(sourceRegionId) || [];
      entries.push({
        runtimeMonitoredRegionId: regionState.runtimeMonitoredRegionId || regionState.monitoredRegionId,
        repeatIndexX: regionState.repeatIndexX ?? 0,
        repeatIndexY: regionState.repeatIndexY ?? 0,
        medianHex,
        calcResults,
      });
      nextRegionInstanceStateMap.set(sourceRegionId, entries);
    }

    for (const [regionId, entries] of nextRegionInstanceStateMap) {
      entries.sort((a, b) => {
        if (a.repeatIndexY !== b.repeatIndexY) {
          return a.repeatIndexY - b.repeatIndexY;
        }
        return a.repeatIndexX - b.repeatIndexX;
      });
      nextRegionInstanceStateMap.set(regionId, entries);
    }

    const nextDisplaySnapshot = this.serializeRegionStateDisplaySnapshot(nextRegionStateMap, nextRegionInstanceStateMap);
    if (nextDisplaySnapshot === this.regionStateDisplaySnapshot) {
      return false;
    }

    this.regionStateDisplaySnapshot = nextDisplaySnapshot;
    this.regionStateMap = nextRegionStateMap;
    this.regionInstanceStateMap = nextRegionInstanceStateMap;
    return true;
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
  // Region sharing / import
  // ---------------------------------------------------------------------------

  openShareRegionDialog(region: any): void {
    this.shareRegionJson = JSON.stringify(this.buildSharedRegionExport(region), null, 2);
    this.shareRegionCopied = false;
  }

  closeShareRegionDialog(): void {
    this.shareRegionJson = '';
    this.shareRegionCopied = false;
  }

  async copySharedRegionJson(): Promise<void> {
    if (!this.shareRegionJson) return;
    await navigator.clipboard.writeText(this.shareRegionJson);
    this.shareRegionCopied = true;
  }

  openImportRegionDialog(): void {
    this.showImportRegionDialog = true;
    this.importRegionJsonText = '';
    this.importRegionErrorMessage = '';
    this.importRegionConflictRegionName = '';
    this.pendingImportedRegion = null;
  }

  closeImportRegionDialog(): void {
    this.showImportRegionDialog = false;
    this.importRegionJsonText = '';
    this.importRegionErrorMessage = '';
    this.importRegionConflictRegionName = '';
    this.pendingImportedRegion = null;
  }

  importSharedRegion(): void {
    const parsed = this.parseSharedRegionImport(this.importRegionJsonText);
    if (!parsed.success) {
      this.importRegionErrorMessage = parsed.message;
      this.importRegionConflictRegionName = '';
      this.pendingImportedRegion = null;
      return;
    }

    const importedRegion = parsed.region;
    const existingRegion = this.regions.find((region) => region.id === importedRegion.id);
    if (existingRegion) {
      this.pendingImportedRegion = importedRegion;
      this.importRegionErrorMessage = '';
      this.importRegionConflictRegionName = existingRegion.name || 'Unnamed Region';
      return;
    }

    this.applyImportedRegion(importedRegion, 'copy');
  }

  resolveImportedRegionConflict(action: 'update' | 'copy'): void {
    if (!this.pendingImportedRegion) return;
    this.applyImportedRegion(this.pendingImportedRegion, action);
  }

  private applyImportedRegion(importedRegion: any, action: 'update' | 'copy'): void {
    const regionToApply = action === 'copy'
      ? this.cloneRegionWithFreshIds(importedRegion)
      : JSON.parse(JSON.stringify(importedRegion));

    this.normalizeOcrMatchModesOnRegion(regionToApply);
    this.normalizeCalculationEvaluationDefaultsOnRegion(regionToApply);
    this.ensureRepeatConfig(regionToApply);

    if (action === 'update') {
      const existingIndex = this.regions.findIndex((region) => region.id === regionToApply.id);
      if (existingIndex >= 0) {
        this.regions[existingIndex] = regionToApply;
      } else {
        this.regions.push(regionToApply);
      }
    } else {
      this.regions.push(regionToApply);
    }

    this.closeImportRegionDialog();
    this.onFieldChanged();
    this.focusRegionName(regionToApply.id);
  }

  private buildSharedRegionExport(region: any): any {
    return {
      exportType: MonitoredRegionsComponent.SHARED_REGION_EXPORT_TYPE,
      exportSchemaVersion: 1,
      region: JSON.parse(JSON.stringify(region)),
    };
  }

  private parseSharedRegionImport(rawJson: string): { success: true; region: any } | { success: false; message: string } {
    try {
      const parsed = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object') {
        return { success: false, message: 'Invalid JSON. Expected a shared Monitored Region export object.' };
      }
      if (parsed.exportType !== MonitoredRegionsComponent.SHARED_REGION_EXPORT_TYPE) {
        return { success: false, message: 'This JSON is not a Monitored Region share export.' };
      }
      const exportSchemaVersion = parsed.exportSchemaVersion ?? parsed.version;
      if (exportSchemaVersion !== 1) {
        return { success: false, message: 'This shared Monitored Region export uses an unsupported schema version.' };
      }
      if (!parsed.region || typeof parsed.region !== 'object') {
        return { success: false, message: 'The shared export is missing its region payload.' };
      }
      if (typeof parsed.region.id !== 'string' || typeof parsed.region.name !== 'string' || !parsed.region.bounds) {
        return { success: false, message: 'The shared export does not contain a valid Monitored Region.' };
      }
      return { success: true, region: JSON.parse(JSON.stringify(parsed.region)) };
    } catch {
      return { success: false, message: 'Invalid JSON. Check that the full shared Monitored Region export was pasted.' };
    }
  }

  private cloneRegionWithFreshIds(region: any): any {
    const clone = JSON.parse(JSON.stringify(region));
    clone.id = crypto.randomUUID();
    clone.name = this.buildCopiedRegionName(clone.name);
    for (const calc of clone.stateCalculations || []) {
      calc.id = crypto.randomUUID();
    }
    return clone;
  }

  private buildCopiedRegionName(name: string): string {
    if (!name) return 'Copied Region';
    return name.endsWith(' Copy') ? name : `${name} Copy`;
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
      this.scheduleRegionPreviewRender();
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

  // ---------------------------------------------------------------------------
  // Preview rendering
  // ---------------------------------------------------------------------------

  trackByRegionId(_index: number, region: any): string {
    return region.id;
  }

  trackByCalcId(_index: number, calc: any): string {
    return calc.id;
  }

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

  getCollapsedPreviewCanvasWidth(region: any): number {
    const maxPreviewWidth = 96;
    const maxPreviewHeight = 56;
    const regionAspectRatio = region.bounds.width / region.bounds.height;
    const widthIfConstrainedByHeight = maxPreviewHeight * regionAspectRatio;
    return widthIfConstrainedByHeight <= maxPreviewWidth
      ? Math.max(1, Math.round(widthIfConstrainedByHeight))
      : maxPreviewWidth;
  }

  getCollapsedPreviewCanvasHeight(region: any): number {
    const maxPreviewWidth = 96;
    const maxPreviewHeight = 56;
    const regionAspectRatio = region.bounds.width / region.bounds.height;
    const heightIfConstrainedByWidth = maxPreviewWidth / regionAspectRatio;
    return heightIfConstrainedByWidth <= maxPreviewHeight
      ? Math.max(1, Math.round(heightIfConstrainedByWidth))
      : maxPreviewHeight;
  }

  private handlePreviewFrame(frame: RegionsPreviewFrameData): void {
    this.latestPreviewFrame = frame;
    this.updateRawPreviewSurface(frame);
    this.scheduleRegionPreviewRender();

    if (!this.hasPreviewFrame) {
      this.hasPreviewFrame = true;
      this.changeDetectorRef.detectChanges();
    }
  }

  private updateRawPreviewSurface(frame: RegionsPreviewFrameData): void {
    if (!this.rawPreviewCanvas) {
      this.rawPreviewCanvas = document.createElement('canvas');
      this.rawPreviewContext = this.rawPreviewCanvas.getContext('2d');
    }

    if (!this.rawPreviewCanvas || !this.rawPreviewContext) {
      return;
    }

    if (this.rawPreviewCanvas.width !== frame.previewWidth || this.rawPreviewCanvas.height !== frame.previewHeight) {
      this.rawPreviewCanvas.width = frame.previewWidth;
      this.rawPreviewCanvas.height = frame.previewHeight;
      this.rawPreviewRgbaBuffer = null;
    }

    const pixelCount = frame.previewWidth * frame.previewHeight;
    if (!this.rawPreviewRgbaBuffer || this.rawPreviewRgbaBuffer.length !== pixelCount * 4) {
      this.rawPreviewRgbaBuffer = new Uint8ClampedArray(pixelCount * 4);
    }

    const bgra = frame.bgraBuffer;
    const rgba = this.rawPreviewRgbaBuffer;
    for (let offset = 0; offset < bgra.length; offset += 4) {
      rgba[offset] = bgra[offset + 2];
      rgba[offset + 1] = bgra[offset + 1];
      rgba[offset + 2] = bgra[offset];
      rgba[offset + 3] = bgra[offset + 3];
    }

    const imageData = new ImageData(rgba, frame.previewWidth, frame.previewHeight);
    this.rawPreviewContext.putImageData(imageData, 0, 0);
  }

  private refreshPreviewCanvasTracking(): void {
    if (!this.previewVisibilityObserver) {
      return;
    }

    this.previewVisibilityObserver.disconnect();
    this.previewCanvasByRegionId.clear();
    this.visiblePreviewRegionIds.clear();

    for (const canvasRef of this.previewCanvasRefs.toArray()) {
      const canvas = canvasRef.nativeElement;
      const regionId = canvas.dataset['regionId'];
      if (!regionId) continue;

      this.previewCanvasByRegionId.set(regionId, canvas);
      this.previewVisibilityObserver.observe(canvas);
    }

    this.scheduleRegionPreviewRender();
  }

  private scheduleRegionPreviewRender(): void {
    if (this.previewRenderScheduled) {
      return;
    }

    this.previewRenderScheduled = true;
    requestAnimationFrame(() => {
      this.previewRenderScheduled = false;
      this.renderAllRegionPreviews();
    });
  }

  private renderAllRegionPreviews(): void {
    if (!this.rawPreviewCanvas || !this.latestPreviewFrame) return;

    const displayOriginX = this.latestPreviewFrame.displayOriginX || 0;
    const displayOriginY = this.latestPreviewFrame.displayOriginY || 0;
    const dpiScaleFactor = this.latestPreviewFrame.displayScaleFactor || 1;
    const previewScaleX = this.latestPreviewFrame.previewWidth / this.latestPreviewFrame.originalWidth;
    const previewScaleY = this.latestPreviewFrame.previewHeight / this.latestPreviewFrame.originalHeight;

    for (const region of this.regions) {
      if (region.bounds.width <= 0 || region.bounds.height <= 0) continue;
      if (!this.visiblePreviewRegionIds.has(region.id)) continue;

      const canvas = this.previewCanvasByRegionId.get(region.id);
      if (!canvas) continue;

      const context = canvas.getContext('2d');
      if (!context) continue;

      const physicalX = (region.bounds.x - displayOriginX) * dpiScaleFactor;
      const physicalY = (region.bounds.y - displayOriginY) * dpiScaleFactor;
      const physicalWidth = region.bounds.width * dpiScaleFactor;
      const physicalHeight = region.bounds.height * dpiScaleFactor;

      const sourceX = physicalX * previewScaleX;
      const sourceY = physicalY * previewScaleY;
      const sourceWidth = physicalWidth * previewScaleX;
      const sourceHeight = physicalHeight * previewScaleY;

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        this.rawPreviewCanvas,
        sourceX, sourceY, sourceWidth, sourceHeight,
        0, 0, canvas.width, canvas.height
      );
    }
  }

  private scheduleViewRefresh(): void {
    if (this.viewRefreshScheduled) {
      return;
    }

    this.viewRefreshScheduled = true;
    requestAnimationFrame(() => {
      this.viewRefreshScheduled = false;
      this.changeDetectorRef.detectChanges();
    });
  }

  private focusCalculationName(calcId: string): void {
    let attemptsRemaining = 5;
    const focusInput = () => {
      const input = document.querySelector(`[data-calc-name-id="${calcId}"]`) as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
        return;
      }

      attemptsRemaining -= 1;
      if (attemptsRemaining <= 0) {
        return;
      }

      requestAnimationFrame(focusInput);
    };

    this.changeDetectorRef.detectChanges();
    requestAnimationFrame(focusInput);
  }

  private focusRegionName(regionId: string): void {
    setTimeout(() => {
      const input = document.querySelector(`[data-region-name-id="${regionId}"]`) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    }, 0);
  }

  private normalizeOcrMatchModes(): void {
    for (const region of this.regions) {
      this.normalizeOcrMatchModesOnRegion(region);
    }
  }

  private normalizeOcrMatchModesOnRegion(region: any): void {
    for (const calc of region.stateCalculations || []) {
      this.normalizeOcrMatchModesOnCalculation(calc);
    }
  }

  private normalizeCalculationEvaluationDefaults(): void {
    for (const region of this.regions) {
      this.normalizeCalculationEvaluationDefaultsOnRegion(region);
    }
  }

  private normalizeCalculationEvaluationDefaultsOnRegion(region: any): void {
    for (const calc of region.stateCalculations || []) {
      calc.skipIfUnchanged = calc.skipIfUnchanged !== false;
      if (calc.ollamaConfig) {
        calc.ollamaConfig.skipIfUnchanged = calc.ollamaConfig.skipIfUnchanged !== false;
      }
    }
  }

  private normalizeOcrMatchModesOnCalculation(calc: any): void {
    for (const mapping of calc?.substringMappings || []) {
      if (mapping.matchMode === 'isEmpty') {
        mapping.matchMode = 'noValueDetected';
      }
    }
  }

  private refreshSavedRegionSnapshots(): void {
    this.savedRegionSnapshots = new Map(
      this.regions.map((region) => [region.id, this.serializeRegion(region)])
    );
  }

  private refreshRegionComparableSnapshots(): void {
    this.regionComparableSnapshots = new Map(
      this.regions.map((region) => [region.id, this.serializeRegionComparable(region)])
    );
  }

  private serializeRegion(region: any): string {
    return JSON.stringify(region);
  }

  private serializeRegionComparable(region: any): string {
    const clone = JSON.parse(JSON.stringify(region));
    delete clone.lastUpdatedAt;
    return JSON.stringify(clone);
  }

  private updateRegionLastUpdatedTimestamps(): void {
    const nextComparableSnapshots = new Map<string, string>();
    const now = Date.now();

    for (const region of this.regions) {
      const comparable = this.serializeRegionComparable(region);
      const previousComparable = this.regionComparableSnapshots.get(region.id);
      if (previousComparable === undefined || previousComparable !== comparable) {
        region.lastUpdatedAt = now;
      }
      nextComparableSnapshots.set(region.id, comparable);
    }

    this.regionComparableSnapshots = nextComparableSnapshots;
  }

  private loadCollapsedRegionState(): void {
    try {
      const saved = localStorage.getItem(MonitoredRegionsComponent.STORAGE_KEY_COLLAPSED_REGIONS);
      if (!saved) return;

      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        this.collapsedRegionIds = new Set(parsed.filter((value): value is string => typeof value === 'string'));
      }
    } catch {
      this.collapsedRegionIds.clear();
    }
  }

  private syncCollapsedRegionState(): void {
    const validIds = new Set(this.regions.map((region) => region.id));
    this.collapsedRegionIds = new Set(
      Array.from(this.collapsedRegionIds).filter((regionId) => validIds.has(regionId))
    );
    this.saveCollapsedRegionState();
  }

  private serializeRegionStateDisplaySnapshot(
    regionStateMap: Map<string, {
      medianHex: string;
      calcResults: Map<string, {
        currentValue: string;
        confidenceByMapping: Record<string, number>;
        ocrText?: string;
        ollamaResponse?: string;
        ollamaResponseTimeMs?: number;
      }>;
    }>,
    regionInstanceStateMap: Map<string, Array<{
      runtimeMonitoredRegionId: string;
      repeatIndexX: number;
      repeatIndexY: number;
      medianHex: string;
      calcResults: Map<string, {
        currentValue: string;
        confidenceByMapping: Record<string, number>;
        ocrText?: string;
        ollamaResponse?: string;
        ollamaResponseTimeMs?: number;
      }>;
    }>>,
  ): string {
    const regionEntries = Array.from(regionStateMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([regionId, regionState]) => ({
        regionId,
        medianHex: regionState.medianHex,
        calcResults: Array.from(regionState.calcResults.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([calcId, calcResult]) => ({
            calcId,
            currentValue: calcResult.currentValue,
            ocrText: calcResult.ocrText ?? '',
            ollamaResponse: calcResult.ollamaResponse ?? '',
            ollamaResponseTimeMs: calcResult.ollamaResponseTimeMs ?? 0,
            confidenceByMapping: this.roundConfidenceMap(calcResult.confidenceByMapping),
          })),
      }));

    const instanceEntries = Array.from(regionInstanceStateMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([regionId, instanceStates]) => ({
        regionId,
        instances: instanceStates.map((instanceState) => ({
          runtimeMonitoredRegionId: instanceState.runtimeMonitoredRegionId,
          repeatIndexX: instanceState.repeatIndexX,
          repeatIndexY: instanceState.repeatIndexY,
          medianHex: instanceState.medianHex,
          calcResults: Array.from(instanceState.calcResults.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([calcId, calcResult]) => ({
              calcId,
              currentValue: calcResult.currentValue,
              ocrText: calcResult.ocrText ?? '',
              ollamaResponse: calcResult.ollamaResponse ?? '',
              ollamaResponseTimeMs: calcResult.ollamaResponseTimeMs ?? 0,
              confidenceByMapping: this.roundConfidenceMap(calcResult.confidenceByMapping),
            })),
        })),
      }));

    return JSON.stringify({
      regions: regionEntries,
      instances: instanceEntries,
    });
  }

  private roundConfidenceMap(confidenceByMapping: Record<string, number>): Record<string, number> {
    const rounded: Record<string, number> = {};
    for (const [stateValue, confidence] of Object.entries(confidenceByMapping || {})) {
      rounded[stateValue] = Math.round(confidence * 10) / 10;
    }
    return rounded;
  }

  private saveCollapsedRegionState(): void {
    try {
      localStorage.setItem(
        MonitoredRegionsComponent.STORAGE_KEY_COLLAPSED_REGIONS,
        JSON.stringify(Array.from(this.collapsedRegionIds))
      );
    } catch {
      // Ignore storage errors so the editor remains usable.
    }
  }
}
