/**
 * Core domain models for Fundido Overlays.
 *
 * These types are shared between the Electron main process, the Angular UI,
 * and the overlay renderer windows. They represent the user's configuration
 * and the runtime state of the application.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Branded string type for entity IDs to prevent accidental misuse. */
export type MonitoredRegionId = string & { readonly __brand: 'MonitoredRegionId' };
export type StateCalculationId = string & { readonly __brand: 'StateCalculationId' };
export type OverlayGroupId = string & { readonly __brand: 'OverlayGroupId' };
export type OverlayId = string & { readonly __brand: 'OverlayId' };

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Rectangle {
  /** Horizontal offset from the left edge of the capture, in pixels. */
  x: number;
  /** Vertical offset from the top edge of the capture, in pixels. */
  y: number;
  /** Width of the rectangle in pixels. */
  width: number;
  /** Height of the rectangle in pixels. */
  height: number;
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/** An RGB color with each channel in the 0–255 range. */
export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

// ---------------------------------------------------------------------------
// Game Capture
// ---------------------------------------------------------------------------

export interface GameCaptureConfig {
  /** Display index or window title to capture. */
  captureSource: string;
  /** Target frames per second for the capture loop. */
  targetFps: number;
}

// ---------------------------------------------------------------------------
// Monitored Regions & State
// ---------------------------------------------------------------------------

/**
 * A color-to-state mapping used by a MedianPixelColor calculation.
 * When the median color of the region is closest to `color`, the
 * state value is set to `stateValue`.
 */
export interface ColorStateMapping {
  /** The reference color to compare against the median. */
  color: RgbColor;
  /** The label/value the state assumes when this color is the closest match. */
  stateValue: string;
}

/**
 * Defines how to compute a state value from a monitored region.
 * Initially the only supported type is 'MedianPixelColor'.
 */
export interface StateCalculation {
  id: StateCalculationId;
  /** Human-readable label, e.g. "isRegionBlack?" */
  name: string;
  type: 'MedianPixelColor';
  /** The set of reference colors and their associated state values. */
  colorStateMappings: ColorStateMapping[];
}

/**
 * A rectangular area of the capture whose pixel content is continuously
 * evaluated to produce one or more state values.
 */
export interface MonitoredRegion {
  id: MonitoredRegionId;
  /** Human-readable label shown in the UI. */
  name: string;
  /** The area of the capture this region covers. */
  bounds: Rectangle;
  /** One or more calculations that derive state from this region. */
  stateCalculations: StateCalculation[];
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

export type OverlayContentType = 'icon' | 'text' | 'regionMirror';

export type GrowDirection = 'right' | 'left' | 'down' | 'up';
export type Alignment = 'start' | 'center' | 'end';

export type OverlayPositionMode = 'absolute' | 'relativeToCursor';

export interface OverlayPositionAbsolute {
  mode: 'absolute';
  /** Pixels from the left edge of the screen. */
  x: number;
  /** Pixels from the top edge of the screen. */
  y: number;
}

export interface OverlayPositionRelativeToCursor {
  mode: 'relativeToCursor';
  /** Horizontal offset from the cursor, in pixels. */
  offsetX: number;
  /** Vertical offset from the cursor, in pixels. */
  offsetY: number;
}

export type OverlayPosition = OverlayPositionAbsolute | OverlayPositionRelativeToCursor;

/**
 * A condition that must be met for an overlay to be visible.
 * Evaluated as: monitoredRegion[stateCalculationId].currentValue === requiredStateValue
 */
export interface OverlayVisibilityCondition {
  monitoredRegionId: MonitoredRegionId;
  stateCalculationId: StateCalculationId;
  requiredStateValue: string;
}

/** An individual overlay element that reacts to state. */
export interface Overlay {
  id: OverlayId;
  name: string;
  contentType: OverlayContentType;
  /**
   * Interpreted based on contentType:
   * - 'icon': path to an image file
   * - 'text': the text string to display
   * - 'regionMirror': the MonitoredRegionId to mirror
   */
  content: string;
  /** All conditions must be true for this overlay to display. */
  visibilityConditions: OverlayVisibilityCondition[];
}

/** A group that controls layout and positioning for a set of overlays. */
export interface OverlayGroup {
  id: OverlayGroupId;
  name: string;
  position: OverlayPosition;
  growDirection: GrowDirection;
  alignment: Alignment;
  overlays: Overlay[];
}

// ---------------------------------------------------------------------------
// Top-level Configuration (persisted)
// ---------------------------------------------------------------------------

export interface FundidoConfig {
  gameCapture: GameCaptureConfig;
  monitoredRegions: MonitoredRegion[];
  overlayGroups: OverlayGroup[];
}

// ---------------------------------------------------------------------------
// Runtime State (not persisted — computed in real-time)
// ---------------------------------------------------------------------------

/** The result of a single state calculation for the current frame. */
export interface StateCalculationResult {
  stateCalculationId: StateCalculationId;
  /** The median color computed from the region's current pixels. */
  medianColor: RgbColor;
  /** The state value of the closest matching color-state mapping. */
  currentValue: string;
  /** Confidence per mapping: how close the median is to each reference color (0–100%). */
  confidenceByMapping: Record<string, number>;
}

/** Runtime state for a single monitored region. */
export interface MonitoredRegionState {
  monitoredRegionId: MonitoredRegionId;
  calculationResults: StateCalculationResult[];
}

/** The full set of computed state for the current frame. */
export interface FrameState {
  timestamp: number;
  regionStates: MonitoredRegionState[];
}
