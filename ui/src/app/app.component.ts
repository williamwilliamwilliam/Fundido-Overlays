import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { Subscription } from 'rxjs';
import { DebugConsoleComponent } from './components/debug-console/debug-console.component';
import { ElectronService } from './services/electron.service';
import { PendingChangesService } from './services/pending-changes.service';
import * as packageJson from '../../../package.json';

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
        <div class="app-brand">
          <img class="app-logo" src="assets/app-icon.png" alt="Fundido Overlays logo" />
          <span class="app-title">Fundido Overlays ({{ appVersion }})</span>
        </div>
        <button
          class="global-toggle"
          [class.enabled]="globalEnabled"
          (click)="toggleGlobal()">
          {{ globalEnabled ? 'ON' : 'OFF' }}
        </button>
        <div class="nav-links">
          <a routerLink="/profiles" routerLinkActive="active" class="nav-link">
            <span class="nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.87 0-7 2.24-7 5v1h14v-1c0-2.76-3.13-5-7-5Z"/>
              </svg>
            </span>
            <span>Profiles</span>
            <span *ngIf="activeProfileNames.length > 0" class="active-profile-list">
              ({{ activeProfileNames.join(', ') }})
            </span>
          </a>
          <a routerLink="/capture" routerLinkActive="active" class="nav-link">
            <span class="nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6l1.5 2h2.5v1H6v-1h2.5L10 18H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 2v9h16V7Z"/>
              </svg>
            </span>
            <span>Capture</span>
          </a>
          <a routerLink="/regions" routerLinkActive="active" class="nav-link">
            <span class="nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M12 7c4.63 0 8.43 2.96 9.73 5-1.3 2.04-5.1 5-9.73 5S3.57 14.04 2.27 12C3.57 9.96 7.37 7 12 7Zm0 2c-3.22 0-6.01 1.77-7.41 3 1.4 1.23 4.19 3 7.41 3s6.01-1.77 7.41-3c-1.4-1.23-4.19-3-7.41-3Zm0 1.5A2.5 2.5 0 1 1 9.5 13 2.5 2.5 0 0 1 12 10.5Z"/>
              </svg>
            </span>
            <span>Monitored Regions</span>
          </a>
          <a routerLink="/overlays" routerLinkActive="active" class="nav-link">
            <span class="nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M4 4h7v7H4Zm2 2v3h3V6Zm7-2h7v7h-7Zm2 2v3h3V6ZM4 13h7v7H4Zm2 2v3h3v-3Zm7-2h7v7h-7Zm2 2v3h3v-3Z"/>
              </svg>
            </span>
            <span>Overlay Groups</span>
          </a>
          <a routerLink="/settings" routerLinkActive="active" class="nav-link">
            <span class="nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="m19.14 12.94.04-.94-.04-.94 2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.4 7.4 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54a7.4 7.4 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.48a.5.5 0 0 0 .12.64l2.03 1.58-.04.94.04.94-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.69 1.63.94l.36 2.54a.5.5 0 0 0 .49.42h3.8a.5.5 0 0 0 .49-.42l.36-2.54c.58-.25 1.13-.56 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64ZM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"/>
              </svg>
            </span>
            <span>Settings</span>
          </a>
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

    .app-brand {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-right: var(--spacing-sm);
    }

    .app-logo {
      width: 24px;
      height: 24px;
      object-fit: contain;
      flex: 0 0 auto;
    }

    .app-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--color-accent);
      white-space: nowrap;
    }

    .global-toggle {
      padding: 4px 16px;
      border-radius: var(--radius-sm);
      font-weight: 700;
      font-size: 0.85rem;
      border: 2px solid;
      cursor: pointer;
      transition: all 0.15s ease;
      min-width: 54px;
      text-align: center;
      letter-spacing: 0.5px;
      margin-right: var(--spacing-md);
    }
    .global-toggle.enabled {
      background-color: var(--color-toggle-on);
      border-color: var(--color-toggle-on);
      color: var(--color-toggle-on-text);
    }
    .global-toggle:not(.enabled) {
      background-color: var(--color-toggle-off);
      border-color: var(--color-toggle-off);
      color: var(--color-toggle-off-text);
    }
    .global-toggle:hover {
      opacity: 0.85;
    }

    .nav-links {
      display: flex;
      gap: var(--spacing-xs);
    }

    .nav-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
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

    .nav-icon {
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .nav-icon svg {
      width: 16px;
      height: 16px;
      display: block;
      fill: currentColor;
    }

    .active-profile-list {
      color: var(--color-success);
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
export class AppComponent implements OnInit, OnDestroy {
  readonly appVersion = packageJson.version;
  globalEnabled = true;
  isDebugMinimized = true;
  activeProfileNames: string[] = [];

  private expandedPanelHeightPx = DEFAULT_PANEL_HEIGHT_PX;
  private appCloseRequestSubscription: Subscription | null = null;
  private stateSubscription: Subscription | null = null;
  private profileNameById = new Map<string, string>();
  private activeProfileIdsSignature = '';
  private profileCacheRefreshPromise: Promise<void> | null = null;

  private static readonly STORAGE_KEY_DEBUG_MINIMIZED = 'fundido:debugMinimized';
  private static readonly STORAGE_KEY_DEBUG_HEIGHT = 'fundido:debugHeight';

  constructor(
    private readonly electronService: ElectronService,
    private readonly pendingChangesService: PendingChangesService,
  ) {
    this.loadDebugPanelState();
  }

  async ngOnInit(): Promise<void> {
    this.globalEnabled = await this.electronService.globalStatus();
    await this.refreshActiveProfileNames();
    this.appCloseRequestSubscription = this.electronService.appCloseRequestedStream.subscribe(async () => {
      const allowClose = await this.pendingChangesService.confirmClose();
      this.electronService.respondToAppCloseRequest(allowClose);
    });
    this.stateSubscription = this.electronService.stateUpdateStream.subscribe((frameState: any) => {
      if (Array.isArray(frameState?.profileStates)) {
        this.refreshActiveProfileNamesFromProfileStates(frameState.profileStates);
      }
    });
  }

  ngOnDestroy(): void {
    this.appCloseRequestSubscription?.unsubscribe();
    this.stateSubscription?.unsubscribe();
  }

  async toggleGlobal(): Promise<void> {
    this.globalEnabled = !this.globalEnabled;
    if (this.globalEnabled) {
      await this.electronService.globalEnable();
    } else {
      await this.electronService.globalDisable();
    }
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

  private async refreshActiveProfileNames(): Promise<void> {
    const config = await this.electronService.loadConfig();
    this.profileNameById = new Map(
      (config.profiles || [])
        .filter((profile: any) => profile.id && profile.name)
        .map((profile: any) => [profile.id, profile.name])
    );
    this.activeProfileNames = (config.profiles || [])
      .filter((profile: any) => profile.active)
      .map((profile: any) => profile.name)
      .filter((name: string) => !!name);
    this.activeProfileIdsSignature = this.buildActiveProfileIdsSignature(
      (config.profiles || [])
        .filter((profile: any) => profile.active)
        .map((profile: any) => profile.id)
    );
  }

  private refreshActiveProfileNamesFromProfileStates(profileStates: any[]): void {
    const activeProfileIds = profileStates
      .filter((profileState: any) => profileState.active)
      .map((profileState: any) => profileState.id);
    const nextSignature = this.buildActiveProfileIdsSignature(activeProfileIds);
    if (nextSignature === this.activeProfileIdsSignature) {
      return;
    }

    this.activeProfileIdsSignature = nextSignature;
    const hasUnknownProfileId = activeProfileIds.some((profileId: string) => !this.profileNameById.has(profileId));
    if (hasUnknownProfileId) {
      this.refreshProfileNameCache();
    }

    const activeProfileIdSet = new Set(activeProfileIds);
    this.activeProfileNames = Array.from(activeProfileIdSet)
      .map((profileId) => this.profileNameById.get(profileId))
      .filter((name): name is string => !!name);
  }

  private refreshProfileNameCache(): void {
    if (this.profileCacheRefreshPromise) {
      return;
    }

    this.profileCacheRefreshPromise = this.refreshActiveProfileNames()
      .finally(() => {
        this.profileCacheRefreshPromise = null;
      });
  }

  private buildActiveProfileIdsSignature(profileIds: string[]): string {
    return Array.from(new Set(
      profileIds
        .filter((profileId) => !!profileId)
    )).sort().join('|');
  }
}
