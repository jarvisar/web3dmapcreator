// Polygon helpers for LiDAR measurement, in a local metric frame (metres).
// The booleans are the model's Clipper wrappers, which work in any unit: in
// metres their grid is a tenth of a millimetre.

import { boxesOverlap, intersection, offsetPolygons, multiArea, multiBounds, pointInPolygon, ringArea, type Box } from '../geometry/polygon';
import type { MultiPolygon, Polygon, Ring, Vec2 } from '../types';
import { minimumAreaRectangle, pyDist } from './geos';

export type { Box };

/** Shapely's buffer: round joins. A negative distance shrinks. */
export function buffer(shape: MultiPolygon, distance: number, join: 'round' | 'miter' = 'round'): MultiPolygon {
  if (!shape.length) return [];
  return offsetPolygons(shape, distance, join);
}

export const area = multiArea;
export const bounds = multiBounds;

export function isEmpty(shape: MultiPolygon): boolean {
  return !shape.length || multiArea(shape) <= 0;
}

/** Area-weighted centroid, holes subtracted. */
export function centroid(shape: MultiPolygon): Vec2 {
  // GEOS's Centroid, as Shapely runs it: triangles fanned from each shell's
  // first vertex. Grids are laid out around it, so it has to match to the bit.
  let cx = 0;
  let cy = 0;
  let a2sum = 0;
  for (const polygon of shape) {
    if (!polygon.length || !polygon[0].length) continue;
    const base = polygon[0][0];
    polygon.forEach((ring, r) => {
      // A clockwise shell and a counterclockwise hole count positive.
      const sign = (ringArea(ring) > 0) === (r > 0) ? 1.0 : -1.0;
      for (let i = 0, n = ring.length; i < n; i++) {
        const p1 = ring[i];
        const p2 = ring[(i + 1) % n];
        const a2 = (p1[0] - base[0]) * (p2[1] - base[1]) - (p2[0] - base[0]) * (p1[1] - base[1]);
        cx += sign * a2 * (base[0] + p1[0] + p2[0]);
        cy += sign * a2 * (base[1] + p1[1] + p2[1]);
        a2sum += sign * a2;
      }
    });
  }
  if (!a2sum) {
    const [x0, y0, x1, y1] = multiBounds(shape);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  return [cx / 3 / a2sum, cy / 3 / a2sum];
}

/**
 * A point guaranteed inside, like GEOS's point on surface: the middle of the
 * widest interior run on a line across the largest polygon's middle.
 */
export function representativePoint(shape: MultiPolygon): Vec2 | null {
  let best: Polygon | null = null;
  let bestArea = 0;
  for (const polygon of shape) {
    const a = Math.abs(ringArea(polygon[0]));
    if (a > bestArea) {
      bestArea = a;
      best = polygon;
    }
  }
  if (!best) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of best[0]) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  let y = (minY + maxY) / 2;
  // Avoid running exactly through a vertex: pick the middle of the widest gap between vertex heights.
  const ys = [...new Set(best.flatMap((ring) => ring.map((p) => p[1])))].sort((p, q) => p - q);
  let gap = 0;
  for (let i = 1; i < ys.length; i++) {
    const mid = (ys[i] + ys[i - 1]) / 2;
    if (ys[i] - ys[i - 1] > gap && Math.abs(mid - y) <= (maxY - minY) / 2) {
      if (ys[i - 1] <= y && y <= ys[i]) {
        y = mid;
        break;
      }
    }
  }
  const xs: number[] = [];
  for (const ring of best) {
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
  }
  xs.sort((p, q) => p - q);
  let width = -1;
  let x = NaN;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k + 1] - xs[k] > width) {
      width = xs[k + 1] - xs[k];
      x = (xs[k] + xs[k + 1]) / 2;
    }
  }
  return Number.isFinite(x) ? [x, y] : null;
}

/** Convex hull by the monotone chain, counter-clockwise, no repeated closing point. */
export function convexHull(points: ArrayLike<number>, count = points.length / 2): Ring {
  const order = Array.from({ length: count }, (_, i) => i);
  order.sort((a, b) => points[2 * a] - points[2 * b] || points[2 * a + 1] - points[2 * b + 1]);
  const cross = (o: number, a: number, b: number) =>
    (points[2 * a] - points[2 * o]) * (points[2 * b + 1] - points[2 * o + 1]) -
    (points[2 * a + 1] - points[2 * o + 1]) * (points[2 * b] - points[2 * o]);
  const lower: number[] = [];
  for (const i of order) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper].map((i) => [points[2 * i], points[2 * i + 1]] as Vec2);
}

/** Hull as a polygon set, empty when the points are collinear. */
export function hullShape(points: ArrayLike<number>, count = points.length / 2): MultiPolygon {
  const hull = convexHull(points, count);
  return hull.length >= 3 && ringArea(hull) > 0 ? [[hull]] : [];
}

/**
 * Start each ring of `result` where the same ring starts in `source`. A
 * Clipper union keeps a valid ring's vertices but picks its own first one,
 * and GEOS, which the add-on leaves such rings to, keeps the input's. The
 * centroid, and with it every grid laid out around it, depends on which
 * vertex comes first. Reversed or changed rings are left alone.
 */
export function keepStart(result: MultiPolygon, source: MultiPolygon): MultiPolygon {
  const firsts = new Map<string, Vec2>();
  for (const polygon of source) for (const ring of polygon) if (ring.length) firsts.set(`${ring[0][0]},${ring[0][1]}`, ring[0]);
  return result.map((polygon) =>
    polygon.map((ring) => {
      const at = ring.findIndex(([x, y]) => firsts.has(`${x},${y}`));
      if (at <= 0) return ring;
      const turned = [...ring.slice(at), ...ring.slice(0, at)];
      const original = source.flatMap((p) => p).find((r) => r.length && r[0][0] === turned[0][0] && r[0][1] === turned[0][1]);
      const same = original && original.length === turned.length && original.every((p, i) => p[0] === turned[i][0] && p[1] === turned[i][1]);
      return same ? turned : ring;
    }),
  );
}

/** The corners of Shapely's minimum_rotated_rectangle, in its order. */
export function minimumRotatedRectangle(shape: MultiPolygon): Vec2[] {
  const points = shape.flatMap((polygon) => polygon[0]);
  const corners = minimumAreaRectangle(points);
  if (corners) return corners;
  const [x0, y0, x1, y1] = multiBounds(shape);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/**
 * Direction of the longest side of the minimum rotated rectangle, in radians,
 * as `max(zip(corners, corners[1:]), key=math.dist)` picks it: the first of
 * equal sides, and opposite sides are often equal to within a few ulps.
 */
export function longAxis(shape: MultiPolygon): number {
  const corners = minimumRotatedRectangle(shape);
  let best = -1;
  let angle = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const length = pyDist(a, b);
    if (length > best) {
      best = length;
      angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  return angle;
}

/** Python's float %, whose result takes the sign of the divisor. */
export function pyMod(x: number, m: number): number {
  const r = x % m;
  if (r === 0) return m < 0 ? -0 : 0;
  return r < 0 !== m < 0 ? r + m : r;
}

/** Rotate about `origin` by `angle` radians (counter-clockwise), as shapely.affinity.rotate does to the bit. */
export function rotate(shape: MultiPolygon, angle: number, origin: Vec2): MultiPolygon {
  if (!angle) return shape;
  let c = Math.cos(angle);
  let s = Math.sin(angle);
  if (Math.abs(c) < 2.5e-16) c = 0;
  if (Math.abs(s) < 2.5e-16) s = 0;
  const [x0, y0] = origin;
  const xoff = x0 - x0 * c + y0 * s;
  const yoff = y0 - x0 * s - y0 * c;
  return shape.map((polygon) => polygon.map((ring) => ring.map(([x, y]) => [c * x + -s * y + xoff, s * x + c * y + yoff] as Vec2)));
}

export function boxShape(x0: number, y0: number, x1: number, y1: number): MultiPolygon {
  return [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]];
}

/**
 * Fast repeated point-in-shape tests. Edges are bucketed into horizontal
 * strips, so a test only crosses the edges near its row.
 */
export class Inside {
  private readonly y0: number;
  private readonly step: number;
  private readonly strips: Float64Array[];
  readonly box: Box;

  constructor(shape: MultiPolygon, strips = 0) {
    this.box = multiBounds(shape);
    const edges: number[] = [];
    for (const polygon of shape) {
      for (const ring of polygon) {
        for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
          if (ring[j][1] === ring[i][1]) continue;
          edges.push(ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
        }
      }
    }
    const count = edges.length / 4;
    const n = Math.max(1, strips || Math.min(4096, Math.ceil(Math.sqrt(count) * 2)));
    const height = this.box[3] - this.box[1];
    this.y0 = this.box[1];
    this.step = height > 0 ? height / n : 1;
    const lists: number[][] = Array.from({ length: n }, () => []);
    for (let e = 0; e < count; e++) {
      const ya = edges[4 * e + 1];
      const yb = edges[4 * e + 3];
      const s0 = Math.max(0, Math.floor((Math.min(ya, yb) - this.y0) / this.step));
      const s1 = Math.min(n - 1, Math.floor((Math.max(ya, yb) - this.y0) / this.step));
      for (let s = s0; s <= s1; s++) lists[s].push(edges[4 * e], ya, edges[4 * e + 2], yb);
    }
    this.strips = lists.map((list) => Float64Array.from(list));
  }

  has(x: number, y: number): boolean {
    const b = this.box;
    if (!(x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])) return false;
    const s = Math.min(this.strips.length - 1, Math.max(0, Math.floor((y - this.y0) / this.step)));
    const edges = this.strips[s];
    let winding = 0;
    for (let k = 0; k < edges.length; k += 4) {
      const x1 = edges[k];
      const y1 = edges[k + 1];
      const x2 = edges[k + 2];
      const y2 = edges[k + 3];
      if (y1 <= y) {
        if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) winding++;
      } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) winding--;
    }
    return winding !== 0;
  }
}

/** Whether two shapes share any area. Touching along an edge alone does not count. */
export function intersects(a: MultiPolygon, b: MultiPolygon): boolean {
  if (!a.length || !b.length || !boxesOverlap(multiBounds(a), multiBounds(b))) return false;
  return multiArea(intersection(a, b)) > 0;
}

/** Point-in-shape for one point, without building an index. */
export function contains(shape: MultiPolygon, x: number, y: number): boolean {
  for (const polygon of shape) if (pointInPolygon(x, y, polygon)) return true;
  return false;
}

/** Distance from a point to the nearest boundary edge, and the nearest boundary point. */
export function nearestOnBoundary(shape: MultiPolygon, x: number, y: number): { distance: number; point: Vec2 } {
  let best = Infinity;
  let point: Vec2 = [x, y];
  for (const polygon of shape) {
    for (const ring of polygon) {
      for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
        const [ax, ay] = ring[j];
        const [bx, by] = ring[i];
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx;
        const py = ay + t * dy;
        const d = Math.hypot(x - px, y - py);
        if (d < best) {
          best = d;
          point = [px, py];
        }
      }
    }
  }
  return { distance: best, point };
}

/** Each polygon of a set on its own, like iterating Shapely's MultiPolygon.geoms. */
export function pieces(shape: MultiPolygon): MultiPolygon[] {
  return shape.map((polygon) => [polygon]);
}

/** Total length of every ring. */
export function perimeter(shape: MultiPolygon): number {
  let total = 0;
  for (const polygon of shape) {
    for (const ring of polygon) {
      for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) total += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
    }
  }
  return total;
}

/** Signed area of a ring clipped to a box (Sutherland-Hodgman on each side). */
function clippedRingArea(ring: Ring, x0: number, y0: number, x1: number, y1: number): number {
  let points: number[] = [];
  for (const [x, y] of ring) points.push(x, y);
  const side = (keep: (x: number, y: number) => boolean, cross: (ax: number, ay: number, bx: number, by: number) => [number, number]) => {
    const out: number[] = [];
    const n = points.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = points[2 * ((i + n - 1) % n)];
      const ay = points[2 * ((i + n - 1) % n) + 1];
      const bx = points[2 * i];
      const by = points[2 * i + 1];
      const aIn = keep(ax, ay);
      const bIn = keep(bx, by);
      if (aIn !== bIn) out.push(...cross(ax, ay, bx, by));
      if (bIn) out.push(bx, by);
    }
    points = out;
  };
  side(
    (x) => x >= x0,
    (ax, ay, bx, by) => [x0, ay + ((x0 - ax) / (bx - ax)) * (by - ay)],
  );
  if (!points.length) return 0;
  side(
    (x) => x <= x1,
    (ax, ay, bx, by) => [x1, ay + ((x1 - ax) / (bx - ax)) * (by - ay)],
  );
  if (!points.length) return 0;
  side(
    (_x, y) => y >= y0,
    (ax, ay, bx, by) => [ax + ((y0 - ay) / (by - ay)) * (bx - ax), y0],
  );
  if (!points.length) return 0;
  side(
    (_x, y) => y <= y1,
    (ax, ay, bx, by) => [ax + ((y1 - ay) / (by - ay)) * (bx - ax), y1],
  );
  let sum = 0;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) sum += (points[2 * j] - points[2 * i]) * (points[2 * j + 1] + points[2 * i + 1]);
  return sum / 2;
}

/**
 * Area of `shape` inside each cell of a grid: cell (i, j) spans
 * [x0 + i * cell, x0 + (i + 1) * cell] and likewise in y, stored at i * ny + j.
 * Only cells an outline edge passes through are clipped; the rest are full or empty.
 */
export function cellAreas(shape: MultiPolygon, x0: number, y0: number, cell: number, nx: number, ny: number): Float64Array {
  const out = new Float64Array(nx * ny);
  const touched = new Uint8Array(nx * ny);
  for (const polygon of shape) {
    for (const ring of polygon) {
      for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
        const [ax, ay] = ring[j];
        const [bx, by] = ring[i];
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - x0) / cell));
        const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) - x0) / cell));
        const j0 = Math.max(0, Math.floor((Math.min(ay, by) - y0) / cell));
        const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) - y0) / cell));
        for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) touched[a * ny + b] = 1;
      }
    }
  }
  const test = new Inside(shape);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = i * ny + j;
      const cx0 = x0 + i * cell;
      const cy0 = y0 + j * cell;
      if (!touched[c]) {
        out[c] = test.has(cx0 + cell / 2, cy0 + cell / 2) ? cell * cell : 0;
        continue;
      }
      let a = 0;
      for (const polygon of shape) {
        polygon.forEach((ring, r) => {
          const part = Math.abs(clippedRingArea(ring, cx0, cy0, cx0 + cell, cy0 + cell));
          a += r === 0 ? part : -part;
        });
      }
      out[c] = Math.max(0, a);
    }
  }
  return out;
}

/** Area of `shape` inside one box. */
export function boxArea(shape: MultiPolygon, x0: number, y0: number, x1: number, y1: number): number {
  let a = 0;
  for (const polygon of shape) {
    polygon.forEach((ring, r) => {
      const part = Math.abs(clippedRingArea(ring, x0, y0, x1, y1));
      a += r === 0 ? part : -part;
    });
  }
  return Math.max(0, a);
}

/** Area of `shape` inside a convex counter-clockwise window. */
export function convexArea(shape: MultiPolygon, window: Vec2[]): number {
  let a = 0;
  for (const polygon of shape) {
    polygon.forEach((ring, r) => {
      let points = ring.map(([x, y]) => [x, y] as Vec2);
      for (let k = 0; k < window.length && points.length; k++) {
        const [ax, ay] = window[k];
        const [bx, by] = window[(k + 1) % window.length];
        const side = (p: Vec2) => (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
        const out: Vec2[] = [];
        for (let i = 0; i < points.length; i++) {
          const p = points[(i + points.length - 1) % points.length];
          const q = points[i];
          const sp = side(p);
          const sq = side(q);
          if (sp >= 0 !== sq >= 0) {
            const t = sp / (sp - sq);
            out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
          }
          if (sq >= 0) out.push(q);
        }
        points = out;
      }
      const part = Math.abs(ringArea(points));
      a += r === 0 ? part : -part;
    });
  }
  return Math.max(0, a);
}

/** Douglas-Peucker on an open polyline, endpoints kept. */
export function douglasPeucker(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = points[i];
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A closed ring simplified with its first point fixed; the ring is kept whole if it would collapse. */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  const closed = [...ring, ring[0]];
  const out = douglasPeucker(closed, tolerance);
  out.pop();
  return out.length >= 3 && Math.abs(ringArea(out)) > 0 ? out : ring;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Collinear overlap is also invalid.
  const on = (p: Vec2, q: Vec2, r: Vec2) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
  return false;
}

/** No ring crosses itself or another ring, and every ring encloses area. Touching at a vertex is allowed. */
export function isValidPolygon(polygon: Polygon): boolean {
  const edges: [Vec2, Vec2, number, number][] = [];
  for (let r = 0; r < polygon.length; r++) {
    const ring = polygon[r];
    if (ring.length < 3 || ringArea(ring) === 0) return false;
    for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length], r, i]);
  }
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b, ra, ia] = edges[i];
      const [c, d, rc, ic] = edges[j];
      if (ra === rc) {
        const n = polygon[ra].length;
        if (Math.abs(ia - ic) === 1 || Math.abs(ia - ic) === n - 1) continue;
      }
      if (segmentsCross(a, b, c, d)) return false;
    }
  }
  return true;
}

function ringSegmentsDistance(x: number, y: number, rings: Ring[]): number {
  let best = Infinity;
  for (const ring of rings) {
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
  return best;
}

/** GEOS's discrete Hausdorff distance between two sets of rings: vertices of each to the other's segments. */
export function hausdorff(a: Ring[], b: Ring[]): number {
  let worst = 0;
  for (const ring of a) for (const [x, y] of ring) worst = Math.max(worst, ringSegmentsDistance(x, y, b));
  for (const ring of b) for (const [x, y] of ring) worst = Math.max(worst, ringSegmentsDistance(x, y, a));
  return worst;
}

/**
 * Shapely's simplify(tolerance) with topology kept: each ring simplified on
 * its own, and a ring that would then cross another keeps its original shape.
 */
export function simplifyShape(shape: MultiPolygon, tolerance: number): MultiPolygon {
  return shape.map((polygon) => {
    const simplified = polygon.map((ring) => simplifyRing(ring, tolerance));
    if (isValidPolygon(simplified)) return simplified;
    // Put rings back one at a time until the polygon is valid again.
    const out = simplified.slice();
    for (let r = 0; r < polygon.length && !isValidPolygon(out); r++) out[r] = polygon[r];
    return isValidPolygon(out) ? out : polygon;
  });
}

/** Python's round(): halves go to the even neighbour. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
