// Where a title fits on the piece. Every shape is convex, so a box fits
// wherever its four corners do, and the spots it fits form a convex region.
import type { Point } from '../lines/geometry';
import { closestPointOnSegment } from '../lines/geometry';
import { type Shape, shapeCentre, shapePolygon } from '../layout/shapes';

function clipHalfPlane(region: Point[], nx: number, ny: number, d: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < region.length; i++) {
    const a = region[i];
    const b = region[(i + 1) % region.length];
    const da = nx * a[0] + ny * a[1] - d;
    const db = nx * b[0] + ny * b[1] - d;
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// Centres where a w by h box fits inside the shape, as a convex polygon.
// Empty when it doesn't fit anywhere.
export function boxCentres(shape: Shape, w: number, h: number): Point[] {
  const ring = shapePolygon(shape);
  const [cx, cy] = shapeCentre(shape);
  let region: Point[] = [
    [shape.x, shape.y],
    [shape.x + shape.w, shape.y],
    [shape.x + shape.w, shape.y + shape.h],
    [shape.x, shape.y + shape.h],
  ];
  for (let i = 0; i < ring.length && region.length > 0; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    let nx = p[1] - q[1];
    let ny = q[0] - p[0];
    const length = Math.hypot(nx, ny);
    if (length === 0) continue;
    nx /= length;
    ny /= length;
    if (nx * (cx - p[0]) + ny * (cy - p[1]) < 0) {
      nx = -nx;
      ny = -ny;
    }
    // A hair of slack so a box exactly as wide as the shape still fits.
    const d = nx * p[0] + ny * p[1] + (Math.abs(nx) * w) / 2 + (Math.abs(ny) * h) / 2 - 1e-9;
    region = clipHalfPlane(region, nx, ny, d);
  }
  return region;
}

function convexContains(region: Point[], p: Point): boolean {
  let sign = 0;
  for (let i = 0; i < region.length; i++) {
    const a = region[i];
    const b = region[(i + 1) % region.length];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

// The point of a convex region nearest to p, with x and y distances
// multiplied by wx and wy. Null for an empty region.
export function nearestIn(region: Point[], p: Point, wx = 1, wy = 1): Point | null {
  if (region.length === 0) return null;
  if (region.length >= 3 && convexContains(region, p)) return [p[0], p[1]];
  const scaled = region.map(([x, y]): Point => [x * wx, y * wy]);
  const target: Point = [p[0] * wx, p[1] * wy];
  let best: Point = scaled[0];
  let bestD = Infinity;
  for (let i = 0; i < scaled.length; i++) {
    const q = closestPointOnSegment(target, scaled[i], scaled[(i + 1) % scaled.length]);
    const d = (q[0] - target[0]) ** 2 + (q[1] - target[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return [best[0] / wx, best[1] / wy];
}

// Where the line x = value (axis 0) or y = value (axis 1) crosses a convex
// region, as a range along the other axis, or null when it misses.
export function regionSlice(region: Point[], axis: 0 | 1, value: number): [number, number] | null {
  const other = axis === 0 ? 1 : 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < region.length; i++) {
    const a = region[i];
    const b = region[(i + 1) % region.length];
    if (a[axis] === value) {
      lo = Math.min(lo, a[other]);
      hi = Math.max(hi, a[other]);
    }
    if (a[axis] < value !== b[axis] < value && a[axis] !== b[axis]) {
      const t = (value - a[axis]) / (b[axis] - a[axis]);
      const v = a[other] + (b[other] - a[other]) * t;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

// Where the row at y crosses the shape, or null past its top or bottom.
export function rowSpan(shape: Shape, y: number): [number, number] | null {
  if (y < shape.y - 1e-9 || y > shape.y + shape.h + 1e-9) return null;
  const [cx, cy] = shapeCentre(shape);
  const dy = Math.abs(y - cy);
  let half: number;
  if (shape.kind === 'circle') half = Math.sqrt(Math.max(0, shape.r * shape.r - dy * dy));
  else if (shape.kind === 'hexagon') half = Math.max(0, shape.r - dy / Math.sqrt(3));
  else {
    half = shape.w / 2;
    const r = shape.kind === 'rounded' ? shape.r : 0;
    const into = dy - (shape.h / 2 - r);
    if (r > 0 && into > 0) half -= r - Math.sqrt(Math.max(0, r * r - into * into));
  }
  return [cx - half, cx + half];
}

// The part of every row from y0 to y1 inside the shape. Convex shapes are
// narrowest at one end or the other.
export function rowsSpan(shape: Shape, y0: number, y1: number): [number, number] | null {
  const a = rowSpan(shape, y0);
  const b = rowSpan(shape, y1);
  if (!a || !b) return null;
  return [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
}
