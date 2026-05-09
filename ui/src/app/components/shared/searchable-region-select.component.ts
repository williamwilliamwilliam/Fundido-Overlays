import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

/**
 * Searchable dropdown for picking a monitored region.
 *
 * Replaces bare `<select>` elements that can grow very long. When the user
 * clicks the trigger the list opens and a text input auto-focuses so the
 * user can immediately type a partial name to filter down the options.
 *
 * Usage:
 *   <app-searchable-region-select
 *     [regions]="monitoredRegions"
 *     [selectedRegionId]="cond.monitoredRegionId"
 *     (regionSelected)="cond.monitoredRegionId = $event; onRegionSelectedForCondition(cond)">
 *   </app-searchable-region-select>
 */
@Component({
  selector: 'app-searchable-region-select',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="region-select-wrapper" [class.is-open]="isDropdownOpen">

      <!-- Trigger button — shows the currently selected region name -->
      <button
        type="button"
        class="region-select-trigger"
        (click)="toggleDropdown()"
        [title]="selectedRegionName">
        <span class="region-select-label">{{ selectedRegionName }}</span>
        <span class="region-select-arrow">{{ isDropdownOpen ? '▲' : '▼' }}</span>
      </button>

      <!-- Dropdown panel -->
      <div *ngIf="isDropdownOpen" class="region-select-menu">

        <!-- Search input — auto-focused when the dropdown opens -->
        <div class="region-search-row">
          <input
            #searchInput
            type="text"
            class="region-search-input"
            [(ngModel)]="searchText"
            (ngModelChange)="onSearchTextChanged()"
            placeholder="Search regions…"
            autocomplete="off"
            (keydown.escape)="closeDropdown()"
            (keydown.enter)="selectFirstVisibleOption()"
            (keydown.arrowdown)="moveFocus(1)"
            (keydown.arrowup)="moveFocus(-1)" />
        </div>

        <!-- Option list -->
        <div class="region-options-list" #optionsList>
          <div
            class="region-option region-option-empty-choice"
            [class.region-option-selected]="!selectedRegionId"
            (mousedown)="selectRegion('')">
            — Select Region —
          </div>

          <ng-container *ngIf="filteredRegions.length > 0; else noMatches">
            <div
              *ngFor="let region of filteredRegions; let i = index"
              class="region-option"
              [class.region-option-selected]="region.id === selectedRegionId"
              [class.region-option-focused]="i === focusedOptionIndex"
              (mousedown)="selectRegion(region.id)"
              (mouseenter)="focusedOptionIndex = i">
              <span class="region-option-name">{{ region.name }}</span>
            </div>
          </ng-container>
          <ng-template #noMatches>
            <div class="region-option region-option-no-matches">No matches for "{{ searchText }}"</div>
          </ng-template>
        </div>
      </div>

    </div>
  `,
  styles: [`
    .region-select-wrapper {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      font-size: 0.8rem;
    }

    /* Trigger button — sized to match the native <select> in condition rows */
    .region-select-trigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      min-width: 120px;
      max-width: 150px;
      padding: 3px 6px;
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      text-align: left;
      font-size: 0.8rem;
      cursor: pointer;
      color: var(--color-text-primary);
    }

    .region-select-trigger:hover {
      border-color: var(--color-accent);
    }

    .is-open .region-select-trigger {
      border-color: var(--color-accent);
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
    }

    .region-select-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }

    .region-select-arrow {
      color: var(--color-text-secondary);
      font-size: 0.65rem;
      flex-shrink: 0;
    }

    /* Dropdown panel */
    .region-select-menu {
      position: absolute;
      top: 100%;
      left: 0;
      z-index: 200;
      width: max(220px, 100%);
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-accent);
      border-top: none;
      border-radius: 0 0 var(--radius-sm) var(--radius-sm);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }

    /* Search input row */
    .region-search-row {
      padding: 6px 6px 4px;
      border-bottom: 1px solid var(--color-border);
    }

    .region-search-input {
      width: 100%;
      box-sizing: border-box;
      font-size: 0.8rem;
      padding: 4px 6px;
      background-color: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-primary);
    }

    .region-search-input:focus {
      outline: none;
      border-color: var(--color-accent);
    }

    /* Options list */
    .region-options-list {
      max-height: 220px;
      overflow-y: auto;
      padding: 4px 0;
    }

    .region-option {
      padding: 5px 10px;
      cursor: pointer;
      font-size: 0.8rem;
      color: var(--color-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .region-option:hover,
    .region-option.region-option-focused {
      background-color: var(--color-bg-panel);
      color: var(--color-text-primary);
    }

    .region-option.region-option-selected {
      color: var(--color-accent);
      font-weight: 600;
    }

    .region-option-empty-choice {
      color: var(--color-text-secondary);
      font-style: italic;
      border-bottom: 1px solid var(--color-border);
      margin-bottom: 2px;
    }

    .region-option-no-matches {
      color: var(--color-text-secondary);
      font-style: italic;
      cursor: default;
    }
  `],
})
export class SearchableRegionSelectComponent implements OnChanges {
  /** Full list of monitored regions to display and filter. */
  @Input() regions: any[] = [];

  /** The currently selected region ID (drives the trigger label). */
  @Input() selectedRegionId: string = '';

  /**
   * Emits the new region ID whenever the user picks an option.
   * Wire both the property update and any side-effect calls here:
   *   (regionSelected)="cond.monitoredRegionId = $event; onRegionSelectedForCondition(cond)"
   */
  @Output() regionSelected = new EventEmitter<string>();

  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;

  isDropdownOpen = false;
  searchText = '';
  filteredRegions: any[] = [];
  focusedOptionIndex = -1;

  constructor(
    private readonly elementRef: ElementRef,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['regions']) {
      this.filteredRegions = this.regions.slice();
    }
  }

  get selectedRegionName(): string {
    if (!this.selectedRegionId) return 'Select Region';
    const found = this.regions.find((r: any) => r.id === this.selectedRegionId);
    return found ? found.name : 'Select Region';
  }

  toggleDropdown(): void {
    if (this.isDropdownOpen) {
      this.closeDropdown();
    } else {
      this.openDropdown();
    }
  }

  openDropdown(): void {
    this.isDropdownOpen = true;
    this.searchText = '';
    this.filteredRegions = this.regions.slice();
    this.focusedOptionIndex = -1;
    // Focus the search input after Angular renders the dropdown panel
    setTimeout(() => {
      this.searchInputRef?.nativeElement.focus();
    }, 0);
    this.cdr.markForCheck();
  }

  closeDropdown(): void {
    this.isDropdownOpen = false;
    this.searchText = '';
    this.focusedOptionIndex = -1;
    this.cdr.markForCheck();
  }

  onSearchTextChanged(): void {
    const query = this.searchText.trim().toLowerCase();
    if (!query) {
      this.filteredRegions = this.regions.slice();
    } else {
      this.filteredRegions = this.regions.filter((r: any) =>
        (r.name as string).toLowerCase().includes(query)
      );
    }
    this.focusedOptionIndex = -1;
    this.cdr.markForCheck();
  }

  selectRegion(regionId: string): void {
    this.regionSelected.emit(regionId);
    this.closeDropdown();
  }

  selectFirstVisibleOption(): void {
    if (this.focusedOptionIndex >= 0 && this.focusedOptionIndex < this.filteredRegions.length) {
      this.selectRegion(this.filteredRegions[this.focusedOptionIndex].id);
    } else if (this.filteredRegions.length > 0) {
      this.selectRegion(this.filteredRegions[0].id);
    }
  }

  moveFocus(direction: 1 | -1): void {
    const maxIndex = this.filteredRegions.length - 1;
    if (maxIndex < 0) return;
    this.focusedOptionIndex = Math.max(0, Math.min(maxIndex, this.focusedOptionIndex + direction));
    this.cdr.markForCheck();
  }

  /**
   * Close the dropdown when the user clicks anywhere outside this component.
   * Uses document mousedown so the close fires before focus moves elsewhere.
   */
  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    const clickedInsideThisComponent = this.elementRef.nativeElement.contains(event.target as Node);
    if (!clickedInsideThisComponent && this.isDropdownOpen) {
      this.closeDropdown();
    }
  }
}
