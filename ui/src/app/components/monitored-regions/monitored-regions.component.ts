import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron.service';

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
        <div class="region-bounds">
          <label>X <input type="number" [(ngModel)]="region.bounds.x" /></label>
          <label>Y <input type="number" [(ngModel)]="region.bounds.y" /></label>
          <label>W <input type="number" [(ngModel)]="region.bounds.width" /></label>
          <label>H <input type="number" [(ngModel)]="region.bounds.height" /></label>
        </div>
        <p class="section-label">State Calculations</p>
        <div *ngFor="let calc of region.stateCalculations; let calcIndex = index" class="calc-card">
          <input [(ngModel)]="calc.name" placeholder="Calculation name" class="name-input" />
          <span class="calc-type">{{ calc.type }}</span>
          <!-- Color-state mappings would be edited here -->
        </div>
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

    .region-bounds {
      display: flex;
      gap: var(--spacing-md);
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
export class MonitoredRegionsComponent implements OnInit {
  regions: any[] = [];
  showImportDialog = false;
  importJsonText = '';

  constructor(private readonly electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electronService.loadConfig();
    this.regions = config.monitoredRegions || [];
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

  async exportRegions(): Promise<void> {
    const json = await this.electronService.exportRegions();
    await navigator.clipboard.writeText(json);
    // TODO: Show a toast notification
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
}
