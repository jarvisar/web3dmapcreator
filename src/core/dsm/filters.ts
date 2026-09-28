// Grid operations behind LiDAR Only heights, ported from the add-on's
// geometry/dsm_model.py. Grids are row-major, nx columns by ny rows, and
// masks are 0/1 bytes. Borders and NaNs behave like the add-on's numpy code,
// since its rules were tuned with them.
//
// Most of these take an `out` grid, which may be the input itself to work in
// place. Big grids are float32, sums and means are float64.

/**
 * Window sums over (2r+1)^2 cells, cut off at the grid's edge, one row at a
 * time. Each window is summed in float64 from its own cells rather than from
 * a summed-area table, which loses precision over millions of cells.
 * Rows are handed out in order. A row's input can be overwritten once it has
 * been asked for, so a caller can write means back into `values`.
 */
export class BoxSums {
  /** Columns in the window of each column. */
  readonly width: Float64Array;
  private readonly ring: Float64Array;
  private readonly sums: Float64Array;
  private added = 0;

  constructor(
    private readonly values: ArrayLike<number>,
    private readonly nx: number,
    private readonly ny: number,
    private readonly radius: number,
  ) {
    this.ring = new Float64Array((2 * radius + 1) * nx);
    this.sums = new Float64Array(nx);
    this.width = new Float64Array(nx);
    for (let x = 0; x < nx; x++) this.width[x] = Math.min(nx - 1, x + radius) - Math.max(0, x - radius) + 1;
  }

  /** Rows in the window of row y. */
  height(y: number): number {
    return Math.min(this.ny - 1, y + this.radius) - Math.max(0, y - this.radius) + 1;
  }

  row(y: number): Float64Array {
    const { nx, ny, radius, ring, sums, values } = this;
    const span = 2 * radius + 1;
    const hi = Math.min(ny - 1, y + radius);
    for (; this.added <= hi; this.added++) {
      const start = this.added * nx;
      const slot = (this.added % span) * nx;
      for (let x = 0; x < nx; x++) {
        const a = x > radius ? x - radius : 0;
        const b = x + radius < nx ? x + radius : nx - 1;
        let s = 0;
        for (let k = a; k <= b; k++) s += values[start + k];
        ring[slot + x] = s;
      }
    }
    const lo = y > radius ? y - radius : 0;
    sums.set(ring.subarray((lo % span) * nx, (lo % span) * nx + nx));
    for (let k = lo + 1; k <= hi; k++) {
      const slot = (k % span) * nx;
      for (let x = 0; x < nx; x++) sums[x] += ring[slot + x];
    }
    return sums;
  }
}

/**
 * Mean over a (2r+1)^2 window cut off at the grid's edge. The add-on's
 * box_mean also takes weights, but compose only ever passes ones.
 */
export function boxMean(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  radius: number,
  out: Float32Array = new Float32Array(nx * ny),
): Float32Array {
  const box = new BoxSums(values, nx, ny, radius);
  for (let y = 0; y < ny; y++) {
    const sums = box.row(y);
    const rows = box.height(y);
    const start = y * nx;
    for (let x = 0; x < nx; x++) out[start + x] = sums[x] / (rows * box.width[x]);
  }
  return out;
}

interface Level {
  v: Float64Array;
  w: Uint8Array;
  nx: number;
  ny: number;
}

// Row or column taps of the add-on's bilinear upsampling from f cells to m.
// The first tap is clipped to the grid but its weight is not, so row and
// column 0 take 0.25 of coarse cell 0 and 0.75 of cell 1. That's the add-on's
// behaviour, keep it.
function taps(m: number, f: number): { i0: Int32Array; i1: Int32Array; t: Float64Array } {
  const i0 = new Int32Array(m);
  const i1 = new Int32Array(m);
  const t = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const c = (i + 0.5) / 2 - 0.5;
    const floor = Math.floor(c);
    const a = Math.min(Math.max(floor, 0), f - 1);
    i0[i] = a;
    i1[i] = Math.min(a + 1, f - 1);
    t[i] = Math.min(Math.max(c - floor, 0), 1);
  }
  return { i0, i1, t };
}

/** Fill NaN cells by pull-push: means of what is known, from coarse to fine. */
export function fillSmooth(values: Float32Array, nx: number, ny: number): Float32Array {
  const n = nx * ny;
  let known = 0;
  for (let i = 0; i < n; i++) if (values[i] === values[i]) known++;
  if (known === n) return values.slice();
  if (!known) throw new Error('Nothing to fill from');

  // Level 0 is `values` itself. Weights stay 0 or 1 on every level.
  const levels: Level[] = [];
  let lx = nx;
  let ly = ny;
  while (Math.max(lx, ly) > 1) {
    const cx = (lx + 1) >> 1;
    const cy = (ly + 1) >> 1;
    const v = new Float64Array(cx * cy);
    const w = new Uint8Array(cx * cy);
    const below = levels.length ? levels[levels.length - 1] : null;
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        let vs = 0;
        let ws = 0;
        for (let dy = 0; dy < 2; dy++) {
          const fy = 2 * y + dy;
          if (fy >= ly) continue;
          for (let dx = 0; dx < 2; dx++) {
            const fx = 2 * x + dx;
            if (fx >= lx) continue;
            const i = fy * lx + fx;
            if (below) {
              if (below.w[i]) {
                vs += below.v[i];
                ws++;
              }
            } else if (values[i] === values[i]) {
              vs += values[i];
              ws++;
            }
          }
        }
        if (ws) {
          v[y * cx + x] = vs / ws;
          w[y * cx + x] = 1;
        }
      }
    }
    levels.push({ v, w, nx: cx, ny: cy });
    lx = cx;
    ly = cy;
  }

  // Back down: each level keeps what it knows and takes the rest from the
  // level above, upsampled. Levels are filled in place.
  const out = values.slice();
  for (let k = levels.length - 2; k >= -1; k--) {
    const coarse = levels[k + 1];
    const level = k >= 0 ? levels[k] : null;
    const mx = level ? level.nx : nx;
    const my = level ? level.ny : ny;
    const rows = taps(my, coarse.ny);
    const cols = taps(mx, coarse.nx);
    const f = coarse.v;
    const fx = coarse.nx;
    for (let y = 0; y < my; y++) {
      const r0 = rows.i0[y] * fx;
      const r1 = rows.i1[y] * fx;
      const ty = rows.t[y];
      for (let x = 0; x < mx; x++) {
        const i = y * mx + x;
        if (level ? level.w[i] : values[i] === values[i]) continue;
        const c0 = cols.i0[x];
        const c1 = cols.i1[x];
        const tx = cols.t[x];
        const value = (f[r0 + c0] * (1 - tx) + f[r0 + c1] * tx) * (1 - ty) + (f[r1 + c0] * (1 - tx) + f[r1 + c1] * tx) * ty;
        if (level) level.v[i] = value;
        else out[i] = value;
      }
    }
  }
  return out;
}

/**
 * Fill NaN cells in `mask` ring by ring from their filled neighbours, `reach`
 * rings at most. A hole among neighbours of one surface takes their median,
 * a hole at a step (neighbours more than `step` apart) the lowest one: a cell
 * with no returns beside a wall is usually the street in the wall's scan
 * shadow, and filling it from the roof grows the building into its shadow.
 * Each ring reads the grid as it was before that ring.
 */
export function fillVoids(
  values: Float32Array,
  nx: number,
  ny: number,
  mask: Uint8Array,
  reach: number,
  step: number,
  out: Float32Array = new Float32Array(nx * ny),
): Float32Array {
  if (out !== values) out.set(values);
  const n = nx * ny;
  let left = 0;
  for (let i = 0; i < n; i++) if (mask[i] && out[i] !== out[i]) left++;
  const cells = new Int32Array(left);
  for (let i = 0, k = 0; i < n; i++) if (mask[i] && out[i] !== out[i]) cells[k++] = i;
  const doneCells = new Int32Array(left);
  const doneValues = new Float64Array(left);
  const around = new Float64Array(8);
  for (let ring = 0; ring < reach && left > 0; ring++) {
    let done = 0;
    let still = 0;
    for (let k = 0; k < left; k++) {
      const i = cells[k];
      const y = (i / nx) | 0;
      const x = i - y * nx;
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((dy === 0 && dx === 0) || xx < 0 || xx >= nx) continue;
          const v = out[yy * nx + xx];
          if (v !== v) continue;
          let j = m++;
          while (j > 0 && around[j - 1] > v) {
            around[j] = around[j - 1];
            j--;
          }
          around[j] = v;
        }
      }
      if (!m) {
        cells[still++] = i;
        continue;
      }
      const low = around[0];
      const high = around[m - 1];
      // numpy's median: the mean of the middle two for an even count.
      const median = m & 1 ? around[m >> 1] : (around[(m >> 1) - 1] + around[m >> 1]) / 2;
      doneCells[done] = i;
      doneValues[done++] = high - low > step ? low : median;
    }
    if (!done) break;
    for (let k = 0; k < done; k++) out[doneCells[k]] = doneValues[k];
    left = still;
  }
  return out;
}

/** 4-connected components labelled by their smallest cell index, -1 outside. */
export function label(mask: Uint8Array, nx: number, ny: number): Int32Array {
  const parent = new Int32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (!mask[i]) {
        parent[i] = -1;
        continue;
      }
      parent[i] = i;
      if (x > 0 && mask[i - 1]) union(parent, i, i - 1);
      if (y > 0 && mask[i - nx]) union(parent, i, i - nx);
    }
  }
  // Every parent is a smaller index, so one pass in order resolves them all.
  for (let i = 0; i < parent.length; i++) {
    const p = parent[i];
    if (p >= 0 && p !== i) parent[i] = parent[p];
  }
  return parent;
}

function find(parent: Int32Array, i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

function union(parent: Int32Array, a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra < rb) parent[rb] = ra;
  else if (rb < ra) parent[ra] = rb;
}

/**
 * Turns `label` output into 0, 1, 2... in order of the smallest cell, the
 * order numpy.unique gives the add-on. Returns how many there are.
 */
export function compactLabels(labels: Int32Array): number {
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    const root = labels[i];
    if (root < 0) continue;
    labels[i] = root === i ? count++ : labels[root];
  }
  return count;
}

export function countSet(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return count;
}

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function rowMedians(z: Float32Array, start: number, nx: number, out: Float32Array): void {
  out[0] = z[start];
  out[nx - 1] = z[start + nx - 1];
  for (let x = 1; x < nx - 1; x++) out[x] = median3(z[start + x - 1], z[start + x], z[start + x + 1]);
}

/**
 * A median of three along rows, then along columns. Along a wall it fills a
 * one-cell notch and trims a one-cell bump, and across one it changes
 * nothing. A corner keeps its own cell, which a 3 x 3 median would shave off.
 * Border rows and columns only get the pass along them.
 */
export function straighten(
  z: Float32Array,
  nx: number,
  ny: number,
  keep: Uint8Array,
  out: Float32Array = new Float32Array(nx * ny),
): Float32Array {
  if (out !== z) out.set(z);
  let below = new Float32Array(nx);
  let here = new Float32Array(nx);
  let above = new Float32Array(nx);
  rowMedians(out, 0, nx, here);
  for (let y = 0; y < ny; y++) {
    if (y + 1 < ny) rowMedians(out, (y + 1) * nx, nx, above);
    const start = y * nx;
    const edge = y === 0 || y === ny - 1;
    for (let x = 0; x < nx; x++) {
      if (keep[start + x]) continue;
      out[start + x] = edge ? here[x] : median3(below[x], here[x], above[x]);
    }
    const spare = below;
    below = here;
    here = above;
    above = spare;
  }
  return out;
}

/**
 * Mean of each cell and its eight neighbours within `delta` of it in height:
 * roofs come out flatter and walls untouched. Neighbours are added in the
 * add-on's order so the sums round the same.
 */
export function evenOut(
  z: Float32Array,
  nx: number,
  ny: number,
  keep: Uint8Array,
  delta: number,
  out: Float32Array = new Float32Array(nx * ny),
): Float32Array {
  if (out !== z) out.set(z);
  let below = new Float32Array(nx);
  let here = new Float32Array(nx);
  const around = new Float64Array(8);
  for (let y = 0; y < ny; y++) {
    const start = y * nx;
    here.set(out.subarray(start, start + nx));
    const up = start + nx;
    for (let x = 0; x < nx; x++) {
      if (keep[start + x]) continue;
      const right = x + 1 < nx;
      const left = x > 0;
      let m = 0;
      if (y + 1 < ny) {
        if (right) around[m++] = out[up + x + 1];
        around[m++] = out[up + x];
        if (left) around[m++] = out[up + x - 1];
      }
      if (right) around[m++] = here[x + 1];
      if (left) around[m++] = here[x - 1];
      if (y > 0) {
        if (right) around[m++] = below[x + 1];
        around[m++] = below[x];
        if (left) around[m++] = below[x - 1];
      }
      const c = here[x];
      let total = c;
      let count = 1;
      for (let k = 0; k < m; k++) {
        const v = around[k];
        if (Math.abs(v - c) < delta) {
          total += v;
          count++;
        }
      }
      out[start + x] = total / count;
    }
    const spare = below;
    below = here;
    here = spare;
  }
  return out;
}

// Dilation (any) or erosion (all) over a (2r+1)^2 window cut off at the grid's
// edge, so erosion doesn't eat in from the border, like the add-on's
// ~_dilate(~mask). Separable, with running counts.
function spread(mask: Uint8Array, nx: number, ny: number, r: number, all: boolean, out: Uint8Array): Uint8Array {
  const rows = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const s = y * nx;
    let c = 0;
    for (let k = 0; k <= r && k < nx; k++) c += mask[s + k];
    for (let x = 0; x < nx; x++) {
      if (all) rows[s + x] = c === Math.min(nx - 1, x + r) - Math.max(0, x - r) + 1 ? 1 : 0;
      else rows[s + x] = c > 0 ? 1 : 0;
      if (x + r + 1 < nx) c += mask[s + x + r + 1];
      if (x - r >= 0) c -= mask[s + x - r];
    }
  }
  const counts = new Int32Array(nx);
  for (let k = 0; k <= r && k < ny; k++) for (let x = 0; x < nx; x++) counts[x] += rows[k * nx + x];
  for (let y = 0; y < ny; y++) {
    const s = y * nx;
    const height = Math.min(ny - 1, y + r) - Math.max(0, y - r) + 1;
    for (let x = 0; x < nx; x++) out[s + x] = (all ? counts[x] === height : counts[x] > 0) ? 1 : 0;
    if (y + r + 1 < ny) {
      const t = (y + r + 1) * nx;
      for (let x = 0; x < nx; x++) counts[x] += rows[t + x];
    }
    if (y - r >= 0) {
      const t = (y - r) * nx;
      for (let x = 0; x < nx; x++) counts[x] -= rows[t + x];
    }
  }
  return out;
}

export function dilate(mask: Uint8Array, nx: number, ny: number, radius = 1, out: Uint8Array = new Uint8Array(nx * ny)): Uint8Array {
  return spread(mask, nx, ny, radius, false, out);
}

export function erode(mask: Uint8Array, nx: number, ny: number, radius = 1, out: Uint8Array = new Uint8Array(nx * ny)): Uint8Array {
  return spread(mask, nx, ny, radius, true, out);
}

// Running max along one line, the edge value repeated past both ends (van
// Herk / Gil-Werman). Min is the max of the negated line. No NaN handling:
// compose never has NaN left by the time it takes these.
function slideLine(
  a: Float32Array,
  start: number,
  stride: number,
  n: number,
  r: number,
  sign: number,
  line: Float64Array,
  g: Float64Array,
  h: Float64Array,
): void {
  const w = 2 * r + 1;
  const blocks = Math.ceil((n + 2 * r) / w) * w;
  const first = sign * a[start];
  const last = sign * a[start + (n - 1) * stride];
  for (let k = 0; k < blocks; k++) {
    const i = k - r;
    line[k] = i < 0 ? first : i >= n ? last : sign * a[start + i * stride];
  }
  for (let b = 0; b < blocks; b += w) {
    g[b] = line[b];
    for (let k = b + 1; k < b + w; k++) g[k] = line[k] > g[k - 1] ? line[k] : g[k - 1];
    h[b + w - 1] = line[b + w - 1];
    for (let k = b + w - 2; k >= b; k--) h[k] = line[k] > h[k + 1] ? line[k] : h[k + 1];
  }
  for (let i = 0; i < n; i++) {
    const p = h[i];
    const q = g[i + w - 1];
    a[start + i * stride] = sign * (p > q ? p : q);
  }
}

function slide(z: Float32Array, nx: number, ny: number, r: number, sign: number, out: Float32Array): Float32Array {
  if (out !== z) out.set(z);
  if (r <= 0) return out;
  const w = 2 * r + 1;
  const size = Math.ceil((Math.max(nx, ny) + 2 * r) / w) * w;
  const line = new Float64Array(size);
  const g = new Float64Array(size);
  const h = new Float64Array(size);
  // Columns first, then rows, like the add-on. Min and max come out the same either way.
  for (let x = 0; x < nx; x++) slideLine(out, x, nx, ny, r, sign, line, g, h);
  for (let y = 0; y < ny; y++) slideLine(out, y * nx, 1, nx, r, sign, line, g, h);
  return out;
}

/** Max over a (2r+1)^2 window, the edge repeated past the grid (the add-on's _window). */
export function windowMax(z: Float32Array, nx: number, ny: number, radius: number, out: Float32Array = new Float32Array(nx * ny)): Float32Array {
  return slide(z, nx, ny, radius, 1, out);
}

export function windowMin(z: Float32Array, nx: number, ny: number, radius: number, out: Float32Array = new Float32Array(nx * ny)): Float32Array {
  return slide(z, nx, ny, radius, -1, out);
}

/**
 * Replace a cell standing more than `threshold` above (or sunk below) all
 * eight neighbours by their median. Unlike a median filter this leaves every
 * edge and corner alone: a roof corner has neighbours at its own height, a
 * lamp post or a bird doesn't. Cells on the grid's border are never spikes,
 * since the add-on pads the grid by repeating them.
 */
export function despike(
  z: Float32Array,
  nx: number,
  ny: number,
  threshold: number,
  keep?: Uint8Array,
  out: Float32Array = new Float32Array(nx * ny),
): { z: Float32Array; count: number } {
  if (out !== z) out.set(z);
  let count = 0;
  if (nx < 3 || ny < 3) return { z: out, count };
  let below = out.slice(0, nx);
  let here = new Float32Array(nx);
  const around = new Float64Array(8);
  for (let y = 1; y < ny - 1; y++) {
    const start = y * nx;
    here.set(out.subarray(start, start + nx));
    const up = start + nx;
    for (let x = 1; x < nx - 1; x++) {
      if (keep && keep[start + x]) continue;
      around[0] = below[x - 1];
      around[1] = below[x];
      around[2] = below[x + 1];
      around[3] = here[x - 1];
      around[4] = here[x + 1];
      around[5] = out[up + x - 1];
      around[6] = out[up + x];
      around[7] = out[up + x + 1];
      let high = around[0];
      let low = around[0];
      for (let k = 1; k < 8; k++) {
        high = Math.max(high, around[k]);
        low = Math.min(low, around[k]);
      }
      const c = here[x];
      if (!(c > high + threshold || c < low - threshold)) continue;
      around.sort();
      out[start + x] = (around[3] + around[4]) / 2;
      count++;
    }
    const spare = below;
    below = here;
    here = spare;
  }
  return { z: out, count };
}
