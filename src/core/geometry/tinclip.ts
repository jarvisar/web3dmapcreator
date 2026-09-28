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
  private readonly grid = new Map<string, number[]>();

  constructor(private readonly eps: number) {}

  private cell(v: number): number {
    return Math.floor(v / (this.eps * 4));
  }

  add(x: number, y: number): number {
    const cx = this.cell(x);
    const cy = this.cell(y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.grid.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const id of list) if (Math.abs(this.xs[id] - x) <= this.eps && Math.abs(this.ys[id] - y) <= this.eps) return id;
      }
    }
    const id = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    const key = `${cx},${cy}`;
    const list = this.grid.get(key);
    if (list) list.push(id);
    else this.grid.set(key, [id]);
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
 * The part of `tin` inside `region`, or null when the triangulation fails.
 * Where the region reaches past the TIN there is simply no surface. Region rings may be in any
 * orientation, outer rings and holes are told apart by the NonZero rule the
 * polygon helpers use (outer counter-clockwise, holes clockwise).
 */
export function clipTin(tin: Tin, region: MultiPolygon, epsilon?: number): Tin | null {
  const eps = epsilon ?? defaultEpsilon(tin, region);
  const out = clipOnce(tin, region, eps);
  if (out !== FAILED) return out;
  // An outline that grazes the TIN's vertices can leave the constrained
  // triangulation stuck. Moving it in by a millionth of the extent almost
  // always gets clear, and callers compare areas with more slack than that.
  const retried = clipOnce(tin, offsetPolygons(region, -eps * 1e5), eps);
  return retried === FAILED ? null : retried;
}

const FAILED = Symbol('failed');

/**
 * Constrainautor can rescan forever on a quad made degenerate by a point all
 * but on a constraint. Its segment tests are counted, and a run far past
 * what a clean one needs gives up.
 */
class Bounded extends Constrainautor {
  constructor(
    del: Delaunator<ArrayLike<number>>,
    private budget: number,
  ) {
    super(del);
  }

  protected override intersectSegments(p1: number, p2: number, p3: number, p4: number): boolean {
    if (--this.budget < 0) throw new Error('Constrained triangulation did not converge');
    return super.intersectSegments(p1, p2, p3, p4);
  }
}

function clipOnce(tin: Tin, region: MultiPolygon, eps: number): Tin | null | typeof FAILED {
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
    const [t, d] = project(xs[id], ys[id], xs[s.a], ys[s.a], xs[s.b], ys[s.b]);
    if (d > eps || t <= 0 || t >= 1) return false;
    if (!s.splits.some(([, other]) => other === id)) s.splits.push([t, id]);
    return true;
  };

  for (const r of regionSegments) {
    const [x0, y0, x1, y1] = cellRange(r);
    const candidates = new Set<number>();
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const i of buckets.get(cellKey(cx, cy)) ?? []) candidates.add(i);
    for (const i of candidates) {
      const s = tinSegments[i];
      if ((s.a === r.a || s.a === r.b) && (s.b === r.a || s.b === r.b)) continue;
      const touches = [onSegment(s.a, r), onSegment(s.b, r), onSegment(r.a, s), onSegment(r.b, s)];
      if (touches.some(Boolean)) continue;
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
  const vertices = new Float64Array(next * 3);
  for (let p = 0; p < count; p++) {
    const i = used[p];
    if (i < 0) continue;
    vertices[3 * i] = xs[p];
    vertices[3 * i + 1] = ys[p];
    vertices[3 * i + 2] = z[p];
  }
  const out = new Uint32Array(kept.length);
  for (let i = 0; i < kept.length; i++) out[i] = used[kept[i]];
  return { vertices, triangles: out };
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
  const grid: number[][] = Array.from({ length: n * n }, () => []);
  for (let t = 0; t < faces; t++) {
    const a = 3 * f[3 * t];
    const b = 3 * f[3 * t + 1];
    const c = 3 * f[3 * t + 2];
    const c0 = Math.max(0, Math.floor((Math.min(v[a], v[b], v[c]) - minX) / sx));
    const c1 = Math.min(n - 1, Math.floor((Math.max(v[a], v[b], v[c]) - minX) / sx));
    const r0 = Math.max(0, Math.floor((Math.min(v[a + 1], v[b + 1], v[c + 1]) - minY) / sy));
    const r1 = Math.min(n - 1, Math.floor((Math.max(v[a + 1], v[b + 1], v[c + 1]) - minY) / sy));
    for (let r = r0; r <= r1; r++) for (let c2 = c0; c2 <= c1; c2++) grid[r * n + c2].push(t);
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
    for (const t of grid[Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, c))]) {
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
