/**
 * Automated sweep for attributing in-game frame-rate loss to overlay behaviour.
 *
 * The question this exists to answer: when overlays cost the game frames, is it
 * the mere existence of the transparent always-on-top window (a fixed cost the
 * desktop compositor pays), or the repainting of mirror content (a cost that
 * scales with rate and mirror count)? Those have completely different fixes,
 * and reasoning about it from CPU numbers has already produced one wrong
 * conclusion in this codebase.
 *
 * The sweep steps through conditions on a timer while the game runs, tagging
 * every perf-trace line with the active condition so the frame rate read off
 * the game's own counter can be compared across them.
 *
 * TEMPORARY DIAGNOSTIC — enabled only by FUNDIDO_FPS_EXPERIMENT and safe to
 * delete once the question is settled. It mutates config in memory only; the
 * saved configuration is never touched.
 *
 * Two things protect the result from the biggest threat to its validity, which
 * is that game frame rate drifts with whatever is happening on screen:
 *
 *   - Conditions run in a palindrome order (forwards then backwards) and the
 *     whole cycle repeats. Linear drift therefore shows up as disagreement
 *     between repeats of the SAME condition, not as a difference between
 *     conditions. If the repeats disagree as much as the conditions do, the run
 *     is invalid and the numbers say so.
 *   - Samples taken in the first few seconds after a switch are marked as
 *     settling and excluded from analysis, so a condition is never scored on
 *     frames captured while it was still taking effect.
 */

import { logger, LogCategory } from '../shared/logger';

export interface FpsExperimentCondition {
  name: string;
  /** Whether the overlay window should exist at all during this condition. */
  overlayWindowOpen: boolean;
  /** Mirror repaint rate; 0 leaves the window up but never repaints it. */
  overlayFps: number;
  /** Fraction of visible mirrors actually broadcast, 0..1. */
  mirrorFraction: number;
}

export interface StepObservation {
  /** Mirror repaints that occurred during the step. */
  repaints: number;
  /** Mirrors included in the most recent broadcast of the step. */
  mirrors: number;
}

export interface FpsExperimentDependencies {
  /** Sets the in-memory mirror repaint rate. Must not persist the change. */
  setOverlayFps(overlayFps: number): void;
  /** Opens or closes the overlay window without altering saved config. */
  setOverlayWindowOpen(open: boolean): void;
  /** Limits how many visible mirrors are broadcast, as a fraction. */
  setMirrorFraction(fraction: number): void;
  /** Returns and resets what was actually observed during the step. */
  readStepObservation(): StepObservation;
}

/**
 * The reference condition, re-measured between every treatment.
 *
 * Game frame rate drifts on its own, by more than the effect being measured —
 * an earlier sweep was thrown out because repeats of one condition varied by
 * 8.5fps while the conditions themselves differed by 2.8fps. Bracketing every
 * treatment with a reference measurement turns each treatment into a local
 * difference against its own neighbours, so slow drift cancels instead of
 * masquerading as an effect.
 */
const REFERENCE_CONDITION: FpsExperimentCondition = {
  name: 'window-closed', overlayWindowOpen: false, overlayFps: 0, mirrorFraction: 0,
};

/**
 * Treatments, chosen so that consecutive pairs isolate one variable each:
 *
 *   window-closed → mirrors-none : cost of the window merely existing
 *   mirrors-none → half → all    : cost scaling with mirror count
 *   mirrors-all → rate-4         : cost scaling with repaint rate
 *
 * Repaint rates must stay below the capture rate to be distinguishable. A
 * previous sweep asked for 15/30/60 while capture ran at 15.6, so all three
 * produced identical behaviour and three of five conditions were duplicates.
 */
const TREATMENT_CONDITIONS: FpsExperimentCondition[] = [
  { name: 'mirrors-none', overlayWindowOpen: true, overlayFps: 0, mirrorFraction: 0 },
  { name: 'mirrors-half', overlayWindowOpen: true, overlayFps: 240, mirrorFraction: 0.5 },
  { name: 'mirrors-all', overlayWindowOpen: true, overlayFps: 240, mirrorFraction: 1 },
  { name: 'rate-4', overlayWindowOpen: true, overlayFps: 4, mirrorFraction: 1 },
];

const DEFAULT_DWELL_SECONDS = 20;
const DEFAULT_CYCLES = 3;
/** Samples this soon after a condition switch are excluded from analysis. */
const SETTLE_MS = 5000;

export class FpsExperiment {
  private dependencies: FpsExperimentDependencies | null = null;
  private sequence: FpsExperimentCondition[] = [];
  private currentStepIndex = -1;
  private stepStartedAtMs = 0;
  private stepTimer: ReturnType<typeof setTimeout> | null = null;
  private dwellMs = DEFAULT_DWELL_SECONDS * 1000;
  private originalOverlayFps: number | null = null;
  private readonly observationsByCondition = new Map<string, { repaintsPerSecond: number; mirrors: number }>();
  private readonly warnedPairs = new Set<string>();

  public isRunning(): boolean {
    return this.currentStepIndex >= 0;
  }

  /** True when the experiment is not enabled for this process. */
  public static isEnabled(): boolean {
    return process.env.FUNDIDO_FPS_EXPERIMENT === '1';
  }

  /**
   * Metadata for the current step, attached to each perf-trace line.
   * Returns null when no experiment is running.
   */
  public getTraceFields(): Record<string, unknown> | null {
    if (!this.isRunning()) return null;
    const condition = this.sequence[this.currentStepIndex];
    const msIntoStep = Date.now() - this.stepStartedAtMs;
    return {
      experimentCondition: condition.name,
      experimentStepIndex: this.currentStepIndex,
      experimentMsIntoStep: msIntoStep,
      // Analysis should ignore settling samples: the condition may not have
      // fully taken effect, and the OCR reading lags the change.
      experimentSettling: msIntoStep < SETTLE_MS,
    };
  }

  public start(dependencies: FpsExperimentDependencies, currentOverlayFps: number): void {
    if (this.isRunning()) return;

    this.dependencies = dependencies;
    this.originalOverlayFps = currentOverlayFps;

    const dwellSeconds = parsePositiveInt(process.env.FUNDIDO_FPS_EXPERIMENT_DWELL, DEFAULT_DWELL_SECONDS);
    const cycles = parsePositiveInt(process.env.FUNDIDO_FPS_EXPERIMENT_CYCLES, DEFAULT_CYCLES);
    this.dwellMs = dwellSeconds * 1000;
    this.sequence = buildBracketedSequence(REFERENCE_CONDITION, TREATMENT_CONDITIONS, cycles);

    const totalSeconds = this.sequence.length * dwellSeconds;
    logger.info(
      LogCategory.General,
      `[FPS EXPERIMENT] Starting: ${this.sequence.length} steps x ${dwellSeconds}s ` +
      `(~${Math.round(totalSeconds / 60)} min). Keep the game in a static scene and ` +
      `do not change settings until it finishes.`
    );

    this.currentStepIndex = -1;
    this.advanceToNextStep();
  }

  public stop(): void {
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
    if (!this.isRunning()) return;

    this.currentStepIndex = -1;
    this.restoreOriginalState();
    logger.info(LogCategory.General, '[FPS EXPERIMENT] Finished — original overlay state restored.');
  }

  private advanceToNextStep(): void {
    this.currentStepIndex++;

    const experimentIsComplete = this.currentStepIndex >= this.sequence.length;
    if (experimentIsComplete) {
      this.stop();
      return;
    }

    // Read what the step that just ended actually did, before switching.
    this.recordObservationForPreviousStep();

    const condition = this.sequence[this.currentStepIndex];
    this.stepStartedAtMs = Date.now();

    try {
      this.dependencies!.setOverlayWindowOpen(condition.overlayWindowOpen);
      this.dependencies!.setOverlayFps(condition.overlayFps);
      this.dependencies!.setMirrorFraction(condition.mirrorFraction);
    } catch (error) {
      logger.error(LogCategory.General, '[FPS EXPERIMENT] Failed to apply condition.', error);
    }

    logger.info(
      LogCategory.General,
      `[FPS EXPERIMENT] Step ${this.currentStepIndex + 1}/${this.sequence.length}: ${condition.name}`
    );

    this.stepTimer = setTimeout(() => this.advanceToNextStep(), this.dwellMs);
  }

  /**
   * Logs what the finished step actually produced, and warns when two
   * treatments turn out to be indistinguishable.
   *
   * A previous sweep asked for three different repaint rates that all exceeded
   * the capture rate, so all three behaved identically and 60% of the run was
   * wasted — a fact only discovered during analysis. Checking as it goes means
   * the run can be abandoned in the first cycle rather than the last.
   */
  private recordObservationForPreviousStep(): void {
    const previousStepIndex = this.currentStepIndex - 1;
    if (previousStepIndex < 0 || !this.dependencies) return;

    const previousCondition = this.sequence[previousStepIndex];
    const observation = this.dependencies.readStepObservation();
    const dwellSeconds = this.dwellMs / 1000;
    const repaintsPerSecond = observation.repaints / dwellSeconds;

    const existing = this.observationsByCondition.get(previousCondition.name);
    if (!existing) {
      this.observationsByCondition.set(previousCondition.name, {
        repaintsPerSecond,
        mirrors: observation.mirrors,
      });
    }

    logger.info(
      LogCategory.General,
      `[FPS EXPERIMENT] ${previousCondition.name} observed: ` +
      `${repaintsPerSecond.toFixed(1)} repaints/s, ${observation.mirrors} mirrors`
    );

    this.warnAboutIndistinguishableConditions();
  }

  private warnAboutIndistinguishableConditions(): void {
    const entries = Array.from(this.observationsByCondition.entries());
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [nameA, a] = entries[i];
        const [nameB, b] = entries[j];
        const repaintsMatch = Math.abs(a.repaintsPerSecond - b.repaintsPerSecond) < 1;
        const mirrorsMatch = a.mirrors === b.mirrors;
        if (repaintsMatch && mirrorsMatch && !this.warnedPairs.has(`${nameA}|${nameB}`)) {
          this.warnedPairs.add(`${nameA}|${nameB}`);
          logger.warn(
            LogCategory.General,
            `[FPS EXPERIMENT] "${nameA}" and "${nameB}" behaved identically ` +
            `(${a.repaintsPerSecond.toFixed(1)} repaints/s, ${a.mirrors} mirrors). ` +
            'They cannot be told apart — the sweep will not answer what separates them.'
          );
        }
      }
    }
  }

  private restoreOriginalState(): void {
    if (!this.dependencies) return;
    try {
      this.dependencies.setOverlayWindowOpen(true);
      this.dependencies.setMirrorFraction(1);
      if (this.originalOverlayFps !== null) {
        this.dependencies.setOverlayFps(this.originalOverlayFps);
      }
    } catch (error) {
      logger.error(LogCategory.General, '[FPS EXPERIMENT] Failed to restore overlay state.', error);
    }
  }
}

/**
 * Builds `ref, T1, ref, T2, ref, T3, ...` and repeats it.
 *
 * Every treatment is immediately preceded and followed by a reference
 * measurement, so it can be scored against the average of its own neighbours
 * rather than against a session-wide average. Drift between the start and end
 * of the run then cancels out of every comparison instead of accumulating into
 * one.
 */
function buildBracketedSequence(
  reference: FpsExperimentCondition,
  treatments: FpsExperimentCondition[],
  cycles: number
): FpsExperimentCondition[] {
  const sequence: FpsExperimentCondition[] = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const treatment of treatments) {
      sequence.push(reference, treatment);
    }
  }
  // Close with a final reference so the last treatment is bracketed on both
  // sides like every other one.
  sequence.push(reference);
  return sequence;
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const fpsExperiment = new FpsExperiment();
