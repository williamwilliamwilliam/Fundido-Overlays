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
 * Searchable dropdown for picking a sound file from the indexed sound library.
 *
 * Input is a list of absolute file paths. The dropdown displays the basename
 * of each path for readability while still emitting the full path on selection.
 *
 * Usage:
 *   <app-searchable-sound-select
 *     [soundFilePaths]="soundFileIndex"
 *     [selectedSoundFilePath]="overlay.soundFileOnBecomeVisible"
 *     (soundFileSelected)="overlay.soundFileOnBecomeVisible = $event; onFieldChanged()">
 *   </app-searchable-sound-select>
 */
@Component({
  selector: 'app-searchable-sound-select',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="sound-select-wrapper" [class.is-open]="isDropdownOpen">

      <!-- Trigger button â€” shows the currently selected filename -->
      <div class="sound-select-trigger-row">
        <button
          type="button"
          class="sound-select-trigger"
          (click)="toggleDropdown()"
          [title]="selectedSoundFilePath || 'No sound'">
          <span class="sound-select-label">{{ selectedDisplayName }}</span>
          <span class="sound-select-arrow">{{ isDropdownOpen ? '▼' : '▼' }}</span>
        </button>
        <button
          *ngIf="selectedSoundFilePath"
          type="button"
          class="sound-option-preview-btn selected-sound-preview-btn"
          [class.sound-option-preview-btn-playing]="playingPreviewPath === selectedSoundFilePath"
          [title]="'Preview: ' + getBasename(selectedSoundFilePath)"
          (click)="onPreviewClicked($event, selectedSoundFilePath)">
          &#9654;
        </button>
      </div>

      <!-- Dropdown panel -->
      <div *ngIf="isDropdownOpen" class="sound-select-menu">

        <!-- Search input -->
        <div class="sound-search-row">
          <input
            #searchInput
            type="text"
            class="sound-search-input"
            [(ngModel)]="searchText"
            (ngModelChange)="onSearchTextChanged()"
            placeholder="Search files..."
            autocomplete="off"
            (keydown.escape)="closeDropdown()"
            (keydown.enter)="selectFirstVisibleOption()"
            (keydown.arrowdown)="moveFocus(1)"
            (keydown.arrowup)="moveFocus(-1)" />
        </div>

        <!-- Option list -->
        <div class="sound-options-list" #optionsList>
          <div
            class="sound-option sound-option-empty-choice"
            [class.sound-option-selected]="!selectedSoundFilePath"
            (mousedown)="selectFile('')">
            -- No Sound --
          </div>

          <ng-container *ngIf="filteredPaths.length > 0; else noMatches">
            <div
              *ngFor="let filePath of filteredPaths; let i = index"
              class="sound-option"
              [class.sound-option-selected]="filePath === selectedSoundFilePath"
              [class.sound-option-focused]="i === focusedOptionIndex"
              [title]="filePath"
              (mouseenter)="focusedOptionIndex = i">
              <div class="sound-option-row">
                <div class="sound-option-text" (mousedown)="selectFile(filePath)">
                  <span class="sound-option-name">{{ getBasename(filePath) }}</span>
                  <span class="sound-option-dir">{{ getDirname(filePath) }}</span>
                </div>
                <button
                  type="button"
                  class="sound-option-preview-btn"
                  [class.sound-option-preview-btn-playing]="playingPreviewPath === filePath"
                  [title]="'Preview: ' + getBasename(filePath)"
                  (mousedown)="$event.stopPropagation()"
                  (click)="onPreviewClicked($event, filePath)">
                  &#9654;
                </button>
              </div>
            </div>
          </ng-container>
          <ng-template #noMatches>
            <div class="sound-option sound-option-no-matches">
              {{ soundFilePaths.length === 0 ? 'No sound files indexed yet' : 'No matches for "' + searchText + '"' }}
            </div>
          </ng-template>
        </div>
      </div>

    </div>
  `,
  styles: [`
    .sound-select-wrapper {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      font-size: 0.8rem;
    }

    .sound-select-trigger-row {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
    }

    .sound-select-trigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      flex: 1;
      min-width: 160px;
      max-width: 260px;
      padding: 3px 6px;
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      text-align: left;
      font-size: 0.8rem;
      cursor: pointer;
      color: var(--color-text-primary);
    }

    .sound-select-trigger:hover {
      border-color: var(--color-accent);
    }

    .is-open .sound-select-trigger {
      border-color: var(--color-accent);
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
    }

    .sound-select-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }

    .sound-select-arrow {
      color: var(--color-text-secondary);
      font-size: 0.65rem;
      flex-shrink: 0;
    }

    .sound-select-menu {
      position: absolute;
      top: 100%;
      left: 0;
      z-index: 200;
      width: max(320px, 100%);
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-accent);
      border-top: none;
      border-radius: 0 0 var(--radius-sm) var(--radius-sm);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }

    .sound-search-row {
      padding: 6px 6px 4px;
      border-bottom: 1px solid var(--color-border);
    }

    .sound-search-input {
      width: 100%;
      box-sizing: border-box;
      font-size: 0.8rem;
      padding: 4px 6px;
      background-color: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-primary);
    }

    .sound-search-input:focus {
      outline: none;
      border-color: var(--color-accent);
    }

    .sound-options-list {
      max-height: 220px;
      overflow-y: auto;
      padding: 4px 0;
    }

    .sound-option {
      padding: 5px 10px;
      cursor: pointer;
      font-size: 0.8rem;
      color: var(--color-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .sound-option:hover,
    .sound-option.sound-option-focused {
      background-color: var(--color-bg-panel);
      color: var(--color-text-primary);
    }

    .sound-option.sound-option-selected {
      color: var(--color-accent);
      font-weight: 600;
    }

    .sound-option-empty-choice {
      color: var(--color-text-secondary);
      font-style: italic;
      border-bottom: 1px solid var(--color-border);
      margin-bottom: 2px;
    }

    .sound-option-no-matches {
      color: var(--color-text-secondary);
      font-style: italic;
      cursor: default;
    }

    .sound-option-name {
      font-size: 0.8rem;
      color: inherit;
    }

    .sound-option-row {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
    }

    .sound-option-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
      cursor: pointer;
    }

    .sound-option-dir {
      font-size: 0.7rem;
      color: var(--color-text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sound-option-preview-btn {
      flex-shrink: 0;
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-secondary);
      font-size: 0.65rem;
      width: 22px;
      height: 22px;
      padding: 0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .sound-option-preview-btn:hover {
      border-color: var(--color-accent);
      color: var(--color-accent);
    }

    .sound-option-preview-btn.sound-option-preview-btn-playing {
      border-color: var(--color-accent);
      color: var(--color-accent);
      background-color: var(--color-bg-panel);
    }

    .selected-sound-preview-btn {
      align-self: stretch;
    }
  `],
})
export class SearchableSoundSelectComponent implements OnChanges {
  /** Full list of absolute sound file paths to display. */
  @Input() soundFilePaths: string[] = [];

  /** The currently selected absolute file path. */
  @Input() selectedSoundFilePath: string = '';

  /** Emits the selected absolute file path when the user picks an option. Empty string = no sound. */
  @Output() soundFileSelected = new EventEmitter<string>();

  /** Emits a file path when the user clicks the preview button next to an option. */
  @Output() soundPreviewRequested = new EventEmitter<string>();

  /** Global sound volume (0.0â€“1.0) passed down from the parent for preview playback. */
  @Input() soundVolume: number = 0.5;

  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;

  isDropdownOpen = false;
  searchText = '';
  filteredPaths: string[] = [];
  focusedOptionIndex = -1;
  playingPreviewPath = '';

  constructor(
    private readonly elementRef: ElementRef,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['soundFilePaths']) {
      this.filteredPaths = this.soundFilePaths.slice();
    }
  }

  get selectedDisplayName(): string {
    if (!this.selectedSoundFilePath) return 'No Sound';
    return this.getBasename(this.selectedSoundFilePath);
  }

  getBasename(filePath: string): string {
    // Works for both Windows (backslash) and Unix (forward slash) paths
    const lastSeparatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return lastSeparatorIndex >= 0 ? filePath.substring(lastSeparatorIndex + 1) : filePath;
  }

  getDirname(filePath: string): string {
    const lastSeparatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return lastSeparatorIndex >= 0 ? filePath.substring(0, lastSeparatorIndex) : '';
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
    this.filteredPaths = this.soundFilePaths.slice();
    this.focusedOptionIndex = -1;
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
      this.filteredPaths = this.soundFilePaths.slice();
    } else {
      this.filteredPaths = this.soundFilePaths.filter((filePath) =>
        this.getBasename(filePath).toLowerCase().includes(query)
      );
    }
    this.focusedOptionIndex = -1;
    this.cdr.markForCheck();
  }

  selectFile(filePath: string): void {
    this.soundFileSelected.emit(filePath);
    this.closeDropdown();
  }

  onPreviewClicked(event: MouseEvent, filePath: string): void {
    event.stopPropagation();
    this.playingPreviewPath = filePath;
    this.soundPreviewRequested.emit(filePath);
    // Clear the playing indicator after a short period (sound length is unknown)
    setTimeout(() => {
      if (this.playingPreviewPath === filePath) {
        this.playingPreviewPath = '';
        this.cdr.markForCheck();
      }
    }, 3000);
    this.cdr.markForCheck();
  }

  selectFirstVisibleOption(): void {
    if (this.focusedOptionIndex >= 0 && this.focusedOptionIndex < this.filteredPaths.length) {
      this.selectFile(this.filteredPaths[this.focusedOptionIndex]);
    } else if (this.filteredPaths.length > 0) {
      this.selectFile(this.filteredPaths[0]);
    }
  }

  moveFocus(direction: 1 | -1): void {
    const maxIndex = this.filteredPaths.length - 1;
    if (maxIndex < 0) return;
    this.focusedOptionIndex = Math.max(0, Math.min(maxIndex, this.focusedOptionIndex + direction));
    this.cdr.markForCheck();
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    const clickedInsideThisComponent = this.elementRef.nativeElement.contains(event.target as Node);
    if (!clickedInsideThisComponent && this.isDropdownOpen) {
      this.closeDropdown();
    }
  }
}

