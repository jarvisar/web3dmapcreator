// Planar helpers the building rules were tuned with, kept to the add-on's
// exact arithmetic: crossing-number containment, cell-centre sample grids and
// the shoelace sum in vertex order. Selection runs on raw lon/lat rings and
// the thresholds (90% coverage and so on) were set against these samples.
// Named apart from the geometry/polygon helpers, which don't behave the same.

import type { Ring, Vec2 } from '../../types';

/** Model-space distance below which two points are the same, in mm. */
export const EPSILON = 1e-4;

export type Bounds = [number, number, number, number];

/** Shoelace area, positive counter-clockwise. */
export function signedArea(points: readonly Vec2[]): number {
  const count = points.length;
  if (count < 3) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % count];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return 0.5 * sum;
}

/** Outer ring area less the holes', whatever their winding. */
export function planarArea(rings: readonly (readonly Vec2[])[]): number {
  let area = Math.abs(signedArea(rings[0]));
  for (let i = 1; i < rings.length; i++) area -= Math.abs(signedArea(rings[i]));
  return area;
}

export function planarBounds(points: readonly Vec2[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function pointInRing(x: number, y: number, ring: readonly Vec2[]): boolean {
  const count = ring.length;
  if (count < 3) return false;
  let inside = false;
  let previous = ring[count - 1];
  for (let i = 0; i < count; i++) {
    const current = ring[i];
    if (current[1] > y !== previous[1] > y) {
      const span = previous[1] - current[1];
      if (span !== 0) {
        const crossing = current[0] + ((y - current[1]) / span) * (previous[0] - current[0]);
        if (x < crossing) inside = !inside;
      }
    }
    previous = current;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInRings(x: number, y: number, rings: readonly (readonly Vec2[])[]): boolean {
  if (!rings.length || !pointInRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, y, rings[i])) return false;
  return true;
}

/**
 * Cell-centre grid points inside a polygon. A huge polygon coarsens the grid
 * first and any surplus is strided rather than truncated, so the samples are
 * never confined to the bottom rows.
 */
export function interiorGridPoints(rings: readonly (readonly Vec2[])[], spacing: number, limit = 1200): Vec2[] {
  if (!rings.length || !(spacing > 0) || rings[0].length < 3 || limit < 1) return [];
  const [minX, minY, maxX, maxY] = planarBounds(rings[0]);
  if (maxX <= minX || maxY <= minY) return [];
  let columns = Math.max(1, Math.trunc((maxX - minX) / spacing));
  let rows = Math.max(1, Math.trunc((maxY - minY) / spacing));
  const cap = limit * 3;
  if (columns * rows > cap) {
    const thinning = Math.sqrt((columns * rows) / cap);
    columns = Math.max(1, Math.trunc(columns / thinning));
    rows = Math.max(1, Math.trunc(rows / thinning));
  }
  let samples: Vec2[] = [];
  for (let row = 0; row < rows; row++) {
    const y = minY + ((maxY - minY) * (row + 0.5)) / rows;
    for (let column = 0; column < columns; column++) {
      const x = minX + ((maxX - minX) * (column + 0.5)) / columns;
      if (pointInRings(x, y, rings)) samples.push([x, y]);
    }
  }
  if (samples.length > limit) {
    const stride = samples.length / limit;
    const kept: Vec2[] = [];
    for (let i = 0; i < limit; i++) kept.push(samples[Math.trunc(i * stride)]);
    samples = kept;
  }
  return samples;
}

/** Drop repeated vertices and the closing duplicate. Empty when fewer than three remain or the area is negligible. */
export function cleanPlanarRing(points: readonly Vec2[], epsilon = EPSILON): Ring {
  const clean: Ring = [];
  for (const [x, y] of points) {
    const last = clean[clean.length - 1];
    if (!last || Math.abs(x - last[0]) > epsilon || Math.abs(y - last[1]) > epsilon) clean.push([x, y]);
  }
  if (clean.length > 1) {
    const first = clean[0];
    const last = clean[clean.length - 1];
    if (Math.abs(first[0] - last[0]) <= epsilon && Math.abs(first[1] - last[1]) <= epsilon) clean.pop();
  }
  if (clean.length < 3 || Math.abs(signedArea(clean)) <= epsilon) return [];
  return clean;
}

/** Twice area over perimeter: tells a 2 m x 60 m wall from a small house of the same area. */
export function ringWidth(ring: readonly Vec2[]): number {
  const count = ring.length;
  if (count < 3) return 0;
  let perimeter = 0;
  for (let i = 0; i < count; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % count];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return perimeter > 0 ? (2 * Math.abs(signedArea(ring))) / perimeter : 0;
}

export function ringCentroid(ring: readonly Vec2[]): Vec2 {
  const area = signedArea(ring);
  const count = ring.length;
  if (Math.abs(area) <= 1e-12) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / count, sy / count];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < count; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % count];
    const cross = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/** Whether a counter-clockwise ring turns left (or runs straight) at every vertex. */
export function isConvex(ring: readonly Vec2[]): boolean {
  const count = ring.length;
  if (count < 3) return false;
  for (let i = 0; i < count; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % count];
    const c = ring[(i + 2) % count];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < 0) return false;
  }
  return true;
}
