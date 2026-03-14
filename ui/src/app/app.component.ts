import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { DebugConsoleComponent } from './components/debug-console/debug-console.component';

const MINIMIZED_PANEL_HEIGHT_PX = 36;
const DEFAULT_PANEL_HEIGHT_PX = 250;
const MIN_EXPANDED_PANEL_HEIGHT_PX = 100;
const MAX_PANEL_HEIGHT_FRACTION = 0.7;

@Component({
    selector: 'app-root',
    standalone: true,
    imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, DebugConsoleComponent],
    template: `
        <div class="app-shell">
            <nav class="top-nav">
                <span class="app-title">Fundido Overlays</span>
                <div class="nav-links">
                    <a routerLink="/capture" routerLinkActive="active" class="nav-link">Capture</a>
                    <a routerLink="/regions" routerLinkActive="active" class="nav-link">Monitored Regions</a>
                    <a routerLink="/overlays" routerLinkActive="active" class="nav-link">Overlay Groups</a>
                    <a routerLink="/settings" routerLinkActive="active" class="nav-link">Settings</a>
                </div>
            </nav>

            <div class="main-area">
                <main class="content" [style.bottom.px]="currentPanelHeightPx">
                    <router-outlet />
                </main>

                <div
                        class="debug-panel"
                        [style.height.px]="currentPanelHeightPx">

                    <div
                            class="resize-handle"
                            [class.minimized]="isDebugMinimized"
                            (mousedown)="onResizeHandleMouseDown($event)">
                        <div class="resize-grip"></div>
                        <span class="panel-label">Debug Console</span>
                        <button class="minimize-btn" (click)="toggleMinimize($event)">
                            {{ isDebugMinimized ? '▲' : '▼' }}
                        </button>
                    </div>

                    <div class="debug-content" *ngIf="!isDebugMinimized">
                        <app-debug-console />
                    </div>
                </div>
            </div>
        </div>
    `,
    styles: [`
        .app-shell {
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        .top-nav {
            display: flex;
            align-items: center;
            gap: var(--spacing-lg);
            padding: 0 var(--spacing-lg);
            height: 44px;
            min-height: 44px;
            background-color: var(--color-bg-secondary);
            border-bottom: 1px solid var(--color-border);
        }

        .app-title {
            font-size: 1rem;
            font-weight: 600;
            color: var(--color-accent);
            margin-right: var(--spacing-md);
        }

        .nav-links {
            display: flex;
            gap: var(--spacing-xs);
        }

        .nav-link {
            color: var(--color-text-secondary);
            text-decoration: none;
            padding: var(--spacing-xs) var(--spacing-md);
            border-radius: var(--radius-sm);
            font-size: 0.9rem;
            transition: background-color 0.15s ease, color 0.15s ease;
        }

        .nav-link:hover {
            background-color: var(--color-bg-panel);
            color: var(--color-text-primary);
        }

        .nav-link.active {
            background-color: var(--color-bg-panel);
            color: var(--color-accent);
            font-weight: 500;
        }

        .main-area {
            flex: 1;
            position: relative;
            overflow: hidden;
        }

        .content {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            overflow-y: auto;
            padding: var(--spacing-lg);
        }

        .debug-panel {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            display: flex;
            flex-direction: column;
            background-color: var(--color-bg-secondary);
            border-top: 1px solid var(--color-border);
            z-index: 10;
        }

        .resize-handle {
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
            padding: 0 var(--spacing-md);
            height: 36px;
            min-height: 36px;
            cursor: ns-resize;
            user-select: none;
            background-color: var(--color-bg-secondary);
            border-bottom: 1px solid var(--color-border);
        }

        .resize-handle.minimized {
            border-bottom: none;
            cursor: default;
        }

        .resize-grip {
            width: 32px;
            height: 4px;
            border-top: 2px solid var(--color-text-secondary);
            border-bottom: 2px solid var(--color-text-secondary);
            opacity: 0.4;
        }

        .resize-handle:hover .resize-grip {
            opacity: 0.8;
        }

        .panel-label {
            font-size: 0.8rem;
            color: var(--color-text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            flex: 1;
        }

        .minimize-btn {
            background: transparent;
            border: none;
            color: var(--color-text-secondary);
            font-size: 0.75rem;
            padding: 2px 6px;
            line-height: 1;
        }

        .minimize-btn:hover {
            color: var(--color-text-primary);
            background: transparent;
        }

        .debug-content {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
    `],
})
export class AppComponent {
    isDebugMinimized = false;

    private expandedPanelHeightPx = DEFAULT_PANEL_HEIGHT_PX;

    private static readonly STORAGE_KEY_DEBUG_MINIMIZED = 'fundido:debugMinimized';
    private static readonly STORAGE_KEY_DEBUG_HEIGHT = 'fundido:debugHeight';

    constructor() {
        this.loadDebugPanelState();
    }

    get currentPanelHeightPx(): number {
        if (this.isDebugMinimized) {
            return MINIMIZED_PANEL_HEIGHT_PX;
        }
        return this.expandedPanelHeightPx;
    }

    toggleMinimize(event: Event): void {
        event.stopPropagation();
        this.isDebugMinimized = !this.isDebugMinimized;
        this.saveDebugPanelState();
    }

    onResizeHandleMouseDown(mouseDownEvent: MouseEvent): void {
        if (this.isDebugMinimized) {
            return;
        }

        mouseDownEvent.preventDefault();

        const startingMouseY = mouseDownEvent.clientY;
        const startingPanelHeight = this.expandedPanelHeightPx;
        const maxPanelHeightPx = window.innerHeight * MAX_PANEL_HEIGHT_FRACTION;

        const onMouseMove = (mouseMoveEvent: MouseEvent) => {
            const deltaY = startingMouseY - mouseMoveEvent.clientY;
            const newHeight = startingPanelHeight + deltaY;

            const clampedHeight = Math.max(
                MIN_EXPANDED_PANEL_HEIGHT_PX,
                Math.min(newHeight, maxPanelHeightPx)
            );

            this.expandedPanelHeightPx = clampedHeight;
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            this.saveDebugPanelState();
        };

        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    private loadDebugPanelState(): void {
        try {
            const savedMinimized = localStorage.getItem(AppComponent.STORAGE_KEY_DEBUG_MINIMIZED);
            if (savedMinimized !== null) {
                this.isDebugMinimized = savedMinimized === 'true';
            }

            const savedHeight = localStorage.getItem(AppComponent.STORAGE_KEY_DEBUG_HEIGHT);
            if (savedHeight !== null) {
                const parsedHeight = parseInt(savedHeight, 10);
                const isValidHeight = !isNaN(parsedHeight) && parsedHeight >= MIN_EXPANDED_PANEL_HEIGHT_PX;
                if (isValidHeight) {
                    this.expandedPanelHeightPx = parsedHeight;
                }
            }
        } catch {
            // localStorage may not be available in all contexts
        }
    }

    private saveDebugPanelState(): void {
        try {
            localStorage.setItem(AppComponent.STORAGE_KEY_DEBUG_MINIMIZED, String(this.isDebugMinimized));
            localStorage.setItem(AppComponent.STORAGE_KEY_DEBUG_HEIGHT, String(this.expandedPanelHeightPx));
        } catch {
            // ignore
        }
    }
}