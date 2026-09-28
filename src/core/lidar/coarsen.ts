// Removing vertices from a grid TIN (delatin.ts) while every masked cell
// stays within the tolerance of it, measured the same way. Greedy insertion
// needs a vertex every cell or two along a roof step, because Delaunay
// triangles cross the step instead of following it. Merging a vertex into a
// neighbour on the same step leaves a strip one cell wide with no cell inside
// it, so straight steps shrink to their ends. Not in the add-on.

import { errorScale, type Tolerance } from './delatin';

/** Half-edge collapses on grid vertices; `coords` are (i, j) pairs, triangles counter-clockwise. */
export function coarsen(coords: number[], triangles: number[], heights: ArrayLike<number>, nx: number, ny: number, tolerance: Tolerance): number[] {
  const { mask, weight } = tolerance;
  const n = coords.length / 2;
  const x = (v: number) => coords[2 * v];
  const y = (v: number) => coords[2 * v + 1];
  const z = (v: number) => heights[x(v) * ny + y(v)];
  const faces = triangles.slice();
  const alive = new Uint8Array(faces.length / 3).fill(1);
  const around: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let f = 0; f < faces.length / 3; f++) for (let k = 0; k < 3; k++) around[faces[3 * f + k]].add(f);
  // The grid's own edge stays put: it keeps the clip that follows whole.
  const pinned = (v: number) => x(v) === 0 || y(v) === 0 || x(v) === nx - 1 || y(v) === ny - 1;
  const removed = new Uint8Array(n);

  const neighbours = (v: number) => {
    const out = new Set<number>();
    for (const f of around[v]) for (let k = 0; k < 3; k++) out.add(faces[3 * f + k]);
    out.delete(v);
    return out;
  };

  // Worst cell under a triangle, stopping as soon as one is over the bound.
  const withinBound = (a: number, b: number, c: number): boolean => {
    const [ax, ay, bx, by, cx, cy] = [x(a), y(a), x(b), y(b), x(c), y(c)];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (area <= 0) return false;
    const [za, zb, zc] = [z(a), z(b), z(c)];
    const scale = errorScale(ax, ay, za, bx, by, zb, cx, cy, zc, tolerance);
    const minX = Math.min(ax, bx, cx);
    const maxX = Math.max(ax, bx, cx);
    const minY = Math.min(ay, by, cy);
    const maxY = Math.max(ay, by, cy);
    for (let i = minX; i <= maxX; i++) {
      for (let j = minY; j <= maxY; j++) {
        // Barycentric weights times twice the area, exact on the integer grid.
        const wa = (bx - i) * (cy - j) - (cx - i) * (by - j);
        const wb = (cx - i) * (ay - j) - (ax - i) * (cy - j);
        const wc = area - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const c = i * ny + j;
        if (mask && !mask[c]) continue;
        if (Math.abs((wa * za + wb * zb + wc * zc) / area - heights[c]) * scale * (weight ? weight[c] : 1) > 1) return false;
      }
    }
    return true;
  };

  const tryCollapse = (u: number, v: number): boolean => {
    const uFaces = [...around[u]];
    const shared = uFaces.filter((f) => around[v].has(f));
    if (!shared.length) return false;
    // Link condition: the only common neighbours are the apexes of the shared faces.
    const apexes = new Set<number>();
    for (const f of shared) for (let k = 0; k < 3; k++) apexes.add(faces[3 * f + k]);
    apexes.delete(u);
    apexes.delete(v);
    const nv = neighbours(v);
    for (const w of neighbours(u)) if (w !== v && nv.has(w) && !apexes.has(w)) return false;
    // Every face that keeps going must stay the right way up and within the bound.
    for (const f of uFaces) {
      if (shared.includes(f)) continue;
      const t = [faces[3 * f], faces[3 * f + 1], faces[3 * f + 2]].map((w) => (w === u ? v : w));
      if (!withinBound(t[0], t[1], t[2])) return false;
    }
    for (const f of shared) {
      alive[f] = 0;
      for (let k = 0; k < 3; k++) around[faces[3 * f + k]].delete(f);
    }
    for (const f of uFaces) {
      if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) if (faces[3 * f + k] === u) faces[3 * f + k] = v;
      around[v].add(f);
    }
    around[u].clear();
    removed[u] = 1;
    return true;
  };

  let queue: number[] = [];
  for (let v = 0; v < n; v++) if (!pinned(v)) queue.push(v);
  while (queue.length) {
    const retry = new Set<number>();
    for (const u of queue) {
      if (removed[u] || pinned(u)) continue;
      // Nearest neighbours first: they are the likeliest to share a step or a plane.
      const options = [...neighbours(u)].sort((p, q) => (x(p) - x(u)) ** 2 + (y(p) - y(u)) ** 2 - ((x(q) - x(u)) ** 2 + (y(q) - y(u)) ** 2));
      for (const v of options) {
        if (tryCollapse(u, v)) {
          for (const w of neighbours(v)) if (!removed[w]) retry.add(w);
          retry.add(v);
          break;
        }
      }
    }
    queue = [...retry];
  }

  const out: number[] = [];
  for (let f = 0; f < faces.length / 3; f++) if (alive[f]) out.push(faces[3 * f], faces[3 * f + 1], faces[3 * f + 2]);
  return out;
}
