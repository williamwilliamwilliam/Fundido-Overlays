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
  /** Target FPS for the preview stream. Default 10. */
  previewFps?: number;
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
 * A color-threshold-to-state mapping used by a ColorThreshold calculation.
 * Evaluated top-down; first row whose match % meets its threshold wins.
 */
export interface ColorThresholdMapping {
  /** The reference color to compare against the median. */
  color: RgbColor;
  /** Minimum match percentage (0–100) required for this row to trigger. */
  matchThreshold: number;
  /** Number of consecutive evaluations that must pass before this row triggers. Default 1. */
  consecutiveRequired: number;
  /** The state value emitted when this row matches. */
  stateValue: string;
}

/**
 * How to compare OCR text against the mapping value.
 */
export type OcrMatchMode = 'contains' | 'equals' | 'notEquals' | 'startsWith' | 'endsWith' | 'isEmpty';

/**
 * A text-to-state mapping used by an OCR calculation.
 * Evaluated top-down; first match wins.
 */
export interface SubstringMapping {
  /** The text to match against the OCR result (case-insensitive). Ignored for 'isEmpty' mode. */
  substring: string;
  /** How to compare the OCR text against the substring. Default 'contains'. */
  matchMode: OcrMatchMode;
  /** Minimum duration in ms that the match must hold continuously before triggering. 0 = immediate. */
  minDurationMs: number;
  /** The state value to emit when this mapping matches. */
  stateValue: string;
}

export type StateCalculationType = 'MedianPixelColor' | 'ColorThreshold' | 'OCR' | 'OllamaLLM';

/**
 * Preprocessing pipeline options for OCR calculations.
 * Applied to the region image before feeding to Tesseract.
 */
export interface OcrPreprocessConfig {
  /** Upscale factor applied before other processing. 1 = no upscale. Default 2. */
  upscaleFactor: number;
  /** Invert the image (swap light/dark). Useful for light text on dark backgrounds. Default false. */
  invert: boolean;
  /**
   * Brightness threshold for binarization (0–255). Pixels above this become white,
   * below become black. Set to 0 to disable thresholding. Default 0 (disabled).
   */
  threshold: number;
  /**
   * If enabled, only keep pixels whose color falls within the target range,
   * zeroing everything else. Useful for isolating colored game UI text.
   */
  colorFilterEnabled: boolean;
  /** Target color for color filtering (center of the range). */
  colorFilterTarget: RgbColor;
  /** Tolerance per channel around the target color (0–255). Default 40. */
  colorFilterTolerance: number;
  /** Character whitelist. Only these characters will be recognized. Empty = default set. */
  charWhitelist: string;
  /** Tesseract page segmentation mode. 7=single line, 8=single word, 10=single char. Default 7. */
  pageSegMode: number;
  /** Maximum characters to return from OCR. Trims the result to this length. Default 10. */
  maxCharacters: number;
}

/**
 * Configuration for an Ollama LLM calculation on a monitored region.
 */
export interface OllamaCalcConfig {
  /** The prompt to send to the LLM along with the region image. */
  prompt: string;
  /** Maximum tokens to generate. Lower = faster. Default 5. */
  numPredict: number;
  /** Whether to enable chain-of-thought reasoning. Default false. */
  think: boolean;
  /** Skip inference if the region pixels haven't changed since the last call. Default true. */
  skipIfUnchanged: boolean;
}

/**
 * Defines how to compute a state value from a monitored region.
 */
export interface StateCalculation {
  id: StateCalculationId;
  /** Human-readable label, e.g. "isRegionBlack?" or "readCooldownText" */
  name: string;
  type: StateCalculationType;
  /** Color mappings for MedianPixelColor type. */
  colorStateMappings: ColorStateMapping[];
  /** Color-threshold mappings for ColorThreshold type. Evaluated top-down, first match wins. */
  colorThresholdMappings: ColorThresholdMapping[];
  /** Substring mappings for OCR type. Evaluated top-down, first match wins. */
  substringMappings: SubstringMapping[];
  /** OCR preprocessing pipeline config. */
  ocrPreprocess?: OcrPreprocessConfig;
  /** Ollama LLM config for OllamaLLM type. */
  ollamaConfig?: OllamaCalcConfig;
  /** Skip this calculation if the region's pixels haven't changed since the last evaluation. */
  skipIfUnchanged?: boolean;
  /** Fallback state value used when the calculation cannot resolve a value. */
  defaultStateValue?: string;
}

/**
 * A rectangular area of the capture whose pixel content is continuously
 * evaluated to produce one or more state values.
 */
export interface MonitoredRegion {
  id: MonitoredRegionId;
  /** Human-readable label shown in the UI. */
  name: string;
  /** Whether this region is actively evaluated. Default true. */
  enabled: boolean;
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
export type RuleLogicMode = 'AND' | 'OR';

export interface RuleCondition {
  monitoredRegionId: MonitoredRegionId;
  stateCalculationId: StateCalculationId;
  operator: RuleOperator;
  value: string;
  /** If true, the result of this condition is inverted (NOT). Default false. */
  negate: boolean;
}

export type RuleAction = 'show' | 'hide' | 'opacity';

export interface OverlayRule {
  id: string;
  /** How conditions are combined. 'AND' = all must match, 'OR' = any must match. Default 'AND'. */
  logicMode: RuleLogicMode;
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
  /** Whether this group is active and rendered. Default true. */
  enabled: boolean;
  position: OverlayPosition;
  growDirection: GrowDirection;
  alignment: Alignment;
  /** Gap between overlays in pixels. */
  gap: number;
  overlays: Overlay[];
}

// ---------------------------------------------------------------------------
// OCR Settings
// ---------------------------------------------------------------------------

export interface OcrConfig {
  /** How often OCR runs, in milliseconds. Lower = more responsive but higher CPU. */
  ocrIntervalMs: number;
  /** Maximum characters to expect in OCR regions. Helps Tesseract optimize. */
  maxCharacters: number;
}

// ---------------------------------------------------------------------------
// Ollama Settings
// ---------------------------------------------------------------------------

export interface OllamaConfig {
  /** Ollama API base URL. Default http://localhost:11434 */
  baseUrl: string;
  /** Model name to use. Default qwen3.5:0.8b */
  modelName: string;
  /** How often Ollama inference runs, in milliseconds. Default 500. */
  intervalMs: number;
  /** How long Ollama keeps the model loaded. Default "5m". Use "-1" for forever. */
  keepAlive: string;
}

// ---------------------------------------------------------------------------
// Top-level Configuration (persisted)
// ---------------------------------------------------------------------------

export interface FundidoConfig {
  gameCapture: GameCaptureConfig;
  preview: PreviewConfig;
  ocr: OcrConfig;
  ollama: OllamaConfig;
  monitoredRegions: MonitoredRegion[];
  overlayGroups: OverlayGroup[];
  /** Max state calculation evaluations per second per calculation. Default 10. */
  maxCalcFrequency?: number;
}

// ---------------------------------------------------------------------------
// Runtime State (not persisted — computed in real-time)
// ---------------------------------------------------------------------------

/** The result of a single state calculation for the current frame. */
export interface StateCalculationResult {
  stateCalculationId: StateCalculationId;
  /** The median color computed from the region's current pixels. */
  medianColor: RgbColor;
  /** The state value of the closest matching color-state mapping or substring mapping. */
  currentValue: string;
  /** Confidence per mapping: how close the median is to each reference color (0–100%). */
  confidenceByMapping: Record<string, number>;
  /** Raw OCR text for OCR-type calculations. */
  ocrText?: string;
  /** Raw Ollama LLM response text for OllamaLLM-type calculations. */
  ollamaResponse?: string;
  /** Ollama inference duration in milliseconds. */
  ollamaResponseTimeMs?: number;
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
