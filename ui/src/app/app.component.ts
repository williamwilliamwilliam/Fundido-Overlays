import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="app-shell">
      <nav class="sidebar">
        <div class="app-title">Fundido Overlays</div>
        <a routerLink="/capture" routerLinkActive="active" class="nav-link">Capture</a>
        <a routerLink="/regions" routerLinkActive="active" class="nav-link">Monitored Regions</a>
        <a routerLink="/overlays" routerLinkActive="active" class="nav-link">Overlay Groups</a>
        <a routerLink="/debug" routerLinkActive="active" class="nav-link">Debug Console</a>
      </nav>
      <main class="content">
        <router-outlet />
      </main>
    </div>
  `,
  styles: [`
    .app-shell {
      display: flex;
      height: 100vh;
    }

    .sidebar {
      width: 220px;
      min-width: 220px;
      background-color: var(--color-bg-secondary);
      border-right: 1px solid var(--color-border);
      display: flex;
      flex-direction: column;
      padding: var(--spacing-md);
      gap: var(--spacing-xs);
    }

    .app-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--color-accent);
      margin-bottom: var(--spacing-lg);
      padding: var(--spacing-sm) 0;
    }

    .nav-link {
      color: var(--color-text-secondary);
      text-decoration: none;
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
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

    .content {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-lg);
    }
  `],
})
export class AppComponent {}
