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
  /** Target frames per second for the capture loop (1–60). */
  targetFps: number;
  /** Whether capture should be running. Persisted so it auto-starts on next launch. */
  captureEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Preview Settings
// ---------------------------------------------------------------------------

export type PreviewDownsampleMethod = 'nearestNeighbor' | 'bilinear' | 'skip';

export interface PreviewConfig {
  /** Scale factor for the preview image (0.1 = 10% of original, 1.0 = full size). */
  previewScale: number;
  /** Downsampling method used to shrink the preview. */
  downsampleMethod: PreviewDownsampleMethod;
  /** JPEG quality for the preview image (1–100). Higher = sharper but more data. */
  jpegQuality: number;
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

export type OverlayContentType = 'text' | 'image' | 'regionMirror';

export type GrowDirection = 'right' | 'left' | 'down' | 'up';
export type Alignment = 'start' | 'center' | 'end';

export type OverlayPositionMode = 'absolute' | 'relativeToCursor';

export interface OverlayPositionAbsolute {
  mode: 'absolute';
  x: number;
  y: number;
}

export interface OverlayPositionRelativeToCursor {
  mode: 'relativeToCursor';
  offsetX: number;
  offsetY: number;
}

export type OverlayPosition = OverlayPositionAbsolute | OverlayPositionRelativeToCursor;

// -- Overlay content configs per type --

export interface OverlayTextConfig {
  text: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  color: string;
  backgroundColor: string;
  padding: number;
}

export interface OverlaySizeConfig {
  /** If set, fixed width in pixels. */
  width?: number;
  /** If set, fixed height in pixels. */
  height?: number;
  /** If set, max width in pixels. */
  maxWidth?: number;
  /** If set, max height in pixels. */
  maxHeight?: number;
  /** If set, scale factor (1.0 = original size). Overrides width/height. */
  scale?: number;
}

export interface OverlayImageConfig {
  /** Absolute path to the image file on disk. */
  filePath: string;
  size: OverlaySizeConfig;
}

export interface OverlayRegionMirrorConfig {
  monitoredRegionId: MonitoredRegionId;
  size: OverlaySizeConfig;
}

// -- Rules engine --

export type RuleOperator = 'equals' | 'notEquals';

export interface RuleCondition {
  monitoredRegionId: MonitoredRegionId;
  stateCalculationId: StateCalculationId;
  operator: RuleOperator;
  value: string;
}

export type RuleAction = 'show' | 'hide' | 'opacity';

export interface OverlayRule {
  id: string;
  /** All conditions must be true for this rule to match (AND logic). */
  conditions: RuleCondition[];
  action: RuleAction;
  /** For 'opacity' action, the opacity value (0–1). */
  opacityValue?: number;
}

/** An individual overlay element with typed content and a rules engine. */
export interface Overlay {
  id: OverlayId;
  name: string;
  contentType: OverlayContentType;
  textConfig?: OverlayTextConfig;
  imageConfig?: OverlayImageConfig;
  regionMirrorConfig?: OverlayRegionMirrorConfig;
  /** Whether the overlay is visible by default before any rules are evaluated. */
  defaultVisible: boolean;
  /** Default opacity (0–1) before any rules are evaluated. */
  defaultOpacity: number;
  /**
   * Rules evaluated top-down. First matching rule's action is taken.
   * If no rules match, defaultVisible and defaultOpacity apply.
   */
  rules: OverlayRule[];
}

/** A group that controls layout and positioning for a set of overlays. */
export interface OverlayGroup {
  id: OverlayGroupId;
  name: string;
  position: OverlayPosition;
  growDirection: GrowDirection;
  alignment: Alignment;
  /** Gap between overlays in pixels. */
  gap: number;
  overlays: Overlay[];
}

// ---------------------------------------------------------------------------
// Top-level Configuration (persisted)
// ---------------------------------------------------------------------------

export interface FundidoConfig {
  gameCapture: GameCaptureConfig;
  preview: PreviewConfig;
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
  /** The median color of the region for this frame, always computed. */
  medianColor: RgbColor;
  calculationResults: StateCalculationResult[];
}

/** The full set of computed state for the current frame. */
export interface FrameState {
  timestamp: number;
  regionStates: MonitoredRegionState[];
}
