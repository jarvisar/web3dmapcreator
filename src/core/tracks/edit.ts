// Editing a route's lines on the map. Most of this works on point indexes,
// so it doesn't care whether the points are lon/lat or metres.

import type { LonLat, Vec2 } from '../types';
import { distanceM } from './track';

const METRES_PER_DEGREE = (Math.PI / 180) * 6371008.8;

/** Metres east and north of a point, and back. */
export interface FlatFrame {
  center: LonLat;
  toLocal(p: LonLat): Vec2;
  toLonLat(p: Vec2): LonLat;
}

/**
 * A flat map around `center`, scaled to metres at its latitude. The two ways
 * are exact inverses, so a point dragged somewhere lands there however far
 * out it is. The model's own projection isn't: a tangent plane, it put a
 * point dragged 300 km from the area a few hundred metres off the pointer.
 * Distances stretch with the latitude, about 1% 100 km north or south.
 */
export function flatFrame(center: LonLat): FlatFrame {
  const kx = METRES_PER_DEGREE * Math.cos((center[1] * Math.PI) / 180);
  const ky = METRES_PER_DEGREE;
  return {
    center,
    toLocal: ([lon, lat]) => [(((lon - center[0] + 540) % 360) - 180) * kx, (lat - center[1]) * ky],
    toLonLat: ([x, y]) => {
      const lon = center[0] + x / kx;
      return [lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon, center[1] + y / ky];
    },
  };
}

function segmentDistanceSq(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return (a[0] + dx * t - p[0]) ** 2 + (a[1] + dy * t - p[1]) ** 2;
}

/**
 * Indexes of the points worth a handle at this zoom: the ones that hold the
 * shape to within `tolerance`, at least `gap` apart, plus both ends and
 * anything in `keep`. A recorded track has a point every few metres, far too
 * many to grab one by one.
 */
export function handleIndexes(path: readonly Vec2[], tolerance: number, gap: number, keep: readonly number[] = []): number[] {
  const n = path.length;
  if (n <= 2) return path.map((_, i) => i);
  const kept = new Uint8Array(n);
  kept[0] = 1;
  kept[n - 1] = 1;
  const stack = [0, n - 1];
  const limit = tolerance * tolerance;
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    let worst = -1;
    let worstSq = limit;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistanceSq(path[i], path[a], path[b]);
      if (d > worstSq) {
        worstSq = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      kept[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
  // Ends and kept points always stay. Others too close to the handle before
  // them are dropped, or give way to a fixed one right after.
  const fixed = new Uint8Array(n);
  fixed[0] = 1;
  fixed[n - 1] = 1;
  for (const i of keep) if (i >= 0 && i < n) fixed[i] = 1;
  const near = (i: number, j: number) => Math.hypot(path[i][0] - path[j][0], path[i][1] - path[j][1]) < gap;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!kept[i] && !fixed[i]) continue;
    const last = out[out.length - 1];
    if (last !== undefined && near(i, last)) {
      if (!fixed[i]) continue;
      if (!fixed[last]) out.pop();
    }
    out.push(i);
  }
  return out;
}

/** The points from..to (both included) of one line swapped for `insert`. */
export function replaceSpan<T>(lines: readonly (readonly T[])[], line: number, from: number, to: number, insert: readonly T[]): T[][] {
  return lines.map((points, i) => (i === line ? [...points.slice(0, from), ...insert, ...points.slice(to + 1)] : [...points]));
}

/**
 * Cuts out what's between `from` and `to` on a line. In the middle the line
 * becomes two, with a gap. At an end it's trimmed. A piece left with fewer
 * than two points goes.
 */
export function cutSpan<T>(lines: readonly (readonly T[])[], line: number, from: number, to: number): T[][] {
  const out: T[][] = [];
  lines.forEach((points, i) => {
    if (i !== line) {
      out.push([...points]);
      return;
    }
    const before = points.slice(0, from + 1);
    const after = points.slice(to);
    if (from > 0 && before.length >= 2) out.push(before);
    if (to < points.length - 1 && after.length >= 2) out.push(after);
  });
  return out;
}

/** The lines the other way round, so the start and finish swap. */
export function reverseLines<T>(lines: readonly (readonly T[])[]): T[][] {
  return [...lines].reverse().map((points) => [...points].reverse());
}

/**
 * Moves the point at `index` to `to`, and the points out to the handles on
 * either side follow along, less the further they are from it. Keeps the
 * shape of a recorded track when a point is only nudged onto a road.
 * Returns the new points from `before` to `after`, both included.
 */
export function warpSpan(path: readonly Vec2[], before: number, index: number, after: number, to: Vec2): Vec2[] {
  const dx = to[0] - path[index][0];
  const dy = to[1] - path[index][1];
  const along = (from: number, until: number) => {
    const out = [0];
    for (let i = from + 1; i <= until; i++) out.push(out[out.length - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    return out;
  };
  const out: Vec2[] = [];
  const left = along(before, index);
  const leftTotal = left[left.length - 1];
  for (let i = before; i < index; i++) {
    const w = i === before || leftTotal === 0 ? 0 : left[i - before] / leftTotal;
    out.push([path[i][0] + dx * w, path[i][1] + dy * w]);
  }
  out.push(to);
  const right = along(index, after);
  const rightTotal = right[right.length - 1];
  for (let i = index + 1; i <= after; i++) {
    const w = i === after || rightTotal === 0 ? 0 : 1 - right[i - index] / rightTotal;
    out.push([path[i][0] + dx * w, path[i][1] + dy * w]);
  }
  return out;
}

export interface LineHit {
  line: number;
  /** The segment from point `segment` to the next. */
  segment: number;
  t: number;
  point: Vec2;
  distance: number;
}

/** The nearest spot on the lines within `reach`, or null. */
export function nearestOnLines(lines: readonly (readonly Vec2[])[], p: Vec2, reach: number): LineHit | null {
  let best: LineHit | null = null;
  let bestSq = reach * reach;
  lines.forEach((path, line) => {
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, ay] = path[i];
      const [bx, by] = path[i + 1];
      // A cheap box test first, since this runs on every pointer move.
      if (Math.min(ax, bx) - reach > p[0] || Math.max(ax, bx) + reach < p[0] || Math.min(ay, by) - reach > p[1] || Math.max(ay, by) + reach < p[1]) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const length2 = dx * dx + dy * dy;
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / length2)) : 0;
      const x = ax + dx * t;
      const y = ay + dy * t;
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d <= bestSq) {
        bestSq = d;
        best = { line, segment: i, t, point: [x, y], distance: Math.sqrt(d) };
      }
    }
  });
  return best;
}

/** Length of points from..to on a lon/lat line, in metres. */
export function spanLengthM(points: readonly LonLat[], from = 0, to = points.length - 1): number {
  let total = 0;
  for (let i = from + 1; i <= to; i++) total += distanceM(points[i - 1], points[i]);
  return total;
}

/**
 * Takes `metres` off the start or the finish of the route, like hiding where
 * a run starts from home. A line shorter than what's left to trim goes
 * altogether, and the trim carries on into the next one.
 */
export function trimLines(lines: readonly (readonly LonLat[])[], metres: number, end: 'start' | 'finish'): LonLat[][] {
  if (!(metres > 0)) return lines.map((l) => [...l]);
  const fromStart = (input: readonly (readonly LonLat[])[]): LonLat[][] => {
    const out: LonLat[][] = [];
    let left = metres;
    for (const points of input) {
      if (left <= 0) {
        out.push([...points]);
        continue;
      }
      // A line used up before `left` runs out adds nothing.
      for (let i = 1; i < points.length; i++) {
        const step = distanceM(points[i - 1], points[i]);
        if (step < left) {
          left -= step;
          continue;
        }
        const t = step > 0 ? left / step : 0;
        const [a, b] = [points[i - 1], points[i]];
        // The short way round, across the antimeridian too.
        const delta = ((b[0] - a[0] + 540) % 360) - 180;
        const lon = a[0] + delta * t;
        const cut: LonLat = [lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon, a[1] + (b[1] - a[1]) * t];
        left = 0;
        // A cut right on the next point would leave it twice.
        out.push(t < 1 ? [cut, ...points.slice(i)] : points.slice(i));
        break;
      }
    }
    return out.filter((points) => points.length >= 2);
  };
  return end === 'start' ? fromStart(lines) : reverseLines(fromStart(reverseLines(lines)));
}
