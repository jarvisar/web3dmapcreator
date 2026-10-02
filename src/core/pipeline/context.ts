// State shared by the generation stages.

import type { ProgressEvent, Stage } from '../engine/protocol';
import type { Projection } from '../geo/projection';
import type { Box } from '../geometry/polygon';
import type { ModelSettings } from '../settings';
import type { HeightField } from '../terrain/heightfield';
import type { GeoBounds, ModelStats, MultiPolygon, Polygon } from '../types';

export class CancelError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelError';
  }
}

export interface ProgressSink {
  (event: ProgressEvent): void;
}

/** A step of a job as the progress bar plans it. */
export interface PlannedStep {
  stage: Stage;
  /**
   * Seconds it should take: work at the speed of the Node timings the
   * estimates come from (estimate.ts), or waiting on downloads.
   */
  seconds: number;
  /** Network bound, so the machine's speed doesn't scale it. */
  wait?: boolean;
  /** A rough guess. No time left is given while one is ahead, or until the step shows its own pace. */
  guess?: boolean;
}

// Pace within a step is read over at least this many seconds back.
const PACE_WINDOW_S = 15;
// Seconds of expected work the speed prior counts for.
const SPEED_PRIOR_S = 2;
// How far a step that's only a guess has to get before its pace counts.
const GUESS_PACED_FROM = 0.1;

/**
 * Reports progress and yields to the event loop every so often, so the
 * worker can see a cancel message. Stages call `checkpoint` inside long
 * loops, or `report` from code that can't yield.
 *
 * The bar is the share of the planned time done. Whenever an estimate
 * changes, the bar keeps where it is and the rest of it is shared out
 * again over what's left, so it never moves back and doesn't jump forward
 * when a step turns out slow. The time left blends each step's estimate
 * with the pace it's showing, and scales the estimates still ahead by how
 * this machine compared on the steps done so far.
 */
export class Progress {
  cancelled = false;
  private lastYield = performance.now();
  private lastSent = -Infinity;
  private planned = false;
  private steps: PlannedStep[] = [];
  private index = -1;
  private stage: Stage = 'data';
  private label = '';
  private within = 0;
  private stepStart = performance.now();
  private pace: { t: number; f: number }[] = [];
  // The bar when it was last shared out, and the seconds then left in this step and after it.
  private base = 0;
  private from = 0;
  private stepLeft = 0;
  private restLeft = 0;
  private rebased = 0;
  private shown = 0;
  // Work steps done: seconds they took and seconds they were expected to take.
  private took = 0;
  private expected = 0;
  private readonly prior: number;

  constructor(
    private readonly sink?: ProgressSink,
    options: { speed?: number } = {},
  ) {
    const speed = options.speed;
    this.prior = speed !== undefined && Number.isFinite(speed) && speed > 0 ? clampSpeed(speed) : 1;
  }

  /**
   * The steps still to come, in order. A step already begun keeps its place
   * and takes its new estimate if it's listed. Steps left out are dropped.
   */
  plan(steps: PlannedStep[]): void {
    this.settle();
    this.planned = true;
    const past = this.steps.slice(0, Math.max(0, this.index));
    const done = new Set(past.map((s) => s.stage));
    const current = this.current();
    const listed = current ? steps.find((s) => s.stage === current.stage) : undefined;
    const after = (listed ? steps.slice(steps.indexOf(listed) + 1) : steps).filter((s) => !done.has(s.stage) && s.stage !== current?.stage);
    this.steps = [...past, ...(current ? [listed ?? current] : []), ...after];
    this.rebase();
  }

  /**
   * Enters a step. One not in the plan holds the bar where it is, and gives
   * no time left, until it shows a pace of its own.
   */
  begin(stage: Stage, label: string, detail?: string): void {
    // The step before is done, whatever it last said, so the bar moves to
    // the end of its share. Not for a guess: the time it might still have
    // taken grows while it's stuck, and a survey search stuck in its density
    // probe for 3 minutes sent the bar from 10% to 78% when it ended.
    const previous = this.current();
    if (previous && !previous.guess) this.within = 1;
    this.settle();
    this.finishStep();
    let next = this.steps.findIndex((s, i) => i > this.index && s.stage === stage);
    if (next < 0) {
      next = this.index + 1;
      this.steps.splice(next, 0, { stage, seconds: 0, guess: true });
    }
    this.index = next;
    this.stage = stage;
    this.label = label;
    this.within = 0;
    this.stepStart = performance.now();
    this.pace = [];
    this.rebase();
    this.emit(detail, true);
  }

  /** Progress within the current step (0 to 1), sent at most every 50 ms. Doesn't yield. */
  report(fraction: number, detail?: string, label?: string): void {
    this.within = Math.max(0, Math.min(1, fraction));
    if (label) this.label = label;
    this.emit(detail, false);
  }

  /** Progress within the current step (0 to 1), and a yield every 40 ms. */
  async checkpoint(fraction = 0, detail?: string, label?: string): Promise<void> {
    if (this.cancelled) throw new CancelError();
    this.within = Math.max(0, Math.min(1, fraction));
    if (label) this.label = label;
    const now = performance.now();
    if (now - this.lastYield < 40) return;
    this.lastYield = now;
    this.emit(detail, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.cancelled) throw new CancelError();
  }

  /** Ends the last step, so `speed` counts it. */
  finish(): void {
    this.finishStep();
    this.index = this.steps.length;
  }

  /** Seconds taken per second expected over the work done so far, starting from the prior. */
  get speed(): number {
    let took = this.took;
    let expected = this.expected;
    const step = this.current();
    if (step && !step.wait && !step.guess && step.seconds > 0 && this.within > 0) {
      took += this.stepElapsed();
      expected += step.seconds * this.within;
    }
    return clampSpeed((took + SPEED_PRIOR_S * this.prior) / (expected + SPEED_PRIOR_S));
  }

  private current(): PlannedStep | undefined {
    return this.index >= 0 ? this.steps[this.index] : undefined;
  }

  private stepElapsed(): number {
    return (performance.now() - this.stepStart) / 1000;
  }

  private seconds(step: PlannedStep, speed: number): number {
    return step.wait ? step.seconds : step.seconds * speed;
  }

  private finishStep(): void {
    const step = this.current();
    if (!step || step.wait || step.guess || step.seconds <= 0) return;
    this.took += this.stepElapsed();
    this.expected += step.seconds;
  }

  /** Seconds left in the current step, or null when there's nothing to go on. */
  private stepRemaining(speed: number): number | null {
    const step = this.current();
    if (!step) return 0;
    const estimate = this.seconds(step, speed) * (1 - this.within);
    // A guess waits for a tenth of the step: LiDAR's first batches are the
    // slowest, and their pace said 7 minutes with 44 s to go.
    const paced = step.guess && this.within < GUESS_PACED_FROM ? null : this.pacedRemaining();
    if (paced === null) return step.guess ? null : estimate;
    // A guess gives way to the pace at once, an estimate as the step goes on.
    const trust = step.guess ? 1 : this.within;
    return estimate * (1 - trust) + paced * trust;
  }

  /**
   * Seconds left at the pace of the last 15 s, or of the last half of the
   * step when that's longer: LiDAR blocks took from 1 s to 2 minutes each.
   * The step's average when nothing moved in that time.
   */
  private pacedRemaining(): number | null {
    const now = performance.now();
    const elapsed = now - this.stepStart;
    if (this.within <= 0 || this.within >= 1 || elapsed < 1000) return null;
    const window = Math.max(PACE_WINDOW_S * 1000, elapsed / 2);
    const oldest = this.pace.find((p) => now - p.t <= window) ?? { t: this.stepStart, f: 0 };
    let rate = (this.within - oldest.f) / ((now - oldest.t) / 1000);
    if (!(rate > 0)) rate = this.within / (elapsed / 1000);
    return (1 - this.within) / rate;
  }

  private restRemaining(speed: number): number {
    let sum = 0;
    for (let i = this.index + 1; i < this.steps.length; i++) sum += this.seconds(this.steps[i], speed);
    return sum;
  }

  private rebase(): void {
    const speed = this.speed;
    this.base = this.shown;
    this.from = this.within;
    const step = this.current();
    this.stepLeft = this.stepRemaining(speed) ?? (step ? this.seconds(step, speed) * (1 - this.within) : 0);
    this.restLeft = this.restRemaining(speed);
    this.rebased = performance.now();
  }

  private bar(): number {
    const total = this.stepLeft + this.restLeft;
    if (total <= 0 || this.from >= 1) return this.shown;
    const done = (this.stepLeft * (this.within - this.from)) / (1 - this.from);
    return Math.min(1, Math.max(this.shown, this.base + ((1 - this.base) * done) / total));
  }

  private settle(): void {
    this.shown = this.bar();
  }

  private emit(detail: string | undefined, force: boolean): void {
    const now = performance.now();
    if (this.pace.length === 0 || now - this.pace[this.pace.length - 1].t >= 250) {
      this.pace.push({ t: now, f: this.within });
      // Every other sample goes once there are plenty, so a long step keeps its whole history.
      if (this.pace.length > 240) this.pace = this.pace.filter((_, i) => i % 2 === 0 || i === this.pace.length - 1);
    }
    const speed = this.speed;
    const left = this.stepRemaining(speed);
    // Share the bar out again once this step's estimate has moved on by a fifth.
    if (left !== null && now - this.rebased > 500) {
      const expected = this.stepLeft * ((1 - this.within) / Math.max(1e-9, 1 - this.from));
      if (Math.abs(left - expected) > 0.2 * Math.max(expected, 0.5)) {
        this.settle();
        this.rebase();
      }
    }
    if (!force && now - this.lastSent < 50) return;
    this.lastSent = now;
    this.shown = this.bar();
    if (!this.sink) return;
    const ahead = this.steps.slice(this.index + 1);
    const remaining = this.planned && left !== null && !ahead.some((s) => s.guess) ? left + this.restRemaining(speed) : undefined;
    this.sink({ stage: this.stage, label: this.label, fraction: this.shown, detail, remaining });
  }
}

function clampSpeed(speed: number): number {
  return Math.max(0.25, Math.min(8, speed));
}

/** What the viewer shows about an object you can select, by its key. */
export interface ObjectInfo {
  kind: 'building' | 'bridge' | 'water' | 'tree' | 'rock' | 'route';
  name?: string;
  /** Class or type, e.g. "office" or "lake". */
  detail?: string;
  /** Height in metres, as mapped or measured. */
  heightM?: number;
  /** Ground level it stands on, in model mm. Heights are edited from here. */
  base?: number;
  measured?: boolean;
  /** Where it stands on the ground and keeps land cover off, by sub-object. */
  ground?: Map<string, MultiPolygon>;
}

export interface Context {
  settings: ModelSettings;
  projection: Projection;
  /** Model outline (the area shape), CCW, in mm. */
  crop: Polygon;
  cropSet: MultiPolygon;
  cropBox: Box;
  /** Geographic bounds the data was fetched for. */
  bounds: GeoBounds;
  heightfield: HeightField;
  stats: ModelStats;
  warnings: string[];
  progress: Progress;
  /** Selectable objects by key, filled in as stages key their solids. */
  objects?: Map<string, ObjectInfo>;
}

/** Records an object for the viewer, keeping what an earlier call knew. */
export function describeObject(ctx: Context, key: string, info: ObjectInfo): void {
  if (!ctx.objects) return;
  const known = ctx.objects.get(key);
  if (!known) {
    ctx.objects.set(key, info);
    return;
  }
  known.name ||= info.name;
  known.detail ||= info.detail;
  if (info.heightM !== undefined) known.heightM = Math.max(known.heightM ?? 0, info.heightM);
  if (info.base !== undefined) known.base = Math.min(known.base ?? Infinity, info.base);
  if (info.measured) known.measured = true;
  if (info.ground) {
    known.ground ??= new Map();
    for (const [sub, pieces] of info.ground) known.ground.set(sub, [...(known.ground.get(sub) ?? []), ...pieces]);
  }
}

export function count(ctx: Pick<Context, 'stats'>, key: string, by = 1): void {
  ctx.stats[key] = ((ctx.stats[key] as number) ?? 0) + by;
}
