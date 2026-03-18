import { Injectable } from '@angular/core';

export interface PendingChangesHandler {
  canDeactivate: () => boolean | Promise<boolean>;
}

@Injectable({ providedIn: 'root' })
export class PendingChangesService {
  private activeHandler: PendingChangesHandler | null = null;

  register(handler: PendingChangesHandler): void {
    this.activeHandler = handler;
  }

  unregister(handler: PendingChangesHandler): void {
    if (this.activeHandler === handler) {
      this.activeHandler = null;
    }
  }

  async confirmClose(): Promise<boolean> {
    if (!this.activeHandler) {
      return true;
    }

    return await this.activeHandler.canDeactivate();
  }
}
