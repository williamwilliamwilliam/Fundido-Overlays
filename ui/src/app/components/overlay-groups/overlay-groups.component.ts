import { ChangeDetectionStrategy, ChangeDetectorRef, Component, HostListener, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { PendingChangesComponent } from '../../guards/pending-changes.guard';
import { ElectronService } from '../../services/electron.service';
import { PendingChangesService } from '../../services/pending-changes.service';
import { SearchableRegionSelectComponent } from '../shared/searchable-region-select.component';
import { SearchableSoundSelectComponent } from '../shared/searchable-sound-select.component';

@Component({
  selector: 'app-overlay-groups',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, SearchableRegionSelectComponent, SearchableSoundSelectComponent],
  template: `
    <div class="page">
      <div class="page-title">
        <span class="page-title-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 4h7v7H4Zm2 2v3h3V6Zm7-2h7v7h-7Zm2 2v3h3V6ZM4 13h7v7H4Zm2 2v3h3v-3Zm7-2h7v7h-7Zm2 2v3h3v-3Z"/>
          </svg>
        </span>
        <h2>Overlay Groups</h2>
      </div>
      <p class="description">
        Configure groups of overlays that appear on top of your game.
        Each group controls positioning and layout for its overlays.
      </p>

      <div class="toolbar">
        <button (click)="saveAllGroups()" [disabled]="!hasUnsavedChanges">
          {{ hasUnsavedChanges ? 'Save (Ctrl+S)' : 'Saved' }}
        </button>
        <button (click)="exportGroups()">Export</button>
        <button (click)="showImportDialog = true">Import</button>
      </div>
      <div class="toolbar-secondary">
        <button class="tertiary-btn" (click)="expandAllGroups()"><span class="tertiary-icon">&#9662;</span>Expand All</button>
        <button class="tertiary-btn" (click)="collapseAllGroups()"><span class="tertiary-icon">&#9656;</span>Collapse All</button>
      </div>
      <div class="group-filter-bar">
        <label class="filter-search-label">
          <span>Search</span>
          <input
            type="search"
            [(ngModel)]="groupSearchText"
            placeholder="Overlay Group or Overlay name" />
        </label>
        <label class="checkbox-label filter-checkbox">
          <input
            type="checkbox"
            [(ngModel)]="hideInactiveOverlayGroups"
            (ngModelChange)="saveInactiveGroupFilterState()" />
          Hide Inactive Overlay Groups
        </label>
        <span class="filter-count" *ngIf="groups.length > 0 && visibleGroups.length !== groups.length">
          Showing {{ visibleGroups.length }} of {{ groups.length }}
        </span>
      </div>

      <div *ngIf="showImportDialog" class="import-dialog">
        <textarea [(ngModel)]="importJsonText" placeholder="Paste overlay group JSON here..." rows="6"></textarea>
        <div class="import-actions">
          <button class="primary" (click)="importGroups()">Import</button>
          <button (click)="showImportDialog = false">Cancel</button>
        </div>
      </div>

      <div *ngIf="showUnsavedChangesDialog" class="modal-backdrop" (click)="stayOnPage()">
        <div class="modal-dialog" (click)="$event.stopPropagation()">
          <h3>Unsaved Changes</h3>
          <p class="modal-description">You have unsaved changes in Overlay Groups.</p>
          <div class="import-actions unsaved-actions">
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

      <div *ngIf="groups.length === 0" class="empty-state">
        No overlay groups defined yet. Click the button below to get started.
      </div>
      <div *ngIf="groups.length > 0 && visibleGroups.length === 0" class="empty-state">
        No overlay groups match the current filters.
      </div>

      <!-- ======================== GROUP CARD ======================== -->
      <div *ngFor="let group of visibleGroups"
        class="group-card"
        [class.group-disabled]="isGroupVisuallyDisabled(group)">
        <div class="group-header">
          <button
            class="collapse-toggle"
            (click)="toggleGroupExpanded(group.id)"
            [attr.aria-label]="isGroupExpanded(group.id) ? 'Collapse group' : 'Expand group'"
            [title]="isGroupExpanded(group.id) ? 'Collapse' : 'Expand'">
            {{ isGroupExpanded(group.id) ? '▾' : '▸' }}
          </button>
          <label
            class="enabled-toggle"
            [class.enabled-toggle-active]="isGroupCurrentlyActive(group)"
            [class.enabled-toggle-inactive]="!isGroupCurrentlyActive(group)"
            [title]="isGroupProfileManaged(group) ? 'Profiles control whether this group is enabled' : 'Enable/disable this group'">
            <ng-container *ngIf="isGroupProfileManaged(group); else manualEnabledToggle">
              <span class="profile-managed-status-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.87 0-7 2.24-7 5v1h14v-1c0-2.76-3.13-5-7-5Z"/>
                </svg>
              </span>
            </ng-container>
            <ng-template #manualEnabledToggle>
              <input type="checkbox"
                [ngModel]="group.enabled !== false"
                (ngModelChange)="group.enabled = $event; onFieldChanged()" />
            </ng-template>
          </label>
          <input
            [(ngModel)]="group.name"
            (ngModelChange)="onFieldChanged()"
            placeholder="Group name"
            class="name-input"
            [attr.data-group-name-id]="group.id" />
          <button class="danger-text" (click)="removeGroup(group.id)">Remove</button>
        </div>
        <ng-container *ngIf="isGroupExpanded(group.id)">

        <div class="group-settings">
          <div class="profile-multiselect" *ngIf="profiles.length > 0" (click)="onProfileDropdownClick($event)">
            <span class="profiles-label">Profiles</span>
            <button
              type="button"
              class="profile-select-button"
              (click)="toggleProfileDropdown(group.id, $event)">
              <span>{{ getGroupProfileSummary(group) }}</span>
              <span class="profile-select-arrow">{{ openProfileDropdownGroupId === group.id ? '▲' : '▼' }}</span>
            </button>
            <div class="profile-select-menu" *ngIf="openProfileDropdownGroupId === group.id">
              <label *ngFor="let profile of profiles" class="profile-option" [class.profile-option-active]="profile.active">
                <input
                  type="checkbox"
                  [ngModel]="isGroupInProfile(group, profile.id)"
                  (ngModelChange)="onGroupProfileChanged(group, profile.id, $event)" />
                <span class="profile-option-name">{{ profile.name }}</span>
                <span class="profile-option-state">{{ profile.active ? 'Active' : 'Inactive' }}</span>
              </label>
            </div>
          </div>
          <label>Scale
            <input
              type="number"
              step="0.1"
              min="0"
              [ngModel]="group.scale ?? 1"
              (ngModelChange)="onGroupScaleChanged(group, $event)"
              style="width:70px" />
          </label>
          <label>Default
            <select [(ngModel)]="group.defaultVisibilityMode" (ngModelChange)="onGroupDefaultVisibilityChanged(group)">
              <option value="visible">Visible</option>
              <option value="hidden">Hidden</option>
              <option value="opacity">Opacity</option>
            </select>
          </label>
          <label *ngIf="group.defaultVisibilityMode === 'opacity'">Opacity
            <input type="range" min="0" max="100" step="1"
              [ngModel]="(group.defaultOpacity ?? 1) * 100"
              (ngModelChange)="onGroupDefaultOpacityChanged(group, $event)" />
            <span class="opacity-value">{{ ((group.defaultOpacity ?? 1) * 100) | number:'1.0-0' }}%</span>
          </label>
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
        </div>
        <div class="rules-header group-rules-header">
          <span class="rules-label">Rules (processed top-down)</span>
          <span class="section-hint">These rules apply overall visibility changes for the entire group (Visible, Hidden, Opacity)</span>
          <button class="add-btn" (click)="addGroupRule(group)">+ Add Rule</button>
        </div>

        <div class="cross-ref-row" *ngIf="groupRuleCrossRefs.get(group.id)?.length">
          <span class="cross-ref-label">Monitored Regions in group rules:</span>
          <a *ngFor="let ref of groupRuleCrossRefs.get(group.id)"
            class="cross-ref-link"
            [routerLink]="['/regions']"
            [queryParams]="{ search: ref.name }">
            {{ ref.name }}
          </a>
        </div>

        <div *ngIf="!group.rules || group.rules.length === 0" class="rules-empty">
          No group rules — individual overlay rules apply normally.
        </div>

        <div
          *ngFor="let rule of group.rules; let ruleIndex = index"
          class="rule-row group-rule-row"
          [class.rule-drag-over]="groupRuleDragOverIndex === ruleIndex && groupRuleDragOverGroupId === group.id"
          (dragover)="onGroupRuleDragOver($event, group, ruleIndex)"
          (dragleave)="onGroupRuleDragLeave($event)"
          (drop)="onGroupRuleDrop($event, group, ruleIndex)">
          <div class="rule-line group-rule-top-row">
            <div class="logic-mode-row">
              <span
                class="rule-drag-handle"
                title="Drag to reorder rule"
                draggable="true"
                (dragstart)="onGroupRuleDragStart($event, group, ruleIndex)"
                (dragend)="onGroupRuleDragEnd($event)">&#x2630;</span>
              <span class="rule-keyword">When</span>
              <select [(ngModel)]="rule.logicMode" (ngModelChange)="onFieldChanged()">
                <option value="AND">Every Condition is true</option>
                <option value="OR">At least one Condition is true</option>
              </select>
            </div>
          </div>
          <div class="conditions-list">
            <div *ngFor="let cond of rule.conditions; let condIndex = index" class="condition-row">
              <span class="rule-keyword condition-joiner" *ngIf="condIndex > 0">{{ rule.logicMode || 'AND' }}</span>
              <label class="not-checkbox" title="Invert this condition">
                <input type="checkbox" [(ngModel)]="cond.negate" (ngModelChange)="onFieldChanged()" />
                NOT
              </label>
              <app-searchable-region-select
                [regions]="monitoredRegions"
                [selectedRegionId]="cond.monitoredRegionId"
                (regionSelected)="cond.monitoredRegionId = $event; onRegionSelectedForCondition(cond)">
              </app-searchable-region-select>
              <select [(ngModel)]="cond.stateCalculationId" (ngModelChange)="onCalculationSelectedForCondition(cond)">
                <option value="">Select Calc</option>
                <option *ngFor="let c of getCalcsForRegion(cond.monitoredRegionId); trackBy: trackByCalcId" [value]="c.id">{{ c.name }}</option>
              </select>
              <select [(ngModel)]="cond.operator" (ngModelChange)="onFieldChanged()">
                <option value="equals">equals</option>
                <option value="notEquals">not equals</option>
                <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsAtLeastOnceAcrossRepeatedRegions">At least once across Repeated Regions</option>
                <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsInEveryRepeatedRegion">In every Repeated Region</option>
                <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsAtLeastNTimesAcrossRepeatedRegions">Occurs a minimum number of times</option>
                <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsInEverySelectedRepeatedRegion">In Every Selected Region</option>
                <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsAtLeastOnceInSelectedRepeatedRegions">At Least One Selected Region</option>
              </select>
              <input *ngIf="cond.operator === 'equalsAtLeastNTimesAcrossRepeatedRegions'"
                type="number" min="1" [(ngModel)]="cond.minimumCount" (ngModelChange)="onFieldChanged()"
                class="minimum-count-input" placeholder="Min" />
              <div *ngIf="cond.operator === 'equalsInEverySelectedRepeatedRegion' || cond.operator === 'equalsAtLeastOnceInSelectedRepeatedRegions'"
                class="instance-multiselect">
                <button type="button" class="instance-select-button" (click)="toggleInstanceDropdown(cond, $event)">
                  <span>{{ getInstanceSelectionSummary(cond, cond.monitoredRegionId) }}</span>
                  <span class="profile-select-arrow">{{ openInstanceDropdownCondition === cond ? '▲' : '▼' }}</span>
                </button>
                <div class="profile-select-menu instance-select-menu" *ngIf="openInstanceDropdownCondition === cond" (click)="$event.stopPropagation()">
                  <label *ngFor="let inst of getRepeatInstanceOptions(cond.monitoredRegionId); trackBy: trackByInstKey" class="profile-option">
                    <input type="checkbox"
                      [ngModel]="isRepeatInstanceSelected(cond, inst.key)"
                      (ngModelChange)="onRepeatInstanceChanged(cond, inst.key, $event)" />
                    <span class="profile-option-name">{{ inst.label }}</span>
                  </label>
                </div>
              </div>
              <select [(ngModel)]="cond.value" (ngModelChange)="onFieldChanged()">
                <option value="">Select Value</option>
                <option *ngFor="let v of getStateValuesForCalc(cond.monitoredRegionId, cond.stateCalculationId); trackBy: trackByStringValue" [value]="v">{{ v }}</option>
              </select>
              <span
                class="condition-debug-status"
                [class.condition-debug-status-true]="isOverlayConditionTrue(cond)"
                [class.condition-debug-status-false]="!isOverlayConditionTrue(cond)">
                Condition = {{ isOverlayConditionTrue(cond) ? 'TRUE' : 'FALSE' }}
              </span>
              <button class="danger-text small condition-remove-btn" (click)="removeGroupRuleCondition(rule, condIndex)">× Remove Condition</button>
            </div>
            <button class="add-btn small" (click)="addGroupRuleCondition(rule)">+ Condition</button>
          </div>
          <div class="rule-line group-rule-action-row">
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
            <span
              class="rule-debug-status"
              [class.rule-debug-status-true]="isOverlayRuleConditionTrue(rule)"
              [class.rule-debug-status-false]="!isOverlayRuleConditionTrue(rule)">
              {{ getRuleLogicSummaryLabel(rule) }} = {{ isOverlayRuleConditionTrue(rule) ? 'TRUE' : 'FALSE' }}
            </span>
            <button class="danger-text small rule-remove-btn" (click)="removeGroupRule(group, ruleIndex)">× Delete Rule</button>
          </div>
          <div class="rules-result-summary">
            {{ getGroupVisibilitySummaryAfterRule(group, ruleIndex) }}
          </div>
        </div>
        <!-- ======================== OVERLAYS ======================== -->
        <div class="section-header">
          <span class="section-label">Overlays</span>
        </div>
        <button class="add-overlay-btn add-overlay-top-btn" (click)="addOverlay(group, 'top')">+ Add Overlay at Top</button>

        <div *ngFor="let overlay of group.overlays; let overlayIndex = index"
          class="overlay-card"
          [class.overlay-card-alt-1]="overlayIndex % 2 === 0"
          [class.overlay-card-alt-2]="overlayIndex % 2 === 1"
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
            <input
              [(ngModel)]="overlay.name"
              (ngModelChange)="onFieldChanged()"
              placeholder="Overlay name"
              class="overlay-name-input"
              [attr.data-overlay-name-id]="overlay.id" />
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
              [queryParams]="{ search: ref.name }">
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

          <!-- ===== SOUND ON BECOME VISIBLE ===== -->
          <div class="sound-row">
            <label class="sound-row-label">Sound on Show</label>
            <app-searchable-sound-select
              [soundFilePaths]="soundFileIndex"
              [selectedSoundFilePath]="overlay.soundFileOnBecomeVisible || ''"
              [soundVolume]="soundVolume"
              (soundFileSelected)="overlay.soundFileOnBecomeVisible = $event || undefined; onFieldChanged()"
              (soundPreviewRequested)="previewSound($event)">
            </app-searchable-sound-select>
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
                <app-searchable-region-select
                  [regions]="monitoredRegions"
                  [selectedRegionId]="overlay.regionMirrorConfig.monitoredRegionId"
                  (regionSelected)="overlay.regionMirrorConfig.monitoredRegionId = $event; onFieldChanged()">
                </app-searchable-region-select>
              </label>
              <label>Scale <input type="number" step="0.1" [(ngModel)]="overlay.regionMirrorConfig.size.scale" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>Max W <input type="number" [(ngModel)]="overlay.regionMirrorConfig.size.maxWidth" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
              <label>Max H <input type="number" [(ngModel)]="overlay.regionMirrorConfig.size.maxHeight" (ngModelChange)="onFieldChanged()" style="width:60px" /></label>
            </div>
          </div>

          <!-- ===== RULES ENGINE ===== -->
          <div class="rules-section">
            <div class="rules-header">
              <span class="rules-label">Rules (processed top-down)</span>
              <div class="rules-header-actions">
                <button class="tertiary-btn" *ngIf="copiedOverlayRule" (click)="pasteRule(overlay)">+ Paste Rule</button>
                <button class="add-btn" (click)="addRule(overlay)">+ Add Rule</button>
              </div>
            </div>
            <div *ngIf="overlay.rules.length === 0" class="rules-empty">
              No rules — defaults apply.
            </div>
            <div
              *ngFor="let rule of overlay.rules; let ruleIndex = index"
              class="rule-row overlay-rule-row"
              [class.rule-drag-over]="ruleDragOverIndex === ruleIndex && ruleDragOverOverlayId === overlay.id"
              (dragover)="onRuleDragOver($event, overlay, ruleIndex)"
              (dragleave)="onRuleDragLeave($event)"
              (drop)="onRuleDrop($event, overlay, ruleIndex)">
              <div class="rule-conditions">
                <div class="rule-card-top">
                  <div class="logic-mode-row">
                    <span
                      class="rule-drag-handle"
                      title="Drag to reorder rule"
                      draggable="true"
                      (dragstart)="onRuleDragStart($event, overlay, ruleIndex)"
                      (dragend)="onRuleDragEnd($event)">&#x2630;</span>
                    <span class="rule-keyword">When</span>
                    <select class="logic-mode-select" [(ngModel)]="rule.logicMode" (ngModelChange)="onFieldChanged()">
                      <option value="AND">Every Condition is true</option>
                      <option value="OR">At least one Condition is true</option>
                    </select>
                  </div>
                  <button class="tertiary-btn rule-copy-btn" (click)="copyRule(rule)">
                    {{ copiedOverlayRuleId === rule.id ? 'Copied!' : 'Copy Rule' }}
                  </button>
                </div>
                <div *ngFor="let cond of rule.conditions; let condIndex = index" class="condition-row">
                  <span class="rule-keyword condition-joiner" *ngIf="condIndex > 0">{{ rule.logicMode || 'AND' }}</span>
                  <label class="not-checkbox" title="Invert this condition">
                    <input type="checkbox" [(ngModel)]="cond.negate" (ngModelChange)="onFieldChanged()" />
                    NOT
                  </label>
                  <app-searchable-region-select
                    [regions]="monitoredRegions"
                    [selectedRegionId]="cond.monitoredRegionId"
                    (regionSelected)="cond.monitoredRegionId = $event; onRegionSelectedForCondition(cond)">
                  </app-searchable-region-select>
                  <select [(ngModel)]="cond.stateCalculationId" (ngModelChange)="onCalculationSelectedForCondition(cond)">
                    <option value="">Select Calc</option>
                    <option *ngFor="let calc of getCalcsForRegion(cond.monitoredRegionId); trackBy: trackByCalcId" [ngValue]="calc.id">{{ calc.name }}</option>
                  </select>
                  <select [(ngModel)]="cond.operator" (ngModelChange)="onFieldChanged()">
                    <option value="equals">=</option>
                    <option value="notEquals">≠</option>
                    <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsAtLeastOnceAcrossRepeatedRegions">
                      At least once across Repeated Regions
                    </option>
                    <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsInEveryRepeatedRegion">
                      In every Repeated Region
                    </option>
                    <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsAtLeastNTimesAcrossRepeatedRegions">
                      Occurs a minimum number of times
                    </option>
                    <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsInEverySelectedRepeatedRegion">
                      In Every Selected Region
                    </option>
                    <option *ngIf="isRepeatingRegion(cond.monitoredRegionId)" value="equalsAtLeastOnceInSelectedRepeatedRegions">
                      At Least One Selected Region
                    </option>
                  </select>
                  <input *ngIf="cond.operator === 'equalsAtLeastNTimesAcrossRepeatedRegions'"
                    type="number" min="1" [(ngModel)]="cond.minimumCount" (ngModelChange)="onFieldChanged()"
                    class="minimum-count-input" placeholder="Min" />
                  <div *ngIf="cond.operator === 'equalsInEverySelectedRepeatedRegion' || cond.operator === 'equalsAtLeastOnceInSelectedRepeatedRegions'"
                    class="instance-multiselect">
                    <button type="button" class="instance-select-button" (click)="toggleInstanceDropdown(cond, $event)">
                      <span>{{ getInstanceSelectionSummary(cond, cond.monitoredRegionId) }}</span>
                      <span class="profile-select-arrow">{{ openInstanceDropdownCondition === cond ? '▲' : '▼' }}</span>
                    </button>
                    <div class="profile-select-menu instance-select-menu" *ngIf="openInstanceDropdownCondition === cond" (click)="$event.stopPropagation()">
                      <label *ngFor="let inst of getRepeatInstanceOptions(cond.monitoredRegionId); trackBy: trackByInstKey" class="profile-option">
                        <input type="checkbox"
                          [ngModel]="isRepeatInstanceSelected(cond, inst.key)"
                          (ngModelChange)="onRepeatInstanceChanged(cond, inst.key, $event)" />
                        <span class="profile-option-name">{{ inst.label }}</span>
                      </label>
                    </div>
                  </div>
                  <select *ngIf="getCalcType(cond.monitoredRegionId, cond.stateCalculationId) !== 'OllamaLLM'"
                    [(ngModel)]="cond.value" (ngModelChange)="onFieldChanged()">
                    <option value="">Select Value</option>
                    <option *ngFor="let sv of getStateValuesForCalc(cond.monitoredRegionId, cond.stateCalculationId); trackBy: trackByStringValue" [ngValue]="sv">{{ sv }}</option>
                  </select>
                  <input *ngIf="getCalcType(cond.monitoredRegionId, cond.stateCalculationId) === 'OllamaLLM'"
                    [(ngModel)]="cond.value" (ngModelChange)="onFieldChanged()"
                    placeholder="Expected response" class="condition-value-input" />
                  <span
                    class="condition-debug-status"
                    [class.condition-debug-status-true]="isOverlayConditionTrue(cond)"
                    [class.condition-debug-status-false]="!isOverlayConditionTrue(cond)">
                    Condition = {{ isOverlayConditionTrue(cond) ? 'TRUE' : 'FALSE' }}
                  </span>
                  <button class="danger-text small condition-remove-btn" (click)="removeCondition(rule, condIndex)">× Remove Condition</button>
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
                <span
                  class="rule-debug-status"
                  [class.rule-debug-status-true]="isOverlayRuleConditionTrue(rule)"
                  [class.rule-debug-status-false]="!isOverlayRuleConditionTrue(rule)">
                  {{ getRuleLogicSummaryLabel(rule) }} = {{ isOverlayRuleConditionTrue(rule) ? 'TRUE' : 'FALSE' }}
                </span>
                <button class="danger-text small rule-remove-btn" (click)="removeRule(overlay, ruleIndex)">× Delete Rule</button>
              </div>
              <div class="rules-result-summary">
                {{ getOverlayVisibilitySummaryAfterRule(overlay, ruleIndex) }}
              </div>
            </div>
          </div>
          <div class="overlay-save-row" *ngIf="hasUnsavedChanges && isOverlayDirty(overlay)">
            <button class="primary" (click)="saveAllGroups()">Save (Ctrl+S)</button>
          </div>
        </div>

        <button class="add-overlay-btn" (click)="addOverlay(group, 'bottom')">+ Add Overlay at Bottom</button>
        </ng-container>
      </div>

      <button class="primary add-bottom-btn" (click)="addGroup()">+ Add Group</button>
    </div>
  `,
  styles: [`
    .page {
      max-width: 1100px;
    }

    .page-title {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
    }

    h2 {
      margin: 0;
    }

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

    .description {
      color: var(--color-text-secondary);
      margin-bottom: var(--spacing-lg);
    }

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

    .group-filter-bar {
      display: flex;
      gap: var(--spacing-md);
      margin: var(--spacing-sm) 0 var(--spacing-md);
      flex-wrap: wrap;
    }

    .filter-search-label {
      display: flex;
      flex-direction: column;
      min-width: 280px;
      color: var(--color-text-secondary);
    }

    .filter-search-label input {
      min-width: 280px;
    }

    .filter-count {
      align-self: flex-end;
      font-size: 0.85rem;
      color: var(--color-text-secondary);
      padding-bottom: 2px;
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
      font-size: 1.25rem;
    }

    .import-dialog {
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      margin-bottom: var(--spacing-lg);
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
      width: min(520px, 100%);
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

    .import-dialog textarea {
      width: 100%;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      margin-bottom: var(--spacing-sm);
    }

    .import-actions {
      display: flex;
      gap: var(--spacing-sm);
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

    .group-card {
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .group-card.group-disabled {
      opacity: var(--opacity-disabled);
    }

    .group-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-sm);
      gap: var(--spacing-sm);
    }

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

    .enabled-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      flex-shrink: 0;
    }

    .enabled-toggle input[type="checkbox"] {
      width: 18px;
      height: 18px;
      margin: 0;
      appearance: none;
      border: 2px solid var(--color-error);
      border-radius: 4px;
      background-color: color-mix(in srgb, var(--color-error) 12%, transparent);
      cursor: pointer;
      display: block;
    }

    .enabled-toggle input[type="checkbox"]:checked {
      border-color: var(--color-success);
      background-color: var(--color-success);
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath fill='white' d='M5.55 10.6 2.4 7.45l1.06-1.06 2.09 2.08 4.99-4.98 1.06 1.06z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: center;
      background-size: 12px 12px;
    }

    .enabled-toggle input[type="checkbox"]:focus-visible {
      outline: 2px solid var(--color-accent);
      outline-offset: 1px;
    }

    .profile-managed-status-icon {
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .profile-managed-status-icon svg {
      width: 18px;
      height: 18px;
      display: block;
      fill: currentColor;
    }

    .enabled-toggle-active {
      color: var(--color-success);
    }

    .enabled-toggle-inactive {
      color: var(--color-error);
    }

    .cross-ref-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
      margin-bottom: var(--spacing-sm);
      padding: 4px var(--spacing-sm);
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

    .cross-ref-link:hover {
      opacity: 0.8;
    }

    .name-input, .overlay-name-input {
      font-size: 1rem;
      font-weight: 500;
      background: transparent;
      border: 1px solid transparent;
      padding: var(--spacing-xs);
      flex: 1;
    }

    .name-input:focus, .overlay-name-input:focus {
      border-color: var(--color-accent);
    }

    .overlay-name-input {
      font-size: 0.9rem;
    }

    .group-settings {
      display: flex;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
      flex-wrap: wrap;
      align-items: flex-end;
    }

    .group-settings label {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      color: var(--color-text-secondary);
      font-size: 0.85rem;
    }

    .group-settings input[type="number"] {
      width: 70px;
    }

    .profile-multiselect {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      min-width: 240px;
    }

    .profiles-label {
      color: var(--color-text-secondary);
      font-size: 0.85rem;
    }

    .profile-select-button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm);
      min-width: 240px;
      max-width: 320px;
      background-color: var(--color-bg-secondary);
      text-align: left;
    }

    .profile-select-button span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .profile-select-arrow {
      color: var(--color-text-secondary);
      font-size: 0.7rem;
      flex-shrink: 0;
    }

    .profile-select-menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 20;
      width: min(360px, 80vw);
      max-height: 260px;
      overflow-y: auto;
      padding: var(--spacing-xs);
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }

    .profile-option {
      display: grid !important;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-sm) !important;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--color-text-secondary) !important;
      font-size: 0.85rem !important;
    }

    .profile-option:hover {
      background-color: var(--color-bg-panel);
    }

    .profile-option.profile-option-active {
      color: var(--color-text-primary) !important;
    }

    .profile-option input {
      accent-color: var(--color-accent);
    }

    .profile-option-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .profile-option-state {
      color: var(--color-text-secondary);
      font-size: 0.75rem;
    }

    .pick-btn {
      font-size: 0.8rem;
      padding: 4px 12px;
      background-color: var(--color-bg-panel);
      border: 1px solid var(--color-accent);
      color: var(--color-accent);
      border-radius: var(--radius-sm);
      white-space: nowrap;
      align-self: flex-end;
    }

    .pick-btn:hover {
      background-color: var(--color-accent);
      color: var(--color-text-primary);
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
    }

    .section-label {
      font-size: 1rem;
      font-weight: bold;
      color: var(--color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 10px;
      margin-left: -10px;
    }

    .add-btn {
      font-size: 0.8rem;
      padding: 2px 10px;
    }

    .overlay-card {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      transition: border-color 0.1s ease;
    }

    .overlay-card-alt-1 {
      background-color: var(--color-bg-alternating1);
    }

    .overlay-card-alt-2 {
      background-color: var(--color-bg-alternating2);
    }

    .overlay-save-row {
      display: flex;
      justify-content: flex-end;
      margin-top: var(--spacing-md);
      padding-top: var(--spacing-sm);
      border-top: 1px solid var(--color-border);
    }

    .overlay-card.drag-over {
      border-color: var(--color-accent);
      border-style: dashed;
    }

    .overlay-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
    }

    .drag-handle {
      cursor: grab;
      color: var(--color-text-secondary);
      font-size: 1rem;
      padding: 0 4px;
      opacity: 0.5;
      user-select: none;
    }

    .drag-handle:hover {
      opacity: 1;
    }

    .drag-handle:active {
      cursor: grabbing;
    }

    /* Defaults row */
    .defaults-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-lg);
      margin-bottom: var(--spacing-sm);
      padding: var(--spacing-xs) 0;
      border-bottom: 1px solid var(--color-border);
    }

    .sound-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) 0;
      border-bottom: 1px solid var(--color-border);
      margin-bottom: var(--spacing-sm);
    }

    .sound-row-label {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
      white-space: nowrap;
      min-width: 90px;
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 0.85rem;
      color: var(--color-text-secondary);
      cursor: pointer;
    }

    .opacity-label {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: 0.85rem;
      color: var(--color-text-secondary);
    }

    .opacity-label input[type="range"] {
      width: 120px;
      accent-color: var(--color-accent);
    }

    .opacity-value {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      min-width: 40px;
      color: var(--color-text-primary);
    }

    /* Content configs */
    .content-config {
      padding: var(--spacing-xs) 0 var(--spacing-sm) 0;
    }

    .config-row {
      display: flex;
      gap: var(--spacing-md);
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 4px;
    }

    .config-row label {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-text-secondary);
      font-size: 0.8rem;
    }

    .wide-input {
      flex: 1;
      min-width: 200px;
    }

    /* Rules */
    .rules-section {
      border-top: 1px solid var(--color-border);
      padding-top: var(--spacing-sm);
      margin-top: var(--spacing-sm);
    }

    .rules-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-xs);
    }

    .rules-header-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .rules-label {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .rules-empty {
      font-size: 0.8rem;
      color: var(--color-text-secondary);
      font-style: italic;
      padding: 4px 0;
    }

    .group-rule-action-row {
      margin-top: 6px;
    }

    .section-hint {
      font-size: 0.7rem;
      color: var(--color-text-secondary);
      font-style: italic;
      flex: 1;
      margin-left: var(--spacing-sm);
    }

    .group-rules-header {
      margin-bottom: var(--spacing-xs);
    }

    .group-rule-row {
      border-left: 3px solid var(--color-accent);
    }

    .group-rule-top-row {
      justify-content: space-between;
    }

    .group-rule-row .rule-line {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      flex-wrap: wrap;
      margin-bottom: 4px;
    }

    .group-rule-row .conditions-list {
      padding-left: 50px;
    }

    .rule-row.overlay-rule-row {
      background-color: rgba(0, 0, 0, 0.25);
    }

    .rule-row {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      margin-bottom: 4px;
    }

    .rule-row.rule-drag-over {
      border-color: var(--color-accent);
      box-shadow: inset 0 0 0 1px var(--color-accent);
    }

    .rule-conditions {
      margin-bottom: 4px;
    }

    .rule-card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--spacing-sm);
    }

    .condition-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      margin-bottom: 2px;
      flex-wrap: wrap;
    }

    .condition-row select {
      font-size: 0.8rem;
      max-width: 150px;
    }

    .condition-debug-status {
      font-size: 0.72rem;
      font-weight: 600;
    }

    .condition-debug-status-true {
      color: var(--color-success);
    }

    .condition-debug-status-false {
      color: var(--color-error);
    }

    .condition-remove-btn {
      margin-left: auto;
    }

    .minimum-count-input {
      width: 54px;
      font-size: 0.8rem;
    }

    .instance-multiselect {
      position: relative;
      display: inline-flex;
      flex-direction: column;
    }

    .instance-select-button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm);
      min-width: 120px;
      background-color: var(--color-bg-secondary);
      text-align: left;
      font-size: 0.8rem;
    }

    .instance-select-menu {
      width: min(200px, 80vw);
    }

    .rule-keyword {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-accent);
      text-transform: uppercase;
      min-width: 40px;
    }

    .condition-joiner {
      min-width: 30px;
      text-align: center;
    }

    .logic-mode-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: 4px;
    }

    .logic-mode-select {
      font-size: 0.75rem;
    }

    .rule-drag-handle {
      cursor: grab;
      color: var(--color-text-secondary);
      font-size: 0.9rem;
      line-height: 1;
      user-select: none;
    }

    .rule-drag-handle:active {
      cursor: grabbing;
    }

    .rule-copy-btn {
      font-size: 0.75rem;
      flex-shrink: 0;
    }

    .not-checkbox {
      display: flex;
      align-items: center;
      gap: 2px;
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--color-text-secondary);
      cursor: pointer;
      white-space: nowrap;
    }

    .not-checkbox input[type="checkbox"] {
      margin: 0;
    }

    .add-condition-btn {
      font-size: 0.7rem;
      background: transparent;
      border: 1px dashed var(--color-border);
      padding: 1px 8px;
    }

    .rule-action {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
    }

    .rule-action select {
      font-size: 0.8rem;
    }

    .rule-action input[type="range"] {
      width: 100px;
      accent-color: var(--color-accent);
    }

    .rule-debug-status {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .rule-debug-status-true {
      color: var(--color-success);
    }

    .rule-debug-status-false {
      color: var(--color-error);
    }

    .rule-remove-btn {
      margin-left: auto;
    }

    .rules-result-summary {
      margin-top: var(--spacing-xs);
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--color-text-secondary);
    }

    .add-overlay-btn {
      font-size: 0.85rem;
      background: rgba(0, 0, 0, 0.25);
      border: 1px dashed var(--color-border);
      padding: var(--spacing-sm);
    }

    .add-overlay-btn:hover {
      background: rgba(0, 0, 0, 0.5);
    }

    .add-overlay-top-btn {
      margin-bottom: var(--spacing-sm);
    }

    .danger-text {
      background: transparent;
      border: none;
      color: var(--color-error);
      font-size: 0.85rem;
    }

    .danger-text.small {
      font-size: 0.8rem;
    }

    .danger-text:hover {
      text-decoration: underline;
    }

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
export class OverlayGroupsComponent implements OnInit, OnDestroy, PendingChangesComponent {
  private static readonly STORAGE_KEY_COLLAPSED_GROUPS = 'fundido:collapsedOverlayGroups';
  private static readonly STORAGE_KEY_HIDE_INACTIVE_GROUPS = 'fundido:hideInactiveOverlayGroups';

  groups: any[] = [];
  monitoredRegions: any[] = [];
  profiles: any[] = [];
  soundFileIndex: string[] = [];
  soundVolume = 0.5;
  groupSearchText = '';
  hideInactiveOverlayGroups = true;
  showImportDialog = false;
  showUnsavedChangesDialog = false;
  importJsonText = '';
  hasUnsavedChanges = false;
  isResolvingUnsavedChanges = false;
  uiHasFocus = true;
  pickingGroupId: string | null = null;
  highlightId: string | null = null;
  copiedOverlayRule: any | null = null;
  copiedOverlayRuleId: string | null = null;
  openProfileDropdownGroupId: string | null = null;
  openInstanceDropdownCondition: any | null = null;
  private currentFrameState: any | null = null;
  private viewRefreshScheduled = false;
  private collapsedGroupIds = new Set<string>();
  private savedOverlaySnapshots = new Map<string, string>();
  private groupComparableSnapshots = new Map<string, string>();
  private pendingNavigationPromise: Promise<boolean> | null = null;
  private pendingNavigationResolve: ((allowNavigation: boolean) => void) | null = null;
  /** True while this route is the active page. Used to short-circuit expensive work while detached. */
  private isRouteActive = true;
  private routerEventsSubscription: Subscription | null = null;

  /** Cached cross-references: overlayId → monitored regions referenced by that overlay. Built once on load. */
  overlayCrossRefs = new Map<string, Array<{ id: string; name: string }>>();

  /** Cached cross-references: groupId → monitored regions referenced by group rules. Built once on load. */
  groupRuleCrossRefs = new Map<string, Array<{ id: string; name: string }>>();

  // Drag-and-drop reorder state
  dragOverIndex: number | null = null;
  dragOverGroupId: string | null = null;
  groupRuleDragOverIndex: number | null = null;
  groupRuleDragOverGroupId: string | null = null;
  ruleDragOverIndex: number | null = null;
  ruleDragOverOverlayId: string | null = null;
  private dragSourceGroupId: string | null = null;
  private dragSourceIndex: number | null = null;
  private dragSourceGroupRuleGroupId: string | null = null;
  private dragSourceGroupRuleIndex: number | null = null;
  private dragSourceRuleOverlayId: string | null = null;
  private dragSourceRuleIndex: number | null = null;

  private stateSubscription: Subscription | null = null;

  constructor(
    private readonly electronService: ElectronService,
    private readonly pendingChangesService: PendingChangesService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly changeDetectorRef: ChangeDetectorRef,
    private readonly ngZone: NgZone,
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

  @HostListener('window:focus')
  onWindowFocus(): void {
    this.uiHasFocus = true;
    this.changeDetectorRef.markForCheck();
  }

  @HostListener('window:blur')
  onWindowBlur(): void {
    this.uiHasFocus = false;
    this.changeDetectorRef.markForCheck();
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.openProfileDropdownGroupId = null;
    this.openInstanceDropdownCondition = null;
  }

  async ngOnInit(): Promise<void> {
    this.uiHasFocus = document.hasFocus();
    this.loadInactiveGroupFilterState();
    this.pendingChangesService.register(this);
    const config = await this.electronService.loadConfig();
    this.groups = config.overlayGroups || [];
    this.normalizeGroupDefaults();
    this.normalizeOverlayRuleLogicModes();
    this.refreshSavedOverlaySnapshots();
    this.refreshGroupComparableSnapshots();
    this.loadCollapsedGroupState();
    this.syncCollapsedGroupState();
    this.monitoredRegions = config.monitoredRegions || [];
    this.profiles = config.profiles || [];
    this.soundFileIndex = await this.electronService.soundGetIndex();
    this.soundVolume = config.soundVolume ?? 0.5;
    this.applyProfileActivationToGroups();
    this.buildOverlayCrossRefs();
    this.changeDetectorRef.markForCheck();
    this.ngZone.runOutsideAngular(() => {
      this.stateSubscription = this.electronService.stateUpdateStream.subscribe((frameState: any) => {
        if (!this.isRouteActive) return;
        this.currentFrameState = frameState;
        this.scheduleViewRefresh();
      });
    });

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
            this.changeDetectorRef.markForCheck();
            setTimeout(() => { this.highlightId = null; this.changeDetectorRef.markForCheck(); }, 2500);
          }, 150);
        };

        // Listen for scroll activity to stop
        scrollContainer.addEventListener('scroll', onScrollEnd);
        // Fallback: if element is already in view and no scroll happens
        scrollTimer = setTimeout(() => {
          scrollContainer.removeEventListener('scroll', onScrollEnd);
          this.highlightId = targetId;
          this.changeDetectorRef.markForCheck();
          setTimeout(() => { this.highlightId = null; this.changeDetectorRef.markForCheck(); }, 2500);
        }, 600);
      }, 150);
    });

    // Subscribe to router navigation events to detect when this route becomes active or
    // inactive without being destroyed (because AppRouteReuseStrategy keeps this component alive).
    this.routerEventsSubscription = this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      const isNowActiveRoute = event.urlAfterRedirects.startsWith('/overlays');
      if (isNowActiveRoute && !this.isRouteActive) {
        this.onRouteActivated();
      } else if (!isNowActiveRoute && this.isRouteActive) {
        this.onRouteDeactivated();
      }
    });
  }

  ngOnDestroy(): void {
    // Safety net: if the component is destroyed while still the active route (e.g. at app
    // shutdown), run deactivation cleanup so IPC state is left consistent.
    if (this.isRouteActive) {
      this.onRouteDeactivated();
    }
    this.pendingChangesService.unregister(this);
    this.routerEventsSubscription?.unsubscribe();
    this.stateSubscription?.unsubscribe();
    this.resolvePendingNavigation(false);
  }

  // ---------------------------------------------------------------------------
  // Route reuse lifecycle — called by NavigationEnd subscription rather than
  // Angular's own ngOnInit/ngOnDestroy because AppRouteReuseStrategy keeps this
  // component alive across navigations.
  // ---------------------------------------------------------------------------

  private onRouteActivated(): void {
    this.isRouteActive = true;
    this.changeDetectorRef.markForCheck();
  }

  private onRouteDeactivated(): void {
    this.isRouteActive = false;
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

    try {
      await this.saveAllGroups();
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

  onFieldChanged(): void { this.markGroupsChanged(); }

  isOverlayDirty(overlay: any): boolean {
    return this.savedOverlaySnapshots.get(overlay.id) !== this.serializeOverlay(overlay);
  }

  // ---------------------------------------------------------------------------
  // Group CRUD
  // ---------------------------------------------------------------------------

  addGroup(): void {
    const activeProfileIds = this.profiles.filter((profile) => profile.active).map((profile) => profile.id);
    const newGroup = {
      id: crypto.randomUUID(), name: 'New Group', enabled: true,
      lastUpdatedAt: Date.now(),
      profileIds: activeProfileIds,
      scale: 1,
      defaultVisibilityMode: 'visible',
      defaultOpacity: 1,
      position: { mode: 'absolute', x: 100, y: 100 },
      growDirection: 'right', alignment: 'start', gap: 0, overlays: [],
    };
    this.groups.push(newGroup);
    this.collapsedGroupIds.delete(newGroup.id);
    this.saveCollapsedGroupState();
    this.markGroupsChanged();
    setTimeout(() => {
      const input = document.querySelector(`[data-group-name-id="${newGroup.id}"]`) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    }, 0);
  }

  async removeGroup(groupId: string): Promise<void> {
    const index = this.groups.findIndex((group) => group.id === groupId);
    if (index < 0) {
      return;
    }

    const [removedGroup] = this.groups.splice(index, 1);
    if (removedGroup?.id) {
      this.collapsedGroupIds.delete(removedGroup.id);
      this.saveCollapsedGroupState();
    }
    this.markGroupsChanged();
    await this.saveAllGroups();
  }

  isGroupExpanded(groupId: string): boolean {
    return !this.collapsedGroupIds.has(groupId);
  }

  get visibleGroups(): any[] {
    return this.groups.filter((group) => this.groupMatchesFilters(group));
  }

  isGroupVisuallyDisabled(group: any): boolean {
    const isInactive = !this.isGroupCurrentlyActive(group);
    if (!isInactive) {
      return false;
    }

    // Keep inactive groups readable while the user is actively editing them.
    return !(this.uiHasFocus && this.isGroupExpanded(group.id));
  }

  isGroupCurrentlyActive(group: any): boolean {
    const activeProfileIds = this.getActiveProfileIds();
    if (this.isGroupProfileManaged(group)) {
      return (group.profileIds || []).some((profileId: string) => activeProfileIds.has(profileId));
    }

    return group.enabled !== false;
  }

  private getActiveProfileIds(): Set<string> {
    if (Array.isArray(this.currentFrameState?.profileStates)) {
      return new Set(
        this.currentFrameState.profileStates
          .filter((profileState: any) => profileState.active)
          .map((profileState: any) => profileState.id)
      );
    }

    return new Set(
      this.profiles
        .filter((profile) => profile.active)
        .map((profile) => profile.id)
    );
  }

  private groupMatchesFilters(group: any): boolean {
    if (this.hideInactiveOverlayGroups && !this.isGroupCurrentlyActive(group)) {
      return false;
    }

    const search = this.groupSearchText.trim().toLowerCase();
    if (!search) {
      return true;
    }

    if ((group.name || '').toLowerCase().includes(search)) {
      return true;
    }

    return (group.overlays || []).some((overlay: any) =>
      (overlay.name || '').toLowerCase().includes(search)
    );
  }

  private loadInactiveGroupFilterState(): void {
    try {
      const saved = localStorage.getItem(OverlayGroupsComponent.STORAGE_KEY_HIDE_INACTIVE_GROUPS);
      if (saved === null) {
        this.hideInactiveOverlayGroups = true;
        return;
      }

      this.hideInactiveOverlayGroups = saved === 'true';
    } catch {
      this.hideInactiveOverlayGroups = true;
    }
  }

  saveInactiveGroupFilterState(): void {
    try {
      localStorage.setItem(
        OverlayGroupsComponent.STORAGE_KEY_HIDE_INACTIVE_GROUPS,
        String(this.hideInactiveOverlayGroups)
      );
    } catch {
      // Ignore storage errors so the editor remains usable.
    }
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
    this.markGroupsChanged();
  }

  onGroupDefaultVisibilityChanged(group: any): void {
    if (!group.defaultVisibilityMode) {
      group.defaultVisibilityMode = 'visible';
    }
    if (group.defaultVisibilityMode === 'opacity' && group.defaultOpacity === undefined) {
      group.defaultOpacity = 1;
    }
    this.markGroupsChanged();
  }

  isGroupInProfile(group: any, profileId: string): boolean {
    return (group.profileIds || []).includes(profileId);
  }

  isGroupProfileManaged(group: any): boolean {
    return (group.profileIds || []).length > 0;
  }

  getGroupProfileSummary(group: any): string {
    const selectedProfiles = this.profiles.filter((profile) => this.isGroupInProfile(group, profile.id));
    if (selectedProfiles.length === 0) {
      return 'No profiles';
    }
    if (selectedProfiles.length === 1) {
      return selectedProfiles[0].name;
    }
    return `${selectedProfiles.length} profiles`;
  }

  toggleProfileDropdown(groupId: string, event: Event): void {
    event.stopPropagation();
    this.openProfileDropdownGroupId = this.openProfileDropdownGroupId === groupId ? null : groupId;
  }

  onProfileDropdownClick(event: Event): void {
    event.stopPropagation();
  }

  onGroupProfileChanged(group: any, profileId: string, belongsToProfile: boolean): void {
    const profileIds = new Set<string>(group.profileIds || []);
    if (belongsToProfile) {
      profileIds.add(profileId);
    } else {
      profileIds.delete(profileId);
    }
    group.profileIds = Array.from(profileIds);
    this.applyProfileActivationToGroups();
    this.markGroupsChanged();
  }

  onGroupScaleChanged(group: any, scaleValue: number): void {
    group.scale = scaleValue > 0 ? scaleValue : 0;
    this.markGroupsChanged();
  }

  onGroupDefaultOpacityChanged(group: any, percentValue: number): void {
    group.defaultOpacity = percentValue / 100;
    this.markGroupsChanged();
  }

  async pickAnchor(group: any): Promise<void> {
    this.pickingGroupId = group.id;
    const result = await this.electronService.pickRegion({ autoConfirmSingleClick: true });
    if (result !== null) {
      group.position.x = result.x;
      group.position.y = result.y;
      this.markGroupsChanged();
      await this.saveAllGroups();
    }
    this.pickingGroupId = null;
  }

  // ---------------------------------------------------------------------------
  // Overlay CRUD
  // ---------------------------------------------------------------------------

  addOverlay(group: any, position: 'top' | 'bottom' = 'bottom'): void {
    const newOverlay = {
      id: crypto.randomUUID(), name: 'New Overlay', contentType: 'text',
      defaultVisible: true, defaultOpacity: 1.0,
      textConfig: {
        text: 'Hello', fontSize: 16, fontFamily: 'Segoe UI',
        fontWeight: 'normal', fontStyle: 'normal',
        color: '#ffffff', backgroundColor: '#000000aa', padding: 4,
      },
      imageConfig: null, regionMirrorConfig: null, rules: [],
    };
    if (position === 'top') {
      group.overlays.unshift(newOverlay);
    } else {
      group.overlays.push(newOverlay);
    }
    this.markGroupsChanged();
    setTimeout(() => {
      const input = document.querySelector(`[data-overlay-name-id="${newOverlay.id}"]`) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    }, 0);
  }

  async removeOverlay(group: any, index: number): Promise<void> {
    group.overlays.splice(index, 1);
    this.markGroupsChanged();
    await this.saveAllGroups();
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
    this.markGroupsChanged();
  }

  onDragEnd(): void {
    this.dragSourceGroupId = null;
    this.dragSourceIndex = null;
    this.dragOverIndex = null;
    this.dragOverGroupId = null;
  }

  onRuleDragStart(event: DragEvent, overlay: any, index: number): void {
    event.stopPropagation();
    this.dragSourceRuleOverlayId = overlay.id;
    this.dragSourceRuleIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  }

  onRuleDragOver(event: DragEvent, overlay: any, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.ruleDragOverIndex = index;
    this.ruleDragOverOverlayId = overlay.id;
  }

  onRuleDragLeave(event: DragEvent): void {
    event.stopPropagation();
    this.ruleDragOverIndex = null;
    this.ruleDragOverOverlayId = null;
  }

  onRuleDrop(event: DragEvent, overlay: any, dropIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.ruleDragOverIndex = null;
    this.ruleDragOverOverlayId = null;

    const isSameOverlay = this.dragSourceRuleOverlayId === overlay.id;
    if (!isSameOverlay || this.dragSourceRuleIndex === null) {
      return;
    }

    const sourceIndex = this.dragSourceRuleIndex;
    if (sourceIndex === dropIndex) {
      return;
    }

    const movedRule = overlay.rules.splice(sourceIndex, 1)[0];
    overlay.rules.splice(dropIndex, 0, movedRule);
    this.markGroupsChanged();
  }

  onRuleDragEnd(event: DragEvent): void {
    event.stopPropagation();
    this.dragSourceRuleOverlayId = null;
    this.dragSourceRuleIndex = null;
    this.ruleDragOverIndex = null;
    this.ruleDragOverOverlayId = null;
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
      overlay.regionMirrorConfig = { monitoredRegionId: '', size: { scale: 1 } };
    }
    this.markGroupsChanged();
  }

  onDefaultOpacityChanged(overlay: any, percentValue: number): void {
    overlay.defaultOpacity = percentValue / 100;
    this.markGroupsChanged();
  }

  async chooseImageFile(overlay: any): Promise<void> {
    const filePath = await this.electronService.openFileDialog();
    if (filePath && overlay.imageConfig) {
      overlay.imageConfig.filePath = filePath;
      this.markGroupsChanged();
    }
  }

  previewSound(filePath: string): void {
    this.electronService.soundPlayPreview(filePath, this.soundVolume);
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
    this.markGroupsChanged();
  }

  removeGroupRule(group: any, index: number): void {
    group.rules.splice(index, 1);
    this.markGroupsChanged();
  }

  addGroupRuleCondition(rule: any): void {
    rule.conditions.push({ monitoredRegionId: '', stateCalculationId: '', operator: 'equals', value: '', negate: false });
    this.markGroupsChanged();
  }

  removeGroupRuleCondition(rule: any, index: number): void {
    rule.conditions.splice(index, 1);
    this.markGroupsChanged();
  }

  onGroupRuleDragStart(event: DragEvent, group: any, index: number): void {
    event.stopPropagation();
    this.dragSourceGroupRuleGroupId = group.id;
    this.dragSourceGroupRuleIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  }

  onGroupRuleDragOver(event: DragEvent, group: any, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.groupRuleDragOverIndex = index;
    this.groupRuleDragOverGroupId = group.id;
  }

  onGroupRuleDragLeave(event: DragEvent): void {
    event.stopPropagation();
    this.groupRuleDragOverIndex = null;
    this.groupRuleDragOverGroupId = null;
  }

  onGroupRuleDrop(event: DragEvent, group: any, dropIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.groupRuleDragOverIndex = null;
    this.groupRuleDragOverGroupId = null;

    const isSameGroup = this.dragSourceGroupRuleGroupId === group.id;
    if (!isSameGroup || this.dragSourceGroupRuleIndex === null) {
      return;
    }

    const sourceIndex = this.dragSourceGroupRuleIndex;
    if (sourceIndex === dropIndex) {
      return;
    }

    const movedRule = group.rules.splice(sourceIndex, 1)[0];
    group.rules.splice(dropIndex, 0, movedRule);
    this.markGroupsChanged();
  }

  onGroupRuleDragEnd(event: DragEvent): void {
    event.stopPropagation();
    this.dragSourceGroupRuleGroupId = null;
    this.dragSourceGroupRuleIndex = null;
    this.groupRuleDragOverIndex = null;
    this.groupRuleDragOverGroupId = null;
  }

  // -- Overlay rules --

  addRule(overlay: any): void {
    // For mirror overlays, pre-fill the first condition's region with the
    // mirrored region — the most common use case is "show/hide this mirror
    // based on the state of the region it's already showing."
    const isMirrorOverlay = overlay.contentType === 'regionMirror';
    const defaultMonitoredRegionId = isMirrorOverlay
      ? (overlay.regionMirrorConfig?.monitoredRegionId || '')
      : '';

    overlay.rules.push({
      id: crypto.randomUUID(),
      logicMode: 'AND',
      conditions: [{ monitoredRegionId: defaultMonitoredRegionId, stateCalculationId: '', operator: 'equals', value: '', negate: false }],
      action: 'show',
    });
    this.markGroupsChanged();
  }

  copyRule(rule: any): void {
    this.copiedOverlayRule = JSON.parse(JSON.stringify(rule));
    this.copiedOverlayRuleId = rule.id;
  }

  pasteRule(overlay: any): void {
    if (!this.copiedOverlayRule) {
      return;
    }

    const clonedRule = JSON.parse(JSON.stringify(this.copiedOverlayRule));
    clonedRule.id = crypto.randomUUID();
    overlay.rules.push(clonedRule);
    this.markGroupsChanged();
  }

  removeRule(overlay: any, index: number): void {
    overlay.rules.splice(index, 1);
    this.markGroupsChanged();
  }

  addCondition(rule: any): void {
    rule.conditions.push({ monitoredRegionId: '', stateCalculationId: '', operator: 'equals', value: '', negate: false });
    this.markGroupsChanged();
  }

  removeCondition(rule: any, index: number): void {
    rule.conditions.splice(index, 1);
    this.markGroupsChanged();
  }

  onRegionSelectedForCondition(condition: any): void {
    const repeatedOnlyOperators = [
      'equalsAtLeastOnceAcrossRepeatedRegions',
      'equalsInEveryRepeatedRegion',
      'equalsAtLeastNTimesAcrossRepeatedRegions',
      'equalsInEverySelectedRepeatedRegion',
      'equalsAtLeastOnceInSelectedRepeatedRegions',
    ];
    if (!this.isRepeatingRegion(condition.monitoredRegionId) && repeatedOnlyOperators.includes(condition.operator)) {
      condition.operator = 'equals';
    }
    this.autofillConditionCalculationAndValue(condition);
    this.markGroupsChanged();
  }

  onCalculationSelectedForCondition(condition: any): void {
    this.autofillConditionValue(condition);
    this.markGroupsChanged();
  }

  onRuleOpacityChanged(rule: any, percentValue: number): void {
    rule.opacityValue = percentValue / 100;
    this.markGroupsChanged();
  }

  isOverlayRuleConditionTrue(rule: any): boolean {
    return this.evaluateConditions(rule?.conditions || [], rule?.logicMode || 'AND', this.currentFrameState);
  }

  getRuleLogicSummaryLabel(rule: any): string {
    return (rule?.logicMode || 'AND') === 'OR'
      ? 'At least one Condition is true'
      : 'Every Condition is true';
  }

  getOverlayVisibilitySummaryAfterRule(overlay: any, ruleIndex: number): string {
    const rule = overlay?.rules?.[ruleIndex];
    if (!this.isOverlayRuleConditionTrue(rule)) {
      return 'Rule did not apply visibility changes.';
    }

    return `Visibility after this Rule applied: ${this.formatOverlayVisibilitySummary(this.evaluateOverlayVisibility(overlay, ruleIndex + 1))}`;
  }

  getFinalOverlayVisibilitySummary(overlay: any): string {
    return `Visibility after Final Rule: ${this.formatOverlayVisibilitySummary(this.evaluateOverlayVisibility(overlay))}`;
  }

  getGroupVisibilitySummaryAfterRule(group: any, ruleIndex: number): string {
    const rule = group?.rules?.[ruleIndex];
    if (!this.isOverlayRuleConditionTrue(rule)) {
      return 'Rule did not apply visibility changes.';
    }

    return `Visibility after this Rule applied: ${this.formatGroupVisibilitySummary(this.evaluateGroupVisibility(group, ruleIndex + 1))}`;
  }

  getFinalGroupVisibilitySummary(group: any): string {
    return `Visibility after Final Rule: ${this.formatGroupVisibilitySummary(this.evaluateGroupVisibility(group))}`;
  }

  isOverlayConditionTrue(condition: any): boolean {
    if (!this.currentFrameState?.regionStates) {
      return false;
    }

    const regionState = this.currentFrameState.regionStates.find(
      (state: any) => state.monitoredRegionId === condition.monitoredRegionId,
    );
    if (!regionState) {
      return false;
    }

    const calcResult = regionState.calculationResults.find(
      (result: any) => result.stateCalculationId === condition.stateCalculationId,
    );
    if (!calcResult) {
      return false;
    }

    let conditionResult = this.evaluateConditionOperator(condition, calcResult, this.currentFrameState);
    if (condition.negate) {
      conditionResult = !conditionResult;
    }

    return conditionResult;
  }

  getCalcsForRegion(regionId: string): any[] {
    const region = this.monitoredRegions.find((r: any) => r.id === regionId);
    return region?.stateCalculations || [];
  }

  isRepeatingRegion(regionId: string): boolean {
    const region = this.monitoredRegions.find((r: any) => r.id === regionId);
    if (!region?.repeat?.enabled) {
      return false;
    }

    const repeatsInX = region.repeat.x?.enabled === true && (region.repeat.x?.count ?? 1) > 1;
    const repeatsInY = region.repeat.y?.enabled === true && (region.repeat.y?.count ?? 1) > 1;
    return repeatsInX || repeatsInY;
  }

  getRepeatInstanceOptions(regionId: string): Array<{ key: string; label: string }> {
    const region = this.monitoredRegions.find((r: any) => r.id === regionId);
    if (!region?.repeat?.enabled) return [];

    const rawXCount = region.repeat.x?.count ?? 1;
    const rawYCount = region.repeat.y?.count ?? 1;
    const rawXEnabled = region.repeat.x?.enabled === true;
    const rawYEnabled = region.repeat.y?.enabled === true;

    const xCount = rawXEnabled && rawXCount > 1 ? rawXCount : 1;
    const yCount = rawYEnabled && rawYCount > 1 ? rawYCount : 1;
    const totalCount = xCount * yCount;

    const countsAreFiniteAndReasonable = Number.isFinite(xCount) && Number.isFinite(yCount) && totalCount <= 10000;
    if (!countsAreFiniteAndReasonable) {
      console.error(`[getRepeatInstanceOptions] Unsafe repeat count detected — xCount=${xCount}, yCount=${yCount}, total=${totalCount}. Aborting loop to prevent hang.`);
      return [{ key: '0_0', label: 'Base (count overflow — check region config)' }];
    }

    const options: Array<{ key: string; label: string }> = [];
    for (let y = 0; y < yCount; y++) {
      for (let x = 0; x < xCount; x++) {
        const key = `${x}_${y}`;
        let label: string;
        if (x === 0 && y === 0) {
          label = 'Base';
        } else if (yCount === 1) {
          label = `X${x}`;
        } else if (xCount === 1) {
          label = `Y${y}`;
        } else {
          label = `X${x} Y${y}`;
        }
        options.push({ key, label });
      }
    }
    return options;
  }

  isRepeatInstanceSelected(condition: any, key: string): boolean {
    return (condition.selectedRepeatInstances || []).includes(key);
  }

  onRepeatInstanceChanged(condition: any, key: string, selected: boolean): void {
    if (!condition.selectedRepeatInstances) condition.selectedRepeatInstances = [];
    if (selected) {
      if (!condition.selectedRepeatInstances.includes(key)) condition.selectedRepeatInstances.push(key);
    } else {
      const idx = condition.selectedRepeatInstances.indexOf(key);
      if (idx >= 0) condition.selectedRepeatInstances.splice(idx, 1);
    }
    this.markGroupsChanged();
  }

  getInstanceSelectionSummary(condition: any, regionId: string): string {
    const selected: string[] = condition.selectedRepeatInstances || [];
    if (selected.length === 0) return 'Select regions…';
    const options = this.getRepeatInstanceOptions(regionId);
    if (selected.length === options.length) return 'All regions';
    if (selected.length === 1) {
      return options.find((o) => o.key === selected[0])?.label ?? '1 region';
    }
    return `${selected.length} regions`;
  }

  trackByInstKey(_index: number, inst: { key: string; label: string }): string {
    return inst.key;
  }

  trackByRegionId(_index: number, region: any): string {
    return region.id;
  }

  trackByCalcId(_index: number, calc: any): string {
    return calc.id;
  }

  trackByStringValue(_index: number, value: string): string {
    return value;
  }

  toggleInstanceDropdown(condition: any, event: Event): void {
    event.stopPropagation();
    this.openInstanceDropdownCondition = this.openInstanceDropdownCondition === condition ? null : condition;
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

  private autofillConditionCalculationAndValue(condition: any): void {
    const firstCalc = this.getCalcsForRegion(condition.monitoredRegionId)[0];
    condition.stateCalculationId = firstCalc?.id || '';
    this.autofillConditionValue(condition);
  }

  private autofillConditionValue(condition: any): void {
    const firstValue = this.getStateValuesForCalc(condition.monitoredRegionId, condition.stateCalculationId)[0];
    condition.value = firstValue || '';
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
    const matchingRegion = this.monitoredRegions.find((r: any) => r.id === regionId);
    const regionName = matchingRegion?.name ?? regionId;
    this.router.navigate(['/regions'], { queryParams: { search: regionName } });
  }

  // ---------------------------------------------------------------------------
  // Save / Import / Export
  // ---------------------------------------------------------------------------

  async saveAllGroups(): Promise<void> {
    const config = await this.electronService.loadConfig();
    this.applyProfileActivationToGroups();
    config.overlayGroups = JSON.parse(JSON.stringify(this.groups));
    await this.electronService.saveConfig(config);
    this.hasUnsavedChanges = false;
    this.refreshSavedOverlaySnapshots();
    this.refreshGroupComparableSnapshots();
    this.changeDetectorRef.markForCheck();
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
      this.normalizeGroupDefaults();
      this.normalizeOverlayRuleLogicModes();
      this.refreshSavedOverlaySnapshots();
      this.refreshGroupComparableSnapshots();
      this.syncCollapsedGroupState();
      this.showImportDialog = false;
      this.importJsonText = '';
      this.changeDetectorRef.markForCheck();
    }
  }

  private resolvePendingNavigation(allowNavigation: boolean): void {
    this.showUnsavedChangesDialog = false;
    this.isResolvingUnsavedChanges = false;

    const resolve = this.pendingNavigationResolve;
    this.pendingNavigationResolve = null;
    this.pendingNavigationPromise = null;

    resolve?.(allowNavigation);
  }

  private evaluateConditions(conditions: any[], logicMode: string, frameState: any): boolean {
    if (!conditions || conditions.length === 0) {
      return true;
    }

    if (!frameState?.regionStates) {
      return false;
    }

    for (const condition of conditions) {
      const regionState = frameState.regionStates.find(
        (state: any) => state.monitoredRegionId === condition.monitoredRegionId,
      );
      if (!regionState) {
        if (logicMode === 'AND') {
          return false;
        }
        continue;
      }

      const calcResult = regionState.calculationResults.find(
        (result: any) => result.stateCalculationId === condition.stateCalculationId,
      );
      if (!calcResult) {
        if (logicMode === 'AND') {
          return false;
        }
        continue;
      }

      let conditionResult = this.evaluateConditionOperator(condition, calcResult, frameState);
      if (condition.negate) {
        conditionResult = !conditionResult;
      }

      if (logicMode === 'OR' && conditionResult) {
        return true;
      }
      if (logicMode === 'AND' && !conditionResult) {
        return false;
      }
    }

    return logicMode === 'AND';
  }

  private evaluateOverlayVisibility(overlay: any, rulesToProcess?: number): { visible: boolean; opacity: number } {
    let visible = overlay?.defaultVisible !== false;
    let opacity = overlay?.defaultOpacity !== undefined ? overlay.defaultOpacity : 1;

    const rules = rulesToProcess === undefined
      ? (overlay?.rules || [])
      : (overlay?.rules || []).slice(0, rulesToProcess);

    for (const rule of rules) {
      if (!this.evaluateConditions(rule.conditions || [], rule.logicMode || 'AND', this.currentFrameState)) {
        continue;
      }

      if (rule.action === 'show') {
        visible = true;
        opacity = 1;
      } else if (rule.action === 'hide') {
        visible = false;
      } else if (rule.action === 'opacity') {
        visible = true;
        opacity = rule.opacityValue !== undefined ? rule.opacityValue : 1;
      }
    }

    return { visible, opacity };
  }

  private evaluateGroupVisibility(group: any, rulesToProcess?: number): { visible: boolean; opacity: number } {
    const defaultMode = group?.defaultVisibilityMode || 'visible';
    let visible = defaultMode !== 'hidden';
    let opacity = defaultMode === 'opacity'
      ? (group?.defaultOpacity !== undefined ? group.defaultOpacity : 1)
      : 1;

    const rules = rulesToProcess === undefined
      ? (group?.rules || [])
      : (group?.rules || []).slice(0, rulesToProcess);

    for (const rule of rules) {
      if (!this.evaluateConditions(rule.conditions || [], rule.logicMode || 'AND', this.currentFrameState)) {
        continue;
      }

      if (rule.action === 'show') {
        visible = true;
        opacity = 1;
      } else if (rule.action === 'hide') {
        visible = false;
      } else if (rule.action === 'opacity') {
        visible = true;
        opacity = rule.opacityValue !== undefined ? rule.opacityValue : 1;
      }
    }

    return { visible, opacity };
  }

  private formatOverlayVisibilitySummary(evaluatedState: { visible: boolean; opacity: number }): string {
    if (!evaluatedState.visible) {
      return 'Hidden';
    }

    const opacityPercent = Math.round(evaluatedState.opacity * 100);
    return `Showing at ${opacityPercent}% opacity`;
  }

  private formatGroupVisibilitySummary(evaluatedState: { visible: boolean; opacity: number }): string {
    if (!evaluatedState.visible) {
      return 'Hidden';
    }

    const opacityPercent = Math.round(evaluatedState.opacity * 100);
    return `Showing at ${opacityPercent}% opacity`;
  }

  private evaluateConditionOperator(condition: any, calcResult: any, frameState: any): boolean {
    if (condition.operator === 'equals') {
      return calcResult.currentValue === condition.value;
    }

    if (condition.operator === 'notEquals') {
      return calcResult.currentValue !== condition.value;
    }

    const instanceStates = frameState?.regionInstanceStates || [];
    const matchingInstances = instanceStates.filter(
      (instanceState: any) => instanceState.monitoredRegionId === condition.monitoredRegionId,
    );
    if (matchingInstances.length === 0) {
      return false;
    }

    const matchingValues = matchingInstances.map((instanceState: any) =>
      instanceState.calculationResults.find(
        (instanceCalcResult: any) => instanceCalcResult.stateCalculationId === condition.stateCalculationId,
      )?.currentValue,
    );

    if (condition.operator === 'equalsAtLeastOnceAcrossRepeatedRegions') {
      return matchingValues.some((value: string | undefined) => value === condition.value);
    }

    if (condition.operator === 'equalsInEveryRepeatedRegion') {
      return matchingValues.every((value: string | undefined) => value === condition.value);
    }

    if (condition.operator === 'equalsAtLeastNTimesAcrossRepeatedRegions') {
      const minCount = condition.minimumCount ?? 1;
      return matchingValues.filter((value: string | undefined) => value === condition.value).length >= minCount;
    }

    if (condition.operator === 'equalsInEverySelectedRepeatedRegion' || condition.operator === 'equalsAtLeastOnceInSelectedRepeatedRegions') {
      const selectedKeys: string[] = condition.selectedRepeatInstances || [];
      const selectedInstances = matchingInstances.filter(
        (instanceState: any) => selectedKeys.includes(`${instanceState.repeatIndexX}_${instanceState.repeatIndexY}`),
      );
      if (selectedInstances.length === 0) return false;
      const selectedValues = selectedInstances.map((instanceState: any) =>
        instanceState.calculationResults.find(
          (r: any) => r.stateCalculationId === condition.stateCalculationId,
        )?.currentValue,
      );
      if (condition.operator === 'equalsInEverySelectedRepeatedRegion') {
        return selectedValues.every((value: string | undefined) => value === condition.value);
      }
      return selectedValues.some((value: string | undefined) => value === condition.value);
    }

    return true;
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

  private refreshSavedOverlaySnapshots(): void {
    this.savedOverlaySnapshots = new Map(
      this.groups.flatMap((group) =>
        (group.overlays || []).map((overlay: any) => [overlay.id, this.serializeOverlay(overlay)] as [string, string])
      )
    );
  }

  private refreshGroupComparableSnapshots(): void {
    this.groupComparableSnapshots = new Map(
      this.groups.map((group) => [group.id, this.serializeGroupComparable(group)])
    );
  }

  private applyProfileActivationToGroups(): void {
    if (this.profiles.length === 0) {
      return;
    }

    const activeProfileIds = new Set(this.profiles.filter((profile) => profile.active).map((profile) => profile.id));
    for (const group of this.groups) {
      if ((group.profileIds || []).length > 0) {
        group.enabled = (group.profileIds || []).some((profileId: string) => activeProfileIds.has(profileId));
      }
    }
  }

  private normalizeOverlayRuleLogicModes(): void {
    for (const group of this.groups) {
      for (const overlay of group.overlays || []) {
        for (const rule of overlay.rules || []) {
          if (!rule.logicMode) {
            rule.logicMode = 'AND';
          }
        }
      }
    }
  }

  private serializeGroupComparable(group: any): string {
    const clone = JSON.parse(JSON.stringify(group));
    delete clone.lastUpdatedAt;
    return JSON.stringify(clone);
  }

  private serializeOverlay(overlay: any): string {
    return JSON.stringify(overlay);
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

  private normalizeGroupDefaults(): void {
    for (const group of this.groups) {
      if (!Array.isArray(group.profileIds)) {
        group.profileIds = [];
      }
      if (group.scale === undefined) {
        group.scale = 1;
      }
      if (!group.defaultVisibilityMode) {
        group.defaultVisibilityMode = 'visible';
      }
      if (group.defaultOpacity === undefined) {
        group.defaultOpacity = 1;
      }
    }
  }

  private markGroupsChanged(): void {
    this.updateGroupLastUpdatedTimestamps();
    this.hasUnsavedChanges = true;
  }

  private updateGroupLastUpdatedTimestamps(): void {
    const nextComparableSnapshots = new Map<string, string>();
    const now = Date.now();

    for (const group of this.groups) {
      const comparable = this.serializeGroupComparable(group);
      const previousComparable = this.groupComparableSnapshots.get(group.id);
      if (previousComparable === undefined || previousComparable !== comparable) {
        group.lastUpdatedAt = now;
      }
      nextComparableSnapshots.set(group.id, comparable);
    }

    this.groupComparableSnapshots = nextComparableSnapshots;
  }
}
