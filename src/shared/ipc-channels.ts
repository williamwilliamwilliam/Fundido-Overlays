/**
 * IPC channel names used for communication between the Electron main process
 * and renderer processes (the Angular UI and overlay windows).
 *
 * Grouped by domain so it's easy to find what you need.
 */

// ---------------------------------------------------------------------------
// Configuration persistence
// ---------------------------------------------------------------------------
export const CONFIG_LOAD = 'config:load';
export const CONFIG_SAVE = 'config:save';
export const CONFIG_EXPORT_REGIONS = 'config:export-regions';
export const CONFIG_IMPORT_REGIONS = 'config:import-regions';
export const CONFIG_EXPORT_OVERLAY_GROUPS = 'config:export-overlay-groups';
export const CONFIG_IMPORT_OVERLAY_GROUPS = 'config:import-overlay-groups';

// ---------------------------------------------------------------------------
// Game capture
// ---------------------------------------------------------------------------
export const CAPTURE_START = 'capture:start';
export const CAPTURE_STOP = 'capture:stop';
export const CAPTURE_FRAME = 'capture:frame';
export const CAPTURE_STATUS = 'capture:status';
export const CAPTURE_LIST_DISPLAYS = 'capture:list-displays';

// ---------------------------------------------------------------------------
// State calculation
// ---------------------------------------------------------------------------
export const STATE_UPDATED = 'state:updated';
export const REGIONS_SET_WORKING = 'regions:set-working';

// ---------------------------------------------------------------------------
// Overlay management
// ---------------------------------------------------------------------------
export const OVERLAY_SHOW = 'overlay:show';
export const OVERLAY_HIDE = 'overlay:hide';
export const OVERLAY_UPDATE = 'overlay:update';

// ---------------------------------------------------------------------------
// Screen picker
// ---------------------------------------------------------------------------
export const PICKER_START = 'picker:start';
export const PICKER_REGION_UPDATE = 'picker:region-update';
export const PICKER_CONFIRM = 'picker:confirm';
export const PICKER_CANCEL = 'picker:cancel';

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------
export const DEBUG_LOG = 'debug:log';
export const DEBUG_SET_FILTERS = 'debug:set-filters';
