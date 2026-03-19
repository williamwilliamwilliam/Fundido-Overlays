/**
 * IPC channel names used for communication between the Electron main process
 * and renderer processes (the Angular UI and overlay windows).
 *
 * Grouped by domain so it's easy to find what you need.
 */

// ---------------------------------------------------------------------------
// Global toggle
// ---------------------------------------------------------------------------
export const GLOBAL_ENABLE = 'global:enable';
export const GLOBAL_DISABLE = 'global:disable';
export const GLOBAL_STATUS = 'global:status';

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
export const GROUPS_SET_WORKING = 'groups:set-working';
export const REGIONS_SET_DIRTY_OVERLAYS = 'regions:set-dirty-overlays';

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------
export const OLLAMA_LIST_MODELS = 'ollama:list-models';

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
export const PICKER_COLOR = 'picker:color';
export const PICKER_REGION_UPDATE = 'picker:region-update';
export const PICKER_CONFIRM = 'picker:confirm';
export const PICKER_CANCEL = 'picker:cancel';

// ---------------------------------------------------------------------------
// File dialogs
// ---------------------------------------------------------------------------
export const DIALOG_OPEN_FILE = 'dialog:open-file';

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------
export const DEBUG_LOG = 'debug:log';
export const DEBUG_SET_FILTERS = 'debug:set-filters';

// ---------------------------------------------------------------------------
// Preview frames
// ---------------------------------------------------------------------------
export const CAPTURE_PREVIEW_FRAME = 'capture:preview-frame';
export const REGIONS_PREVIEW_FRAME = 'regions:preview-frame';

// ---------------------------------------------------------------------------
// Performance metrics
// ---------------------------------------------------------------------------
export const PERF_METRICS = 'perf:metrics';

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------
export const UI_ACTIVE_PAGE = 'ui:active-page';
export const APP_CLOSE_REQUESTED = 'app:close-requested';
export const APP_CLOSE_RESPONSE = 'app:close-response';

// ---------------------------------------------------------------------------
// Preview state
// ---------------------------------------------------------------------------
export const PREVIEW_PAUSED = 'preview:paused';
