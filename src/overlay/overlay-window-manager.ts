import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import {
  OverlayGroup,
  OverlayGroupId,
  FrameState,
} from '../shared';
import { logger, LogCategory } from '../shared/logger';

/**
 * Manages the lifecycle of transparent, click-through overlay windows.
 *
 * Each overlay group gets its own BrowserWindow. This keeps rendering
 * isolated and makes it straightforward to position groups independently.
 */
export class OverlayWindowManager {
  private overlayWindowsByGroupId = new Map<OverlayGroupId, BrowserWindow>();

  /**
   * Creates (or recreates) overlay windows for the given groups.
   * Call this when the user's overlay group configuration changes.
   */
  public syncOverlayWindows(overlayGroups: OverlayGroup[]): void {
    // Close windows for groups that no longer exist
    const activeGroupIds = new Set(overlayGroups.map((group) => group.id));
    for (const [groupId, window] of this.overlayWindowsByGroupId) {
      const groupWasRemoved = !activeGroupIds.has(groupId);
      if (groupWasRemoved) {
        logger.info(LogCategory.Overlay, `Closing overlay window for removed group: ${groupId}`);
        window.close();
        this.overlayWindowsByGroupId.delete(groupId);
      }
    }

    // Create windows for new groups
    for (const group of overlayGroups) {
      const windowAlreadyExists = this.overlayWindowsByGroupId.has(group.id);
      if (!windowAlreadyExists) {
        this.createOverlayWindow(group);
      }
    }
  }

  /**
   * Pushes updated frame state to all overlay windows so they can
   * re-evaluate visibility conditions and update their display.
   */
  public broadcastFrameState(frameState: FrameState): void {
    for (const [_groupId, window] of this.overlayWindowsByGroupId) {
      if (!window.isDestroyed()) {
        window.webContents.send('overlay:frame-state', frameState);
      }
    }
  }

  /**
   * Closes all overlay windows. Called on app shutdown.
   */
  public closeAll(): void {
    for (const [_groupId, window] of this.overlayWindowsByGroupId) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    this.overlayWindowsByGroupId.clear();
  }

  private createOverlayWindow(group: OverlayGroup): void {
    logger.info(LogCategory.Overlay, `Creating overlay window for group: "${group.name}" (${group.id})`);

    const primaryDisplay = screen.getPrimaryDisplay();
    const displayBounds = primaryDisplay.bounds;

    const overlayWindow = new BrowserWindow({
      x: displayBounds.x,
      y: displayBounds.y,
      width: displayBounds.width,
      height: displayBounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload-overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Make the window click-through so it doesn't intercept game input
    overlayWindow.setIgnoreMouseEvents(true);

    // Load the overlay renderer HTML
    // In production this will be a bundled file; in dev it could be a local URL.
    const overlayHtmlPath = path.join(__dirname, '..', 'overlay-renderer', 'index.html');
    overlayWindow.loadFile(overlayHtmlPath).catch((error) => {
      logger.error(LogCategory.Overlay, `Failed to load overlay HTML for group "${group.name}".`, error);
    });

    // Once loaded, send the group configuration so it knows what to render
    overlayWindow.webContents.once('did-finish-load', () => {
      overlayWindow.webContents.send('overlay:init', group);
    });

    this.overlayWindowsByGroupId.set(group.id, overlayWindow);
  }
}
