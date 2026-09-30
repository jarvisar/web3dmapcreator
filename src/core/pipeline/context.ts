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

/**
 * Yields to the event loop every so often so the worker can see a cancel
 * message, and reports progress. Stages call `checkpoint` inside long loops.
 */
export class Progress {
  private lastYield = performance.now();
  private stageStart = 0;
  private stageSpan = 0;
  private stage: Stage = 'data';
  private label = '';
  cancelled = false;

  constructor(private readonly sink?: ProgressSink) {}

  /** Enter a stage that covers [start, start + span] of the overall bar. */
  begin(stage: Stage, label: string, start: number, span: number, detail?: string): void {
    this.stage = stage;
    this.label = label;
    this.stageStart = start;
    this.stageSpan = span;
    this.sink?.({ stage, label, fraction: start, detail });
  }

  /** Report progress within the current stage (0 to 1) and maybe yield. */
  async checkpoint(fraction = 0, detail?: string, label?: string): Promise<void> {
    if (this.cancelled) throw new CancelError();
    const now = performance.now();
    if (now - this.lastYield < 40) return;
    this.lastYield = now;
    if (label) this.label = label;
    this.sink?.({
      stage: this.stage,
      label: this.label,
      fraction: this.stageStart + this.stageSpan * Math.max(0, Math.min(1, fraction)),
      detail,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.cancelled) throw new CancelError();
  }
}

/** What the viewer shows about an object you can select, by its key. */
export interface ObjectInfo {
  kind: 'building' | 'bridge' | 'water' | 'tree' | 'rock';
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
