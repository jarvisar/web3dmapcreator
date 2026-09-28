// Error-bounded edge collapse for a triangulated height raster, ported from
// the add-on's lidar_simplify.py.
//
// A raster cap costs one face per cell and draws every wall as a staircase of
// cells. Collapsing edges by quadric error (Garland & Heckbert) merges a flat
// roof into a few faces and a run of stairs into one straight facet.
//
// The error is priced against the faces as they are now, not the original
// ones (Lindstrom & Turk's memoryless variant). With accumulated quadrics a
// straight facet remembers every stair it replaced and walls stop merging at
// about a metre however loose the threshold.
//
// The cap has to stay a height field so its outline walls can be built: a
// collapse never flips a face in plan or leaves one thinner than MIN_GAP,
// never puts two vertices within MIN_GAP of each other in plan, and never
// moves a vertex on the mesh rim.

import { PySet } from './pyset';

export const MIN_GAP = 0.01;

type Plane = [number, number, number, number] | null;

function plane(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): Plane {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!length) return null;
  nx /= length;
  ny /= length;
  nz /= length;
  return [nx, ny, nz, -(nx * ax + ny * ay + nz * az)];
}

/** The 10 unique entries of the summed 4x4 plane quadric. */
function quadric(planes: [number, number, number, number][]): number[] {
  const q = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const [a, b, c, d] of planes) {
    q[0] += a * a;
    q[1] += a * b;
    q[2] += a * c;
    q[3] += a * d;
    q[4] += b * b;
    q[5] += b * c;
    q[6] += b * d;
    q[7] += c * c;
    q[8] += c * d;
    q[9] += d * d;
  }
  return q;
}

function error(q: number[], x: number, y: number, z: number): number {
  return q[0] * x * x + q[4] * y * y + q[7] * z * z + 2 * (q[1] * x * y + q[2] * x * z + q[5] * y * z + q[3] * x + q[6] * y + q[8] * z) + q[9];
}

/** The point minimising the quadric, or null when the planes do not fix one. */
function optimum(q: number[]): [number, number, number] | null {
  const [a, b, c, d, e, f, g, h, i] = [q[0], q[1], q[2], q[4], q[5], q[7], q[3], q[6], q[8]];
  const det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
  const trace = (a + d + f) / 3;
  if (trace <= 0 || det <= 1e-6 * trace * trace * trace) return null;
  const x = -(g * (d * f - e * e) - b * (h * f - e * i) + c * (h * e - d * i)) / det;
  const y = -(a * (h * f - e * i) - g * (b * f - c * e) + c * (b * i - h * c)) / det;
  const z = -(a * (d * i - e * h) - b * (b * i - c * h) + g * (b * e - c * d)) / det;
  return [x, y, z];
}

interface Entry {
  cost: number;
  length: number;
  a: number;
  b: number;
  va: number;
  vb: number;
  x: number;
  y: number;
  z: number;
}

// Same total order as the add-on's heap tuples, so ties break the same way.
function before(p: Entry, q: Entry): boolean {
  if (p.cost !== q.cost) return p.cost < q.cost;
  if (p.length !== q.length) return p.length < q.length;
  if (p.a !== q.a) return p.a < q.a;
  if (p.b !== q.b) return p.b < q.b;
  if (p.va !== q.va) return p.va < q.va;
  if (p.vb !== q.vb) return p.vb < q.vb;
  if (p.x !== q.x) return p.x < q.x;
  if (p.y !== q.y) return p.y < q.y;
  return p.z < q.z;
}

class Heap {
  private items: Entry[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): Entry {
    return this.items[0];
  }

  push(entry: Entry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop(): Entry {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && before(items[l], items[m])) m = l;
        if (r < items.length && before(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top;
  }
}

export interface CollapseOptions {
  /** A merged vertex never sits further than this from any face it replaces. */
  deviation?: number;
  /** Vertices of slender masses: edges touching them are held to half the deviation. */
  fine?: Iterable<number>;
}

/**
 * Collapse every edge cheaper than `threshold`, then keep collapsing the
 * cheapest while there are more than `budget` faces. `vertices` are xyz
 * triplets in metres, `faces` counter-clockwise triangles in plan. Returns
 * the kept vertices (in their original order) and faces.
 *
 * The bound is a distance to planes, and a wall's plane says nothing about
 * height: a wall may wander `deviation` sideways at every merge, which folds a
 * mass only a few times that wide into its neighbours. Edges touching a
 * `fine` vertex, or a vertex that absorbed one, get half the bound.
 */
export function collapse(
  vertices: ArrayLike<number>,
  faces: ArrayLike<number>,
  threshold: number,
  budget: number,
  options: CollapseOptions = {},
): { vertices: Float64Array; faces: Uint32Array } {
  const deviation = options.deviation ?? Infinity;
  const vertexCount = vertices.length / 3;
  const faceCount = faces.length / 3;
  const V = Float64Array.from(vertices);
  const F = Int32Array.from(faces);
  const alive = new Uint8Array(faceCount).fill(1);
  // Face sets per vertex, iterated in the add-on's order: see pyset.ts.
  const vf: PySet[] = new Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) vf[v] = new PySet();
  for (let f = 0; f < faceCount; f++) for (let k = 0; k < 3; k++) vf[F[3 * f + k]].add(f);

  // Unique edges, sorted, and the vertices on edges used once: the rim.
  const edgeUses = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * vertexCount + b : b * vertexCount + a);
  for (let f = 0; f < faceCount; f++) {
    for (let k = 0; k < 3; k++) {
      const e = key(F[3 * f + k], F[3 * f + ((k + 1) % 3)]);
      edgeUses.set(e, (edgeUses.get(e) ?? 0) + 1);
    }
  }
  const pinned = new Uint8Array(vertexCount);
  const edges: number[] = [];
  for (const [e, n] of edgeUses) {
    edges.push(e);
    if (n === 1) {
      pinned[Math.floor(e / vertexCount)] = 1;
      pinned[e % vertexCount] = 1;
    }
  }
  edges.sort((p, q) => p - q);
  const fine = new Uint8Array(vertexCount);
  for (const v of options.fine ?? []) fine[v] = 1;
  const version = new Int32Array(vertexCount);
  const heap = new Heap();

  // A face's plane changes only when a collapse moves one of its corners.
  const planes: Plane[] = new Array(faceCount);
  const refit = (f: number) => {
    const a = 3 * F[3 * f];
    const b = 3 * F[3 * f + 1];
    const c = 3 * F[3 * f + 2];
    planes[f] = plane(V[a], V[a + 1], V[a + 2], V[b], V[b + 1], V[b + 2], V[c], V[c + 1], V[c + 2]);
  };
  for (let f = 0; f < faceCount; f++) refit(f);

  const neighbours = (v: number): Set<number> => {
    const out = new Set<number>();
    for (const f of vf[v]) for (let k = 0; k < 3; k++) out.add(F[3 * f + k]);
    out.delete(v);
    return out;
  };

  const push = (a: number, b: number) => {
    if (a > b) [a, b] = [b, a];
    const pinA = pinned[a] === 1;
    const pinB = pinned[b] === 1;
    if (pinA && pinB) return;
    const around: [number, number, number, number][] = [];
    for (const f of PySet.union(vf[a], vf[b])) {
      const p = planes[f];
      if (p) around.push(p);
    }
    const q = quadric(around);
    const ax = V[3 * a];
    const ay = V[3 * a + 1];
    const az = V[3 * a + 2];
    const bx = V[3 * b];
    const by = V[3 * b + 1];
    const bz = V[3 * b + 2];
    const candidates: [number, number, number][] = [];
    if (pinA) candidates.push([ax, ay, az]);
    else if (pinB) candidates.push([bx, by, bz]);
    else {
      const mid: [number, number, number] = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2];
      candidates.push([ax, ay, az], [bx, by, bz], mid);
      const best = optimum(q);
      if (best && Math.hypot(best[0] - mid[0], best[1] - mid[1], best[2] - mid[2]) <= 2 * Math.hypot(ax - bx, ay - by, az - bz) + 1) {
        candidates.push(best);
      }
    }
    const bound = fine[a] || fine[b] ? deviation / 2 : deviation;
    const priced = candidates.map((c) => ({ cost: Math.max(error(q, c[0], c[1], c[2]), 0), c }));
    priced.sort((p, r) => p.cost - r.cost || p.c[0] - r.c[0] || p.c[1] - r.c[1] || p.c[2] - r.c[2]);
    for (const { cost, c } of priced) {
      let ok = true;
      for (const [nx, ny, nz, d] of around) {
        if (Math.abs(nx * c[0] + ny * c[1] + nz * c[2] + d) > bound) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      heap.push({
        cost,
        length: (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2,
        a,
        b,
        va: version[a],
        vb: version[b],
        x: c[0],
        y: c[1],
        z: c[2],
      });
      return;
    }
  };

  for (const e of edges) push(Math.floor(e / vertexCount), e % vertexCount);
  let count = faceCount;

  // Twice the plan area over the longest edge is the least altitude.
  const folds = (f: number, a: number, b: number, x: number, y: number): boolean => {
    const pts: number[] = [];
    for (let k = 0; k < 3; k++) {
      const v = F[3 * f + k];
      if (v === a || v === b) pts.push(x, y);
      else pts.push(V[3 * v], V[3 * v + 1]);
    }
    const [px, py, qx, qy, rx, ry] = pts;
    const cross = (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const longest = Math.max((qx - px) ** 2 + (qy - py) ** 2, (rx - qx) ** 2 + (ry - qy) ** 2, (px - rx) ** 2 + (py - ry) ** 2);
    return cross <= MIN_GAP * Math.sqrt(longest);
  };

  while (heap.size && (count > budget || heap.peek().cost <= threshold)) {
    const { a, b, va, vb, x, y, z } = heap.pop();
    if (version[a] !== va || version[b] !== vb) continue;
    const shared: number[] = [];
    for (const f of vf[a]) if (vf[b].has(f)) shared.push(f);
    const aroundA = neighbours(a);
    const aroundB = neighbours(b);
    // Link condition: the only common neighbours are the apexes of the faces
    // on this edge, so the collapse cannot pinch the cap.
    const apexes = new Set<number>();
    for (const f of shared) for (let k = 0; k < 3; k++) apexes.add(F[3 * f + k]);
    apexes.delete(a);
    apexes.delete(b);
    let common = 0;
    let linked = true;
    for (const u of aroundA) {
      if (!aroundB.has(u)) continue;
      common++;
      if (!apexes.has(u)) {
        linked = false;
        break;
      }
    }
    if (!linked || common !== apexes.size) continue;
    let folded = false;
    for (const set of [vf[a], vf[b]]) {
      for (const f of set) {
        if (shared.includes(f)) continue;
        if (folds(f, a, b, x, y)) {
          folded = true;
          break;
        }
      }
      if (folded) break;
    }
    if (folded) continue;
    let crowded = false;
    for (const set of [aroundA, aroundB]) {
      for (const u of set) {
        if (u === a || u === b) continue;
        if ((V[3 * u] - x) ** 2 + (V[3 * u + 1] - y) ** 2 < MIN_GAP * MIN_GAP) {
          crowded = true;
          break;
        }
      }
      if (crowded) break;
    }
    if (crowded) continue;

    V[3 * a] = x;
    V[3 * a + 1] = y;
    V[3 * a + 2] = z;
    for (const f of shared) {
      alive[f] = 0;
      count--;
      for (let k = 0; k < 3; k++) vf[F[3 * f + k]].delete(f);
    }
    for (const f of vf[b].values()) {
      for (let k = 0; k < 3; k++) if (F[3 * f + k] === b) F[3 * f + k] = a;
      vf[a].add(f);
    }
    vf[b] = new PySet();
    for (const f of vf[a]) refit(f);
    version[a]++;
    version[b] = -1;
    if (pinned[b]) pinned[a] = 1;
    if (fine[b]) fine[a] = 1;
    for (const u of neighbours(a)) push(a, u);
  }

  const used = new Int32Array(vertexCount).fill(-1);
  let keptFaces = 0;
  for (let f = 0; f < faceCount; f++) {
    if (!alive[f]) continue;
    keptFaces++;
    for (let k = 0; k < 3; k++) used[F[3 * f + k]] = 0;
  }
  let next = 0;
  for (let v = 0; v < vertexCount; v++) if (used[v] === 0) used[v] = next++;
  const outVertices = new Float64Array(next * 3);
  for (let v = 0; v < vertexCount; v++) {
    const i = used[v];
    if (i < 0) continue;
    outVertices[3 * i] = V[3 * v];
    outVertices[3 * i + 1] = V[3 * v + 1];
    outVertices[3 * i + 2] = V[3 * v + 2];
  }
  const outFaces = new Uint32Array(keptFaces * 3);
  let o = 0;
  for (let f = 0; f < faceCount; f++) {
    if (!alive[f]) continue;
    for (let k = 0; k < 3; k++) outFaces[o++] = used[F[3 * f + k]];
  }
  return { vertices: outVertices, faces: outFaces };
}
