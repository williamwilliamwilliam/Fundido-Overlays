import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-overlay-groups',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
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
        <button (click)="expandAllGroups()">Expand All</button>
        <button (click)="collapseAllGroups()">Collapse All</button>
        <button (click)="exportGroups()">Export</button>
        <button (click)="showImportDialog = true">Import</button>
      </div>

      <div *ngIf="showImportDialog" class="import-dialog">
        <textarea [(ngModel)]="importJsonText" placeholder="Paste overlay group JSON here..." rows="6"></textarea>
        <div class="import-actions">
          <button class="primary" (click)="importGroups()">Import</button>
          <button (click)="showImportDialog = false">Cancel</button>
        </div>
      </div>

      <div *ngIf="groups.length === 0" class="empty-state">
        No overlay groups defined yet. Click "+ Add Group" to get started.
      </div>

      <!-- ======================== GROUP CARD ======================== -->
      <div *ngFor="let group of groups; let groupIndex = index"
        class="group-card"
        [class.group-disabled]="group.enabled === false">
        <div class="group-header">
          <button
            class="collapse-toggle"
            (click)="toggleGroupExpanded(group.id)"
            [attr.aria-label]="isGroupExpanded(group.id) ? 'Collapse group' : 'Expand group'"
            [title]="isGroupExpanded(group.id) ? 'Collapse' : 'Expand'">
            {{ isGroupExpanded(group.id) ? '▾' : '▸' }}
          </button>
          <label class="enabled-toggle" title="Enable/disable this group">
            <input type="checkbox"
              [ngModel]="group.enabled !== false"
              (ngModelChange)="group.enabled = $event; onFieldChanged()" />
          </label>
          <input [(ngModel)]="group.name" (ngModelChange)="onFieldChanged()" placeholder="Group name" class="name-input" />
          <button class="danger-text" (click)="removeGroup(groupIndex)">Remove</button>
        </div>
        <ng-container *ngIf="isGroupExpanded(group.id)">

        <div class="group-settings">
          <label>Position
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
          <label>Grow
            <select [(ngModel)]="group.growDirection" (ngModelChange)="onFieldChanged()">
              <option value="right">Right</option><option value="left">Left</option>
              <option value="down">Down</option><option value="up">Up</option>
            </select>
          </label>
          <label>Align
            <select [(ngModel)]="group.alignment" (ngModelChange)="onFieldChanged()">
              <option value="start">Start</option><option value="center">Center</option><option value="end">End</option>
            </select>
          </label>
          <label>Gap <input type="number" [(ngModel)]="group.gap" (ngModelChange)="onFieldChanged()" style="width:50px" /></label>
        </div>

        <!-- ======================== GROUP RULES ======================== -->
        <div class="section-header">
          <span class="section-label">Group Rules</span>
          <span class="section-hint">Override all individual overlay rules when a group rule matches</span>
          <button class="add-btn" (click)="addGroupRule(group)">+ Add Rule</button>
        </div>

        <div class="cross-ref-row" *ngIf="groupRuleCrossRefs.get(group.id)?.length">
          <span class="cross-ref-label">Monitored Regions in group rules:</span>
          <a *ngFor="let ref of groupRuleCrossRefs.get(group.id)"
            class="cross-ref-link"
            [routerLink]="['/regions']"
            [queryParams]="{ highlight: ref.id }">
            {{ ref.name }}
          </a>
        </div>

        <div *ngIf="!group.rules || group.rules.length === 0" class="rules-empty">
          No group rules — individual overlay rules apply normally.
        </div>

        <div *ngFor="let rule of group.rules; let ruleIndex = index" class="rule-row group-rule-row">
          <div class="rule-line">
            <span class="rule-keyword">When</span>
            <select [(ngModel)]="rule.logicMode" (ngModelChange)="onFieldChanged()">
              <option value="AND">ALL conditions</option>
              <option value="OR">ANY condition</option>
            </select>
            <span class="rule-keyword">Then</span>
            <select [(ngModel)]="rule.action" (ngModelChange)="onFieldChanged()">
              <option value="show">Show All</option>
              <option value="hide">Hide All</option>
              <option value="opacity">Set Opacity</option>
            </select>
            <input *ngIf="rule.action === 'opacity'" type="range" min="0" max="100" step="1"
              [ngModel]="(rule.opacityValue ?? 1) * 100"
              (ngModelChange)="rule.opacityValue = $event / 100; onFieldChanged()"
              class="opacity-slider" />
            <span *ngIf="rule.action === 'opacity'" class="opacity-value">{{ ((rule.opacityValue ?? 1) * 100) | number:'1.0-0' }}%</span>
            <button class="danger-text small" (click)="removeGroupRule(group, ruleIndex)">Remove</button>
          </div>
          <div class="conditions-list">
            <div *ngFor="let cond of rule.conditions; let condIndex = index" class="condition-row">
              <span class="rule-keyword condition-joiner" *ngIf="condIndex > 0">{{ rule.logicMode || 'AND' }}</span>
              <label class="not-checkbox" title="Invert this condition">
                <input type="checkbox" [(ngModel)]="cond.negate" (ngModelChange)="onFieldChanged()" />
                NOT
              </label>
              <select [(ngModel)]="cond.monitoredRegionId" (ngModelChange)="onFieldChanged()">
                <option value="">Select Region</option>
                <option *ngFor="let r of monitoredRegions" [value]="r.id">{{ r.name }}</option>
              </select>
              <select [(ngModel)]="cond.stateCalculationId" (ngModelChange)="onFieldChanged()">
                <option value="">Select Calc</option>
                <option *ngFor="let c of getCalcsForRegion(cond.monitoredRegionId)" [value]="c.id">{{ c.name }}</option>
              </select>
              <select [(ngModel)]="cond.operator" (ngModelChange)="onFieldChanged()">
                <option value="equals">equals</option>
                <option value="notEquals">not equals</option>
              </select>
              <select [(ngModel)]="cond.value" (ngModelChange)="onFieldChanged()">
                <option value="">Select Value</option>
                <option *ngFor="let v of getStateValuesForCalc(cond.monitoredRegionId, cond.stateCalculationId)" [value]="v">{{ v }}</option>
              </select>
              <button class="danger-text small" (click)="removeGroupRuleCondition(rule, condIndex)">×</button>
            </div>
            <button class="add-btn small" (click)="addGroupRuleCondition(rule)">+ Condition</button>
          </div>
        </div>

        <!-- ======================== OVERLAYS ======================== -->
        <div class="section-header">
          <span class="section-label">Overlays</span>
        </div>

        <div *ngFor="let overlay of group.overlays; let overlayIndex = index"
          class="overlay-card"
          [attr.data-highlight-id]="overlay.id"
          [class.highlight-flash]="highlightId === overlay.id"
          [class.drag-over]="dragOverIndex === overlayIndex && dragOverGroupId === group.id"
          draggable="true"
          (dragstart)="onDragStart($event, group, overlayIndex)"
          (dragover)="onDragOver($event, group, overlayIndex)"
          (dragleave)="onDragLeave($event)"
          (drop)="onDrop($event, group, overlayIndex)"
          (dragend)="onDragEnd()">
          <div class="overlay-header">
            <span class="drag-handle" title="Drag to reorder">&#x2630;</span>
            <input [(ngModel)]="overlay.name" (ngModelChange)="onFieldChanged()" placeholder="Overlay name" class="overlay-name-input" />
            <select [(ngModel)]="overlay.contentType" (ngModelChange)="onContentTypeChanged(overlay)">
              <option value="text">Text</option><option value="image">Image</option><option value="regionMirror">Region Mirror</option>
            </select>
            <button class="danger-text small" (click)="removeOverlay(group, overlayIndex)">Remove</button>
          </div>
          <div class="cross-ref-row" *ngIf="overlayCrossRefs.get(overlay.id)?.length">
            <span class="cross-ref-label">Monitored Regions in this Overlay:</span>
            <a *ngFor="let ref of overlayCrossRefs.get(overlay.id)"
              class="cross-ref-link"
              [routerLink]="['/regions']"
              [queryParams]="{ highlight: ref.id }">
              {{ ref.name }}
            </a>
          </div>

          <!-- Default visibility + opacity -->
          <div class="defaults-row">
            <label class="checkbox-label">
              <input type="checkbox" [(ngModel)]="overlay.defaultVisible" (ngModelChange)="onFieldChanged()" />
              Visible by default
            </label>
            <label class="opacity-label">
              Default Opacity
              <input type="range" min="0" max="100" step="1"
                [ngModel]="overlay.defaultOpacity * 100"
                (ngModelChange)="onDefaultOpacityChanged(overlay, $event)" />
              <span class="opacity-value">{{ (overlay.defaultOpacity * 100) | number:'1.0-0' }}%</span>
            </label>
          </div>

          <!-- ===== TEXT CONFIG ===== -->
          <div *ngIf="overlay.contentType === 'text' && overlay.textConfig" class="content-config">
            <div class="config-row">
              <label>Text <input [(ngModel)]="overlay.textConfig.text" (ngModelChange)="onFieldChanged()" class="wide-input" /></label>
            </div>
            <div class="config-row">
              <label>Size <input type="number" [(ngModel)]="overlay.textConfig.fontSize" (ngModelChange)="onFieldChanged()" style="width:50px" /></label>
              <label>Font <input [(ngModel)]="overlay.textConfig.fontFamily" (ngModelChange)="onFieldChanged()" style="width:120px" /></label>
              <label>Weight
                <select [(ngModel)]="overlay.textConfig.fontWeight" (ngModelChange)="onFieldChanged()">
                  <option value="normal">Normal</option><option value="bold">Bold</option>
                </select>
              </label>
              <label>Style
                <select [(ngModel)]="overlay.textConfig.fontStyle" (ngModelChange)="onFieldChanged()">
                  <option value="normal">Normal</option><option value="italic">Italic</option>
                </select>
              </label>
            </div>
            <div class="config-row">
              <label>Color <input type="color" [(ngModel)]="overlay.textConfig.color" (ngModelChange)="onFieldChanged()" /></label>
              <label>Bg <input type="color" [(ngModel)]="overlay.textConfig.backgroundColor" (ngModelChange)="onFieldChanged()" /></label>
              <label>Padding <input type="number" [(ngModel)]="overlay.textConfig.padding" (ngModelChange)="onFieldChanged()" style="width:50px" /></label>
            </div>
          </div>

          <!-- ===== IMAGE CONFIG ===== -->
          <div *ngIf="overlay.contentType === 'image' && overlay.imageConfig" class="content-config">
            <div class="config-row">
              <label>File</label>
              <input [(ngModel)]="overlay.imageConfig.filePath" (ngModelChange)="onFieldChanged()" class="wide-input" placeholder="Path to image file" />
              <button class="pick-btn" (click)="chooseImageFile(overlay)">Choose File</button>
            </div>
            <div class="config-row">
              <label>Scale <input type="number" step="0.1" [(ngModel)]="overlay.imageConfig.size.scale" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>W <input type="number" [(ngModel)]="overlay.imageConfig.size.width" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>H <input type="number" [(ngModel)]="overlay.imageConfig.size.height" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>Max W <input type="number" [(ngModel)]="overlay.imageConfig.size.maxWidth" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>Max H <input type="number" [(ngModel)]="overlay.imageConfig.size.maxHeight" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
            </div>
          </div>

          <!-- ===== REGION MIRROR CONFIG ===== -->
          <div *ngIf="overlay.contentType === 'regionMirror' && overlay.regionMirrorConfig" class="content-config">
            <div class="config-row">
              <label>Region
                <select [(ngModel)]="overlay.regionMirrorConfig.monitoredRegionId" (ngModelChange)="onFieldChanged()">
                  <option *ngFor="let region of monitoredRegions" [ngValue]="region.id">{{ region.name }}</option>
                </select>
              </label>
              <label>Scale <input type="number" step="0.1" [(ngModel)]="overlay.regionMirrorConfig.size.scale" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>Max W <input type="number" [(ngModel)]="overlay.regionMirrorConfig.size.maxWidth" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>Max H <input type="number" [(ngModel)]="overlay.regionMirrorConfig.size.maxHeight" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
            </div>
          </div>

          <!-- ===== RULES ENGINE ===== -->
          <div class="rules-section">
            <div class="rules-header">
              <span class="rules-label">Rules (top-down, first match wins)</span>
              <button class="add-btn" (click)="addRule(overlay)">+ Add Rule</button>
            </div>
            <div *ngIf="overlay.rules.length === 0" class="rules-empty">
              No rules — defaults apply.
            </div>
            <div *ngFor="let rule of overlay.rules; let ruleIndex = index" class="rule-row">
              <div class="rule-conditions">
                <div class="logic-mode-row">
                  <span class="rule-keyword">When</span>
                  <select class="logic-mode-select" [(ngModel)]="rule.logicMode" (ngModelChange)="onFieldChanged()" *ngIf="rule.conditions.length > 1">
                    <option value="AND">ALL (AND)</option>
                    <option value="OR">ANY (OR)</option>
                  </select>
                </div>
                <div *ngFor="let cond of rule.conditions; let condIndex = index" class="condition-row">
                  <span class="rule-keyword condition-joiner" *ngIf="condIndex > 0">{{ rule.logicMode || 'AND' }}</span>
                  <label class="not-checkbox" title="Invert this condition">
                    <input type="checkbox" [(ngModel)]="cond.negate" (ngModelChange)="onFieldChanged()" />
                    NOT
                  </label>
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
                  <select *ngIf="getCalcType(cond.monitoredRegionId, cond.stateCalculationId) !== 'OllamaLLM'"
                    [(ngModel)]="cond.value" (ngModelChange)="onFieldChanged()">
                    <option value="">Select Value</option>
                    <option *ngFor="let sv of getStateValuesForCalc(cond.monitoredRegionId, cond.stateCalculationId)" [ngValue]="sv">{{ sv }}</option>
                  </select>
                  <input *ngIf="getCalcType(cond.monitoredRegionId, cond.stateCalculationId) === 'OllamaLLM'"
                    [(ngModel)]="cond.value" (ngModelChange)="onFieldChanged()"
                    placeholder="Expected response" class="condition-value-input" />
                  <button class="danger-text small" (click)="removeCondition(rule, condIndex)">×</button>
                </div>
                <button class="add-condition-btn" (click)="addCondition(rule)">+ Add Condition</button>
              </div>
              <div class="rule-action">
                <span class="rule-keyword">Then</span>
                <select [(ngModel)]="rule.action" (ngModelChange)="onFieldChanged()">
                  <option value="show">Show</option>
                  <option value="hide">Hide</option>
                  <option value="opacity">Set Opacity</option>
                </select>
                <ng-container *ngIf="rule.action === 'opacity'">
                  <input type="range" min="0" max="100" step="1"
                    [ngModel]="(rule.opacityValue ?? 1) * 100"
                    (ngModelChange)="onRuleOpacityChanged(rule, $event)" />
                  <span class="opacity-value">{{ ((rule.opacityValue ?? 1) * 100) | number:'1.0-0' }}%</span>
                </ng-container>
                <button class="danger-text small" (click)="removeRule(overlay, ruleIndex)">Remove</button>
              </div>
            </div>
          </div>
        </div>

        <button class="add-overlay-btn" (click)="addOverlay(group)">+ Add Overlay</button>
        </ng-container>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 1100px; }
    h2 { margin-bottom: var(--spacing-sm); }
    .description { color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }
    .toolbar { display: flex; gap: var(--spacing-sm); margin-bottom: var(--spacing-lg); flex-wrap: wrap; }

    .import-dialog {
      background-color: var(--color-bg-secondary); border: 1px solid var(--color-border);
      border-radius: var(--radius-md); padding: var(--spacing-md); margin-bottom: var(--spacing-lg);
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
    .group-card.group-disabled { opacity: var(--opacity-disabled); }
    .group-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--spacing-sm); gap: var(--spacing-sm); }

    .collapse-toggle {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-secondary);
      border-radius: var(--radius-sm);
      width: 28px;
      height: 28px;
      padding: 0;
      font-size: 0.95rem;
      line-height: 1;
      flex-shrink: 0;
    }
    .collapse-toggle:hover {
      color: var(--color-text-primary);
      border-color: var(--color-accent);
      background-color: var(--color-bg-panel);
    }

    .enabled-toggle { display: flex; align-items: center; cursor: pointer; flex-shrink: 0; }
    .enabled-toggle input[type="checkbox"] { width: 18px; height: 18px; margin: 0; accent-color: var(--color-accent); }

    .cross-ref-row {
      display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap;
      margin-bottom: var(--spacing-sm); padding: 4px var(--spacing-sm);
      background-color: var(--color-bg-primary); border-radius: var(--radius-sm);
    }
    .cross-ref-label { font-size: 0.75rem; color: var(--color-text-secondary); white-space: nowrap; }
    .cross-ref-link { font-size: 0.75rem; color: var(--color-accent); cursor: pointer; text-decoration: underline; white-space: nowrap; }
    .cross-ref-link:hover { opacity: 0.8; }

    .name-input, .overlay-name-input {
      font-size: 1rem; font-weight: 500; background: transparent;
      border: 1px solid transparent; padding: var(--spacing-xs); flex: 1;
    }
    .name-input:focus, .overlay-name-input:focus { border-color: var(--color-accent); }
    .overlay-name-input { font-size: 0.9rem; }

    .group-settings {
      display: flex; gap: var(--spacing-md); margin-bottom: var(--spacing-md); flex-wrap: wrap; align-items: flex-end;
    }
    .group-settings label {
      display: flex; flex-direction: column; gap: var(--spacing-xs); color: var(--color-text-secondary); font-size: 0.85rem;
    }
    .group-settings input[type="number"] { width: 70px; }

    .pick-btn {
      font-size: 0.8rem; padding: 4px 12px; background-color: var(--color-bg-panel);
      border: 1px solid var(--color-accent); color: var(--color-accent);
      border-radius: var(--radius-sm); white-space: nowrap; align-self: flex-end;
    }
    .pick-btn:hover { background-color: var(--color-accent); color: var(--color-text-primary); }

    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--spacing-sm); }
    .section-label { font-size: 0.85rem; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
    .add-btn { font-size: 0.8rem; padding: 2px 10px; }

    .overlay-card {
      background-color: var(--color-bg-primary); border: 1px solid var(--color-border);
      border-radius: var(--radius-sm); padding: var(--spacing-sm); margin-bottom: var(--spacing-sm);
      transition: border-color 0.1s ease;
    }
    .overlay-card.drag-over {
      border-color: var(--color-accent);
      border-style: dashed;
    }
    .overlay-header { display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm); }

    .drag-handle {
      cursor: grab;
      color: var(--color-text-secondary);
      font-size: 1rem;
      padding: 0 4px;
      opacity: 0.5;
      user-select: none;
    }
    .drag-handle:hover { opacity: 1; }
    .drag-handle:active { cursor: grabbing; }

    /* Defaults row */
    .defaults-row {
      display: flex; align-items: center; gap: var(--spacing-lg); margin-bottom: var(--spacing-sm);
      padding: var(--spacing-xs) 0; border-bottom: 1px solid var(--color-border);
    }
    .checkbox-label { display: flex; align-items: center; gap: var(--spacing-xs); font-size: 0.85rem; color: var(--color-text-secondary); cursor: pointer; }
    .opacity-label { display: flex; align-items: center; gap: var(--spacing-sm); font-size: 0.85rem; color: var(--color-text-secondary); }
    .opacity-label input[type="range"] { width: 120px; accent-color: var(--color-accent); }
    .opacity-value { font-family: var(--font-mono); font-size: 0.8rem; min-width: 40px; color: var(--color-text-primary); }

    /* Content configs */
    .content-config { padding: var(--spacing-xs) 0 var(--spacing-sm) 0; }
    .config-row { display: flex; gap: var(--spacing-md); align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
    .config-row label { display: flex; align-items: center; gap: var(--spacing-xs); color: var(--color-text-secondary); font-size: 0.8rem; }
    .wide-input { flex: 1; min-width: 200px; }

    /* Rules */
    .rules-section { border-top: 1px solid var(--color-border); padding-top: var(--spacing-sm); margin-top: var(--spacing-sm); }
    .rules-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--spacing-xs); }
    .rules-label { font-size: 0.75rem; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.3px; }
    .rules-empty { font-size: 0.8rem; color: var(--color-text-secondary); font-style: italic; padding: 4px 0; }

    .section-hint { font-size: 0.7rem; color: var(--color-text-secondary); font-style: italic; flex: 1; margin-left: var(--spacing-sm); }

    .group-rule-row {
      border-left: 3px solid var(--color-accent);
    }
    .group-rule-row .rule-line {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      flex-wrap: wrap;
      margin-bottom: 4px;
    }
    .group-rule-row .conditions-list {
      padding-left: var(--spacing-sm);
    }

    .rule-row {
      background-color: var(--color-bg-secondary); border: 1px solid var(--color-border);
      border-radius: var(--radius-sm); padding: var(--spacing-xs) var(--spacing-sm); margin-bottom: 4px;
    }
    .rule-conditions { margin-bottom: 4px; }
    .condition-row { display: flex; align-items: center; gap: var(--spacing-xs); margin-bottom: 2px; flex-wrap: wrap; }
    .condition-row select { font-size: 0.8rem; max-width: 150px; }
    .rule-keyword { font-size: 0.75rem; font-weight: 600; color: var(--color-accent); text-transform: uppercase; min-width: 40px; }
    .condition-joiner { min-width: 30px; text-align: center; }
    .logic-mode-row { display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: 4px; }
    .logic-mode-select { font-size: 0.75rem; }
    .not-checkbox { display: flex; align-items: center; gap: 2px; font-size: 0.7rem; font-weight: 600; color: var(--color-text-secondary); cursor: pointer; white-space: nowrap; }
    .not-checkbox input[type="checkbox"] { margin: 0; }
    .add-condition-btn { font-size: 0.7rem; background: transparent; border: 1px dashed var(--color-border); padding: 1px 8px; }
    .rule-action { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; }
    .rule-action select { font-size: 0.8rem; }
    .rule-action input[type="range"] { width: 100px; accent-color: var(--color-accent); }

    .add-overlay-btn {
      font-size: 0.85rem; background: transparent; border: 1px dashed var(--color-border);
      width: 100%; padding: var(--spacing-sm);
    }

    .danger-text { background: transparent; border: none; color: var(--color-error); font-size: 0.85rem; }
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
export class OverlayGroupsComponent implements OnInit, OnDestroy {
  private static readonly STORAGE_KEY_COLLAPSED_GROUPS = 'fundido:collapsedOverlayGroups';

  groups: any[] = [];
  monitoredRegions: any[] = [];
  showImportDialog = false;
  importJsonText = '';
  hasUnsavedChanges = false;
  pickingGroupId: string | null = null;
  highlightId: string | null = null;
  private collapsedGroupIds = new Set<string>();

  /** Cached cross-references: overlayId → monitored regions referenced by that overlay. Built once on load. */
  overlayCrossRefs = new Map<string, Array<{ id: string; name: string }>>();

  /** Cached cross-references: groupId → monitored regions referenced by group rules. Built once on load. */
  groupRuleCrossRefs = new Map<string, Array<{ id: string; name: string }>>();

  // Drag-and-drop reorder state
  dragOverIndex: number | null = null;
  dragOverGroupId: string | null = null;
  private dragSourceGroupId: string | null = null;
  private dragSourceIndex: number | null = null;

  private stateSubscription: Subscription | null = null;

  constructor(
    private readonly electronService: ElectronService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
  ) {}

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    const isCtrlS = (event.ctrlKey || event.metaKey) && event.key === 's';
    if (isCtrlS) {
      event.preventDefault();
      if (this.hasUnsavedChanges) { this.saveAllGroups(); }
    }

    const isEnterInInput = event.key === 'Enter' && (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement
    );
    if (isEnterInInput) {
      event.preventDefault();
      (event.target as HTMLElement).blur();
      if (this.hasUnsavedChanges) { this.saveAllGroups(); }
    }
  }

  async ngOnInit(): Promise<void> {
    const config = await this.electronService.loadConfig();
    this.groups = config.overlayGroups || [];
    this.loadCollapsedGroupState();
    this.syncCollapsedGroupState();
    this.monitoredRegions = config.monitoredRegions || [];
    this.buildOverlayCrossRefs();

    // Scroll to and highlight an element if navigated here with ?highlight=id
    this.route.queryParams.subscribe((params) => {
      const targetId = params['highlight'];
      if (!targetId) return;

      // Wait for Angular to render the cards
      setTimeout(() => {
        const element = document.querySelector(`[data-highlight-id="${targetId}"]`) as HTMLElement;
        if (!element) return;

        // Scroll to the element first
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Wait for scroll to finish, then apply highlight
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

        // Listen for scroll activity to stop
        scrollContainer.addEventListener('scroll', onScrollEnd);
        // Fallback: if element is already in view and no scroll happens
        scrollTimer = setTimeout(() => {
          scrollContainer.removeEventListener('scroll', onScrollEnd);
          this.highlightId = targetId;
          setTimeout(() => { this.highlightId = null; }, 2500);
        }, 600);
      }, 150);
    });
  }

  ngOnDestroy(): void {
    this.stateSubscription?.unsubscribe();
  }

  onFieldChanged(): void { this.hasUnsavedChanges = true; }

  // ---------------------------------------------------------------------------
  // Group CRUD
  // ---------------------------------------------------------------------------

  addGroup(): void {
    const newGroup = {
      id: crypto.randomUUID(), name: 'New Group', enabled: true,
      position: { mode: 'absolute', x: 100, y: 100 },
      growDirection: 'right', alignment: 'start', gap: 0, overlays: [],
    };
    this.groups.push(newGroup);
    this.collapsedGroupIds.delete(newGroup.id);
    this.saveCollapsedGroupState();
    this.hasUnsavedChanges = true;
  }

  removeGroup(index: number): void {
    const [removedGroup] = this.groups.splice(index, 1);
    if (removedGroup?.id) {
      this.collapsedGroupIds.delete(removedGroup.id);
      this.saveCollapsedGroupState();
    }
    this.hasUnsavedChanges = true;
  }

  isGroupExpanded(groupId: string): boolean {
    return !this.collapsedGroupIds.has(groupId);
  }

  toggleGroupExpanded(groupId: string): void {
    if (this.collapsedGroupIds.has(groupId)) {
      this.collapsedGroupIds.delete(groupId);
    } else {
      this.collapsedGroupIds.add(groupId);
    }
    this.saveCollapsedGroupState();
  }

  expandAllGroups(): void {
    this.collapsedGroupIds.clear();
    this.saveCollapsedGroupState();
  }

  collapseAllGroups(): void {
    this.collapsedGroupIds = new Set(this.groups.map((group) => group.id));
    this.saveCollapsedGroupState();
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
    group.overlays.push({
      id: crypto.randomUUID(), name: 'New Overlay', contentType: 'text',
      defaultVisible: true, defaultOpacity: 1.0,
      textConfig: {
        text: 'Hello', fontSize: 16, fontFamily: 'Segoe UI',
        fontWeight: 'normal', fontStyle: 'normal',
        color: '#ffffff', backgroundColor: '#000000aa', padding: 4,
      },
      imageConfig: null, regionMirrorConfig: null, rules: [],
    });
    this.hasUnsavedChanges = true;
  }

  removeOverlay(group: any, index: number): void {
    group.overlays.splice(index, 1);
    this.hasUnsavedChanges = true;
  }

  // ---------------------------------------------------------------------------
  // Drag-and-drop reorder
  // ---------------------------------------------------------------------------

  onDragStart(event: DragEvent, group: any, index: number): void {
    this.dragSourceGroupId = group.id;
    this.dragSourceIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  }

  onDragOver(event: DragEvent, group: any, index: number): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dragOverIndex = index;
    this.dragOverGroupId = group.id;
  }

  onDragLeave(event: DragEvent): void {
    this.dragOverIndex = null;
    this.dragOverGroupId = null;
  }

  onDrop(event: DragEvent, group: any, dropIndex: number): void {
    event.preventDefault();
    this.dragOverIndex = null;
    this.dragOverGroupId = null;

    const isSameGroup = this.dragSourceGroupId === group.id;
    if (!isSameGroup || this.dragSourceIndex === null) return;

    const sourceIndex = this.dragSourceIndex;
    const isSamePosition = sourceIndex === dropIndex;
    if (isSamePosition) return;

    const movedOverlay = group.overlays.splice(sourceIndex, 1)[0];
    group.overlays.splice(dropIndex, 0, movedOverlay);
    this.hasUnsavedChanges = true;
  }

  onDragEnd(): void {
    this.dragSourceGroupId = null;
    this.dragSourceIndex = null;
    this.dragOverIndex = null;
    this.dragOverGroupId = null;
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
      overlay.imageConfig = { filePath: '', size: { scale: 1.0 } };
    }
    if (overlay.contentType === 'regionMirror' && !overlay.regionMirrorConfig) {
      overlay.regionMirrorConfig = { monitoredRegionId: '', size: { scale: 0.5 } };
    }
    this.hasUnsavedChanges = true;
  }

  onDefaultOpacityChanged(overlay: any, percentValue: number): void {
    overlay.defaultOpacity = percentValue / 100;
    this.hasUnsavedChanges = true;
  }

  async chooseImageFile(overlay: any): Promise<void> {
    const filePath = await this.electronService.openFileDialog();
    if (filePath && overlay.imageConfig) {
      overlay.imageConfig.filePath = filePath;
      this.hasUnsavedChanges = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Rules engine
  // ---------------------------------------------------------------------------

  // -- Group rules --

  addGroupRule(group: any): void {
    if (!group.rules) group.rules = [];
    group.rules.push({
      id: crypto.randomUUID(),
      logicMode: 'AND',
      conditions: [{ monitoredRegionId: '', stateCalculationId: '', operator: 'equals', value: '', negate: false }],
      action: 'show',
    });
    this.hasUnsavedChanges = true;
  }

  removeGroupRule(group: any, index: number): void {
    group.rules.splice(index, 1);
    this.hasUnsavedChanges = true;
  }

  addGroupRuleCondition(rule: any): void {
    rule.conditions.push({ monitoredRegionId: '', stateCalculationId: '', operator: 'equals', value: '', negate: false });
    this.hasUnsavedChanges = true;
  }

  removeGroupRuleCondition(rule: any, index: number): void {
    rule.conditions.splice(index, 1);
    this.hasUnsavedChanges = true;
  }

  // -- Overlay rules --

  addRule(overlay: any): void {
    overlay.rules.push({
      id: crypto.randomUUID(),
      logicMode: 'AND',
      conditions: [{ monitoredRegionId: '', stateCalculationId: '', operator: 'equals', value: '', negate: false }],
      action: 'show',
    });
    this.hasUnsavedChanges = true;
  }

  removeRule(overlay: any, index: number): void {
    overlay.rules.splice(index, 1);
    this.hasUnsavedChanges = true;
  }

  addCondition(rule: any): void {
    rule.conditions.push({ monitoredRegionId: '', stateCalculationId: '', operator: 'equals', value: '', negate: false });
    this.hasUnsavedChanges = true;
  }

  removeCondition(rule: any, index: number): void {
    rule.conditions.splice(index, 1);
    this.hasUnsavedChanges = true;
  }

  onRegionSelectedForCondition(condition: any): void {
    condition.stateCalculationId = '';
    condition.value = '';
    this.hasUnsavedChanges = true;
  }

  onRuleOpacityChanged(rule: any, percentValue: number): void {
    rule.opacityValue = percentValue / 100;
    this.hasUnsavedChanges = true;
  }

  getCalcsForRegion(regionId: string): any[] {
    const region = this.monitoredRegions.find((r: any) => r.id === regionId);
    return region?.stateCalculations || [];
  }

  /**
   * Returns the list of possible state values for a given region + calculation.
   * These come from the colorStateMappings on the state calculation.
   */
  getStateValuesForCalc(regionId: string, calcId: string): string[] {
    const region = this.monitoredRegions.find((r: any) => r.id === regionId);
    if (!region) return [];
    const calc = region.stateCalculations.find((c: any) => c.id === calcId);
    if (!calc) return [];
    const colorValues = (calc.colorStateMappings || []).map((m: any) => m.stateValue).filter((v: string) => v);
    const thresholdValues = (calc.colorThresholdMappings || []).map((m: any) => m.stateValue).filter((v: string) => v);
    const substringValues = (calc.substringMappings || []).map((m: any) => m.stateValue).filter((v: string) => v);
    const allValues = [...colorValues, ...thresholdValues, ...substringValues];
    if (calc.defaultStateValue && !allValues.includes(calc.defaultStateValue)) {
      allValues.push(calc.defaultStateValue);
    }
    return allValues;
  }

  getCalcType(regionId: string, calcId: string): string {
    const region = this.monitoredRegions.find((r: any) => r.id === regionId);
    if (!region) return '';
    const calc = region.stateCalculations.find((c: any) => c.id === calcId);
    return calc?.type || '';
  }

  // ---------------------------------------------------------------------------
  // Cross-references
  // ---------------------------------------------------------------------------

  private buildOverlayCrossRefs(): void {
    this.overlayCrossRefs.clear();
    this.groupRuleCrossRefs.clear();

    for (const group of this.groups) {
      // Build group-level rule cross-refs
      const groupRegionIds = new Set<string>();
      for (const rule of (group.rules || [])) {
        for (const cond of (rule.conditions || [])) {
          if (cond.monitoredRegionId) groupRegionIds.add(cond.monitoredRegionId);
        }
      }
      if (groupRegionIds.size > 0) {
        const refs: Array<{ id: string; name: string }> = [];
        for (const regionId of groupRegionIds) {
          const region = this.monitoredRegions.find((r: any) => r.id === regionId);
          refs.push({ id: regionId, name: region ? region.name : regionId });
        }
        this.groupRuleCrossRefs.set(group.id, refs);
      }

      // Build overlay-level cross-refs
      for (const overlay of (group.overlays || [])) {
        const regionIds = new Set<string>();

        for (const rule of (overlay.rules || [])) {
          for (const cond of (rule.conditions || [])) {
            if (cond.monitoredRegionId) regionIds.add(cond.monitoredRegionId);
          }
        }

        if (overlay.contentType === 'regionMirror' && overlay.regionMirrorConfig?.monitoredRegionId) {
          regionIds.add(overlay.regionMirrorConfig.monitoredRegionId);
        }

        const refs: Array<{ id: string; name: string }> = [];
        for (const regionId of regionIds) {
          const region = this.monitoredRegions.find((r: any) => r.id === regionId);
          refs.push({ id: regionId, name: region ? region.name : regionId });
        }
        if (refs.length > 0) {
          this.overlayCrossRefs.set(overlay.id, refs);
        }
      }
    }
  }

  navigateToRegion(regionId: string): void {
    this.router.navigate(['/regions'], { queryParams: { highlight: regionId } });
  }

  // ---------------------------------------------------------------------------
  // Save / Import / Export
  // ---------------------------------------------------------------------------

  async saveAllGroups(): Promise<void> {
    const config = await this.electronService.loadConfig();
    config.overlayGroups = JSON.parse(JSON.stringify(this.groups));
    await this.electronService.saveConfig(config);
    this.hasUnsavedChanges = false;
  }

  async exportGroups(): Promise<void> {
    const json = await this.electronService.exportOverlayGroups();
    await navigator.clipboard.writeText(json);
  }

  async importGroups(): Promise<void> {
    const result = await this.electronService.importOverlayGroups(this.importJsonText);
    if (result.success) {
      const config = await this.electronService.loadConfig();
      this.groups = config.overlayGroups || [];
      this.syncCollapsedGroupState();
      this.showImportDialog = false;
      this.importJsonText = '';
    }
  }

  private loadCollapsedGroupState(): void {
    try {
      const saved = localStorage.getItem(OverlayGroupsComponent.STORAGE_KEY_COLLAPSED_GROUPS);
      if (!saved) return;

      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        this.collapsedGroupIds = new Set(parsed.filter((value): value is string => typeof value === 'string'));
      }
    } catch {
      this.collapsedGroupIds.clear();
    }
  }

  private syncCollapsedGroupState(): void {
    const validIds = new Set(this.groups.map((group) => group.id));
    this.collapsedGroupIds = new Set(
      Array.from(this.collapsedGroupIds).filter((groupId) => validIds.has(groupId))
    );
    this.saveCollapsedGroupState();
  }

  private saveCollapsedGroupState(): void {
    try {
      localStorage.setItem(
        OverlayGroupsComponent.STORAGE_KEY_COLLAPSED_GROUPS,
        JSON.stringify(Array.from(this.collapsedGroupIds))
      );
    } catch {
      // Ignore storage errors so the editor remains usable.
    }
  }
}
