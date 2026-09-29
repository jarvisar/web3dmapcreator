// Polyline helpers and a grid of segments for "what runs near this point".

import type { Vec2 } from '../../types';
import { dedupe } from '../linework';

export function cumulative(points: Vec2[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return out;
}

/** The segment holding arc length `s`, searched from `from`. */
export function locate(cum: number[], s: number, from = 0): number {
  let i = Math.max(0, Math.min(from, cum.length - 2));
  while (i < cum.length - 2 && cum[i + 1] < s) i++;
  while (i > 0 && cum[i] > s) i--;
  return i;
}

export function pointAt(points: Vec2[], cum: number[], s: number, segment = locate(cum, s)): Vec2 {
  const a = points[segment];
  const b = points[segment + 1];
  const span = cum[segment + 1] - cum[segment];
  const f = span > 0 ? Math.min(1, Math.max(0, (s - cum[segment]) / span)) : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** The part of a polyline between arc lengths s0 and s1. */
export function slice(points: Vec2[], cum: number[], s0: number, s1: number): Vec2[] {
  const i0 = locate(cum, s0);
  const i1 = locate(cum, s1, i0);
  const out: Vec2[] = [pointAt(points, cum, s0, i0)];
  for (let i = i0 + 1; i <= i1; i++) out.push(points[i]);
  out.push(pointAt(points, cum, s1, i1));
  return dedupe(out);
}

export interface Sample {
  x: number;
  y: number;
  ux: number;
  uy: number;
}

/** Midpoints of `count` equal intervals along a polyline, with the heading there. */
export function intervals(points: Vec2[], cum: number[], count: number): Sample[] {
  const total = cum[cum.length - 1];
  const out: Sample[] = [];
  let segment = 0;
  for (let k = 0; k < count; k++) {
    const s = ((k + 0.5) * total) / count;
    segment = locate(cum, s, segment);
    const a = points[segment];
    const b = points[segment + 1];
    const span = cum[segment + 1] - cum[segment] || 1;
    const f = (s - cum[segment]) / span;
    out.push({ x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, ux: (b[0] - a[0]) / span, uy: (b[1] - a[1]) / span });
  }
  return out;
}

export function unit(a: Vec2, b: Vec2): Vec2 | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  return length > 1e-12 ? [dx / length, dy / length] : null;
}

/** Heading of a line arriving at one of its ends. */
export function endHeading(points: Vec2[], end: 0 | 1): Vec2 | null {
  return end === 0 ? unit(points[1], points[0]) : unit(points[points.length - 2], points[points.length - 1]);
}

/**
 * Segments bucketed on a grid. Each is filed under every cell it passes
 * through, so with a cell at least as large as the query radius the 3 x 3
 * cells around a point hold everything in reach.
 */
export class SegmentIndex {
  readonly ax: number[] = [];
  readonly ay: number[] = [];
  readonly bx: number[] = [];
  readonly by: number[] = [];
  readonly ux: number[] = [];
  readonly uy: number[] = [];
  readonly length: number[] = [];
  /** Arc length along the owner's line where the segment starts. */
  readonly from: number[] = [];
  readonly owner: number[] = [];
  /** Whether the segment's start (or end) is an end of its line rather than a joint. */
  readonly first: boolean[] = [];
  readonly last: boolean[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly seen: number[] = [];
  private stamp = 0;

  constructor(readonly cell: number) {}

  get size(): number {
    return this.owner.length;
  }

  add(points: Vec2[], owner: number, ends: [boolean, boolean] = [true, true]): void {
    let firstSegment = -1;
    let lastSegment = -1;
    for (let i = 1; i < points.length; i++) {
      if (points[i][0] !== points[i - 1][0] || points[i][1] !== points[i - 1][1]) {
        if (firstSegment < 0) firstSegment = i;
        lastSegment = i;
      }
    }
    let from = 0;
    for (let i = firstSegment; i >= 1 && i <= lastSegment; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const length = Math.hypot(bx - ax, by - ay);
      if (length === 0) continue;
      const id = this.owner.length;
      this.ax.push(ax);
      this.ay.push(ay);
      this.bx.push(bx);
      this.by.push(by);
      this.ux.push((bx - ax) / length);
      this.uy.push((by - ay) / length);
      this.length.push(length);
      this.from.push(from);
      this.owner.push(owner);
      this.first.push(i === firstSegment && ends[0]);
      this.last.push(i === lastSegment && ends[1]);
      this.seen.push(0);
      this.file(id, ax, ay, bx, by);
      from += length;
    }
  }

  // Walk the cells a segment crosses.
  private file(id: number, ax: number, ay: number, bx: number, by: number): void {
    const c = this.cell;
    let cx = Math.floor(ax / c);
    let cy = Math.floor(ay / c);
    const ex = Math.floor(bx / c);
    const ey = Math.floor(by / c);
    const dx = bx - ax;
    const dy = by - ay;
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    let tx = dx !== 0 ? ((sx > 0 ? (cx + 1) * c : cx * c) - ax) / dx : Infinity;
    let ty = dy !== 0 ? ((sy > 0 ? (cy + 1) * c : cy * c) - ay) / dy : Infinity;
    const stepX = dx !== 0 ? c / Math.abs(dx) : Infinity;
    const stepY = dy !== 0 ? c / Math.abs(dy) : Infinity;
    this.put(cx, cy, id);
    let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
    while ((cx !== ex || cy !== ey) && guard-- > 0) {
      if (tx < ty) {
        tx += stepX;
        cx += sx;
      } else {
        ty += stepY;
        cy += sy;
      }
      this.put(cx, cy, id);
    }
  }

  private put(cx: number, cy: number, id: number): void {
    const key = (cx + 1048576) * 2097152 + (cy + 1048576);
    const list = this.cells.get(key);
    if (list) list.push(id);
    else this.cells.set(key, [id]);
  }

  /** Visit each segment filed within one cell of the point, once. Stops when `visit` returns true. */
  near(x: number, y: number, visit: (segment: number) => boolean | void): boolean {
    const stamp = ++this.stamp;
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.cells.get((cx + i + 1048576) * 2097152 + (cy + j + 1048576));
        if (!list) continue;
        for (const id of list) {
          if (this.seen[id] === stamp) continue;
          this.seen[id] = stamp;
          if (visit(id)) return true;
        }
      }
    }
    return false;
  }

  /** Position of the closest point of a segment to (x, y), 0 to 1 unclamped. */
  along(segment: number, x: number, y: number): number {
    return ((x - this.ax[segment]) * this.ux[segment] + (y - this.ay[segment]) * this.uy[segment]) / this.length[segment];
  }

  distance(segment: number, x: number, y: number, t = this.along(segment, x, y)): number {
    const f = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = this.ax[segment] + (this.bx[segment] - this.ax[segment]) * f;
    const py = this.ay[segment] + (this.by[segment] - this.ay[segment]) * f;
    return Math.hypot(x - px, y - py);
  }

  closest(segment: number, x: number, y: number): Vec2 {
    const t = this.along(segment, x, y);
    const f = t < 0 ? 0 : t > 1 ? 1 : t;
    return [this.ax[segment] + (this.bx[segment] - this.ax[segment]) * f, this.ay[segment] + (this.by[segment] - this.ay[segment]) * f];
  }
}
