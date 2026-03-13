import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import type { LogEntry } from '../../models/electron-api';

const ALL_LOG_CATEGORIES = [
    'Capture',
    'StateCalculation',
    'Overlay',
    'Persistence',
    'Ipc',
    'General',
];

@Component({
    selector: 'app-debug-console',
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
        <div class="console-panel">
            <div class="filter-bar">
                <span class="filter-label">Filter:</span>
                <label *ngFor="let category of allCategories" class="filter-checkbox">
                    <input
                            type="checkbox"
                            [checked]="enabledCategories.has(category)"
                            (change)="toggleCategory(category)" />
                    {{ category }}
                </label>
                <button class="clear-btn" (click)="clearLog()">Clear</button>
            </div>

            <div class="log-output">
                <div
                        *ngFor="let entry of filteredEntries"
                        class="log-entry"
                        [ngClass]="'level-' + entry.level">
                    <span class="log-time">{{ formatTimestamp(entry.timestamp) }}</span>
                    <span class="log-level">{{ entry.level.toUpperCase() }}</span>
                    <span class="log-category">{{ entry.category }}</span>
                    <span class="log-message">{{ entry.message }}</span>
                </div>
                <div *ngIf="filteredEntries.length === 0" class="empty-log">
                    No log entries to display.
                </div>
            </div>
        </div>
    `,
    styles: [`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            overflow: hidden;
        }

        .console-panel {
            display: flex;
            flex-direction: column;
            height: 100%;
            overflow: hidden;
        }

        .filter-bar {
            display: flex;
            align-items: center;
            gap: var(--spacing-md);
            flex-wrap: wrap;
            padding: var(--spacing-xs) var(--spacing-md);
            background-color: var(--color-bg-secondary);
            border-bottom: 1px solid var(--color-border);
            flex-shrink: 0;
        }

        .filter-label {
            font-size: 0.8rem;
            color: var(--color-text-secondary);
        }

        .filter-checkbox {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 0.8rem;
            cursor: pointer;
        }

        .clear-btn {
            margin-left: auto;
            font-size: 0.75rem;
            padding: 2px 8px;
        }

        .log-output {
            flex: 1;
            overflow-y: auto;
            background-color: #0d0d1a;
            padding: var(--spacing-xs) var(--spacing-sm);
            font-family: var(--font-mono);
            font-size: 0.75rem;
            line-height: 1.6;
        }

        .log-entry {
            display: flex;
            gap: var(--spacing-sm);
            padding: 1px 0;
        }

        .log-time { color: #666; min-width: 75px; }
        .log-level { min-width: 45px; font-weight: 600; }
        .log-category { color: var(--color-accent); min-width: 120px; }
        .log-message { color: var(--color-text-primary); }

        .level-debug .log-level { color: #888; }
        .level-info .log-level { color: #4caf50; }
        .level-warn .log-level { color: #ff9800; }
        .level-error .log-level { color: #f44336; }

        .empty-log {
            color: var(--color-text-secondary);
            font-style: italic;
            text-align: center;
            padding: var(--spacing-md);
        }
    `],
})
export class DebugConsoleComponent implements OnInit, OnDestroy {
    readonly allCategories = ALL_LOG_CATEGORIES;
    enabledCategories = new Set<string>(ALL_LOG_CATEGORIES);

    private allEntries: LogEntry[] = [];
    filteredEntries: LogEntry[] = [];

    private logSubscription: Subscription | null = null;
    private static readonly MAX_LOG_ENTRIES = 2000;

    constructor(private readonly electronService: ElectronService) {}

    ngOnInit(): void {
        this.logSubscription = this.electronService.debugLogStream.subscribe((entry) => {
            this.allEntries.push(entry);

            const isOverMaxEntries = this.allEntries.length > DebugConsoleComponent.MAX_LOG_ENTRIES;
            if (isOverMaxEntries) {
                this.allEntries.shift();
            }

            this.refreshFilteredEntries();
        });
    }

    ngOnDestroy(): void {
        this.logSubscription?.unsubscribe();
    }

    toggleCategory(category: string): void {
        const isCurrentlyEnabled = this.enabledCategories.has(category);
        if (isCurrentlyEnabled) {
            this.enabledCategories.delete(category);
        } else {
            this.enabledCategories.add(category);
        }
        this.refreshFilteredEntries();
    }

    clearLog(): void {
        this.allEntries = [];
        this.filteredEntries = [];
    }

    formatTimestamp(timestamp: number): string {
        const date = new Date(timestamp);
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const seconds = date.getSeconds().toString().padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    private refreshFilteredEntries(): void {
        this.filteredEntries = this.allEntries.filter((entry) =>
            this.enabledCategories.has(entry.category)
        );
    }
}