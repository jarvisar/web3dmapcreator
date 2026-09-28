// Ground under a footprint, from the same survey's ground-class returns
// around it. Heights are always roof minus this ground, never against the
// terrain DEM, so no vertical datum ever has to be converted.

import type { MultiPolygon } from '../types';
import { lstsq, median } from './numeric';
import { PointIndex, take, type Points } from './points';
import { area, buffer, bounds, centroid, hullShape, Inside, intersects, representativePoint } from './shapes';
import { intersection, multiArea } from '../geometry/polygon';

// Share of the footprint the surrounding ground cells' hull must cover.
const ANCHOR_COVERAGE = 0.9;

/** Ground-class returns within `margin` of the footprint, outside it. */
export function surroundingGround(footprint: MultiPolygon, index: PointIndex, margin = 25): Points {
  const neighbourhood = buffer(footprint, margin);
  const [x0, y0, x1, y1] = bounds(neighbourhood);
  const candidates = index.queryIndices(x0, y0, x1, y1);
  const near = new Inside(neighbourhood);
  const inside = new Inside(footprint);
  const p = index.points;
  const keep: number[] = [];
  for (const i of candidates) {
    if (p.cls[i] === 2 && near.has(p.x[i], p.y[i]) && !inside.has(p.x[i], p.y[i])) keep.push(i);
  }
  return take(p, keep);
}

/** Per-column medians of the rows grouped into 4 m cells, in first-seen cell order. */
function cellMedians(points: Points, minimum = 0, sortCells = false): number[][] {
  const groups = new Map<string, number[]>();
  const order: string[] = [];
  const keys: [number, number][] = [];
  for (let i = 0; i < points.count; i++) {
    const kx = Math.floor(points.x[i] / 4);
    const ky = Math.floor(points.y[i] / 4);
    const key = `${kx},${ky}`;
    let list = groups.get(key);
    if (!list) {
      groups.set(key, (list = []));
      order.push(key);
      keys.push([kx, ky]);
    }
    list.push(i);
  }
  let sequence = order.map((key, k) => ({ key, cell: keys[k] }));
  if (sortCells) sequence = sequence.sort((a, b) => a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1]);
  const out: number[][] = [];
  for (const { key } of sequence) {
    const rows = groups.get(key)!;
    if (rows.length < minimum) continue;
    out.push([median(rows.map((i) => points.x[i])), median(rows.map((i) => points.y[i])), median(rows.map((i) => points.z[i]))]);
  }
  return out;
}

/** Distance from a point to a shape: 0 inside, else to the nearest edge. */
function distanceTo(shape: MultiPolygon, x: number, y: number): number {
  if (new Inside(shape).has(x, y)) return 0;
  let best = Infinity;
  for (const polygon of shape) {
    for (const ring of polygon) {
      for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
        const [ax, ay] = ring[j];
        const [bx, by] = ring[i];
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
      }
    }
  }
  return best;
}

/** Hull of points as a shape, or for collinear points the distance test falls back to the points themselves. */
function hullCovers(cells: number[][], x: number, y: number, pad: number): boolean {
  const flat = cells.flatMap((c) => [c[0], c[1]]);
  const hull = hullShape(flat);
  if (hull.length) return distanceTo(hull, x, y) <= pad;
  // Collinear: Shapely's hull is a line; buffer it.
  let best = Infinity;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const [ax, ay] = cells[i];
      const [bx, by] = cells[j];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
  }
  return best <= pad;
}

/**
 * A planar ground reference: the lowest point of a robust plane fitted to
 * surrounding 4 m ground cells, at the footprint outline. Equal-weight cells
 * keep a dense scan strip from dominating, and the cells must surround the
 * building: extrapolating from a patch on one side is unsafe on hills.
 */
export function groundReference(footprint: MultiPolygon, index: PointIndex, margin = 25): number | null {
  const ground = surroundingGround(footprint, index, margin);
  if (ground.count < 20) return null;
  const cells = cellMedians(ground);
  if (cells.length < 8) return null;
  const [cx, cy] = centroid(footprint);
  const inner = representativePoint(footprint);
  if (!inner || !hullCovers(cells, inner[0], inner[1], 2)) return null;
  const n = cells.length;
  const design = new Float64Array(n * 3);
  const z = new Float64Array(n);
  cells.forEach(([x, y, h], k) => {
    design[3 * k] = x - cx;
    design[3 * k + 1] = y - cy;
    design[3 * k + 2] = 1;
    z[k] = h;
  });
  let keep = new Uint8Array(n).fill(1);
  let coef = [0, 0, 0];
  let residual = new Float64Array(n);
  for (let iteration = 0; iteration < 3; iteration++) {
    const kept: number[] = [];
    for (let k = 0; k < n; k++) if (keep[k]) kept.push(k);
    if (kept.length < 8) return null;
    const d = new Float64Array(kept.length * 3);
    const r = new Float64Array(kept.length);
    kept.forEach((k, m) => {
      d.set(design.subarray(3 * k, 3 * k + 3), 3 * m);
      r[m] = z[k];
    });
    const fit = lstsq(d, r, 3);
    if (fit.rank < 3) return null;
    coef = fit.coef;
    residual = new Float64Array(n);
    for (let k = 0; k < n; k++) residual[k] = z[k] - (design[3 * k] * coef[0] + design[3 * k + 1] * coef[1] + coef[2]);
    const limit = Math.max(0.5, 3 * median(kept.map((k) => Math.abs(residual[k]))));
    keep = new Uint8Array(n);
    for (let k = 0; k < n; k++) keep[k] = Math.abs(residual[k]) < limit ? 1 : 0;
  }
  let sum = 0;
  let count = 0;
  for (let k = 0; k < n; k++) {
    if (!keep[k]) continue;
    sum += residual[k] ** 2;
    count++;
  }
  if (Math.sqrt(sum / count) > 1) return null;
  let lowest = Infinity;
  for (const polygon of footprint) {
    const ring = polygon[0];
    // Shapely's exterior repeats the first point; it does not change the minimum.
    for (const [x, y] of ring) lowest = Math.min(lowest, (x - cx) * coef[0] + (y - cy) * coef[1] + coef[2]);
  }
  return lowest;
}

/**
 * A low ground cell and its location, for sites where the surrounding ground
 * is not one plane. The model aligns this exact location to its own terrain,
 * so a hillside keeps its shape. The surrounding cells must cover nearly the
 * whole footprint: ground on one side says nothing about the rest of a hill,
 * but a stadium flush with a riverbank has none on the water side.
 */
export function groundAnchor(footprint: MultiPolygon, index: PointIndex, margin = 25): [number, number, number] | null {
  const samples = surroundingGround(footprint, index, margin);
  if (samples.count < 20) return null;
  const cells = cellMedians(samples, 3, true);
  if (cells.length < 8) return null;
  const hull = hullShape(cells.flatMap((c) => [c[0], c[1]]));
  if (!hull.length) return null;
  const grown = buffer(hull, 2);
  const inner = representativePoint(footprint);
  if (!inner || !new Inside(grown).has(inner[0], inner[1])) return null;
  if (!intersects(grown, footprint) || multiArea(intersection(grown, footprint)) < area(footprint) * ANCHOR_COVERAGE) return null;
  const order = cells.map((_, k) => k).sort((a, b) => cells[a][2] - cells[b][2] || a - b);
  const pick = cells[order[Math.floor((cells.length - 1) * 0.1)]];
  return [pick[0], pick[1], pick[2]];
}
