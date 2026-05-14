import { Injectable } from '@angular/core';

/**
 * Preserves the scroll position of the main content area for each route so
 * that navigating back to a page lands the user where they left off.
 *
 * Each page component saves its scroll position on ngOnDestroy and restores it
 * on ngAfterViewInit. The scroll container is the `<main class="content">`
 * element in the app shell, identified by its CSS selector.
 */
@Injectable({ providedIn: 'root' })
export class ScrollPositionService {
  private static readonly SCROLL_CONTAINER_SELECTOR = 'main.content';

  private readonly savedScrollTopByRoute = new Map<string, number>();

  savePosition(routePath: string): void {
    const scrollContainer = this.getScrollContainer();
    if (scrollContainer) {
      this.savedScrollTopByRoute.set(routePath, scrollContainer.scrollTop);
    }
  }

  restorePosition(routePath: string): void {
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer) return;
    const savedScrollTop = this.savedScrollTopByRoute.get(routePath) ?? 0;
    scrollContainer.scrollTop = savedScrollTop;
  }

  clearPosition(routePath: string): void {
    this.savedScrollTopByRoute.delete(routePath);
  }

  private getScrollContainer(): HTMLElement | null {
    return document.querySelector(ScrollPositionService.SCROLL_CONTAINER_SELECTOR);
  }
}
