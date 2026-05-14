import { ActivatedRouteSnapshot, DetachedRouteHandle, RouteReuseStrategy } from '@angular/router';

/**
 * Keeps the Monitored Regions and Overlay Groups components alive when navigating
 * away from them, rather than destroying and recreating them on each visit.
 *
 * Benefits:
 * - Scroll position is preserved naturally (the DOM nodes are the same objects).
 * - Expensive subscriptions (frame state, perf metrics, canvas observers) do not
 *   need to be re-established on every visit.
 *
 * Each reused component is responsible for pausing its heavy work while detached
 * (via a `NavigationEnd` subscription that calls `onRouteActivated` /
 * `onRouteDeactivated` helper methods on the component).
 */

const REUSED_ROUTE_PATHS = new Set(['regions', 'overlays']);

export class AppRouteReuseStrategy implements RouteReuseStrategy {
  private readonly storedHandlesByRoutePath = new Map<string, DetachedRouteHandle>();

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    const routePath = route.routeConfig?.path ?? '';
    return REUSED_ROUTE_PATHS.has(routePath);
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const routePath = route.routeConfig?.path ?? '';
    if (handle) {
      this.storedHandlesByRoutePath.set(routePath, handle);
    } else {
      this.storedHandlesByRoutePath.delete(routePath);
    }
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const routePath = route.routeConfig?.path ?? '';
    return this.storedHandlesByRoutePath.has(routePath);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const routePath = route.routeConfig?.path ?? '';
    return this.storedHandlesByRoutePath.get(routePath) ?? null;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig;
  }
}
