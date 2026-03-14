import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-overlay-groups',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="page">
      <h2>Overlay Groups</h2>
      <p class="description">
        Configure groups of overlays that appear on top of your game.
        Each group controls positioning and layout for its overlays.
      </p>

      <div class="toolbar">
        <button class="primary" (click)="addGroup()">+ Add Group</button>
        <button (click)="saveAllGroups()" [disabled]="!hasUnsavedChanges">
          {{ hasUnsavedChanges ? 'Save (Ctrl+S)' : 'Saved' }}
        </button>
        <button (click)="exportGroups()">Export</button>
        <button (click)="showImportDialog = true">Import</button>
      </div>

      <div *ngIf="showImportDialog" class="import-dialog">
        <textarea
          [(ngModel)]="importJsonText"
          placeholder="Paste overlay group JSON here..."
          rows="6">
        </textarea>
        <div class="import-actions">
          <button class="primary" (click)="importGroups()">Import</button>
          <button (click)="showImportDialog = false">Cancel</button>
        </div>
      </div>

      <div *ngIf="groups.length === 0" class="empty-state">
        No overlay groups defined yet. Click "+ Add Group" to get started.
      </div>

      <div *ngFor="let group of groups; let groupIndex = index" class="group-card">
        <div class="group-header">
          <input [(ngModel)]="group.name" (ngModelChange)="onFieldChanged()" placeholder="Group name" class="name-input" />
          <button class="danger-text" (click)="removeGroup(groupIndex)">Remove</button>
        </div>

        <!-- Group settings row -->
        <div class="group-settings">
          <label>
            Position Mode
            <select [(ngModel)]="group.position.mode" (ngModelChange)="onPositionModeChanged(group)">
              <option value="absolute">Absolute</option>
              <option value="relativeToCursor">Relative to Cursor</option>
            </select>
          </label>

          <ng-container *ngIf="group.position.mode === 'absolute'">
            <label>X <input type="number" [(ngModel)]="group.position.x" (ngModelChange)="onFieldChanged()" /></label>
            <label>Y <input type="number" [(ngModel)]="group.position.y" (ngModelChange)="onFieldChanged()" /></label>
            <button class="pick-btn" (click)="pickAnchor(group)">
              {{ pickingGroupId === group.id ? 'Picking...' : 'Set Anchor' }}
            </button>
          </ng-container>

          <ng-container *ngIf="group.position.mode === 'relativeToCursor'">
            <label>Offset X <input type="number" [(ngModel)]="group.position.offsetX" (ngModelChange)="onFieldChanged()" /></label>
            <label>Offset Y <input type="number" [(ngModel)]="group.position.offsetY" (ngModelChange)="onFieldChanged()" /></label>
          </ng-container>

          <label>
            Grow
            <select [(ngModel)]="group.growDirection" (ngModelChange)="onFieldChanged()">
              <option value="right">Right</option>
              <option value="left">Left</option>
              <option value="down">Down</option>
              <option value="up">Up</option>
            </select>
          </label>
          <label>
            Align
            <select [(ngModel)]="group.alignment" (ngModelChange)="onFieldChanged()">
              <option value="start">Start</option>
              <option value="center">Center</option>
              <option value="end">End</option>
            </select>
          </label>
          <label>
            Gap
            <input type="number" [(ngModel)]="group.gap" (ngModelChange)="onFieldChanged()" style="width:50px" />
          </label>
        </div>

        <!-- Overlays -->
        <div class="section-header">
          <span class="section-label">Overlays</span>
          <button class="add-btn" (click)="addOverlay(group)">+ Add Overlay</button>
        </div>

        <div *ngFor="let overlay of group.overlays; let overlayIndex = index" class="overlay-card">
          <div class="overlay-header">
            <input [(ngModel)]="overlay.name" (ngModelChange)="onFieldChanged()" placeholder="Overlay name" class="overlay-name-input" />
            <select [(ngModel)]="overlay.contentType" (ngModelChange)="onContentTypeChanged(overlay)">
              <option value="text">Text</option>
              <option value="image">Image</option>
              <option value="regionMirror">Region Mirror</option>
            </select>
            <button class="danger-text small" (click)="removeOverlay(group, overlayIndex)">Remove</button>
          </div>

          <!-- Text config -->
          <div *ngIf="overlay.contentType === 'text' && overlay.textConfig" class="content-config">
            <div class="config-row">
              <label>Text <input [(ngModel)]="overlay.textConfig.text" (ngModelChange)="onFieldChanged()" class="wide-input" /></label>
            </div>
            <div class="config-row">
              <label>Size <input type="number" [(ngModel)]="overlay.textConfig.fontSize" (ngModelChange)="onFieldChanged()" style="width:50px" /></label>
              <label>Font <input [(ngModel)]="overlay.textConfig.fontFamily" (ngModelChange)="onFieldChanged()" style="width:120px" /></label>
              <label>
                Weight
                <select [(ngModel)]="overlay.textConfig.fontWeight" (ngModelChange)="onFieldChanged()">
                  <option value="normal">Normal</option>
                  <option value="bold">Bold</option>
                </select>
              </label>
              <label>
                Style
                <select [(ngModel)]="overlay.textConfig.fontStyle" (ngModelChange)="onFieldChanged()">
                  <option value="normal">Normal</option>
                  <option value="italic">Italic</option>
                </select>
              </label>
            </div>
            <div class="config-row">
              <label>Color <input type="color" [(ngModel)]="overlay.textConfig.color" (ngModelChange)="onFieldChanged()" /></label>
              <label>Bg <input type="color" [(ngModel)]="overlay.textConfig.backgroundColor" (ngModelChange)="onFieldChanged()" /></label>
              <label>Padding <input type="number" [(ngModel)]="overlay.textConfig.padding" (ngModelChange)="onFieldChanged()" style="width:50px" /></label>
            </div>
          </div>

          <!-- Image config -->
          <div *ngIf="overlay.contentType === 'image' && overlay.imageConfig" class="content-config">
            <div class="config-row">
              <label>File <input [(ngModel)]="overlay.imageConfig.filePath" (ngModelChange)="onFieldChanged()" class="wide-input" placeholder="Path to image file" /></label>
            </div>
            <div class="config-row">
              <label>Scale <input type="number" step="0.1" [(ngModel)]="overlay.imageConfig.size.scale" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>W <input type="number" [(ngModel)]="overlay.imageConfig.size.width" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>H <input type="number" [(ngModel)]="overlay.imageConfig.size.height" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>Max W <input type="number" [(ngModel)]="overlay.imageConfig.size.maxWidth" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>Max H <input type="number" [(ngModel)]="overlay.imageConfig.size.maxHeight" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
            </div>
          </div>

          <!-- Region mirror config -->
          <div *ngIf="overlay.contentType === 'regionMirror' && overlay.regionMirrorConfig" class="content-config">
            <div class="config-row">
              <label>
                Region
                <select [(ngModel)]="overlay.regionMirrorConfig.monitoredRegionId" (ngModelChange)="onFieldChanged()">
                  <option *ngFor="let region of monitoredRegions" [ngValue]="region.id">{{ region.name }}</option>
                </select>
              </label>
              <label>Scale <input type="number" step="0.1" [(ngModel)]="overlay.regionMirrorConfig.size.scale" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
            </div>
          </div>

          <!-- Rules engine -->
          <div class="rules-section">
            <div class="rules-header">
              <span class="rules-label">Rules (evaluated top-down, first match wins)</span>
              <button class="add-btn" (click)="addRule(overlay)">+ Add Rule</button>
            </div>
            <div *ngIf="overlay.rules.length === 0" class="rules-empty">
              No rules — overlay always visible at full opacity.
            </div>
            <div *ngFor="let rule of overlay.rules; let ruleIndex = index" class="rule-row">
              <div class="rule-conditions">
                <span class="rule-keyword">When</span>
                <div *ngFor="let cond of rule.conditions; let condIndex = index" class="condition-row">
                  <span *ngIf="condIndex > 0" class="rule-keyword">AND</span>
                  <select [(ngModel)]="cond.monitoredRegionId" (ngModelChange)="onRegionSelectedForCondition(cond)">
                    <option value="">Select Region</option>
                    <option *ngFor="let region of monitoredRegions" [ngValue]="region.id">{{ region.name }}</option>
                  </select>
                  <select [(ngModel)]="cond.stateCalculationId" (ngModelChange)="onFieldChanged()">
                    <option value="">Select Calc</option>
                    <option *ngFor="let calc of getCalcsForRegion(cond.monitoredRegionId)" [ngValue]="calc.id">{{ calc.name }}</option>
                  </select>
                  <select [(ngModel)]="cond.operator" (ngModelChange)="onFieldChanged()">
                    <option value="equals">=</option>
                    <option value="notEquals">≠</option>
                  </select>
                  <input [(ngModel)]="cond.value" (ngModelChange)="onFieldChanged()" placeholder="State value" class="condition-value-input" />
                  <button class="danger-text small" (click)="removeCondition(rule, condIndex)">×</button>
                </div>
                <button class="add-condition-btn" (click)="addCondition(rule)">+ AND</button>
              </div>
              <div class="rule-action">
                <span class="rule-keyword">Then</span>
                <select [(ngModel)]="rule.action" (ngModelChange)="onFieldChanged()">
                  <option value="show">Show</option>
                  <option value="hide">Hide</option>
                  <option value="opacity">Opacity</option>
                </select>
                <input *ngIf="rule.action === 'opacity'"
                  type="number" step="0.1" min="0" max="1"
                  [(ngModel)]="rule.opacityValue" (ngModelChange)="onFieldChanged()"
                  style="width:55px" placeholder="0-1" />
                <button class="danger-text small" (click)="removeRule(overlay, ruleIndex)">Remove Rule</button>
              </div>
            </div>
          </div>
        </div>

        <button *ngIf="group.overlays.length === 0" class="add-overlay-btn" (click)="addOverlay(group)">+ Add Overlay</button>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 1100px; }
    h2 { margin-bottom: var(--spacing-sm); }
    .description { color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }

    .toolbar { display: flex; gap: var(--spacing-sm); margin-bottom: var(--spacing-lg); }

    .import-dialog {
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      margin-bottom: var(--spacing-lg);
    }
    .import-dialog textarea { width: 100%; font-family: var(--font-mono); font-size: 0.85rem; margin-bottom: var(--spacing-sm); }
    .import-actions { display: flex; gap: var(--spacing-sm); }

    .empty-state {
      color: var(--color-text-secondary); font-style: italic; padding: var(--spacing-lg);
      text-align: center; border: 1px dashed var(--color-border); border-radius: var(--radius-md);
    }

    .group-card {
      background-color: var(--color-bg-secondary); border: 1px solid var(--color-border);
      border-radius: var(--radius-md); padding: var(--spacing-md); margin-bottom: var(--spacing-md);
    }

    .group-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--spacing-sm);
    }

    .name-input, .overlay-name-input {
      font-size: 1rem; font-weight: 500; background: transparent;
      border: 1px solid transparent; padding: var(--spacing-xs);
    }
    .name-input:focus, .overlay-name-input:focus { border-color: var(--color-accent); }
    .overlay-name-input { font-size: 0.9rem; flex: 1; }

    .group-settings {
      display: flex; gap: var(--spacing-md); margin-bottom: var(--spacing-md);
      flex-wrap: wrap; align-items: flex-end;
    }
    .group-settings label {
      display: flex; flex-direction: column; gap: var(--spacing-xs);
      color: var(--color-text-secondary); font-size: 0.85rem;
    }
    .group-settings input[type="number"] { width: 70px; }

    .pick-btn {
      font-size: 0.8rem; padding: 4px 12px;
      background-color: var(--color-bg-panel); border: 1px solid var(--color-accent);
      color: var(--color-accent); border-radius: var(--radius-sm); white-space: nowrap;
      align-self: flex-end;
    }
    .pick-btn:hover { background-color: var(--color-accent); color: var(--color-text-primary); }

    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--spacing-sm); }
    .section-label { font-size: 0.85rem; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
    .add-btn { font-size: 0.8rem; padding: 2px 10px; }

    .overlay-card {
      background-color: var(--color-bg-primary); border: 1px solid var(--color-border);
      border-radius: var(--radius-sm); padding: var(--spacing-sm); margin-bottom: var(--spacing-sm);
    }

    .overlay-header { display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm); }

    .content-config { padding: var(--spacing-xs) 0 var(--spacing-sm) 0; }
    .config-row {
      display: flex; gap: var(--spacing-md); align-items: center; flex-wrap: wrap; margin-bottom: 4px;
    }
    .config-row label {
      display: flex; align-items: center; gap: var(--spacing-xs);
      color: var(--color-text-secondary); font-size: 0.8rem;
    }
    .wide-input { flex: 1; min-width: 200px; }

    /* Rules */
    .rules-section { border-top: 1px solid var(--color-border); padding-top: var(--spacing-sm); margin-top: var(--spacing-sm); }
    .rules-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--spacing-xs); }
    .rules-label { font-size: 0.75rem; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.3px; }
    .rules-empty { font-size: 0.8rem; color: var(--color-text-secondary); font-style: italic; padding: 4px 0; }

    .rule-row {
      background-color: var(--color-bg-secondary); border: 1px solid var(--color-border);
      border-radius: var(--radius-sm); padding: var(--spacing-xs) var(--spacing-sm);
      margin-bottom: 4px;
    }
    .rule-conditions { margin-bottom: 4px; }
    .condition-row { display: flex; align-items: center; gap: var(--spacing-xs); margin-bottom: 2px; flex-wrap: wrap; }
    .condition-row select { font-size: 0.8rem; max-width: 150px; }
    .condition-value-input { width: 100px; font-size: 0.8rem; }
    .rule-keyword { font-size: 0.75rem; font-weight: 600; color: var(--color-accent); text-transform: uppercase; min-width: 35px; }
    .add-condition-btn { font-size: 0.7rem; background: transparent; border: 1px dashed var(--color-border); padding: 1px 8px; }
    .rule-action { display: flex; align-items: center; gap: var(--spacing-sm); }
    .rule-action select { font-size: 0.8rem; }

    .add-overlay-btn {
      font-size: 0.85rem; background: transparent; border: 1px dashed var(--color-border);
      width: 100%; padding: var(--spacing-sm);
    }

    .danger-text { background: transparent; border: none; color: var(--color-error); font-size: 0.85rem; }
    .danger-text.small { font-size: 0.8rem; }
    .danger-text:hover { text-decoration: underline; }
  `],
})
export class OverlayGroupsComponent implements OnInit, OnDestroy {
  groups: any[] = [];
  monitoredRegions: any[] = [];
  showImportDialog = false;
  importJsonText = '';
  hasUnsavedChanges = false;
  pickingGroupId: string | null = null;

  private stateSubscription: Subscription | null = null;

  constructor(private readonly electronService: ElectronService) {}

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    const isCtrlS = (event.ctrlKey || event.metaKey) && event.key === 's';
    if (isCtrlS) {
      event.preventDefault();
      if (this.hasUnsavedChanges) {
        this.saveAllGroups();
      }
    }
  }

  async ngOnInit(): Promise<void> {
    const config = await this.electronService.loadConfig();
    this.groups = config.overlayGroups || [];
    this.monitoredRegions = config.monitoredRegions || [];
  }

  ngOnDestroy(): void {
    this.stateSubscription?.unsubscribe();
  }

  // ---------------------------------------------------------------------------
  // Dirty tracking
  // ---------------------------------------------------------------------------

  onFieldChanged(): void {
    this.hasUnsavedChanges = true;
  }

  // ---------------------------------------------------------------------------
  // Group CRUD
  // ---------------------------------------------------------------------------

  addGroup(): void {
    const newGroup = {
      id: crypto.randomUUID(),
      name: 'New Group',
      position: { mode: 'absolute', x: 100, y: 100 },
      growDirection: 'right',
      alignment: 'start',
      gap: 4,
      overlays: [],
    };
    this.groups.push(newGroup);
    this.hasUnsavedChanges = true;
  }

  removeGroup(index: number): void {
    this.groups.splice(index, 1);
    this.hasUnsavedChanges = true;
  }

  onPositionModeChanged(group: any): void {
    if (group.position.mode === 'absolute') {
      group.position = { mode: 'absolute', x: group.position.x || 100, y: group.position.y || 100 };
    } else {
      group.position = { mode: 'relativeToCursor', offsetX: group.position.offsetX || 20, offsetY: group.position.offsetY || 20 };
    }
    this.hasUnsavedChanges = true;
  }

  async pickAnchor(group: any): Promise<void> {
    this.pickingGroupId = group.id;
    const result = await this.electronService.pickRegion();
    if (result !== null) {
      group.position.x = result.x;
      group.position.y = result.y;
      this.hasUnsavedChanges = true;
    }
    this.pickingGroupId = null;
  }

  // ---------------------------------------------------------------------------
  // Overlay CRUD
  // ---------------------------------------------------------------------------

  addOverlay(group: any): void {
    const newOverlay = {
      id: crypto.randomUUID(),
      name: 'New Overlay',
      contentType: 'text',
      textConfig: {
        text: 'Hello',
        fontSize: 16,
        fontFamily: 'Segoe UI',
        fontWeight: 'normal',
        fontStyle: 'normal',
        color: '#ffffff',
        backgroundColor: '#000000aa',
        padding: 4,
      },
      imageConfig: null,
      regionMirrorConfig: null,
      rules: [],
    };
    group.overlays.push(newOverlay);
    this.hasUnsavedChanges = true;
  }

  removeOverlay(group: any, index: number): void {
    group.overlays.splice(index, 1);
    this.hasUnsavedChanges = true;
  }

  onContentTypeChanged(overlay: any): void {
    if (overlay.contentType === 'text' && !overlay.textConfig) {
      overlay.textConfig = {
        text: 'Hello', fontSize: 16, fontFamily: 'Segoe UI',
        fontWeight: 'normal', fontStyle: 'normal',
        color: '#ffffff', backgroundColor: '#000000aa', padding: 4,
      };
    }
    if (overlay.contentType === 'image' && !overlay.imageConfig) {
      overlay.imageConfig = {
        filePath: '',
        size: { scale: 1.0 },
      };
    }
    if (overlay.contentType === 'regionMirror' && !overlay.regionMirrorConfig) {
      overlay.regionMirrorConfig = {
        monitoredRegionId: '',
        size: { scale: 0.5 },
      };
    }
    this.hasUnsavedChanges = true;
  }

  // ---------------------------------------------------------------------------
  // Rules engine CRUD
  // ---------------------------------------------------------------------------

  addRule(overlay: any): void {
    overlay.rules.push({
      id: crypto.randomUUID(),
      conditions: [],
      action: 'show',
    });
    this.hasUnsavedChanges = true;
  }

  removeRule(overlay: any, index: number): void {
    overlay.rules.splice(index, 1);
    this.hasUnsavedChanges = true;
  }

  addCondition(rule: any): void {
    rule.conditions.push({
      monitoredRegionId: '',
      stateCalculationId: '',
      operator: 'equals',
      value: '',
    });
    this.hasUnsavedChanges = true;
  }

  removeCondition(rule: any, index: number): void {
    rule.conditions.splice(index, 1);
    this.hasUnsavedChanges = true;
  }

  onRegionSelectedForCondition(condition: any): void {
    condition.stateCalculationId = '';
    this.hasUnsavedChanges = true;
  }

  getCalcsForRegion(regionId: string): any[] {
    const region = this.monitoredRegions.find((r: any) => r.id === regionId);
    return region?.stateCalculations || [];
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  async saveAllGroups(): Promise<void> {
    const config = await this.electronService.loadConfig();
    config.overlayGroups = JSON.parse(JSON.stringify(this.groups));
    await this.electronService.saveConfig(config);
    this.hasUnsavedChanges = false;
  }

  // ---------------------------------------------------------------------------
  // Import / Export
  // ---------------------------------------------------------------------------

  async exportGroups(): Promise<void> {
    const json = await this.electronService.exportOverlayGroups();
    await navigator.clipboard.writeText(json);
  }

  async importGroups(): Promise<void> {
    const result = await this.electronService.importOverlayGroups(this.importJsonText);
    if (result.success) {
      const config = await this.electronService.loadConfig();
      this.groups = config.overlayGroups || [];
      this.showImportDialog = false;
      this.importJsonText = '';
    }
  }
}
