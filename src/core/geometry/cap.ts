// Closed shells from measured roof caps (see CapSolid): the roof surface on
// top, a flat underside, and walls along the boundary edges. The boundary is
// the outline the cap tiles, plus any section edge it was cut along, so every
// shell closes by construction.

import Delaunator from 'delaunator';
import earcut from 'earcut';
import { orient2d } from 'robust-predicates';
import { boxesOverlap, offsetPolygons, PINCH_MM, ringArea, type Box } from './polygon';
import type { CapSolid } from './solid';
import { Bounded, clipTin, type Tin } from './tinclip';
import type { MultiPolygon } from '../types';

/** Thinnest the cap may be over its underside, as for prisms. */
const MIN_THICKNESS = 0.01;

interface Region {
  polygons: MultiPolygon;
  box: Box;
  rectangular: boolean;
}

interface Sink {
  vertex(x: number, y: number, z: number): number;
  triangle(a: number, b: number, c: number): void;
}

export function tinBounds(tin: Tin): Box {
  const v = tin.vertices;
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < box[0]) box[0] = v[i];
    if (v[i + 1] < box[1]) box[1] = v[i + 1];
    if (v[i] > box[2]) box[2] = v[i];
    if (v[i + 1] > box[3]) box[3] = v[i + 1];
  }
  return box;
}

/**
 * Boundary edges of a TIN in their own direction, or null when an edge is
 * used twice the same way or two boundary loops touch at a vertex: walls
 * there would put four faces on one vertical edge.
 */
export function capBoundary(tin: Tin): [number, number][] | null {
  const t = tin.triangles;
  const n = tin.vertices.length / 3;
  const directed = new Set<number>();
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const key = t[i + k] * n + t[i + ((k + 1) % 3)];
      if (directed.has(key)) return null;
      directed.add(key);
    }
  }
  const boundary: [number, number][] = [];
  const outgoing = new Uint32Array(n);
  for (const key of directed) {
    const a = Math.floor(key / n);
    const b = key - a * n;
    if (directed.has(b * n + a)) continue;
    boundary.push([a, b]);
    if (++outgoing[a] > 1) return null;
  }
  return boundary;
}

/**
 * The flat underside, triangulated from the boundary: triangles counter-
 * clockwise in plan, of TIN vertex indices, and of `points` numbered on from
 * the TIN's vertex count. It needs a fraction of the roof's triangles and
 * uses the same boundary edges, so the walls still meet it. Null when the
 * outline can't be traced or the triangles don't close.
 */
export function undersideTriangles(tin: Tin, boundary: [number, number][]): { triangles: number[]; points: [number, number][] } | null {
  const v = tin.vertices;
  const next = new Int32Array(v.length / 3).fill(-1);
  for (const [a, b] of boundary) next[a] = b;
  const seen = new Uint8Array(next.length);
  const outers: { ids: number[]; ring: [number, number][]; area: number }[] = [];
  const holes: { ids: number[]; ring: [number, number][]; area: number }[] = [];
  for (const [start] of boundary) {
    if (seen[start]) continue;
    const ids: number[] = [];
    for (let p = start; !seen[p]; p = next[p]) {
      if (next[p] < 0) return null;
      seen[p] = 1;
      ids.push(p);
    }
    const ring = ids.map((i) => [v[3 * i], v[3 * i + 1]] as [number, number]);
    const area = ringArea(ring);
    (area > 0 ? outers : holes).push({ ids, ring, area: Math.abs(area) });
  }
  // Each hole goes to the smallest outline around it.
  const owned = outers.map(() => [] as typeof holes);
  for (const hole of holes) {
    const [x, y] = hole.ring[0];
    let best = -1;
    outers.forEach((outer, k) => {
      if (inside(outer.ring, x, y) && (best < 0 || outer.area < outers[best].area)) best = k;
    });
    if (best < 0) return null;
    owned[best].push(hole);
  }
  const out: number[] = [];
  for (let k = 0; k < outers.length; k++) {
    const rings = [outers[k], ...owned[k]];
    const ids = rings.flatMap((r) => r.ids);
    const flat = rings.flatMap((r) => r.ring.flat());
    const starts: number[] = [];
    let at = outers[k].ids.length;
    for (const hole of owned[k]) {
      starts.push(at);
      at += hole.ids.length;
    }
    const tris = earcut(flat, starts);
    let area = 0;
    for (let i = 0; i < tris.length; i += 3) {
      let [a, b, c] = [ids[tris[i]], ids[tris[i + 1]], ids[tris[i + 2]]];
      const cross = (v[3 * b] - v[3 * a]) * (v[3 * c + 1] - v[3 * a + 1]) - (v[3 * c] - v[3 * a]) * (v[3 * b + 1] - v[3 * a + 1]);
      if (cross < 0) [b, c] = [c, b];
      area += Math.abs(cross) / 2;
      out.push(a, b, c);
    }
    const expected = outers[k].area - owned[k].reduce((sum, h) => sum + h.area, 0);
    if (Math.abs(area - expected) > Math.max(1e-9, expected * 1e-9)) return null;
  }
  // Earcut drops outline vertices on straight stretches, and its hole
  // bridges can run along them, but the walls use every one. A triangle with
  // outline vertices on its edges is fanned from its centroid through them.
  const loops = [...outers, ...holes].map((r) => r.ids);
  const n = next.length;
  const outline = loops.flat();
  const grid = new Map<string, number[]>();
  const size = Math.sqrt(Math.max(1e-12, outers.reduce((sum, o) => sum + o.area, 0)) / Math.max(1, outline.length)) * 4;
  const key = (gx: number, gy: number) => `${gx},${gy}`;
  for (const i of outline) {
    const k = key(Math.floor(v[3 * i] / size), Math.floor(v[3 * i + 1] / size));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  const between = (a: number, b: number): number[] => {
    const [ax, ay, bx, by] = [v[3 * a], v[3 * a + 1], v[3 * b], v[3 * b + 1]];
    const found: [number, number][] = [];
    for (let gx = Math.floor(Math.min(ax, bx) / size); gx <= Math.floor(Math.max(ax, bx) / size); gx++) {
      for (let gy = Math.floor(Math.min(ay, by) / size); gy <= Math.floor(Math.max(ay, by) / size); gy++) {
        for (const i of grid.get(key(gx, gy)) ?? []) {
          if (i === a || i === b) continue;
          const [px, py] = [v[3 * i], v[3 * i + 1]];
          if (orient2d(ax, ay, bx, by, px, py) !== 0) continue;
          const t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2);
          if (t > 0 && t < 1) found.push([t, i]);
        }
      }
    }
    return found.sort((p, q) => p[0] - q[0]).map(([, i]) => i);
  };
  const cover: number[] = [];
  const points: [number, number][] = [];
  for (let t = 0; t < out.length; t += 3) {
    const corners = [out[t], out[t + 1], out[t + 2]];
    const ring: number[] = [];
    for (let k = 0; k < 3; k++) ring.push(corners[k], ...between(corners[k], corners[(k + 1) % 3]));
    if (ring.length === 3) {
      cover.push(...corners);
      continue;
    }
    // The centroid is strictly inside, so no fan triangle is flat.
    const centre = n + points.length;
    points.push([(v[3 * corners[0]] + v[3 * corners[1]] + v[3 * corners[2]]) / 3, (v[3 * corners[0] + 1] + v[3 * corners[1] + 1] + v[3 * corners[2] + 1]) / 3]);
    for (let k = 0; k < ring.length; k++) cover.push(ring[k], ring[(k + 1) % ring.length], centre);
  }
  return capIsClosed(cover, loops, n + points.length) ? { triangles: cover, points } : null;
}

/**
 * The flat underside as a constrained Delaunay triangulation of the outline,
 * for when earcut's can't be used: a long straight stretch of outline with
 * points all but in line gets slivers from earcut that the fan above adds
 * the same points to twice. A LiDAR only surface cut along a river has
 * thousands of such points. Triangles left of an outline edge are inside, and
 * so is everything reached from them without crossing one. Null when it
 * doesn't close either.
 */
export function constrainedUnderside(tin: Tin, boundary: [number, number][]): { triangles: number[]; points: [number, number][] } | null {
  const v = tin.vertices;
  const n = v.length / 3;
  const local = new Int32Array(n).fill(-1);
  const ids: number[] = [];
  for (const edge of boundary) {
    for (const p of edge) {
      if (local[p] >= 0) continue;
      local[p] = ids.length;
      ids.push(p);
    }
  }
  if (ids.length < 3) return null;
  const coords = new Float64Array(2 * ids.length);
  ids.forEach((p, k) => {
    coords[2 * k] = v[3 * p];
    coords[2 * k + 1] = v[3 * p + 1];
  });
  let del: Delaunator<Float64Array>;
  let con: Bounded;
  try {
    del = new Delaunator(coords);
    con = new Bounded(del, 1e6 + 1000 * boundary.length);
    for (const [a, b] of boundary) con.constrainOne(local[a], local[b]);
  } catch {
    return null;
  }
  const t = del.triangles;
  const faces = t.length / 3;
  const m = ids.length;
  const outline = new Set<number>();
  for (const [a, b] of boundary) outline.add(local[a] * m + local[b]);
  const up = new Uint8Array(faces);
  for (let f = 0; f < faces; f++) {
    const [a, b, c] = [2 * t[3 * f], 2 * t[3 * f + 1], 2 * t[3 * f + 2]];
    up[f] = (coords[b] - coords[a]) * (coords[c + 1] - coords[a + 1]) - (coords[b + 1] - coords[a + 1]) * (coords[c] - coords[a]) > 0 ? 1 : 0;
  }
  const inside = new Uint8Array(faces);
  const queue: number[] = [];
  for (let f = 0; f < faces; f++) {
    for (let k = 0; k < 3 && !inside[f]; k++) {
      const a = t[3 * f + k];
      const b = t[3 * f + ((k + 1) % 3)];
      if (!outline.has(up[f] ? a * m + b : b * m + a)) continue;
      inside[f] = 1;
      queue.push(f);
    }
  }
  while (queue.length) {
    const f = queue.pop()!;
    for (let k = 0; k < 3; k++) {
      const e = 3 * f + k;
      const o = del.halfedges[e];
      if (o < 0 || con.isConstrained(e)) continue;
      const g = Math.floor(o / 3);
      if (inside[g]) continue;
      inside[g] = 1;
      queue.push(g);
    }
  }
  const out: number[] = [];
  for (let f = 0; f < faces; f++) {
    if (!inside[f]) continue;
    const [a, b, c] = [ids[t[3 * f]], ids[t[3 * f + 1]], ids[t[3 * f + 2]]];
    if (up[f]) out.push(a, b, c);
    else out.push(a, c, b);
  }
  const next = new Int32Array(n).fill(-1);
  for (const [a, b] of boundary) next[a] = b;
  const seen = new Uint8Array(n);
  const loops: number[][] = [];
  for (const [start] of boundary) {
    if (seen[start]) continue;
    const loop: number[] = [];
    for (let p = start; !seen[p]; p = next[p]) {
      if (next[p] < 0) return null;
      seen[p] = 1;
      loop.push(p);
    }
    loops.push(loop);
  }
  return capIsClosed(out, loops, n) ? { triangles: out, points: [] } : null;
}

/**
 * Whether counter-clockwise cap triangles cover the rings exactly: every ring
 * edge is used once in its own direction and every other edge twice, once
 * each way. Area alone can miss a dropped sliver, which leaves a hole.
 */
export function capIsClosed(tris: number[], rings: number[][], count: number): boolean {
  const uses = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k];
      const b = tris[t + ((k + 1) % 3)];
      const key = a * count + b;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const ringEdges = new Set<number>();
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k++) {
      const key = ring[k] * count + ring[(k + 1) % ring.length];
      if (uses.get(key) !== 1) return false;
      ringEdges.add(key);
    }
  }
  for (const [key, n] of uses) {
    if (n !== 1) return false;
    if (ringEdges.has(key)) continue;
    const a = Math.floor(key / count);
    const b = key - a * count;
    if (uses.get(b * count + a) !== 1) return false;
  }
  return true;
}

function inside(ring: [number, number][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Mesh a cap into `out`, cut to `region` when given. */
export function meshCap(solid: CapSolid, out: Sink, region?: Region): 'ok' | 'empty' | 'failed' {
  const whole: Tin = { vertices: solid.vertices, triangles: solid.triangles };
  let tin = whole;
  let clippedTo: MultiPolygon | null = null;
  if (!tin.triangles.length) return 'empty';
  if (region) {
    const box = tinBounds(tin);
    if (!boxesOverlap(box, region.box)) return 'empty';
    const inside = region.rectangular && box[0] >= region.box[0] && box[1] >= region.box[1] && box[2] <= region.box[2] && box[3] <= region.box[3];
    if (!inside) {
      const clipped = clipTin(tin, region.polygons);
      if (!clipped) return 'failed';
      if (!clipped.triangles.length) return 'empty';
      tin = clipped;
      clippedTo = region.polygons;
    }
  }
  let boundary = capBoundary(tin);
  // A section line through a concave corner of the outline leaves two parts
  // touching at that corner, which capBoundary refuses. Shrinking the region
  // parts them, as for a pinched prism.
  if (!boundary && clippedTo) {
    const retried = clipTin(whole, offsetPolygons(clippedTo, -PINCH_MM, 'miter'));
    if (retried?.triangles.length) {
      tin = retried;
      boundary = capBoundary(tin);
    }
  }
  if (!boundary) return 'failed';
  const v = tin.vertices;
  const count = v.length / 3;
  const bottom = solid.bottom;
  const top = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const z = Math.max(v[3 * i + 2], bottom + MIN_THICKNESS);
    top[i] = out.vertex(v[3 * i], v[3 * i + 1], z);
  }
  const t = tin.triangles;
  for (let i = 0; i < t.length; i += 3) out.triangle(top[t[i]], top[t[i + 1]], top[t[i + 2]]);
  // The underside is flat, so its outline is all it needs. The roof's own
  // triangles, reversed, are the last resort.
  const flat = undersideTriangles(tin, boundary) ?? constrainedUnderside(tin, boundary) ?? { triangles: Array.from(t), points: [] };
  const under = new Int32Array(count + flat.points.length).fill(-1);
  const below = (i: number) => {
    if (under[i] < 0) under[i] = i < count ? out.vertex(v[3 * i], v[3 * i + 1], bottom) : out.vertex(...flat.points[i - count], bottom);
    return under[i];
  };
  const cover = flat.triangles;
  for (let i = 0; i < cover.length; i += 3) out.triangle(below(cover[i]), below(cover[i + 2]), below(cover[i + 1]));
  // The cap lies left of each boundary edge, so its wall faces right.
  for (const [a, b] of boundary) {
    out.triangle(below(a), below(b), top[b]);
    out.triangle(below(a), top[b], top[a]);
  }
  return 'ok';
}
