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
}

export function count(ctx: Context, key: string, by = 1): void {
  ctx.stats[key] = ((ctx.stats[key] as number) ?? 0) + by;
}
