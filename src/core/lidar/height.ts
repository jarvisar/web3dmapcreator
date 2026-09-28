// Scalar roof heights without reconstructing roof geometry, for "Correct
// heights only". Ported from the add-on's lidar_height.py.

import { difference, intersection, multiArea, union } from '../geometry/polygon';
import type { MultiPolygon } from '../types';
import { mean, sortedQuantile } from './numeric';
import { buffer, contains } from './shapes';
import { heightDecision, strongMeasurement, type Props, type SourcePart } from './source';

/** Cells keyed "ix,iy". */
export type CellHeights = Map<string, number>;

const key = (x: number, y: number) => `${x},${y}`;

/**
 * The highest supported roof patch, not a whole-footprint percentile. A
 * tower may cover less than a tenth of its podium; equal-area cells and
 * connected support keep it without letting isolated returns or a chimney
 * set the height of the whole assembly.
 */
export function supportedHeight(cells: CellHeights, cellM: number, classifiedFraction: number): [number, number] | null {
  const pending = new Set(cells.keys());
  const patches: number[][] = [];
  const minimum = Math.max(4, Math.ceil(36 / cellM ** 2));
  while (pending.size) {
    // Python's set.pop takes an arbitrary element; the patches do not depend on which.
    const seed = pending.values().next().value as string;
    pending.delete(seed);
    const group = [seed];
    const stack = [seed];
    while (stack.length) {
      const [x, y] = stack.pop()!.split(',').map(Number);
      const here = cells.get(key(x, y))!;
      for (const other of [key(x - 1, y), key(x + 1, y), key(x, y - 1), key(x, y + 1)]) {
        if (pending.has(other) && Math.abs(cells.get(other)! - here) < 3) {
          pending.delete(other);
          stack.push(other);
          group.push(other);
        }
      }
    }
    if (group.length >= minimum) patches.push(group.map((k) => cells.get(k)!));
  }
  const explained = patches.reduce((s, p) => s + p.length, 0) / Math.max(1, cells.size);
  if (!patches.length || explained < 0.85) return null;
  // Unclassified roofs can slope and have several levels: require local coherence.
  const edges: number[] = [];
  for (const [k, z] of cells) {
    const [x, y] = k.split(',').map(Number);
    for (const other of [key(x + 1, y), key(x, y + 1)]) {
      const h = cells.get(other);
      if (h !== undefined) edges.push(Math.abs(z - h) < 3 ? 1 : 0);
    }
  }
  const coherent = edges.length ? mean(edges) : 0;
  if (classifiedFraction < 0.7 && coherent < 0.8) return null;
  // A tiny high patch must not raise a convention hall; a tower with 2% of the roof may.
  const major = patches.filter((p) => p.length >= cells.size * 0.02);
  if (!major.length) return null;
  const top = Math.max(...major.map((p) => sortedQuantile(Float64Array.from(p).sort(), 0.95)));
  return [top, Math.min(explained, coherent)];
}

/** A supported cell: key, centre in the world frame, height above ground. */
export interface CellSample {
  key: string;
  x: number;
  y: number;
  z: number;
}

/**
 * Check each mapped main mass against the cells within its own footprint.
 * No fitting of parts and no new outlines, and the tallest source height is
 * never handed to whichever roof the scan found tallest.
 */
export function sourceHeights(
  feature: { id: string; props: Props },
  parts: SourcePart[],
  footprint: MultiPolygon,
  samples: CellSample[],
  cellM: number,
  classified: number,
  stats: { coverage?: number; roofSupportDensityM2?: number; method?: string },
  preferLidar: boolean,
): Record<string, number> {
  const corrections: Record<string, number> = {};
  const targets: { id: string; props: Props; geometry: MultiPolygon; part: number }[] = [
    { id: feature.id, props: feature.props, geometry: footprint, part: -1 },
    ...parts.map((p, part) => ({ ...p, part })),
  ];
  const footprintArea = multiArea(footprint);
  for (const target of targets) {
    const main = target.part < 0;
    const props = target.props;
    const targetArea = multiArea(target.geometry);
    if (props.is_underground || props.min_height || props.min_floor) continue;
    if (!main && (targetArea < footprintArea * 0.05 || ![undefined, null, '', 'flat'].includes(props.roof_shape as string))) continue;
    const others = parts.filter((_, k) => k !== target.part).map((p) => p.geometry);
    // A half-cell margin keeps neighbouring tall roofs from setting a low mass's height.
    let exposed = intersection(target.geometry, footprint);
    if (others.length) exposed = difference(exposed, buffer(union(...others), cellM * 0.5));
    const exposedArea = multiArea(exposed);
    if (exposedArea < Math.max(36, targetArea * 0.25)) continue;
    const selected: CellHeights = new Map();
    for (const s of samples) if (contains(exposed, s.x, s.y)) selected.set(s.key, s.z);
    if (selected.size * cellM ** 2 < exposedArea * 0.85) continue;
    const scalar = supportedHeight(selected, cellM, classified);
    if (!scalar) continue;
    const [observed, explained] = scalar;
    const decision = heightDecision(props, observed, strongMeasurement({ ...stats, method: stats.method as never, explainedFraction: explained }));
    if ((decision === 'source_height_conflict' || decision === 'weak_height_correction') && !preferLidar) continue;
    if (target.id) corrections[target.id] = observed;
  }
  return corrections;
}
