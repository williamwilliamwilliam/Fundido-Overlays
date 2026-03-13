import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
          <input [(ngModel)]="group.name" placeholder="Group name" class="name-input" />
          <button class="danger-text" (click)="removeGroup(groupIndex)">Remove</button>
        </div>

        <div class="group-settings">
          <label>
            Position Mode
            <select [(ngModel)]="group.position.mode">
              <option value="absolute">Absolute</option>
              <option value="relativeToCursor">Relative to Cursor</option>
            </select>
          </label>
          <label>
            Grow Direction
            <select [(ngModel)]="group.growDirection">
              <option value="right">Right</option>
              <option value="left">Left</option>
              <option value="down">Down</option>
              <option value="up">Up</option>
            </select>
          </label>
          <label>
            Alignment
            <select [(ngModel)]="group.alignment">
              <option value="start">Start</option>
              <option value="center">Center</option>
              <option value="end">End</option>
            </select>
          </label>
        </div>

        <p class="section-label">Overlays</p>
        <div *ngFor="let overlay of group.overlays; let overlayIndex = index" class="overlay-card">
          <input [(ngModel)]="overlay.name" placeholder="Overlay name" class="name-input" />
          <select [(ngModel)]="overlay.contentType">
            <option value="icon">Icon</option>
            <option value="text">Text</option>
            <option value="regionMirror">Region Mirror</option>
          </select>
        </div>
        <button class="add-overlay-btn" (click)="addOverlay(group)">+ Add Overlay</button>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 900px; }
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

    .group-card {
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .group-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-md);
    }

    .name-input {
      font-size: 1rem;
      font-weight: 500;
      background: transparent;
      border: 1px solid transparent;
      padding: var(--spacing-xs);
    }

    .name-input:focus { border-color: var(--color-accent); }

    .group-settings {
      display: flex;
      gap: var(--spacing-lg);
      margin-bottom: var(--spacing-md);
    }

    .group-settings label {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      color: var(--color-text-secondary);
      font-size: 0.85rem;
    }

    .section-label {
      font-size: 0.85rem;
      color: var(--color-text-secondary);
      margin-bottom: var(--spacing-sm);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .overlay-card {
      background-color: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .add-overlay-btn {
      font-size: 0.85rem;
      background: transparent;
      border: 1px dashed var(--color-border);
      width: 100%;
      padding: var(--spacing-sm);
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
export class OverlayGroupsComponent implements OnInit {
  groups: any[] = [];
  showImportDialog = false;
  importJsonText = '';

  constructor(private readonly electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electronService.loadConfig();
    this.groups = config.overlayGroups || [];
  }

  addGroup(): void {
    const newGroup = {
      id: crypto.randomUUID(),
      name: 'New Group',
      position: { mode: 'absolute', x: 100, y: 100 },
      growDirection: 'right',
      alignment: 'start',
      overlays: [],
    };
    this.groups.push(newGroup);
  }

  removeGroup(index: number): void {
    this.groups.splice(index, 1);
  }

  addOverlay(group: any): void {
    const newOverlay = {
      id: crypto.randomUUID(),
      name: 'New Overlay',
      contentType: 'text',
      content: '',
      visibilityConditions: [],
    };
    group.overlays.push(newOverlay);
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
      this.showImportDialog = false;
      this.importJsonText = '';
    }
  }
}
