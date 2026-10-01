// Thinning a measured roof's rim. Clipping the meshed surface to the
// footprint leaves a vertex wherever a mesh edge crosses the outline. Along
// a straight wall they add nothing but triangles: two wall triangles each,
// plus the roof and underside around them. They made up most of a measured
// city's triangles.
//
// A rim vertex goes when it lies on a straight stretch of outline and the
// roof around it stays within `tolerance` of where it was. Footprint corners
// and real steps in the rim height stay.

import earcut from 'earcut';
import type { Tin } from '../geometry/tinclip';

/** Rim vertices closer than this to the line through their neighbours are on a straight wall. */
const STRAIGHT_M = 1e-6;
// A rim vertex stays when filling its place takes a triangle thinner than
// this. Earcut fills a straight wall's vertices with slivers a trillionth of
// a millimetre thin, and a later cut at the model's edge couldn't
// triangulate around one.
const MIN_ALTITUDE_M = 1e-4;

export function thinRim(tin: Tin, tolerance: number): Tin {
  const v = tin.vertices;
  const tris: number[][] = [];
  for (let t = 0; t < tin.triangles.length; t += 3) tris.push([tin.triangles[t], tin.triangles[t + 1], tin.triangles[t + 2]]);
  const alive: boolean[] = tris.map(() => true);
  const around = new Map<number, Set<number>>();
  const link = (t: number) => {
    for (const p of tris[t]) (around.get(p) ?? around.set(p, new Set()).get(p)!).add(t);
  };
  tris.forEach((_, t) => link(t));

  // Directed rim edges have no twin. The roof lies to their left.
  const directed = new Set<string>();
  for (const [a, b, c] of tris) for (const [p, q] of [[a, b], [b, c], [c, a]]) directed.add(`${p},${q}`);
  const next = new Map<number, number>();
  const prev = new Map<number, number>();
  for (const [a, b, c] of tris) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if (directed.has(`${q},${p}`)) continue;
      next.set(p, q);
      prev.set(q, p);
    }
  }

  const x = (i: number) => v[3 * i];
  const y = (i: number) => v[3 * i + 1];
  const z = (i: number) => v[3 * i + 2];
  const cross = (a: number, b: number, c: number) => (x(b) - x(a)) * (y(c) - y(a)) - (x(c) - x(a)) * (y(b) - y(a));
  const heightIn = (t: number[], px: number, py: number): number | null => {
    const [a, b, c] = t;
    const d = cross(a, b, c);
    if (!d) return null;
    const u = ((x(b) - px) * (y(c) - py) - (x(c) - px) * (y(b) - py)) / d;
    const w = ((x(c) - px) * (y(a) - py) - (x(a) - px) * (y(c) - py)) / d;
    const s = 1 - u - w;
    if (u < -1e-9 || w < -1e-9 || s < -1e-9) return null;
    return u * z(a) + w * z(b) + s * z(c);
  };

  const removeVertex = (vi: number): boolean => {
    const p = prev.get(vi);
    const q = next.get(vi);
    if (p === undefined || q === undefined || p === q) return false;
    // On a straight stretch, and between its neighbours.
    const length = Math.hypot(x(q) - x(p), y(q) - y(p));
    if (!length || Math.abs(cross(p, vi, q)) / length > STRAIGHT_M) return false;
    const along = ((x(vi) - x(p)) * (x(q) - x(p)) + (y(vi) - y(p)) * (y(q) - y(p))) / (length * length);
    if (along <= 0 || along >= 1) return false;
    if (Math.abs(z(vi) - (z(p) + along * (z(q) - z(p)))) > tolerance) return false;

    // The fan around the vertex, from the triangle on its outgoing rim edge
    // round to the one on its incoming edge.
    const fan: number[] = [];
    const chain: number[] = [q];
    let from = q;
    const incident = around.get(vi)!;
    while (from !== p) {
      let found = -1;
      for (const t of incident) {
        const k = tris[t].indexOf(vi);
        if (tris[t][(k + 1) % 3] === from) found = t;
      }
      if (found < 0 || fan.includes(found)) return false;
      fan.push(found);
      const k = tris[found].indexOf(vi);
      from = tris[found][(k + 2) % 3];
      chain.push(from);
    }
    if (fan.length !== incident.size || fan.length < 2) return false;
    // p and q must not already share an edge, or the roof would fold.
    for (const t of around.get(p) ?? []) if (!fan.includes(t) && tris[t].includes(q)) return false;

    // The polygon left behind: p, then the chain from q round to p.
    const polygon = [p, ...chain.slice(0, -1)];
    const coords = polygon.flatMap((i) => [x(i), y(i)]);
    const local = earcut(coords);
    if (local.length !== 3 * (polygon.length - 2)) return false;
    const made: number[][] = [];
    for (let i = 0; i < local.length; i += 3) {
      let [a, b, c] = [polygon[local[i]], polygon[local[i + 1]], polygon[local[i + 2]]];
      if (cross(a, b, c) < 0) [b, c] = [c, b];
      const longest = Math.max(Math.hypot(x(b) - x(a), y(b) - y(a)), Math.hypot(x(c) - x(b), y(c) - y(b)), Math.hypot(x(a) - x(c), y(a) - y(c)));
      if (!(cross(a, b, c) > MIN_ALTITUDE_M * longest)) return false;
      made.push([a, b, c]);
    }
    // Where the old triangles were, the new ones may not have moved the roof
    // by more than the tolerance, and the other way round.
    const locate = (list: number[][], px: number, py: number) => {
      for (const t of list) {
        const h = heightIn(t, px, py);
        if (h !== null) return h;
      }
      return null;
    };
    const oldTris = fan.map((t) => tris[t]);
    for (const [a, b, c] of [...oldTris, ...made]) {
      const cx = (x(a) + x(b) + x(c)) / 3;
      const cy = (y(a) + y(b) + y(c)) / 3;
      const before = locate(oldTris, cx, cy);
      const after = locate(made, cx, cy);
      if (before === null || after === null || Math.abs(before - after) > tolerance) return false;
    }

    for (const t of fan) {
      alive[t] = false;
      for (const i of tris[t]) around.get(i)?.delete(t);
    }
    around.delete(vi);
    for (const t of made) {
      tris.push(t);
      alive.push(true);
      link(tris.length - 1);
    }
    next.set(p, q);
    prev.set(q, p);
    next.delete(vi);
    prev.delete(vi);
    return true;
  };

  // Keep going until nothing more comes off: each removal can free a neighbour.
  let queue = [...next.keys()];
  while (queue.length) {
    const retry = new Set<number>();
    for (const vi of queue) {
      if (!around.has(vi)) continue;
      const [p, q] = [prev.get(vi), next.get(vi)];
      if (removeVertex(vi)) {
        retry.add(p!);
        retry.add(q!);
      }
    }
    queue = [...retry].filter((i) => around.has(i));
  }

  const used = new Int32Array(v.length / 3).fill(-1);
  const out: number[] = [];
  let count = 0;
  tris.forEach((t, i) => {
    if (!alive[i]) return;
    for (const p of t) {
      if (used[p] < 0) used[p] = count++;
      out.push(used[p]);
    }
  });
  const vertices = new Float64Array(count * 3);
  for (let p = 0; p < used.length; p++) {
    if (used[p] < 0) continue;
    vertices.set([v[3 * p], v[3 * p + 1], v[3 * p + 2]], 3 * used[p]);
  }
  return { vertices, triangles: Uint32Array.from(out) };
}
