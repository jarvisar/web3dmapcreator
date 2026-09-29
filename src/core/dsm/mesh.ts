// The top surface of a LiDAR Only model: a height grid triangulated into a
// TIN that covers the grid's rectangle exactly. Ported from the add-on's
// dsm_mesh.py, with one change.
//
// A right-triangulated irregular network (Mapbox's Martini) first drops what
// a flat roof or street doesn't need, cheaply and without cracks. Then edges
// collapse, cheapest first, priced by memoryless quadric error: against the
// faces as they are now, so a wall drawn in one-cell stairs keeps merging
// into one straight facet. Accumulated quadrics stop at the first stair.
//
// The change: every collapse is also checked against the grid itself, and
// no grid point may end up further than `deviation` from the surface,
// measured square to it (so across a wall it's how far the wall moved).
// Priced only against the current faces, a vertex can move a little each
// time until a penthouse is a pyramid, which is what happened to roof caps.
//
// Vertices on the grid's edge only slide along their own side and corners
// never move, so the outline stays the exact rectangle. Tiles of 512 cells have every point
// on their edges as a vertex, so they can be simplified apart (in workers)
// with those points pinned, then the seams get one more pass.

import type { Tin } from '../geometry/tinclip';

export const TILE = 512;

export interface MeshLimits {
  /** Largest distance from a grid point to the surface, in mm. */
  deviation: number;
  /** Largest quadric cost of a collapse, in mm². */
  threshold: number;
  /** Least altitude of a triangle in plan, in mm. */
  minGap: number;
}

/** A height grid in model mm: point (i, j) at (x0 + i dx, y0 + j dy), index j * nx + i. */
export interface HeightGrid {
  heights: Float32Array;
  /** Per point factor on the deviation: under 1 holds a tree to finer facets, over 1 lets a wall straighten. */
  detail: Float32Array;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  /** Far edges, exactly, so the surface ends on the area's own outline. */
  x1: number;
  y1: number;
  dx: number;
  dy: number;
}

// ------------------------------------------------------------------- RTIN

/**
 * Right triangles over a pw x ph block (row-major, row 0 south) where every
 * point on the block's edge is a vertex, as three (x, y) grid points each,
 * counter-clockwise. A point splits its triangle when its error over the
 * tolerance times its detail is more than 1.
 */
export function rtinBlock(heights: ArrayLike<number>, detail: ArrayLike<number> | null, pw: number, ph: number, tolerance: number): Int32Array {
  let size = 1;
  while (size < Math.max(pw - 1, ph - 1, 1)) size *= 2;
  const g = size + 1;
  const h = new Float64Array(g * g);
  const scale = new Float64Array(g * g);
  for (let y = 0; y < g; y++) {
    const sy = Math.min(y, ph - 1);
    for (let x = 0; x < g; x++) {
      const k = sy * pw + Math.min(x, pw - 1);
      h[y * g + x] = heights[k];
      scale[y * g + x] = 1 / (tolerance * (detail ? detail[k] : 1));
    }
  }
  // Errors are shares of what each point allows. Points on the block's edge
  // always split, so tiles share their edges and nothing crosses one.
  const errors = new Float64Array(g * g);
  for (let x = 0; x < pw; x++) errors[x] = errors[(ph - 1) * g + x] = Infinity;
  for (let y = 0; y < ph; y++) errors[y * g] = errors[y * g + pw - 1] = Infinity;
  const smallest = size * size;
  const count = smallest * 2 - 2;
  const lastLevel = count - smallest;
  for (let i = count - 1; i >= 0; i--) {
    let id = i + 2;
    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    let cx = 0;
    let cy = 0;
    if (id & 1) bx = by = cx = size;
    else ax = ay = cy = size;
    while ((id >>= 1) > 1) {
      const mx = (ax + bx) >> 1;
      const my = (ay + by) >> 1;
      if (id & 1) {
        bx = ax;
        by = ay;
        ax = cx;
        ay = cy;
      } else {
        ax = bx;
        ay = by;
        bx = cx;
        by = cy;
      }
      cx = mx;
      cy = my;
    }
    const middle = ((ay + by) >> 1) * g + ((ax + bx) >> 1);
    let e = Math.abs((h[ay * g + ax] + h[by * g + bx]) / 2 - h[middle]) * scale[middle];
    if (i < lastLevel) e = Math.max(e, errors[((ay + cy) >> 1) * g + ((ax + cx) >> 1)], errors[((by + cy) >> 1) * g + ((bx + cx) >> 1)]);
    if (e > errors[middle]) errors[middle] = e;
  }
  let out = new Int32Array(6 * 1024);
  let n = 0;
  const stack: number[] = [0, 0, size, size, size, 0, size, size, 0, 0, 0, size];
  while (stack.length) {
    const cy = stack.pop()!;
    const cx = stack.pop()!;
    const by = stack.pop()!;
    const bx = stack.pop()!;
    const ay = stack.pop()!;
    const ax = stack.pop()!;
    const mx = (ax + bx) >> 1;
    const my = (ay + by) >> 1;
    if (Math.abs(ax - cx) + Math.abs(ay - cy) > 1 && errors[my * g + mx] > 1) {
      stack.push(cx, cy, ax, ay, mx, my, bx, by, cx, cy, mx, my);
      continue;
    }
    // Nothing straddles the block's edge, so a triangle is in it iff its centroid is.
    if (ax + bx + cx >= 3 * (pw - 1) || ay + by + cy >= 3 * (ph - 1)) continue;
    if (n + 6 > out.length) {
      const grown = new Int32Array(out.length * 2);
      grown.set(out);
      out = grown;
    }
    const ccw = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0;
    out[n++] = ax;
    out[n++] = ay;
    if (ccw) {
      out[n++] = bx;
      out[n++] = by;
      out[n++] = cx;
      out[n++] = cy;
    } else {
      out[n++] = cx;
      out[n++] = cy;
      out[n++] = bx;
      out[n++] = by;
    }
  }
  return out.slice(0, n);
}

// --------------------------------------------------------------- collapse

/** The grid a surface must stay near, with each point's own allowance. */
export interface GridBound {
  heights: ArrayLike<number>;
  /** Largest distance square to the surface at each point, in mm. */
  tolerance: ArrayLike<number>;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
}

export interface EditableMesh {
  /** xyz triplets. */
  positions: Float64Array;
  /** Counter-clockwise in plan. */
  triangles: Uint32Array;
  /** Rim sides of each vertex: 1 west, 2 east, 4 south, 8 north. */
  side: Uint8Array;
  /** Never moves or goes: corners and tile seams. */
  pinned: Uint8Array;
  /** Factor on the deviation and (squared) the threshold. */
  detail: Float32Array;
  /** Carried along to the vertex that stays, e.g. a seam point's grid index. */
  keys: Int32Array;
}

const WEST = 1;
const EAST = 2;
const SOUTH = 4;
const NORTH = 8;

/** Sides of the rectangle a grid point is on. */
export function gridSide(i: number, j: number, nx: number, ny: number): number {
  return (i === 0 ? WEST : 0) | (i === nx - 1 ? EAST : 0) | (j === 0 ? SOUTH : 0) | (j === ny - 1 ? NORTH : 0);
}

const isCorner = (side: number) => (side & (WEST | EAST)) !== 0 && (side & (SOUTH | NORTH)) !== 0;

/** A binary min-heap of candidate collapses, by cost then length. Stale entries are skipped on the way out. */
class Queue {
  cost = new Float64Array(1024);
  length = new Float64Array(1024);
  u = new Int32Array(1024);
  w = new Int32Array(1024);
  su = new Int32Array(1024);
  sw = new Int32Array(1024);
  private heap = new Int32Array(1024);
  private free: number[] = [];
  private slots = 0;
  size = 0;

  private grow() {
    const n = this.cost.length * 2;
    const f = (a: Float64Array) => {
      const b = new Float64Array(n);
      b.set(a);
      return b;
    };
    const i = (a: Int32Array) => {
      const b = new Int32Array(n);
      b.set(a);
      return b;
    };
    this.cost = f(this.cost);
    this.length = f(this.length);
    this.u = i(this.u);
    this.w = i(this.w);
    this.su = i(this.su);
    this.sw = i(this.sw);
    this.heap = i(this.heap);
  }

  private less(a: number, b: number): boolean {
    return this.cost[a] < this.cost[b] || (this.cost[a] === this.cost[b] && this.length[a] < this.length[b]);
  }

  private up(i: number) {
    const h = this.heap;
    const slot = h[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(slot, h[parent])) break;
      h[i] = h[parent];
      i = parent;
    }
    h[i] = slot;
  }

  private down(i: number) {
    const h = this.heap;
    const n = this.size;
    const slot = h[i];
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && this.less(h[r], h[l]) ? r : l;
      if (!this.less(h[c], slot)) break;
      h[i] = h[c];
      i = c;
    }
    h[i] = slot;
  }

  push(cost: number, length: number, u: number, w: number, su: number, sw: number) {
    let slot = this.free.pop();
    if (slot === undefined) {
      if (this.slots === this.cost.length) this.grow();
      slot = this.slots++;
    }
    this.cost[slot] = cost;
    this.length[slot] = length;
    this.u[slot] = u;
    this.w[slot] = w;
    this.su[slot] = su;
    this.sw[slot] = sw;
    this.heap[this.size] = slot;
    this.up(this.size++);
  }

  /** The slot of the smallest entry, taken off the heap. Its fields stay readable until the next push. */
  pop(): number {
    const slot = this.heap[0];
    this.heap[0] = this.heap[--this.size];
    if (this.size) this.down(0);
    this.free.push(slot);
    return slot;
  }

  /** Keeps only the entries `keep` accepts. */
  compact(keep: (slot: number) => boolean) {
    let n = 0;
    for (let i = 0; i < this.size; i++) {
      const slot = this.heap[i];
      if (keep(slot)) this.heap[n++] = slot;
      else this.free.push(slot);
    }
    this.size = n;
    for (let i = (n >> 1) - 1; i >= 0; i--) this.down(i);
  }
}

// Placements of the vertex that stays: at u, at w, halfway, or where the quadric is least.
const AT_U = 0;
const AT_W = 1;
const MID = 2;
const OPT = 3;

/**
 * Edge collapses on a height-field TIN. Build it, call run() until it
 * returns true, then take result().
 */
export class Collapser {
  private readonly pos: Float64Array;
  private readonly tri: Int32Array;
  private readonly plane: Float64Array;
  private readonly dead: Uint8Array;
  private readonly faces: number[][];
  private readonly quad: Float64Array;
  private readonly alive: Uint8Array;
  private readonly stamp: Int32Array;
  private readonly mark: Int32Array;
  private epoch = 0;
  private readonly seen: Int32Array;
  private turn = 0;
  private readonly side: Uint8Array;
  private readonly pinned: Uint8Array;
  private readonly detail: Float32Array;
  private readonly keys: Int32Array;
  private readonly queue = new Queue();
  private pending = 0;
  private live = 0;
  collapses = 0;
  // Scratch for one edge's evaluation.
  private readonly qe = new Float64Array(10);
  private readonly places = new Float64Array(12);
  private readonly costs = new Float64Array(4);
  private f1 = -1;
  private f2 = -1;

  constructor(
    mesh: EditableMesh,
    private readonly limits: MeshLimits,
    private readonly bound: GridBound | null,
    live?: Uint8Array,
  ) {
    const n = mesh.positions.length / 3;
    const m = mesh.triangles.length / 3;
    this.pos = Float64Array.from(mesh.positions);
    this.tri = Int32Array.from(mesh.triangles);
    this.plane = new Float64Array(4 * m);
    this.dead = new Uint8Array(m);
    this.faces = Array.from({ length: n }, () => [] as number[]);
    for (let f = 0; f < m; f++) {
      for (let k = 0; k < 3; k++) this.faces[this.tri[3 * f + k]].push(f);
      this.setPlane(f);
    }
    this.quad = new Float64Array(10 * n);
    this.alive = new Uint8Array(n);
    for (let v = 0; v < n; v++) {
      if (!this.faces[v].length) continue;
      this.alive[v] = 1;
      this.setQuadric(v);
    }
    this.live = n;
    this.stamp = new Int32Array(n);
    this.mark = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.side = mesh.side;
    this.pinned = Uint8Array.from(mesh.pinned);
    for (let v = 0; v < n; v++) if (isCorner(this.side[v])) this.pinned[v] = 1;
    this.detail = mesh.detail;
    this.keys = Int32Array.from(mesh.keys);
    for (let f = 0; f < m; f++) {
      for (let k = 0; k < 3; k++) {
        const a = this.tri[3 * f + k];
        const b = this.tri[3 * f + ((k + 1) % 3)];
        if (live && !live[a] && !live[b]) continue;
        // Each interior edge runs both ways, so it is queued once from a < b. A rim edge runs one way only.
        if (a < b || this.edgeFaces(a, b) === 1) this.offer(a, b);
      }
    }
  }

  private setPlane(f: number) {
    const t = this.tri;
    const p = this.pos;
    const a = 3 * t[3 * f];
    const b = 3 * t[3 * f + 1];
    const c = 3 * t[3 * f + 2];
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    const q = 4 * f;
    this.plane[q] = nx;
    this.plane[q + 1] = ny;
    this.plane[q + 2] = nz;
    this.plane[q + 3] = -(nx * p[a] + ny * p[a + 1] + nz * p[a + 2]);
  }

  private setQuadric(v: number) {
    const q = this.quad;
    const o = 10 * v;
    q.fill(0, o, o + 10);
    for (const f of this.faces[v]) {
      const k = 4 * f;
      const a = this.plane[k];
      const b = this.plane[k + 1];
      const c = this.plane[k + 2];
      const d = this.plane[k + 3];
      q[o] += a * a;
      q[o + 1] += a * b;
      q[o + 2] += a * c;
      q[o + 3] += a * d;
      q[o + 4] += b * b;
      q[o + 5] += b * c;
      q[o + 6] += b * d;
      q[o + 7] += c * c;
      q[o + 8] += c * d;
      q[o + 9] += d * d;
    }
  }

  /** How many faces have edge u-w, and which (into f1, f2). */
  private edgeFaces(u: number, w: number): number {
    this.f1 = -1;
    this.f2 = -1;
    let count = 0;
    const t = this.tri;
    for (const f of this.faces[u]) {
      if (t[3 * f] === w || t[3 * f + 1] === w || t[3 * f + 2] === w) {
        if (count === 0) this.f1 = f;
        else this.f2 = f;
        count++;
      }
    }
    return count;
  }

  private subtractFace(f: number) {
    const qe = this.qe;
    const k = 4 * f;
    const a = this.plane[k];
    const b = this.plane[k + 1];
    const c = this.plane[k + 2];
    const d = this.plane[k + 3];
    qe[0] -= a * a;
    qe[1] -= a * b;
    qe[2] -= a * c;
    qe[3] -= a * d;
    qe[4] -= b * b;
    qe[5] -= b * c;
    qe[6] -= b * d;
    qe[7] -= c * c;
    qe[8] -= c * d;
    qe[9] -= d * d;
  }

  private cost(x: number, y: number, z: number): number {
    const q = this.qe;
    const value = x * (q[0] * x + 2 * (q[1] * y + q[2] * z + q[3])) + y * (q[4] * y + 2 * (q[5] * z + q[6])) + z * (q[7] * z + 2 * q[8]) + q[9];
    return value > 0 ? value : 0;
  }

  /**
   * Costs of the four placements for edge u-w into `costs` (Infinity where
   * not allowed), with the edge's faces in f1 and f2. Returns the least, or
   * Infinity when the edge can't collapse.
   */
  private evaluate(u: number, w: number): number {
    const count = this.edgeFaces(u, w);
    const costs = this.costs;
    costs.fill(Infinity);
    if (!count) return Infinity;
    const boundary = count === 1;
    const qe = this.qe;
    const qu = 10 * u;
    const qw = 10 * w;
    for (let k = 0; k < 10; k++) qe[k] = this.quad[qu + k] + this.quad[qw + k];
    this.subtractFace(this.f1);
    if (this.f2 >= 0) this.subtractFace(this.f2);
    const p = this.pos;
    const places = this.places;
    const su = this.side[u];
    const sw = this.side[w];
    // A rim vertex may only merge along its own side, and pinned ones never move.
    const intoU = !this.pinned[w] && (sw === 0 || boundary);
    const intoW = !this.pinned[u] && (su === 0 || boundary);
    const free = su === 0 && sw === 0 && !this.pinned[u] && !this.pinned[w];
    for (let k = 0; k < 3; k++) {
      places[k] = p[3 * u + k];
      places[3 + k] = p[3 * w + k];
      places[6 + k] = (p[3 * u + k] + p[3 * w + k]) / 2;
    }
    if (intoU) costs[AT_U] = this.cost(places[0], places[1], places[2]);
    if (intoW) costs[AT_W] = this.cost(places[3], places[4], places[5]);
    if (free) {
      costs[MID] = this.cost(places[6], places[7], places[8]);
      // Nothing beats a placement that costs nothing, and flat ground is mostly that.
      if (Math.min(costs[AT_U], costs[AT_W], costs[MID]) > 0 && this.optimum()) {
        const ex = p[3 * u] - p[3 * w];
        const ey = p[3 * u + 1] - p[3 * w + 1];
        const ez = p[3 * u + 2] - p[3 * w + 2];
        const ox = places[9] - places[6];
        const oy = places[10] - places[7];
        const oz = places[11] - places[8];
        const reach = 2 * Math.sqrt(ex * ex + ey * ey + ez * ez) + this.limits.deviation * Math.min(this.detail[u], this.detail[w]);
        if (ox * ox + oy * oy + oz * oz <= reach * reach) costs[OPT] = this.cost(places[9], places[10], places[11]);
      }
    }
    return Math.min(costs[0], costs[1], costs[2], costs[3]);
  }

  /** The point minimising the edge quadric into places[9..11], when the planes fix one. */
  private optimum(): boolean {
    const q = this.qe;
    const a = q[0];
    const b = q[1];
    const c = q[2];
    const d = q[4];
    const e = q[5];
    const f = q[7];
    const g = q[3];
    const h = q[6];
    const i = q[8];
    const minorA = d * f - e * e;
    const minorB = b * f - c * e;
    const minorC = b * e - c * d;
    const det = a * minorA - b * minorB + c * minorC;
    const trace = (a + d + f) / 3;
    if (!(trace > 0 && det > 1e-6 * trace ** 3)) return false;
    this.places[9] = -(g * minorA - b * (h * f - e * i) + c * (h * e - d * i)) / det;
    this.places[10] = -(a * (h * f - e * i) - g * minorB + c * (b * i - h * c)) / det;
    this.places[11] = -(a * (d * i - e * h) - b * (b * i - c * h) + g * minorC) / det;
    return true;
  }

  private offer(u: number, w: number) {
    const best = this.evaluate(u, w);
    const factor = Math.min(this.detail[u], this.detail[w]);
    if (!(best <= this.limits.threshold * factor * factor)) return;
    const p = this.pos;
    const ex = p[3 * u] - p[3 * w];
    const ey = p[3 * u + 1] - p[3 * w + 1];
    this.queue.push(best, ex * ex + ey * ey, u, w, this.stamp[u], this.stamp[w]);
    this.pending++;
  }

  /** Whether u and w share no neighbour but the corners of their edge's faces. */
  private linked(u: number, w: number, faces: number): boolean {
    const e = (this.epoch += 2);
    const t = this.tri;
    const mark = this.mark;
    for (const f of this.faces[u]) for (let k = 0; k < 3; k++) mark[t[3 * f + k]] = e;
    let common = 0;
    for (const f of this.faces[w]) {
      for (let k = 0; k < 3; k++) {
        const v = t[3 * f + k];
        if (v === u || v === w || mark[v] !== e) continue;
        mark[v] = e + 1;
        common++;
      }
    }
    return common === faces;
  }

  /** Every face around u or w still meets `limits` with both moved to (x, y, z). */
  private acceptable(u: number, w: number, x: number, y: number, z: number, factor: number): boolean {
    const t = this.tri;
    const p = this.pos;
    const reach = this.limits.deviation * factor;
    const gap = this.limits.minGap;
    for (const v of [u, w]) {
      for (const f of this.faces[v]) {
        if (v === w && (t[3 * f] === u || t[3 * f + 1] === u || t[3 * f + 2] === u)) continue;
        const k = 4 * f;
        if (Math.abs(this.plane[k] * x + this.plane[k + 1] * y + this.plane[k + 2] * z + this.plane[k + 3]) > reach) return false;
        if (f === this.f1 || f === this.f2) continue;
        // The face as it would be: least altitude in plan over the gap.
        let ax = 0;
        let ay = 0;
        let bx = 0;
        let by = 0;
        let cx = 0;
        let cy = 0;
        for (let j = 0; j < 3; j++) {
          const q = t[3 * f + j];
          const moved = q === u || q === w;
          const px = moved ? x : p[3 * q];
          const py = moved ? y : p[3 * q + 1];
          if (j === 0) {
            ax = px;
            ay = py;
          } else if (j === 1) {
            bx = px;
            by = py;
          } else {
            cx = px;
            cy = py;
          }
        }
        const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const longest = Math.max((bx - ax) ** 2 + (by - ay) ** 2, (cx - bx) ** 2 + (cy - by) ** 2, (ax - cx) ** 2 + (ay - cy) ** 2);
        if (!(cross > gap * Math.sqrt(longest))) return false;
      }
    }
    return this.bound ? this.nearGrid(u, w, x, y, z) : true;
  }

  /** Every grid point under the faces around u and w stays within its tolerance of them, both moved to (x, y, z). */
  private nearGrid(u: number, w: number, x: number, y: number, z: number): boolean {
    const t = this.tri;
    const p = this.pos;
    for (const v of [u, w]) {
      for (const f of this.faces[v]) {
        if (f === this.f1 || f === this.f2) continue;
        if (v === w && (t[3 * f] === u || t[3 * f + 1] === u || t[3 * f + 2] === u)) continue;
        const a = t[3 * f];
        const b = t[3 * f + 1];
        const c = t[3 * f + 2];
        const ma = a === u || a === w;
        const mb = b === u || b === w;
        const mc = c === u || c === w;
        if (
          !this.faceNearGrid(
            ma ? x : p[3 * a], ma ? y : p[3 * a + 1], ma ? z : p[3 * a + 2],
            mb ? x : p[3 * b], mb ? y : p[3 * b + 1], mb ? z : p[3 * b + 2],
            mc ? x : p[3 * c], mc ? y : p[3 * c + 1], mc ? z : p[3 * c + 2],
          )
        ) {
          return false;
        }
      }
    }
    return true;
  }

  private faceNearGrid(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): boolean {
    const g = this.bound!;
    const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!(det > 0)) return false;
    // Height gradient, and the cosine of the slope: distance square to the face per unit height.
    const gx = ((bz - az) * (cy - ay) - (cz - az) * (by - ay)) / det;
    const gy = ((cz - az) * (bx - ax) - (bz - az) * (cx - ax)) / det;
    const square = 1 / Math.sqrt(1 + gx * gx + gy * gy);
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - g.x0) / g.dx - 1e-9));
    const i1 = Math.min(g.nx - 1, Math.floor((Math.max(ax, bx, cx) - g.x0) / g.dx + 1e-9));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - g.y0) / g.dy - 1e-9));
    const j1 = Math.min(g.ny - 1, Math.floor((Math.max(ay, by, cy) - g.y0) / g.dy + 1e-9));
    const eps = -1e-9 * det;
    for (let j = j0; j <= j1; j++) {
      const py = g.y0 + j * g.dy;
      for (let i = i0; i <= i1; i++) {
        const px = g.x0 + i * g.dx;
        // Barycentric weights times det. Points on an edge count for both faces.
        const wa = (bx - px) * (cy - py) - (by - py) * (cx - px);
        if (wa < eps) continue;
        const wb = (cx - px) * (ay - py) - (cy - py) * (ax - px);
        if (wb < eps) continue;
        const wc = det - wa - wb;
        if (wc < eps) continue;
        const k = j * g.nx + i;
        const surface = az + gx * (px - ax) + gy * (py - ay);
        if (Math.abs(surface - g.heights[k]) * square > g.tolerance[k]) return false;
      }
    }
    return true;
  }

  private kill(f: number, gone: number) {
    this.dead[f] = 1;
    for (let k = 0; k < 3; k++) {
      const v = this.tri[3 * f + k];
      if (v === gone) continue;
      const list = this.faces[v];
      const at = list.indexOf(f);
      list[at] = list[list.length - 1];
      list.pop();
    }
  }

  /** Collapse edge u-w with `keep` staying at (x, y, z). f1 and f2 are the edge's faces. */
  private apply(keep: number, gone: number, x: number, y: number, z: number) {
    const t = this.tri;
    this.pos[3 * keep] = x;
    this.pos[3 * keep + 1] = y;
    this.pos[3 * keep + 2] = z;
    this.kill(this.f1, gone);
    if (this.f2 >= 0) this.kill(this.f2, gone);
    for (const f of this.faces[gone]) {
      if (this.dead[f]) continue;
      for (let k = 0; k < 3; k++) if (t[3 * f + k] === gone) t[3 * f + k] = keep;
      this.faces[keep].push(f);
    }
    this.faces[gone] = [];
    this.alive[gone] = 0;
    this.live--;
    for (const f of this.faces[keep]) this.setPlane(f);
    // The vertex that stays and everything around it: their faces moved.
    const e = (this.epoch += 2);
    const mark = this.mark;
    const around: number[] = [keep];
    mark[keep] = e;
    for (const f of this.faces[keep]) {
      for (let k = 0; k < 3; k++) {
        const v = t[3 * f + k];
        if (mark[v] === e) continue;
        mark[v] = e;
        around.push(v);
      }
    }
    for (const v of around) {
      this.setQuadric(v);
      this.stamp[v]++;
    }
    const seen = this.seen;
    for (const v of around) {
      const turn = ++this.turn;
      for (const f of this.faces[v]) {
        for (let k = 0; k < 3; k++) {
          const q = t[3 * f + k];
          if (q === v || seen[q] === turn) continue;
          seen[q] = turn;
          // An edge between two moved vertices is offered once.
          if (mark[q] === e && q < v) continue;
          this.offer(v, q);
        }
      }
    }
    this.collapses++;
  }

  private current(slot: number): boolean {
    const q = this.queue;
    return this.alive[q.u[slot]] === 1 && this.alive[q.w[slot]] === 1 && this.stamp[q.u[slot]] === q.su[slot] && this.stamp[q.w[slot]] === q.sw[slot];
  }

  /** Up to `steps` queue entries. True once nothing more can collapse. */
  run(steps = Infinity): boolean {
    const q = this.queue;
    const order = [0, 1, 2, 3];
    for (let s = 0; s < steps; s++) {
      if (!q.size) return true;
      // Stale entries pile up behind the live ones, so they are dropped now and then.
      if (q.size > 4096 && q.size > 8 * this.live) q.compact((slot) => this.current(slot));
      const slot = q.pop();
      if (!this.current(slot)) continue;
      const u = q.u[slot];
      const w = q.w[slot];
      const best = this.evaluate(u, w);
      const factor = Math.min(this.detail[u], this.detail[w]);
      const limit = this.limits.threshold * factor * factor;
      if (!(best <= limit)) continue;
      if (!this.linked(u, w, this.f2 >= 0 ? 2 : 1)) continue;
      const costs = this.costs;
      // Cheapest placement first.
      for (let a = 1; a < 4; a++) {
        const k = order[a];
        let b = a - 1;
        while (b >= 0 && costs[order[b]] > costs[k]) {
          order[b + 1] = order[b];
          b--;
        }
        order[b + 1] = k;
      }
      for (const k of order) {
        if (!(costs[k] <= limit)) break;
        const x = this.places[3 * k];
        const y = this.places[3 * k + 1];
        const z = this.places[3 * k + 2];
        if (!this.acceptable(u, w, x, y, z, factor)) continue;
        // The vertex that stays keeps its detail and key: w for AT_W, else u.
        if (k === AT_W) this.apply(w, u, x, y, z);
        else this.apply(u, w, x, y, z);
        break;
      }
    }
    return false;
  }

  /** The surviving vertices and faces, renumbered, with each vertex's key. */
  result(): { positions: Float64Array; triangles: Uint32Array; keys: Int32Array } {
    const n = this.alive.length;
    const index = new Int32Array(n).fill(-1);
    let count = 0;
    for (let v = 0; v < n; v++) if (this.alive[v]) index[v] = count++;
    const positions = new Float64Array(3 * count);
    const keys = new Int32Array(count);
    for (let v = 0; v < n; v++) {
      const i = index[v];
      if (i < 0) continue;
      positions[3 * i] = this.pos[3 * v];
      positions[3 * i + 1] = this.pos[3 * v + 1];
      positions[3 * i + 2] = this.pos[3 * v + 2];
      keys[i] = this.keys[v];
    }
    let faces = 0;
    for (let f = 0; f < this.dead.length; f++) if (!this.dead[f]) faces++;
    const triangles = new Uint32Array(3 * faces);
    let at = 0;
    for (let f = 0; f < this.dead.length; f++) {
      if (this.dead[f]) continue;
      for (let k = 0; k < 3; k++) triangles[at++] = index[this.tri[3 * f + k]];
    }
    return { positions, triangles, keys };
  }
}

// ------------------------------------------------------------------ tiles

/** One tile's heights, self-contained so a worker can simplify it. */
export interface TileJob {
  /** First column and row of the tile in the whole grid. */
  i0: number;
  j0: number;
  /** Points across and up the tile, edges included. */
  pw: number;
  ph: number;
  heights: Float32Array;
  detail: Float32Array;
  /** The whole grid's size and spacing, for rim sides and positions. */
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dx: number;
  dy: number;
  limits: MeshLimits;
}

export interface TileResult {
  positions: Float64Array;
  triangles: Uint32Array;
  /** Grid index of each vertex still on a seam (pinned, so shared with the next tile), else -1. */
  keys: Int32Array;
}

function coordinate(index: number, count: number, start: number, end: number, step: number): number {
  return index === count - 1 ? end : start + index * step;
}

/** RTIN over one tile, then collapses with its seams pinned. */
export function simplifyTile(job: TileJob): TileResult {
  const { i0, j0, pw, ph, nx, ny, limits } = job;
  const tris = rtinBlock(job.heights, job.detail, pw, ph, 0.5 * limits.deviation);
  const index = new Int32Array(pw * ph).fill(-1);
  const points: number[] = [];
  const triangles = new Uint32Array(tris.length / 2);
  for (let k = 0; k < tris.length; k += 2) {
    const local = tris[k + 1] * pw + tris[k];
    if (index[local] < 0) {
      index[local] = points.length;
      points.push(local);
    }
    triangles[k / 2] = index[local];
  }
  const n = points.length;
  const positions = new Float64Array(3 * n);
  const side = new Uint8Array(n);
  const pinned = new Uint8Array(n);
  const detail = new Float32Array(n);
  const keys = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    const local = points[v];
    const li = local % pw;
    const lj = (local - li) / pw;
    const i = i0 + li;
    const j = j0 + lj;
    positions[3 * v] = coordinate(i, nx, job.x0, job.x1, job.dx);
    positions[3 * v + 1] = coordinate(j, ny, job.y0, job.y1, job.dy);
    positions[3 * v + 2] = job.heights[local];
    side[v] = gridSide(i, j, nx, ny);
    detail[v] = job.detail[local];
    const seam = ((li === 0 || li === pw - 1) && i > 0 && i < nx - 1) || ((lj === 0 || lj === ph - 1) && j > 0 && j < ny - 1);
    pinned[v] = seam ? 1 : 0;
    keys[v] = seam ? j * nx + i : -1;
  }
  const tolerance = new Float32Array(job.detail.length);
  for (let k = 0; k < tolerance.length; k++) tolerance[k] = limits.deviation * job.detail[k];
  const bound: GridBound = {
    heights: job.heights,
    tolerance,
    nx: pw,
    ny: ph,
    x0: coordinate(i0, nx, job.x0, job.x1, job.dx),
    y0: coordinate(j0, ny, job.y0, job.y1, job.dy),
    dx: job.dx,
    dy: job.dy,
  };
  const collapser = new Collapser({ positions, triangles, side, pinned, detail, keys }, limits, bound);
  collapser.run();
  return collapser.result();
}

export function tileJobs(grid: HeightGrid, limits: MeshLimits, tile = TILE): TileJob[] {
  const jobs: TileJob[] = [];
  const { nx, ny } = grid;
  for (let j0 = 0; j0 < ny - 1; j0 += tile) {
    for (let i0 = 0; i0 < nx - 1; i0 += tile) {
      const pw = Math.min(nx - i0, tile + 1);
      const ph = Math.min(ny - j0, tile + 1);
      const heights = new Float32Array(pw * ph);
      const detail = new Float32Array(pw * ph);
      for (let lj = 0; lj < ph; lj++) {
        const from = (j0 + lj) * nx + i0;
        heights.set(grid.heights.subarray(from, from + pw), lj * pw);
        detail.set(grid.detail.subarray(from, from + pw), lj * pw);
      }
      jobs.push({ i0, j0, pw, ph, heights, detail, nx, ny, x0: grid.x0, y0: grid.y0, x1: grid.x1, y1: grid.y1, dx: grid.dx, dy: grid.dy, limits });
    }
  }
  return jobs;
}

export interface MeshOptions {
  /** Simplifies tiles, e.g. in workers. By default one at a time here. */
  runTile?: (job: TileJob) => Promise<TileResult>;
  /** Tiles at once. */
  concurrency?: number;
  /** Fraction done, 0 to 1. May throw to cancel. */
  progress?: (fraction: number) => Promise<void> | void;
  tile?: number;
}

/** The surface of a height grid as a TIN covering its rectangle exactly. */
export async function meshSurface(grid: HeightGrid, limits: MeshLimits, options: MeshOptions = {}): Promise<Tin & { rtin?: number }> {
  if (grid.nx < 2 || grid.ny < 2) throw new Error('A height grid needs at least 2 x 2 points');
  const jobs = tileJobs(grid, limits, options.tile ?? TILE);
  const run = options.runTile ?? (async (job: TileJob) => simplifyTile(job));
  const results: TileResult[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const k = next++;
      results[k] = await run(jobs[k]);
      done++;
      await options.progress?.((0.85 * done) / jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, jobs.length)) }, lane));
  if (results.length === 1) {
    const only = results[0];
    return { vertices: only.positions, triangles: only.triangles };
  }

  // Stitch: seam points keep their grid index, so neighbouring tiles share them.
  // Seam points get the first numbers, then each tile's own vertices.
  const shared = new Map<number, number>();
  let owned = 0;
  let faces = 0;
  for (const r of results) {
    for (let v = 0; v < r.keys.length; v++) {
      if (r.keys[v] < 0) owned++;
      else if (!shared.has(r.keys[v])) shared.set(r.keys[v], shared.size);
    }
    faces += r.triangles.length / 3;
  }
  const count = shared.size + owned;
  const positions = new Float64Array(3 * count);
  const triangles = new Uint32Array(3 * faces);
  const side = new Uint8Array(count);
  const detail = new Float32Array(count);
  const keys = new Int32Array(count).fill(-1);
  const live = new Uint8Array(count);
  let own = shared.size;
  let at = 0;
  for (const r of results) {
    const map = new Int32Array(r.keys.length);
    for (let v = 0; v < r.keys.length; v++) {
      const key = r.keys[v];
      const id = key < 0 ? own++ : shared.get(key)!;
      map[v] = id;
      positions[3 * id] = r.positions[3 * v];
      positions[3 * id + 1] = r.positions[3 * v + 1];
      positions[3 * id + 2] = r.positions[3 * v + 2];
      if (key >= 0) {
        const i = key % grid.nx;
        const j = (key - i) / grid.nx;
        side[id] = gridSide(i, j, grid.nx, grid.ny);
        detail[id] = grid.detail[key];
        live[id] = 1;
      }
    }
    for (let k = 0; k < r.triangles.length; k++) triangles[at++] = map[r.triangles[k]];
  }
  // Tile-own vertices: their rim side from where they are, their detail from the nearest point.
  for (let id = shared.size; id < count; id++) {
    const x = positions[3 * id];
    const y = positions[3 * id + 1];
    const i = Math.min(grid.nx - 1, Math.max(0, Math.round((x - grid.x0) / grid.dx)));
    const j = Math.min(grid.ny - 1, Math.max(0, Math.round((y - grid.y0) / grid.dy)));
    side[id] = (x === grid.x0 ? WEST : 0) | (x === grid.x1 ? EAST : 0) | (y === grid.y0 ? SOUTH : 0) | (y === grid.y1 ? NORTH : 0);
    detail[id] = grid.detail[j * grid.nx + i];
  }
  const tolerance = new Float32Array(grid.heights.length);
  for (let k = 0; k < tolerance.length; k++) tolerance[k] = limits.deviation * grid.detail[k];
  const bound: GridBound = { heights: grid.heights, tolerance, nx: grid.nx, ny: grid.ny, x0: grid.x0, y0: grid.y0, dx: grid.dx, dy: grid.dy };
  const collapser = new Collapser({ positions, triangles, side, pinned: new Uint8Array(count), detail, keys }, limits, bound, live);
  while (!collapser.run(20000)) await options.progress?.(0.9);
  await options.progress?.(1);
  const out = collapser.result();
  return { vertices: out.positions, triangles: out.triangles };
}

// ------------------------------------------------------------------ walls

/**
 * Walls straightened after simplifying. A wall is a band of steep triangles
 * between its roof edge and its foot, and a tall one standing on a crooked
 * foot is a fan of long triangles each facing its own way: a row of ribs
 * from roof to street. The foot is crooked because of what stands along it
 * (planters, canopies, a lower wing) and because the grid draws a diagonal
 * in one-cell stairs.
 *
 * So each roof edge (a crease between a flat face and a steep one hanging
 * below it) is simplified to straight lines within `delta`, and the wall's
 * foot below each line is moved onto a line parallel to it, at the wall's
 * median width. Only plan positions move, never a rim vertex or a tree's,
 * and never so a triangle turns over. Then whatever is left in line
 * collapses, within the usual limits.
 */
export function straightenWalls(tin: Tin, grid: HeightGrid, limits: MeshLimits, delta: number): Tin {
  const pos = Float64Array.from(tin.vertices);
  const tri = tin.triangles;
  const nv = pos.length / 3;
  const nt = tri.length / 3;
  const start = new Int32Array(nv + 1);
  for (let k = 0; k < tri.length; k++) start[tri[k] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const faceOf = new Int32Array(tri.length);
  const fill = start.slice(0, nv);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) faceOf[fill[tri[3 * t + k]]++] = t;
  const facesOf = (v: number) => faceOf.subarray(start[v], start[v + 1]);

  const cellOf = (v: number) => {
    const i = Math.min(grid.nx - 1, Math.max(0, Math.round((pos[3 * v] - grid.x0) / grid.dx)));
    const j = Math.min(grid.ny - 1, Math.max(0, Math.round((pos[3 * v + 1] - grid.y0) / grid.dy)));
    return j * grid.nx + i;
  };
  // 1 on the rim, which never moves, 2 on a tree, which may only be a wall's foot.
  const fixed = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = pos[3 * v];
    const y = pos[3 * v + 1];
    if (x <= grid.x0 || x >= grid.x1 || y <= grid.y0 || y >= grid.y1) fixed[v] = 1;
    else if (grid.detail[cellOf(v)] < 1) fixed[v] = 2;
  }
  // Steep: more than 60 degrees.
  const steep = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = 3 * tri[3 * t];
    const b = 3 * tri[3 * t + 1];
    const c = 3 * tri[3 * t + 2];
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    steep[t] = Math.abs(nz) < 0.5 * Math.hypot(nx, ny, nz) ? 1 : 0;
  }
  // Roof edges: an edge between a flat face and a steep one whose third corner is below it.
  const edgeKey = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const top = new Map<number, number[]>();
  const onTop = new Uint8Array(nv);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tri[3 * t + k];
      const b = tri[3 * t + ((k + 1) % 3)];
      // The face across the edge runs it b to a.
      let s = -1;
      for (const u of facesOf(b)) {
        if (tri[3 * u] === a || tri[3 * u + 1] === a || tri[3 * u + 2] === a) {
          if (u !== t) s = u;
        }
      }
      if (s < t || steep[s] === steep[t]) continue;
      const wall = steep[s] ? s : t;
      let third = tri[3 * wall];
      if (third === a || third === b) third = tri[3 * wall + 1];
      if (third === a || third === b) third = tri[3 * wall + 2];
      if (!(pos[3 * third + 2] < Math.min(pos[3 * a + 2], pos[3 * b + 2]))) continue;
      for (const [p, q] of [
        [a, b],
        [b, a],
      ]) {
        const list = top.get(p);
        if (list) list.push(q);
        else top.set(p, [q]);
      }
      onTop[a] = onTop[b] = 1;
    }
  }
  // Chains of roof edge through vertices with two such edges.
  const used = new Set<number>();
  const chains: number[][] = [];
  const walk = (from: number, to: number) => {
    const chain = [from, to];
    let prev = from;
    let cur = to;
    while (cur !== from && top.get(cur)!.length === 2) {
      const [p, q] = top.get(cur)!;
      const next = p === prev ? q : p;
      const key = edgeKey(cur, next);
      if (used.has(key)) break;
      used.add(key);
      chain.push(next);
      prev = cur;
      cur = next;
    }
    return chain;
  };
  // Ends and junctions first, then loops.
  for (const loops of [false, true]) {
    for (const [v, list] of top) {
      if ((list.length === 2) !== loops) continue;
      for (const w of list) {
        const key = edgeKey(v, w);
        if (used.has(key)) continue;
        used.add(key);
        chains.push(walk(v, w));
      }
    }
  }
  // A loop's ends are kept, so it starts at its sharpest corner rather than
  // somewhere along a straight wall.
  for (let c = 0; c < chains.length; c++) {
    const chain = chains[c];
    const n = chain.length - 1;
    if (n < 3 || chain[0] !== chain[n]) continue;
    let sharpest = 0;
    let lowest = Infinity;
    for (let k = 0; k < n; k++) {
      const p = chain[(k + n - 1) % n];
      const q = chain[k];
      const r = chain[k + 1];
      const ux = pos[3 * q] - pos[3 * p];
      const uy = pos[3 * q + 1] - pos[3 * p + 1];
      const vx = pos[3 * r] - pos[3 * q];
      const vy = pos[3 * r + 1] - pos[3 * q + 1];
      const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
      if (cos < lowest) {
        lowest = cos;
        sharpest = k;
      }
    }
    chains[c] = [...chain.slice(sharpest, n), ...chain.slice(0, sharpest + 1)];
  }

  const target = new Map<number, [number, number, number]>();
  const aim = (v: number, x: number, y: number, foot: boolean) => {
    if (fixed[v] === 1 || (fixed[v] === 2 && !foot)) return;
    const d = Math.hypot(x - pos[3 * v], y - pos[3 * v + 1]);
    const prev = target.get(v);
    if (!prev || d < prev[2]) target.set(v, [x, y, d]);
  };
  // A foot further out than this isn't this wall's.
  const reach = 6 * Math.min(grid.dx, grid.dy);
  for (const chain of chains) {
    const n = chain.length;
    if (n < 3) continue;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    for (let k = 0; k < n; k++) if (fixed[chain[k]]) keep[k] = 1;
    const simplify = (i0: number, i1: number) => {
      if (i1 - i0 < 2) return;
      const ax = pos[3 * chain[i0]];
      const ay = pos[3 * chain[i0] + 1];
      const dx = pos[3 * chain[i1]] - ax;
      const dy = pos[3 * chain[i1] + 1] - ay;
      const length = Math.hypot(dx, dy);
      let worst = -1;
      let at = -1;
      for (let k = i0 + 1; k < i1; k++) {
        const px = pos[3 * chain[k]] - ax;
        const py = pos[3 * chain[k] + 1] - ay;
        const d = length > 0 ? Math.abs(px * dy - py * dx) / length : Math.hypot(px, py);
        if (d > worst) {
          worst = d;
          at = k;
        }
      }
      if (worst <= delta) return;
      keep[at] = 1;
      simplify(i0, at);
      simplify(at, i1);
    };
    let last = 0;
    for (let k = 1; k < n; k++) {
      if (!keep[k]) continue;
      simplify(last, k);
      last = k;
    }
    last = 0;
    for (let k = 1; k < n; k++) {
      if (!keep[k]) continue;
      const a = chain[last];
      const b = chain[k];
      const ax = pos[3 * a];
      const ay = pos[3 * a + 1];
      const length = Math.hypot(pos[3 * b] - ax, pos[3 * b + 1] - ay);
      if (length > 0) {
        const ux = (pos[3 * b] - ax) / length;
        const uy = (pos[3 * b + 1] - ay) / length;
        for (let m = last + 1; m < k; m++) {
          const v = chain[m];
          const s = (pos[3 * v] - ax) * ux + (pos[3 * v + 1] - ay) * uy;
          aim(v, ax + s * ux, ay + s * uy, false);
        }
        // The foot: lower corners of the steep faces hanging from this stretch.
        const feet: number[] = [];
        const along: number[] = [];
        const across: number[] = [];
        for (let m = last; m <= k; m++) {
          const v = chain[m];
          for (const t of facesOf(v)) {
            if (!steep[t]) continue;
            for (let q = 0; q < 3; q++) {
              const f = tri[3 * t + q];
              if (onTop[f] || !(pos[3 * f + 2] < pos[3 * v + 2])) continue;
              const px = pos[3 * f] - ax;
              const py = pos[3 * f + 1] - ay;
              const s = px * ux + py * uy;
              if (s < -0.5 * length || s > 1.5 * length) continue;
              feet.push(f);
              along.push(s);
              across.push(py * ux - px * uy);
            }
          }
        }
        const sorted = across.slice().sort((p, q) => p - q);
        const side = Math.sign(sorted[sorted.length >> 1] ?? 0);
        const widths = sorted.map((t) => t * side).filter((t) => t > 0);
        if (side && widths.length) {
          const width = widths[widths.length >> 1];
          for (let m = 0; m < feet.length; m++) {
            if (across[m] * side <= 0 || Math.abs(across[m]) > reach) continue;
            aim(feet[m], ax + along[m] * ux - side * width * uy, ay + along[m] * uy + side * width * ux, true);
          }
        }
      }
      last = k;
    }
  }

  // Move what can move without turning a triangle over or thinner than the mesher allows.
  const moved = new Uint8Array(nv);
  for (const [v, [x, y]] of target) {
    const ox = pos[3 * v];
    const oy = pos[3 * v + 1];
    pos[3 * v] = x;
    pos[3 * v + 1] = y;
    let upright = true;
    for (const t of facesOf(v)) {
      const a = 3 * tri[3 * t];
      const b = 3 * tri[3 * t + 1];
      const c = 3 * tri[3 * t + 2];
      const cross = (pos[b] - pos[a]) * (pos[c + 1] - pos[a + 1]) - (pos[b + 1] - pos[a + 1]) * (pos[c] - pos[a]);
      const longest = Math.max(Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1]), Math.hypot(pos[c] - pos[b], pos[c + 1] - pos[b + 1]), Math.hypot(pos[a] - pos[c], pos[a + 1] - pos[c + 1]));
      if (!(cross > limits.minGap * longest)) {
        upright = false;
        break;
      }
    }
    if (upright) moved[v] = 1;
    else {
      pos[3 * v] = ox;
      pos[3 * v + 1] = oy;
    }
  }

  // Collapse around what moved.
  const side = new Uint8Array(nv);
  const detail = new Float32Array(nv);
  const live = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = pos[3 * v];
    const y = pos[3 * v + 1];
    side[v] = (x === grid.x0 ? WEST : 0) | (x === grid.x1 ? EAST : 0) | (y === grid.y0 ? SOUTH : 0) | (y === grid.y1 ? NORTH : 0);
    detail[v] = grid.detail[cellOf(v)];
    if (!moved[v]) continue;
    for (const t of facesOf(v)) for (let k = 0; k < 3; k++) live[tri[3 * t + k]] = 1;
  }
  const tolerance = new Float32Array(grid.heights.length);
  for (let k = 0; k < tolerance.length; k++) tolerance[k] = limits.deviation * grid.detail[k];
  const bound: GridBound = { heights: grid.heights, tolerance, nx: grid.nx, ny: grid.ny, x0: grid.x0, y0: grid.y0, dx: grid.dx, dy: grid.dy };
  const collapser = new Collapser({ positions: pos, triangles: Uint32Array.from(tri), side, pinned: new Uint8Array(nv), detail, keys: new Int32Array(nv).fill(-1) }, limits, bound, live);
  collapser.run();
  const out = collapser.result();
  return { vertices: out.positions, triangles: out.triangles };
}
