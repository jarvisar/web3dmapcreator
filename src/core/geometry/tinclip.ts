// A triangulated height surface (TIN) cut to a polygon region.
//
// Every TIN edge and every region edge goes into one constrained Delaunay
// triangulation, with the points where they cross added once each. So each
// output triangle lies inside one TIN face and on one side of the region
// outline, faces share their corners by construction, and heights come
// from the TIN face above them. Clipping each face on its own and matching
// the pieces back up by coordinate is what the add-on did first, and float
// rounding at the crossings left cracks that failed 155 buildings of
// downtown Chicago.

import Constrainautor from '@kninnug/constrainautor';
import Delaunator from 'delaunator';
import type { MultiPolygon } from '../types';
import { offsetPolygons, ringArea } from './polygon';

export interface Tin {
  /** xyz triplets. */
  vertices: Float64Array;
  /** Counter-clockwise (in plan) vertex index triplets. */
  triangles: Uint32Array;
}

/** Points closer than this in plan are one point, and a point this close to an edge lies on it. */
function defaultEpsilon(tin: Tin, region: MultiPolygon): number {
  let extent = 0;
  for (let i = 0; i < tin.vertices.length; i += 3) extent = Math.max(extent, Math.abs(tin.vertices[i]), Math.abs(tin.vertices[i + 1]));
  for (const polygon of region) for (const ring of polygon) for (const [x, y] of ring) extent = Math.max(extent, Math.abs(x), Math.abs(y));
  return Math.max(1e-9, extent * 1e-11);
}

class PointTable {
  xs: number[] = [];
  ys: number[] = [];
  // Cell column, then row. Cells are far too many to pack into one number.
  private readonly grid = new Map<number, Map<number, number[]>>();

  constructor(private readonly eps: number) {}

  private cell(v: number): number {
    return Math.floor(v / (this.eps * 4));
  }

  add(x: number, y: number): number {
    const cx = this.cell(x);
    const cy = this.cell(y);
    const eps = this.eps;
    for (let dx = -1; dx <= 1; dx++) {
      const column = this.grid.get(cx + dx);
      if (!column) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const list = column.get(cy + dy);
        if (!list) continue;
        for (const id of list) if (Math.abs(this.xs[id] - x) <= eps && Math.abs(this.ys[id] - y) <= eps) return id;
      }
    }
    const id = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    let column = this.grid.get(cx);
    if (!column) this.grid.set(cx, (column = new Map()));
    const list = column.get(cy);
    if (list) list.push(id);
    else column.set(cy, [id]);
    return id;
  }
}

interface Segment {
  a: number;
  b: number;
  /** Split points along the segment: parameter and point id. */
  splits: [number, number][];
}

/** Parameter of the projection of (x, y) on a-b, and its distance from the segment. */
function project(x: number, y: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return [t, Math.hypot(x - (ax + c * dx), y - (ay + c * dy))];
}

function nextEdge(e: number): number {
  return e % 3 === 2 ? e - 2 : e + 1;
}

/**
 * The part of `tin` inside `region`, with no triangles when none of it is,
 * or null when the triangulation fails. A print section needs to tell those
 * apart. Where the region reaches past the TIN there is simply no surface.
 * Region rings may be in any orientation, outer rings and holes are told
 * apart by the NonZero rule the polygon helpers use (outer counter-clockwise,
 * holes clockwise).
 */
export function clipTin(tin: Tin, region: MultiPolygon, epsilon?: number): Tin | null {
  const eps = epsilon ?? defaultEpsilon(tin, region);
  const out = clipBand(tin, region, eps);
  if (out !== FAILED) return out ?? emptyTin();
  // An outline that grazes the TIN's vertices can leave the constrained
  // triangulation stuck. Moving it in by a millionth of the extent almost
  // always gets clear, and callers compare areas with more slack than that.
  const retried = clipBand(tin, offsetPolygons(region, -eps * 1e5), eps);
  if (retried !== FAILED) return retried ?? emptyTin();
  // A TIN cut before (a LiDAR only surface cut along its water) can have
  // vertices a few millionths of a mm apart where that cut ran close by, and
  // cutting it again got stuck on them or walked off the hull. Merged at
  // SNAP_MM and triangulated inside a frame, only those slivers are lost.
  const snapped = clipBand(tin, region, Math.max(eps, SNAP_MM), true);
  return snapped === FAILED ? null : (snapped ?? emptyTin());
}

// Under a third of PINCH_MM, and the least that got every stuck section
// of the fuzzed LiDAR only models through.
const SNAP_MM = 3e-5;

const emptyTin = (): Tin => ({ vertices: new Float64Array(0), triangles: new Uint32Array(0) });

const FAILED = Symbol('failed');

// Below this many triangles the whole TIN goes into one triangulation.
const BAND_MIN = 4096;

/**
 * A large TIN (a LiDAR Only model's is a few hundred thousand triangles)
 * sends only the triangles near the outline through the constrained
 * triangulation, and keeps or drops the rest whole. Every TIN edge is a
 * constraint anyway, so a triangle clear of the outline comes out the same
 * either way. A triangle is near when an outline edge crosses its box: both
 * triangles on an edge the outline touches are then near, so the two parts
 * meet at edges nothing cut, and join by vertex index.
 */
function clipBand(tin: Tin, region: MultiPolygon, eps: number, framed = false): Tin | null | typeof FAILED {
  const f = tin.triangles;
  const v = tin.vertices;
  const faces = f.length / 3;
  const whole = () => {
    const out = clipOnce(tin, region, eps, framed);
    return out === FAILED ? FAILED : (out?.tin ?? null);
  };
  if (faces < BAND_MIN) return whole();
  // Outline edges, the first ring of each polygon counter-clockwise and holes clockwise.
  const edges: number[] = [];
  for (const polygon of region) {
    polygon.forEach((ring, r) => {
      if (ring.length < 3) return;
      const flip = ringArea(ring) > 0 !== (r === 0);
      const n = ring.length;
      for (let k = 0; k < n; k++) {
        const a = ring[flip ? n - 1 - k : k];
        const b = ring[flip ? (2 * n - 2 - k) % n : (k + 1) % n];
        edges.push(a[0], a[1], b[0], b[1]);
      }
    });
  }
  if (!edges.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    minX = Math.min(minX, v[i]);
    minY = Math.min(minY, v[i + 1]);
    maxX = Math.max(maxX, v[i]);
    maxY = Math.max(maxY, v[i + 1]);
  }
  // Outline edges bucketed by the cells their boxes touch.
  const cells = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(faces) / 4)));
  const sx = (maxX - minX) / cells || 1;
  const sy = (maxY - minY) / cells || 1;
  const cellOf = (value: number, low: number, step: number) => Math.min(cells - 1, Math.max(0, Math.floor((value - low) / step)));
  const buckets = new Map<number, number[]>();
  const count = edges.length / 4;
  for (let e = 0; e < count; e++) {
    const ax = edges[4 * e];
    const ay = edges[4 * e + 1];
    const bx = edges[4 * e + 2];
    const by = edges[4 * e + 3];
    if (Math.max(ax, bx) < minX - eps || Math.min(ax, bx) > maxX + eps || Math.max(ay, by) < minY - eps || Math.min(ay, by) > maxY + eps) continue;
    for (let cx = cellOf(Math.min(ax, bx) - eps, minX, sx); cx <= cellOf(Math.max(ax, bx) + eps, minX, sx); cx++) {
      for (let cy = cellOf(Math.min(ay, by) - eps, minY, sy); cy <= cellOf(Math.max(ay, by) + eps, minY, sy); cy++) {
        const key = cy * cells + cx;
        const list = buckets.get(key);
        if (list) list.push(e);
        else buckets.set(key, [e]);
      }
    }
  }
  // Winding numbers only need the edges spanning the point's height, so edges are banded by y.
  const bandsOfY = Math.max(1, Math.min(4096, count));
  let lowY = minY;
  let highY = maxY;
  for (let k = 1; k < edges.length; k += 2) {
    lowY = Math.min(lowY, edges[k]);
    highY = Math.max(highY, edges[k]);
  }
  const bandHeight = (highY - lowY) / bandsOfY || 1;
  const bandOf = (y: number) => Math.min(bandsOfY - 1, Math.max(0, Math.floor((y - lowY) / bandHeight)));
  const spanning: number[][] = Array.from({ length: bandsOfY }, () => []);
  for (let e = 0; e < count; e++) {
    for (let b = bandOf(Math.min(edges[4 * e + 1], edges[4 * e + 3])); b <= bandOf(Math.max(edges[4 * e + 1], edges[4 * e + 3])); b++) spanning[b].push(e);
  }
  const inside = (x: number, y: number) => {
    let w = 0;
    for (const e of spanning[bandOf(y)]) {
      const x1 = edges[4 * e];
      const y1 = edges[4 * e + 1];
      const x2 = edges[4 * e + 2];
      const y2 = edges[4 * e + 3];
      if (y1 <= y) {
        if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) w++;
      } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) w--;
    }
    return w !== 0;
  };
  // 0 dropped, 1 kept whole, 2 near the outline.
  const kind = new Uint8Array(faces);
  let near = 0;
  for (let t = 0; t < faces; t++) {
    const a = 3 * f[3 * t];
    const b = 3 * f[3 * t + 1];
    const c = 3 * f[3 * t + 2];
    const x0 = Math.min(v[a], v[b], v[c]) - eps;
    const x1 = Math.max(v[a], v[b], v[c]) + eps;
    const y0 = Math.min(v[a + 1], v[b + 1], v[c + 1]) - eps;
    const y1 = Math.max(v[a + 1], v[b + 1], v[c + 1]) + eps;
    let hit = false;
    for (let cx = cellOf(x0, minX, sx); cx <= cellOf(x1, minX, sx) && !hit; cx++) {
      for (let cy = cellOf(y0, minY, sy); cy <= cellOf(y1, minY, sy) && !hit; cy++) {
        for (const e of buckets.get(cy * cells + cx) ?? []) {
          const ax = edges[4 * e];
          const ay = edges[4 * e + 1];
          const bx = edges[4 * e + 2];
          const by = edges[4 * e + 3];
          if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue;
          // A long diagonal edge's box covers much more than the edge: the box is only hit when its corners aren't all on one side.
          const ex = bx - ax;
          const ey = by - ay;
          const s0 = ex * (y0 - ay) - ey * (x0 - ax);
          const s1 = ex * (y0 - ay) - ey * (x1 - ax);
          const s2 = ex * (y1 - ay) - ey * (x0 - ax);
          const s3 = ex * (y1 - ay) - ey * (x1 - ax);
          if ((s0 > 0 && s1 > 0 && s2 > 0 && s3 > 0) || (s0 < 0 && s1 < 0 && s2 < 0 && s3 < 0)) continue;
          hit = true;
          break;
        }
      }
    }
    if (hit) {
      kind[t] = 2;
      near++;
    } else if (inside((v[a] + v[b] + v[c]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3)) kind[t] = 1;
  }
  if (near === faces) return whole();
  // The triangles near the outline as a TIN of their own.
  const bandIndex = new Int32Array(v.length / 3).fill(-1);
  const bandSource: number[] = [];
  const bandTriangles = new Uint32Array(3 * near);
  let at = 0;
  for (let t = 0; t < faces; t++) {
    if (kind[t] !== 2) continue;
    for (let k = 0; k < 3; k++) {
      const p = f[3 * t + k];
      if (bandIndex[p] < 0) {
        bandIndex[p] = bandSource.length;
        bandSource.push(p);
      }
      bandTriangles[at++] = bandIndex[p];
    }
  }
  const bandVertices = new Float64Array(3 * bandSource.length);
  bandSource.forEach((p, i) => bandVertices.set(v.subarray(3 * p, 3 * p + 3), 3 * i));
  const clipped = near ? clipOnce({ vertices: bandVertices, triangles: bandTriangles }, region, eps, framed) : null;
  if (clipped === FAILED) return FAILED;
  // Kept triangles with their own vertices, then the clipped band, sharing TIN vertices by index.
  const index = new Int32Array(v.length / 3).fill(-1);
  const out: number[] = [];
  const points: number[] = [];
  const vertex = (p: number) => {
    if (index[p] < 0) {
      index[p] = points.length / 3;
      points.push(v[3 * p], v[3 * p + 1], v[3 * p + 2]);
    }
    return index[p];
  };
  for (let t = 0; t < faces; t++) if (kind[t] === 1) out.push(vertex(f[3 * t]), vertex(f[3 * t + 1]), vertex(f[3 * t + 2]));
  if (clipped) {
    const cv = clipped.tin.vertices;
    const ids = new Int32Array(cv.length / 3);
    for (let i = 0; i < ids.length; i++) {
      const source = clipped.source[i];
      if (source >= 0) ids[i] = vertex(bandSource[source]);
      else {
        ids[i] = points.length / 3;
        points.push(cv[3 * i], cv[3 * i + 1], cv[3 * i + 2]);
      }
    }
    for (const p of clipped.tin.triangles) out.push(ids[p]);
  }
  if (!out.length) return null;
  return { vertices: Float64Array.from(points), triangles: Uint32Array.from(out) };
}

/**
 * Constrainautor's set of edges to flip, keeping a list of its members.
 * Constrainautor goes through the whole set after every constraint that flips
 * something, and its bit set reads every byte to do it. A clipped lattice
 * flips about half the cells' diagonals (Delaunay takes either on a square),
 * so that was quadratic in the cells, and most of the time a clip took.
 */
class ListedSet {
  private readonly member: Uint8Array;
  private list: number[] = [];

  constructor(size: number) {
    this.member = new Uint8Array(size);
  }

  has(i: number): boolean {
    return this.member[i] === 1;
  }

  add(i: number): this {
    if (this.member[i] !== 1) {
      this.member[i] = 1;
      this.list.push(i);
    }
    return this;
  }

  delete(i: number): this {
    this.member[i] = 0;
    return this;
  }

  set(i: number, value: boolean): boolean {
    if (value) this.add(i);
    else this.delete(i);
    return value;
  }

  // As the bit set's: a member deleted before its turn is skipped, and one
  // added during the pass may or may not be visited.
  forEach(fn: (i: number) => void): this {
    const list = this.list;
    for (let k = 0; k < list.length; k++) if (this.member[list[k]] === 1) fn(list[k]);
    const kept: number[] = [];
    for (const i of list) {
      if (this.member[i] !== 1) continue;
      this.member[i] = 2;
      kept.push(i);
    }
    for (const i of kept) this.member[i] = 1;
    this.list = kept;
    return this;
  }
}

/**
 * Constrainautor can rescan forever on a quad made degenerate by a point all
 * but on a constraint. Its segment tests are counted, and a run far past
 * what a clean one needs gives up.
 */
export class Bounded extends Constrainautor {
  constructor(
    del: Delaunator<ArrayLike<number>>,
    private budget: number,
  ) {
    super(del);
    (this as unknown as { flips: ListedSet }).flips = new ListedSet(del.triangles.length);
  }

  protected override intersectSegments(p1: number, p2: number, p3: number, p4: number): boolean {
    if (--this.budget < 0) throw new Error('Constrained triangulation did not converge');
    return super.intersectSegments(p1, p2, p3, p4);
  }
}

/** The clipped TIN, with the input vertex behind each of its vertices (-1 for new points). */
function clipOnce(tin: Tin, region: MultiPolygon, eps: number, framed = false): { tin: Tin; source: Int32Array } | null | typeof FAILED {
  const table = new PointTable(eps);
  const vertexCount = tin.vertices.length / 3;
  const tinPoint = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) tinPoint[v] = table.add(tin.vertices[3 * v], tin.vertices[3 * v + 1]);

  // Unique TIN edges.
  const tinSegments: Segment[] = [];
  const seenEdge = new Set<number>();
  for (let t = 0; t < tin.triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tinPoint[tin.triangles[t + k]];
      const b = tinPoint[tin.triangles[t + ((k + 1) % 3)]];
      if (a === b) continue;
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      tinSegments.push({ a: Math.min(a, b), b: Math.max(a, b), splits: [] });
    }
  }

  // Region edges, directed so the region is on their left.
  const regionSegments: Segment[] = [];
  for (const polygon of region) {
    for (let r = 0; r < polygon.length; r++) {
      const ring = polygon[r];
      if (ring.length < 3) continue;
      const ccw = ringArea(ring) > 0;
      const ids = ring.map(([x, y]) => table.add(x, y));
      const wantCcw = r === 0;
      const ordered = ccw === wantCcw ? ids : ids.slice().reverse();
      for (let k = 0; k < ordered.length; k++) {
        const a = ordered[k];
        const b = ordered[(k + 1) % ordered.length];
        if (a !== b) regionSegments.push({ a, b, splits: [] });
      }
    }
  }
  if (!regionSegments.length) return null;

  // TIN edges bucketed by a coarse grid for the crossing search.
  const xs = table.xs;
  const ys = table.ys;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    minX = Math.min(minX, xs[i]);
    minY = Math.min(minY, ys[i]);
    maxX = Math.max(maxX, xs[i]);
    maxY = Math.max(maxY, ys[i]);
  }
  const span = Math.max(maxX - minX, maxY - minY, eps);
  const cells = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(tinSegments.length) / 2)));
  const size = span / cells + eps;
  const buckets = new Map<number, number[]>();
  const cellKey = (cx: number, cy: number) => cx * 65536 + cy;
  const cellRange = (s: Segment) => {
    const x0 = Math.floor((Math.min(xs[s.a], xs[s.b]) - eps - minX) / size);
    const x1 = Math.floor((Math.max(xs[s.a], xs[s.b]) + eps - minX) / size);
    const y0 = Math.floor((Math.min(ys[s.a], ys[s.b]) - eps - minY) / size);
    const y1 = Math.floor((Math.max(ys[s.a], ys[s.b]) + eps - minY) / size);
    return [x0, y0, x1, y1];
  };
  tinSegments.forEach((s, i) => {
    const [x0, y0, x1, y1] = cellRange(s);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        const list = buckets.get(key);
        if (list) list.push(i);
        else buckets.set(key, [i]);
      }
    }
  });

  const onSegment = (id: number, s: Segment): boolean => {
    if (id === s.a || id === s.b) return false;
    const ax = xs[s.a];
    const ay = ys[s.a];
    const dx = xs[s.b] - ax;
    const dy = ys[s.b] - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? ((xs[id] - ax) * dx + (ys[id] - ay) * dy) / l2 : 0;
    if (t <= 0 || t >= 1 || Math.hypot(xs[id] - (ax + t * dx), ys[id] - (ay + t * dy)) > eps) return false;
    for (const [, other] of s.splits) if (other === id) return true;
    s.splits.push([t, id]);
    return true;
  };

  // Each TIN edge is tested once per region edge, however many cells they share.
  const tested = new Int32Array(tinSegments.length).fill(-1);
  for (let ri = 0; ri < regionSegments.length; ri++) {
    const r = regionSegments[ri];
    const [x0, y0, x1, y1] = cellRange(r);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const i of buckets.get(cellKey(cx, cy)) ?? []) {
      if (tested[i] === ri) continue;
      tested[i] = ri;
      const s = tinSegments[i];
      if ((s.a === r.a || s.a === r.b) && (s.b === r.a || s.b === r.b)) continue;
      // All four, each records the split it finds.
      const t1 = onSegment(s.a, r);
      const t2 = onSegment(s.b, r);
      const t3 = onSegment(r.a, s);
      const t4 = onSegment(r.b, s);
      if (t1 || t2 || t3 || t4) continue;
      if (s.a === r.a || s.a === r.b || s.b === r.a || s.b === r.b) continue;
      // Proper crossing.
      const [px, py, qx, qy] = [xs[r.a], ys[r.a], xs[r.b], ys[r.b]];
      const [ax, ay, bx, by] = [xs[s.a], ys[s.a], xs[s.b], ys[s.b]];
      const d1 = (qx - px) * (ay - py) - (qy - py) * (ax - px);
      const d2 = (qx - px) * (by - py) - (qy - py) * (bx - px);
      const d3 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const d4 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
      if (!((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) || !((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) continue;
      // Parameter along the TIN edge, from its lower id: the same edge
      // crossed by the same region edge always gives the same point.
      const u = d1 / (d1 - d2);
      const x = ax + u * (bx - ax);
      const y = ay + u * (by - ay);
      const id = table.add(x, y);
      if (id !== s.a && id !== s.b) s.splits.push([u, id]);
      if (id !== r.a && id !== r.b) {
        const [t] = project(x, y, px, py, qx, qy);
        r.splits.push([t, id]);
      }
    }
  }

  // Points well clear of everything, so no constraint runs along the hull.
  // Nothing outside the TIN is kept, so they never reach the output.
  if (framed) {
    const pad = 10 * span;
    for (const [x, y] of [[minX - pad, minY - pad], [maxX + pad, minY - pad], [maxX + pad, maxY + pad], [minX - pad, maxY + pad]]) table.add(x, y);
  }

  // Constraint pieces.
  const count = xs.length;
  const pieceKey = (a: number, b: number) => (a < b ? a * count + b : b * count + a);
  const constraints = new Map<number, [number, number]>();
  const directed = new Set<number>();
  const chain = (s: Segment): number[] => {
    const ids = [s.a, ...s.splits.sort((p, q) => p[0] - q[0]).map(([, id]) => id), s.b];
    const out: number[] = [];
    for (const id of ids) if (out[out.length - 1] !== id) out.push(id);
    return out;
  };
  for (const r of regionSegments) {
    const ids = chain(r);
    for (let k = 0; k + 1 < ids.length; k++) {
      constraints.set(pieceKey(ids[k], ids[k + 1]), [ids[k], ids[k + 1]]);
      directed.add(ids[k] * count + ids[k + 1]);
    }
  }
  for (const s of tinSegments) {
    const ids = chain(s);
    for (let k = 0; k + 1 < ids.length; k++) {
      const key = pieceKey(ids[k], ids[k + 1]);
      if (!constraints.has(key)) constraints.set(key, [ids[k], ids[k + 1]]);
    }
  }

  const coords = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    coords[2 * i] = xs[i];
    coords[2 * i + 1] = ys[i];
  }
  let triangles: Uint32Array;
  let halfedges: Int32Array;
  try {
    const del = new Delaunator(coords);
    const con = new Bounded(del, 1e6 + 1000 * constraints.size);
    for (const [a, b] of constraints.values()) con.constrainOne(a, b);
    triangles = del.triangles;
    halfedges = del.halfedges;
  } catch {
    return FAILED;
  }

  // Inside the region: flood from the directed region pieces across
  // unconstrained... every edge here is constrained, so walk across TIN
  // pieces too, only stopping at region pieces.
  const orient = orientation(coords, triangles);
  const triCount = triangles.length / 3;
  const label = new Int8Array(triCount);
  const queue: number[] = [];
  for (let e = 0; e < triangles.length; e++) {
    const a = triangles[e];
    const b = triangles[nextEdge(e)];
    let side = 0;
    if (directed.has(a * count + b)) side = 1;
    else if (directed.has(b * count + a)) side = -1;
    if (!side) continue;
    side *= orient;
    const t = (e / 3) | 0;
    if (label[t] === 0) {
      label[t] = side;
      queue.push(t);
    } else if (label[t] !== side) label[t] = 2;
  }
  while (queue.length) {
    const t = queue.pop()!;
    const value = label[t];
    if (value === 2) continue;
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k;
      const opposite = halfedges[e];
      if (opposite < 0) continue;
      const a = triangles[e];
      const b = triangles[nextEdge(e)];
      if (directed.has(a * count + b) || directed.has(b * count + a)) continue;
      const u = (opposite / 3) | 0;
      if (label[u] === 0) {
        label[u] = value;
        queue.push(u);
      }
    }
  }

  // Heights from the TIN face under each kept triangle.
  const locate = faceLocator(tin);
  const z = new Float64Array(count).fill(NaN);
  for (let v = 0; v < vertexCount; v++) if (Number.isNaN(z[tinPoint[v]])) z[tinPoint[v]] = tin.vertices[3 * v + 2];
  const kept: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = triangles[3 * t];
    const b = triangles[3 * t + 1];
    const c = triangles[3 * t + 2];
    const cx = (xs[a] + xs[b] + xs[c]) / 3;
    const cy = (ys[a] + ys[b] + ys[c]) / 3;
    let inside = label[t] === 1;
    if (label[t] === 0 || label[t] === 2) inside = windingInside(cx, cy, xs, ys, regionSegments);
    if (!inside) continue;
    // Every TIN edge is a constraint, so a triangle is wholly on or off the
    // TIN. Off it, the region reaches past the surface: callers that need
    // full coverage compare areas.
    const face = locate(cx, cy);
    if (face < 0) continue;
    for (const p of [a, b, c]) if (Number.isNaN(z[p])) z[p] = locate.height(face, xs[p], ys[p]);
    if (orient > 0) kept.push(a, b, c);
    else kept.push(a, c, b);
  }
  if (!kept.length) return null;

  const used = new Int32Array(count).fill(-1);
  let next = 0;
  for (const p of kept) if (used[p] < 0) used[p] = next++;
  // TIN vertices were added to the table first, so each of their points came from the first TIN vertex there.
  const from = new Int32Array(count).fill(-1);
  for (let w = vertexCount - 1; w >= 0; w--) from[tinPoint[w]] = w;
  const vertices = new Float64Array(next * 3);
  const source = new Int32Array(next);
  for (let p = 0; p < count; p++) {
    const i = used[p];
    if (i < 0) continue;
    vertices[3 * i] = xs[p];
    vertices[3 * i + 1] = ys[p];
    vertices[3 * i + 2] = z[p];
    source[i] = from[p];
  }
  const out = new Uint32Array(kept.length);
  for (let i = 0; i < kept.length; i++) out[i] = used[kept[i]];
  return { tin: { vertices, triangles: out }, source };
}

function orientation(coords: Float64Array, triangles: Uint32Array): number {
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t];
    const b = triangles[t + 1];
    const c = triangles[t + 2];
    const cross =
      (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) -
      (coords[2 * c] - coords[2 * a]) * (coords[2 * b + 1] - coords[2 * a + 1]);
    if (cross !== 0) return cross > 0 ? 1 : -1;
  }
  return 1;
}

function windingInside(x: number, y: number, xs: number[], ys: number[], segments: Segment[]): boolean {
  let winding = 0;
  for (const s of segments) {
    const x1 = xs[s.a];
    const y1 = ys[s.a];
    const x2 = xs[s.b];
    const y2 = ys[s.b];
    if (y1 <= y) {
      if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) winding++;
    } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) winding--;
  }
  return winding !== 0;
}

interface Locator {
  (x: number, y: number): number;
  height(face: number, x: number, y: number): number;
}

/** Finds the TIN face over a point, through a grid of face bounds. */
export function faceLocator(tin: Tin): Locator {
  const { vertices: v, triangles: f } = tin;
  const faces = f.length / 3;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    minX = Math.min(minX, v[i]);
    minY = Math.min(minY, v[i + 1]);
    maxX = Math.max(maxX, v[i]);
    maxY = Math.max(maxY, v[i + 1]);
  }
  const n = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(faces))));
  const sx = (maxX - minX) / n || 1;
  const sy = (maxY - minY) / n || 1;
  // Faces per bucket as one flat list, counted first: an array per bucket was
  // most of the time a clip took.
  const ranges = new Int32Array(faces * 4);
  const start = new Int32Array(n * n + 1);
  for (let t = 0; t < faces; t++) {
    const a = 3 * f[3 * t];
    const b = 3 * f[3 * t + 1];
    const c = 3 * f[3 * t + 2];
    const c0 = Math.max(0, Math.floor((Math.min(v[a], v[b], v[c]) - minX) / sx));
    const c1 = Math.min(n - 1, Math.floor((Math.max(v[a], v[b], v[c]) - minX) / sx));
    const r0 = Math.max(0, Math.floor((Math.min(v[a + 1], v[b + 1], v[c + 1]) - minY) / sy));
    const r1 = Math.min(n - 1, Math.floor((Math.max(v[a + 1], v[b + 1], v[c + 1]) - minY) / sy));
    ranges.set([c0, c1, r0, r1], 4 * t);
    for (let r = r0; r <= r1; r++) for (let c2 = c0; c2 <= c1; c2++) start[r * n + c2 + 1]++;
  }
  for (let i = 1; i <= n * n; i++) start[i] += start[i - 1];
  const fill = start.slice(0, n * n);
  const bucket = new Int32Array(start[n * n]);
  for (let t = 0; t < faces; t++) {
    const [c0, c1, r0, r1] = ranges.subarray(4 * t, 4 * t + 4);
    for (let r = r0; r <= r1; r++) for (let c2 = c0; c2 <= c1; c2++) bucket[fill[r * n + c2]++] = t;
  }
  const weights = (t: number, x: number, y: number): [number, number, number] => {
    const a = 3 * f[3 * t];
    const b = 3 * f[3 * t + 1];
    const c = 3 * f[3 * t + 2];
    const det = (v[b + 1] - v[c + 1]) * (v[a] - v[c]) + (v[c] - v[b]) * (v[a + 1] - v[c + 1]);
    if (!det) return [NaN, NaN, NaN];
    const u = ((v[b + 1] - v[c + 1]) * (x - v[c]) + (v[c] - v[b]) * (y - v[c + 1])) / det;
    const w = ((v[c + 1] - v[a + 1]) * (x - v[c]) + (v[a] - v[c]) * (y - v[c + 1])) / det;
    return [u, w, 1 - u - w];
  };
  const locate = ((x: number, y: number) => {
    const c = Math.floor((x - minX) / sx);
    const r = Math.floor((y - minY) / sy);
    if (c < -1 || r < -1 || c > n || r > n) return -1;
    let best = -1;
    let bestMin = -1e-9;
    const cell = Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, c));
    for (let k = start[cell]; k < start[cell + 1]; k++) {
      const t = bucket[k];
      const [u, w, s] = weights(t, x, y);
      const least = Math.min(u, w, s);
      if (least > bestMin) {
        bestMin = least;
        best = t;
      }
    }
    return best;
  }) as Locator;
  locate.height = (t: number, x: number, y: number) => {
    const [u, w, s] = weights(t, x, y);
    return u * v[3 * f[3 * t] + 2] + w * v[3 * f[3 * t + 1] + 2] + s * v[3 * f[3 * t + 2] + 2];
  };
  return locate;
}

/** Plan area of a TIN. */
export function tinArea(tin: Tin): number {
  const { vertices: v, triangles: f } = tin;
  let area = 0;
  for (let t = 0; t < f.length; t += 3) {
    const a = 3 * f[t];
    const b = 3 * f[t + 1];
    const c = 3 * f[t + 2];
    area += ((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1])) / 2;
  }
  return area;
}
