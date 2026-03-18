import { CanDeactivateFn } from '@angular/router';

export interface PendingChangesComponent {
  canDeactivate: () => boolean | Promise<boolean>;
}

export const pendingChangesGuard: CanDeactivateFn<PendingChangesComponent> = (component) => {
  if (!component || typeof component.canDeactivate !== 'function') {
    return true;
  }

  return component.canDeactivate();
};
