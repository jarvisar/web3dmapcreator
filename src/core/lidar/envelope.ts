// A robust upper-surface raster over LiDAR returns, collapsed and clipped to
// a mapped footprint. Ported from the add-on's lidar_envelope.py; the long
// comments there record why each rule exists, and short versions are kept
// here next to the code they explain.
//
// The upper surface is the second-highest return in each print-scale cell, a
// moving median over a disc of cells, and a light mean over observed cells
// away from walls. Unobserved cells copy their nearest observed neighbour.
// Relief along a steep face narrower than a nozzle is straightened, then an
// error-bounded edge collapse merges flat roofs into a few faces and wall
// staircases into straight facets. Nothing detects tiers or architecture: the
// returns alone say where the walls are. The one thing mapped data decides is
// whose wall stands on a shared outline.
//
// Rasters are Float64Arrays in the numpy (nx, ny) layout, cell (i, j) at
// i * ny + j, x along i. Shifts that numpy's roll wraps around wrap here too.

import { rowCrossings } from '../geometry/scanline';
import { clipTin, type Tin } from '../geometry/tinclip';
import { difference, union } from '../geometry/polygon';
import type { MultiPolygon, Vec2 } from '../types';
import { concatXyz, type Xyz } from './points';
import {
  area,
  bounds,
  buffer,
  centroid,
  Inside,
  intersects,
  longAxis,
  pyMod,
  nearestOnBoundary,
  pieces,
  pyRound,
  rotate,
  type Box,
} from './shapes';
import { thinRim } from './rim';
import { collapse, MIN_GAP } from './simplify';

export class UnsupportedFit extends Error {}

const CROSS: Vec2[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
// Each cell's height before the rank filter: its second-highest return.
const UPPER_RANK = 2;
// The quantile of a scan shadow's cells that its pooled height takes.
const UPPER_QUANTILE = 0.9;
const MIN_VOTES = 4;
// Collapse error, in cells squared, under which an edge is always merged.
// Calibrated on Chicago towers at 0.5 m: 4-5 m facets on a curved face.
export const COLLAPSE_TOLERANCE = 32;
// A collapsed vertex may leave the faces it replaces by this many cells.
const DEVIATION_CELLS = 2;
const SPIRE_SHARE = 0.8;
// Relief along a steep face narrower than half the window (0.3 mm printed)
// is straightened where no height level moves further than the reach.
const FAIR_WINDOW_MM = 0.6;
const FAIR_REACH_MM = 0.14;
// A mapped neighbour's facade stands within the first of its outline, and its
// returns reach the second inside ours.
const NEIGHBOUR_FACADE_M = 4;
const FACADE_BAND_M = 1.5;
// Printed length along the outline under which a dip in that band is a notch.
const NOTCH_MM = 0.4;
/** Printed mm per ground metre, horizontal and vertical, when none is given. */
export const DEFAULT_SURFACE_SCALE: [number, number] = [0.07, 0.077];

export const ENVELOPE_FACETS_AT_1M = 16384;
export const MAX_ENVELOPE_FACETS = 65536;

/**
 * Raster pitch, rank window and secondary admission band, each a printed
 * length converted back to ground metres. The pitch is half a printed layer
 * (0.035 mm) down to 0.8 m, or to 0.5 m while a cell still averages about one
 * return. The band is 0.28 mm printed and never under 3 m.
 */
export function envelopeParameters(scale: [number, number], density?: number | null): [number, number, number] {
  if (scale.length !== 2 || !scale.every((s) => Number.isFinite(s) && s > 0)) throw new Error('Invalid LiDAR reconstruction scale');
  let floor = 0.8;
  if (density != null && Number.isFinite(density) && density > 0) floor = Math.min(floor, Math.max(0.5, 1 / Math.sqrt(density)));
  const pitch = Math.min(3, Math.max(floor, 0.035 / scale[0]));
  return [pitch, pitch * 2, Math.max(3, 0.28 / scale[0])];
}

/** Faces one cap may use: the 1 m budget, grown with a finer grid. */
export function facetBudget(pitch: number): number {
  return Math.min(MAX_ENVELOPE_FACETS, Math.floor(ENVELOPE_FACETS_AT_1M / Math.min(1, pitch) ** 2));
}

function disc(radius: number, pitch: number): Vec2[] {
  const reach = pyRound(radius / pitch);
  const out: Vec2[] = [];
  for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) if (dx * dx + dy * dy <= reach * reach + 1e-9) out.push([dx, dy]);
  return out;
}

type Grid = Float64Array;
type Mask = Uint8Array;

/** A padded cell grid covering one footprint component. */
export class Raster {
  readonly pitch: number;
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;

  constructor(box: Box, pitch: number, reach: number) {
    const margin = Math.ceil(reach / pitch) + 2;
    this.pitch = pitch;
    this.x0 = box[0] - margin * pitch;
    this.y0 = box[1] - margin * pitch;
    this.nx = Math.ceil((box[2] - this.x0) / pitch) + margin + 1;
    this.ny = Math.ceil((box[3] - this.y0) / pitch) + margin + 1;
  }

  get size(): number {
    return this.nx * this.ny;
  }

  ci(x: number): number {
    const i = pyRound((x - this.x0) / this.pitch);
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
  }

  cj(y: number): number {
    const j = pyRound((y - this.y0) / this.pitch);
    return j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
  }

  cellOf(x: number, y: number): number {
    return this.ci(x) * this.ny + this.cj(y);
  }

  /**
   * The rank-th highest return in each cell, or its lowest if it holds
   * fewer. The second highest ignores one stray return and, unlike a
   * quantile, how many returns lie below it: a facade cell holds hundreds.
   */
  upper(samples: Xyz, rank = 1): Grid {
    const grid = new Float64Array(this.size).fill(-Infinity);
    if (rank <= 1) {
      for (let k = 0; k < samples.count; k++) {
        const c = this.cellOf(samples.x[k], samples.y[k]);
        if (samples.z[k] > grid[c]) grid[c] = samples.z[k];
      }
      return grid;
    }
    // Only rank 2 is used: track the two highest (duplicates count twice).
    const second = new Float64Array(this.size).fill(-Infinity);
    const counts = new Uint32Array(this.size);
    for (let k = 0; k < samples.count; k++) {
      const c = this.cellOf(samples.x[k], samples.y[k]);
      const z = samples.z[k];
      counts[c]++;
      if (z >= grid[c]) {
        second[c] = grid[c];
        grid[c] = z;
      } else if (z > second[c]) second[c] = z;
    }
    for (let c = 0; c < this.size; c++) if (counts[c] >= rank) grid[c] = second[c];
    return grid;
  }

  cornerX(i: number): number {
    return i * this.pitch + this.x0;
  }

  cornerY(j: number): number {
    return j * this.pitch + this.y0;
  }

  /** Grid corners strictly inside the shape, as Shapely's contains_xy: a corner on the outline is outside. */
  mask(shape: MultiPolygon): Mask {
    const out = new Uint8Array(this.size);
    const rings = shape.flat();
    if (!rings.length) return out;
    const rows = rowCrossings(rings, this.y0, this.pitch, 0, this.ny);
    // The scanline counts a corner on a horizontal edge as inside or outside
    // depending on which side the polygon lies; those corners are on the outline.
    const flats = new Map<number, [number, number][]>();
    for (const ring of rings) {
      for (let a = 0, n = ring.length, b = n - 1; a < n; b = a++) {
        if (ring[a][1] !== ring[b][1]) continue;
        const list = flats.get(ring[a][1]) ?? [];
        list.push([Math.min(ring[a][0], ring[b][0]), Math.max(ring[a][0], ring[b][0])]);
        flats.set(ring[a][1], list);
      }
    }
    for (let j = 0; j < this.ny; j++) {
      const xs = rows[j];
      const flat = flats.get(this.cornerY(j));
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.floor((xs[k] - this.x0) / this.pitch) + 1);
        const i1 = Math.min(this.nx - 1, Math.ceil((xs[k + 1] - this.x0) / this.pitch) - 1);
        for (let i = i0; i <= i1; i++) {
          const x = this.cornerX(i);
          if (!(x > xs[k] && x < xs[k + 1])) continue;
          if (flat && flat.some(([lo, hi]) => x >= lo && x <= hi)) continue;
          out[i * this.ny + j] = 1;
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- shifts

/** Index of data[i - dx, j - dy] with wrap-around, as numpy.roll(data, (dx, dy)) reads at (i, j). */
function rolled(nx: number, ny: number, i: number, j: number, dx: number, dy: number): number {
  let a = (i - dx) % nx;
  if (a < 0) a += nx;
  let b = (j - dy) % ny;
  if (b < 0) b += ny;
  return a * ny + b;
}

/** Index of the edge-padded value at (i + dx, j + dy): clamped to the grid. */
function clamped(nx: number, ny: number, i: number, j: number, dx: number, dy: number): number {
  let a = i + dx;
  let b = j + dy;
  a = a < 0 ? 0 : a >= nx ? nx - 1 : a;
  b = b < 0 ? 0 : b >= ny ? ny - 1 : b;
  return a * ny + b;
}

function inGrid(nx: number, ny: number, i: number, j: number): boolean {
  return i >= 0 && j >= 0 && i < nx && j < ny;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}

/** numpy's default (linear) quantile of sorted-or-not values. */
export function quantile(values: ArrayLike<number>, q: number): number {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  if (!n) return NaN;
  const position = q * (n - 1);
  const lo = Math.floor(position);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

// ---------------------------------------------------------------- filters

/**
 * Cells of slender masses standing free: `rise` above most of a ring six
 * cells out. A tower, steeple or chimney clears nearly the whole ring; a bay
 * or fin on a larger mass half, a square corner three quarters.
 */
function spires(heights: Grid, nx: number, ny: number, rise: number): Mask {
  const reach = 3 * DEVIATION_CELLS;
  const ring: Vec2[] = [];
  for (let dx = -reach - 1; dx <= reach + 1; dx++) {
    for (let dy = -reach - 1; dy <= reach + 1; dy++) {
      const d2 = dx * dx + dy * dy;
      if ((reach - 0.5) ** 2 <= d2 && d2 < (reach + 0.5) ** 2) ring.push([dx, dy]);
    }
  }
  const out = new Uint8Array(nx * ny);
  const need = SPIRE_SHARE * ring.length;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const h = heights[i * ny + j] - rise;
      let below = 0;
      for (const [dx, dy] of ring) if (heights[clamped(nx, ny, i, j, dx, dy)] < h) below++;
      if (below >= need) out[i * ny + j] = 1;
    }
  }
  return out;
}

/**
 * Straighten relief along steep faces narrower than half `window`, within
 * `reach`. Along a face the heights rise monotonically across it, so the
 * median of the heights on a line along the face is the median of the face's
 * position at every height: it straightens the face without mixing heights
 * across it. Each steep cell takes the line of four directions whose heights
 * vary least, only where the face is straight along it and goes on past both
 * ends, only where every height level moves at most `reach` in plan, and never
 * within half a window of a spire.
 */
function fair(heights: Grid, nx: number, ny: number, pitch: number, window: number, reach: number, spire: Mask): Grid {
  const half = Math.max(1, pyRound(window / pitch / 2));
  const offsets = disc(reach, pitch);
  const size = nx * ny;
  const at = (data: Grid, i: number, j: number, dx: number, dy: number) => data[clamped(nx, ny, i, j, dx, dy)];

  // Over four cells, so noise on a gentle roof never reads as a face.
  const slope = new Float64Array(size);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      slope[i * ny + j] = Math.hypot(at(heights, i, j, 2, 0) - at(heights, i, j, -2, 0), at(heights, i, j, 0, 2) - at(heights, i, j, 0, -2)) / (4 * pitch);
    }
  }
  // Steep within half the reach: at a pier's toe the face has not started to rise yet.
  const steepNear = new Uint8Array(size);
  const halfReach = disc(reach / 2, pitch);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (const [dx, dy] of halfReach) {
        const a = i + dx;
        const b = j + dy;
        if (inGrid(nx, ny, a, b) && slope[a * ny + b] >= 1) {
          steepNear[i * ny + j] = 1;
          break;
        }
      }
    }
  }
  const steepAt = (i: number, j: number) => inGrid(nx, ny, i, j) && steepNear[i * ny + j] === 1;

  const least = new Float64Array(size).fill(Infinity);
  const straight = Float64Array.from(heights);
  const level = new Uint8Array(size);
  const directions: Vec2[] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  const line: number[] = [];
  for (const [dx, dy] of directions) {
    const steps = !(dx && dy) ? half : Math.max(1, pyRound(half / Math.SQRT2));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c = i * ny + j;
        line.length = 0;
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = -steps; k <= steps; k++) {
          const v = at(heights, i, j, k * dx, k * dy);
          line.push(v);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const spread = hi - lo;
        if (!(spread < least[c])) continue;
        least[c] = spread;
        const middle = median(line.slice());
        straight[c] = middle;
        const tolerance = (slope[c] * pitch) / 2;
        let near = 0;
        for (const v of line) if (Math.abs(v - middle) <= tolerance) near++;
        level[c] = 2 * near > line.length && steepAt(i + steps * dx, j + steps * dy) && steepAt(i - steps * dx, j - steps * dy) ? 1 : 0;
      }
    }
  }

  // Dilate the spires by `half` along both axes.
  let wide: Mask | null = null;
  if (spire.some((v) => v)) {
    const rows = new Uint8Array(size);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        for (let d = -half; d <= half; d++) {
          const a = i + d;
          if (a >= 0 && a < nx && spire[a * ny + j]) {
            rows[i * ny + j] = 1;
            break;
          }
        }
      }
    }
    wide = new Uint8Array(size);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        for (let d = -half; d <= half; d++) {
          const b = j + d;
          if (b >= 0 && b < ny && rows[i * ny + b]) {
            wide[i * ny + j] = 1;
            break;
          }
        }
      }
    }
  }

  const out = Float64Array.from(heights);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = i * ny + j;
      const h = heights[c];
      const s = straight[c];
      if (!(slope[c] >= 1) || !level[c] || s === h) continue;
      if (wide && wide[c]) continue;
      let movedMin = Infinity;
      let movedMax = -Infinity;
      let heightMin = Infinity;
      let heightMax = -Infinity;
      for (const [dx, dy] of offsets) {
        const k = clamped(nx, ny, i, j, dx, dy);
        movedMin = Math.min(movedMin, straight[k]);
        movedMax = Math.max(movedMax, straight[k]);
        heightMin = Math.min(heightMin, heights[k]);
        heightMax = Math.max(heightMax, heights[k]);
      }
      if (movedMin <= h && movedMax >= h && heightMin <= s && heightMax >= s) out[c] = s;
    }
  }
  return out;
}

/**
 * Copy the nearest observed height into each unobserved cell, unchanged.
 * Copying keeps a roof edge a step; relaxing across the band beside a facade
 * made a ramp of uneven heights, which the cap showed as ribs.
 */
function fill(heights: Grid, observed: Mask, nx: number, ny: number): Grid {
  const size = nx * ny;
  let seen = 0;
  for (let c = 0; c < size; c++) seen += observed[c];
  if (seen === size) return heights;
  if (!seen) throw new UnsupportedFit('no observed upper surface cells');
  const filled = new Float64Array(size);
  const known = new Uint8Array(size);
  for (let c = 0; c < size; c++) {
    if (observed[c]) {
      filled[c] = heights[c];
      known[c] = 1;
    }
  }
  const take = new Int32Array(size);
  while (seen < size) {
    for (const [dx, dy] of CROSS) {
      // One step per offset, as numpy does it: a cell filled in this step
      // does not pass its value on until the next.
      let n = 0;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          const c = i * ny + j;
          if (known[c]) continue;
          const from = rolled(nx, ny, i, j, dx, dy);
          if (known[from]) {
            take[n++] = c;
            take[n++] = from;
          }
        }
      }
      for (let k = 0; k < n; k += 2) {
        filled[take[k]] = filled[take[k + 1]];
        known[take[k]] = 1;
      }
      seen += n / 2;
    }
  }
  return filled;
}

/**
 * Average each observed cell with its observed edge neighbours, except
 * beside a wall, where they differ by more than `steep`: averaging there
 * smears a roof edge into a ramp.
 */
function soften(heights: Grid, observed: Mask, steep: number, nx: number, ny: number): Grid {
  const out = Float64Array.from(heights);
  const offsets: Vec2[] = [[0, 0], ...CROSS];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = i * ny + j;
      if (!observed[c]) continue;
      let total = 0;
      let count = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (const [dx, dy] of offsets) {
        const k = rolled(nx, ny, i, j, dx, dy);
        if (!observed[k]) continue;
        const v = heights[k];
        total += v;
        count++;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > steep) continue;
      out[c] = total / Math.max(count, 1);
    }
  }
  return out;
}

/**
 * Moving median of the cell values; unobserved cells never vote, or a roof
 * edge would be dragged across a courtyard. Where fewer than MIN_VOTES cells
 * of the disc are observed the cell is in a scan shadow and takes the upper
 * quantile of the shadow's cells over twice the reach.
 */
function rank(grid: Grid, nx: number, ny: number, pitch: number, window: number): { heights: Grid; observed: Mask } {
  const size = nx * ny;
  const near = disc(window, pitch);
  const heights = new Float64Array(size).fill(NaN);
  const sparse = new Uint8Array(size);
  let anySparse = false;
  const values: number[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      values.length = 0;
      for (const [dx, dy] of near) {
        const v = grid[rolled(nx, ny, i, j, dx, dy)];
        if (Number.isFinite(v)) values.push(v);
      }
      const c = i * ny + j;
      if (values.length) heights[c] = median(values);
      if (values.length < MIN_VOTES) {
        sparse[c] = 1;
        anySparse = true;
      }
    }
  }
  if (anySparse) {
    const wide = disc(window * 2, pitch);
    const pooled: number[] = [];
    const out = Float64Array.from(heights);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c = i * ny + j;
        if (!sparse[c]) continue;
        pooled.length = 0;
        for (const [dx, dy] of wide) {
          const k = rolled(nx, ny, i, j, dx, dy);
          if (sparse[k] && Number.isFinite(grid[k])) pooled.push(grid[k]);
        }
        if (pooled.length) out[c] = quantile(pooled, UPPER_QUANTILE);
      }
    }
    heights.set(out);
  }
  const observed = new Uint8Array(size);
  for (let c = 0; c < size; c++) {
    if (Number.isFinite(heights[c])) observed[c] = 1;
    else heights[c] = 0;
  }
  const softened = soften(heights, observed, pitch * 2, nx, ny);
  return { heights: fill(softened, observed, nx, ny), observed };
}

/** The highest value within `reach` cells either way along both axes. */
function reachMax(data: Grid, nx: number, ny: number, reach: number): Grid {
  const along = new Float64Array(nx * ny).fill(-Infinity);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      let best = -Infinity;
      for (let k = -reach; k <= reach; k++) {
        const a = i + k;
        if (a >= 0 && a < nx && data[a * ny + j] > best) best = data[a * ny + j];
      }
      along[i * ny + j] = best;
    }
  }
  const out = new Float64Array(nx * ny).fill(-Infinity);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      let best = -Infinity;
      for (let k = -reach; k <= reach; k++) {
        const b = j + k;
        if (b >= 0 && b < ny && along[i * ny + b] > best) best = along[i * ny + b];
      }
      out[i * ny + j] = best;
    }
  }
  return out;
}

/**
 * Seeds whose raised mass reaches the core: the cells inside the outline
 * 8-connected to a seed and standing above that seed's `level`.
 */
function reachesCore(seeds: Mask, heights: Grid, level: Grid, within: Mask, core: Mask, nx: number, ny: number): Mask {
  const reached = new Uint8Array(nx * ny);
  const done = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const seed = i * ny + j;
      if (!seeds[seed] || done[seed]) continue;
      const floor = level[seed];
      const mass = new Set<number>([seed]);
      const stack = [seed];
      let real = false;
      while (stack.length && !real) {
        const c = stack.pop()!;
        const a = Math.floor(c / ny);
        const b = c - a * ny;
        for (let p = Math.max(a - 1, 0); p < Math.min(a + 2, nx); p++) {
          for (let q = Math.max(b - 1, 0); q < Math.min(b + 2, ny); q++) {
            const k = p * ny + q;
            if (!mass.has(k) && within[k] && heights[k] > floor) {
              if (core[k]) real = true;
              mass.add(k);
              stack.push(k);
            }
          }
        }
      }
      for (const k of mass) {
        if (seeds[k]) {
          done[k] = 1;
          reached[k] = real ? 1 : 0;
        }
      }
    }
  }
  return reached;
}

/** The band's depth in cells and the core of the outline behind it. */
function facadeBand(within: Mask, nx: number, ny: number, pitch: number): { band: number; core: Mask } {
  const band = Math.max(1, pyRound(FACADE_BAND_M / pitch));
  let core = Uint8Array.from(within);
  for (let step = 0; step < band; step++) {
    const shrunk = Uint8Array.from(core);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c = i * ny + j;
        if (!shrunk[c]) continue;
        for (const [dx, dy] of CROSS) {
          if (!core[rolled(nx, ny, i, j, dx, dy)]) {
            shrunk[c] = 0;
            break;
          }
        }
      }
    }
    core = shrunk;
  }
  return { band, core };
}

/**
 * Bring a mapped neighbour's facade standing inside our outline down to our
 * roof. A cell in the band along the outline, within reach of a mapped
 * neighbour's outline, that stands `rise` above every cell behind the band
 * takes that roof's height, unless its raised mass reaches behind the band
 * (a parapet or front wall is ours).
 */
function neighbourFacades(heights: Grid, within: Mask, zone: Mask, nx: number, ny: number, pitch: number, rise: number): Grid {
  const size = nx * ny;
  const { band, core } = facadeBand(within, nx, ny, pitch);
  let anyEdge = false;
  let anyCore = false;
  const edge = new Uint8Array(size);
  for (let c = 0; c < size; c++) {
    if (within[c] && !core[c] && zone[c]) {
      edge[c] = 1;
      anyEdge = true;
    }
    if (core[c]) anyCore = true;
  }
  if (!anyEdge || !anyCore) return heights;
  const coreHeights = new Float64Array(size);
  for (let c = 0; c < size; c++) coreHeights[c] = core[c] ? heights[c] : -Infinity;
  const roof = reachMax(coreHeights, nx, ny, 2 * band);
  const facade = new Uint8Array(size);
  const level = new Float64Array(size);
  let anyFacade = false;
  for (let c = 0; c < size; c++) {
    level[c] = roof[c] + rise;
    if (edge[c] && Number.isFinite(roof[c]) && heights[c] > roof[c] + rise) {
      facade[c] = 1;
      anyFacade = true;
    }
  }
  if (!anyFacade) return heights;
  const reached = reachesCore(facade, heights, level, within, core, nx, ny);
  const out = Float64Array.from(heights);
  for (let c = 0; c < size; c++) if (facade[c] && !reached[c]) out[c] = roof[c];
  return out;
}

/**
 * Fill the notches of the band along the outline, patches shorter than
 * `width`. A sparse survey scans a facade with a few returns a cell from
 * anywhere down the wall, and where the outline runs a little outside the
 * wall they are all the last cells hold. A dip that goes on behind the band,
 * one longer than `width` or a gently sloping roof stays.
 */
function rimNotches(heights: Grid, within: Mask, nx: number, ny: number, pitch: number, width: number): Grid {
  const size = nx * ny;
  const { band, core } = facadeBand(within, nx, ny, pitch);
  let anyEdge = false;
  let anyCore = false;
  for (let c = 0; c < size; c++) {
    if (within[c] && !core[c]) anyEdge = true;
    if (core[c]) anyCore = true;
  }
  if (!anyEdge || !anyCore) return heights;
  const negated = new Float64Array(size);
  for (let c = 0; c < size; c++) negated[c] = core[c] ? -heights[c] : -Infinity;
  const lowest = reachMax(negated, nx, ny, 2 * band);
  const roof = new Float64Array(size);
  const low = new Uint8Array(size);
  for (let c = 0; c < size; c++) {
    roof[c] = -lowest[c];
    if (within[c] && !core[c] && Number.isFinite(roof[c]) && heights[c] < roof[c] - 2 * pitch) low[c] = 1;
  }
  const longest = Math.max(1, pyRound(width / pitch));
  const filled = Float64Array.from(heights);
  const seen = new Uint8Array(size);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const start = i * ny + j;
      if (!low[start] || seen[start]) continue;
      seen[start] = 1;
      const stack = [start];
      const cells: number[] = [];
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        const a = Math.floor(c / ny);
        const b = c - a * ny;
        for (let p = Math.max(a - 1, 0); p < Math.min(a + 2, nx); p++) {
          for (let q = Math.max(b - 1, 0); q < Math.min(b + 2, ny); q++) {
            const k = p * ny + q;
            if (low[k] && !seen[k]) {
              seen[k] = 1;
              stack.push(k);
            }
          }
        }
      }
      let r0 = Infinity;
      let r1 = -Infinity;
      let c0 = Infinity;
      let c1 = -Infinity;
      let deepest = -Infinity;
      for (const c of cells) {
        const a = Math.floor(c / ny);
        const b = c - a * ny;
        r0 = Math.min(r0, a);
        r1 = Math.max(r1, a);
        c0 = Math.min(c0, b);
        c1 = Math.max(c1, b);
        deepest = Math.max(deepest, roof[c] - heights[c]);
      }
      // A notch is short along the outline, whichever way that runs.
      if (Math.max(r1 - r0, c1 - c0) < longest && deepest > 2 * band * pitch) for (const c of cells) filled[c] = roof[c];
    }
  }
  return filled;
}

// ---------------------------------------------------------------- surface

function insideOf(samples: Xyz, shape: MultiPolygon): Xyz {
  const test = new Inside(shape);
  const keep: number[] = [];
  for (let k = 0; k < samples.count; k++) if (test.has(samples.x[k], samples.y[k])) keep.push(k);
  return pick(samples, keep);
}

function pick(samples: Xyz, keep: number[]): Xyz {
  const out: Xyz = { count: keep.length, x: new Float64Array(keep.length), y: new Float64Array(keep.length), z: new Float64Array(keep.length) };
  keep.forEach((k, n) => {
    out.x[n] = samples.x[k];
    out.y[n] = samples.y[k];
    out.z[n] = samples.z[k];
  });
  return out;
}

interface Surface {
  heights: Grid;
  raster: Raster;
  observed: Mask;
  within: Mask;
}

/**
 * Upper returns, rank filtered, over one connected footprint component.
 * `secondary` returns (a vegetation class) join each cell's upper return but
 * never lower one the building classes observed.
 */
function componentSurface(
  polygon: MultiPolygon,
  samples: Xyz,
  pitch: number,
  window: number,
  secondary: Xyz | null,
  zone: MultiPolygon | null,
  rise: number,
  notch: number | null,
): Surface {
  const raster = new Raster(bounds(polygon), pitch, window);
  const { nx, ny } = raster;
  const size = nx * ny;
  const reach = buffer(polygon, pitch);
  const inside = insideOf(samples, reach);
  if (inside.count < 4) throw new UnsupportedFit('insufficient upper surface support');
  let grid = raster.upper(inside, UPPER_RANK);
  if (secondary && secondary.count) {
    const extra = insideOf(secondary, reach);
    if (extra.count) {
      const both = raster.upper(concatXyz([inside, extra]), UPPER_RANK);
      for (let c = 0; c < size; c++) grid[c] = Number.isFinite(grid[c]) ? Math.max(grid[c], both[c]) : both[c];
    }
  }
  const within = raster.mask(polygon);
  // Returns outside the outline never vote: the roof reaches the outline at
  // the height of its last cell inside.
  grid = Float64Array.from(grid);
  for (let c = 0; c < size; c++) if (!within[c]) grid[c] = -Infinity;
  const ranked = rank(grid, nx, ny, pitch, window);
  let heights = ranked.heights;
  // A rim cell more than two cells below a neighbour is a facade's dip, not roof.
  const interior = Uint8Array.from(within);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = i * ny + j;
      if (!interior[c]) continue;
      for (const [dx, dy] of CROSS) {
        if (!within[rolled(nx, ny, i, j, dx, dy)]) {
          interior[c] = 0;
          break;
        }
      }
    }
  }
  const one = disc(pitch, pitch);
  const lifted = Float64Array.from(heights);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = i * ny + j;
      if (!within[c] || interior[c]) continue;
      let highest = -Infinity;
      for (const [dx, dy] of one) highest = Math.max(highest, heights[rolled(nx, ny, i, j, dx, dy)]);
      if (highest - heights[c] > 2 * pitch) lifted[c] = highest;
    }
  }
  heights = lifted;
  if (zone) heights = neighbourFacades(heights, within, raster.mask(zone), nx, ny, pitch, rise);
  if (notch) heights = rimNotches(heights, within, nx, ny, pitch, notch);
  return { heights: fill(heights, within, nx, ny), raster, observed: ranked.observed, within };
}

function hasSpires(polygon: MultiPolygon, samples: Xyz, pitch: number, window: number, rise: number, zone: MultiPolygon | null): boolean {
  const { heights, raster, within } = componentSurface(polygon, samples, pitch, window, null, zone, rise, null);
  const marked = spires(heights, raster.nx, raster.ny, rise);
  for (let c = 0; c < marked.length; c++) if (marked[c] && within[c]) return true;
  return false;
}

/**
 * Move vertices within `gap` of the component boundary onto it, in plan. An
 * outline running a hair inside a grid line otherwise clips a row of faces
 * into slivers thinner than float32 holds at print scale.
 */
function snapToBoundary(vertices: Float64Array, polygon: MultiPolygon, gap: number): void {
  for (let k = 0; k < vertices.length; k += 3) {
    const { distance, point } = nearestOnBoundary(polygon, vertices[k], vertices[k + 1]);
    if (distance <= gap) {
      vertices[k] = point[0];
      vertices[k + 1] = point[1];
    }
  }
}

interface Faces {
  tin: Tin;
  area: number;
  faces: number;
}

/** Straighten the raster's faces, triangulate it over the component, collapse it and clip it. */
function surfaces(polygon: MultiPolygon, heights: Grid, raster: Raster, threshold: number, budget: number, rise: number, fairing: [number, number]): Faces {
  const { pitch, nx, ny } = raster;
  const spire = spires(heights, nx, ny, rise);
  const faired = fair(heights, nx, ny, pitch, fairing[0], fairing[1], spire);
  const mask = raster.mask(buffer(polygon, pitch * 1.5));
  const index = new Int32Array(nx * ny).fill(-1);
  let count = 0;
  for (let c = 0; c < nx * ny; c++) if (mask[c]) index[c] = count++;
  const vertices = new Float64Array(count * 3);
  const fine: number[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = i * ny + j;
      const k = index[c];
      if (k < 0) continue;
      vertices[3 * k] = raster.cornerX(i);
      vertices[3 * k + 1] = raster.cornerY(j);
      vertices[3 * k + 2] = faired[c];
      if (spire[c]) fine.push(k);
    }
  }
  // Split each cell along the diagonal whose corners are closest in height.
  // A fixed diagonal folds every cell a diagonal wall cuts into a notch.
  const first: number[] = [];
  const second: number[] = [];
  for (let i = 0; i + 1 < nx; i++) {
    for (let j = 0; j + 1 < ny; j++) {
      const a = index[i * ny + j];
      const b = index[(i + 1) * ny + j];
      const c = index[(i + 1) * ny + j + 1];
      const d = index[i * ny + j + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      const ha = faired[i * ny + j];
      const hb = faired[(i + 1) * ny + j];
      const hc = faired[(i + 1) * ny + j + 1];
      const hd = faired[i * ny + j + 1];
      if (Math.abs(hb - hd) < Math.abs(ha - hc)) {
        first.push(a, b, d);
        second.push(b, c, d);
      } else {
        first.push(a, b, c);
        second.push(a, c, d);
      }
    }
  }
  if (!first.length) throw new UnsupportedFit('incomplete clipped upper surface');
  const collapsed = collapse(vertices, Uint32Array.from([...first, ...second]), threshold, budget, {
    deviation: DEVIATION_CELLS * pitch,
    fine,
  });
  snapToBoundary(collapsed.vertices, polygon, MIN_GAP / 4);
  const clipped = clipTin({ vertices: collapsed.vertices, triangles: collapsed.faces }, polygon);
  if (!clipped) throw new UnsupportedFit('incomplete clipped upper surface');
  // Not in the add-on: the clip leaves a rim vertex every cell along straight
  // walls, which only cost triangles.
  const tin = thinRim(clipped, pitch / 2);
  let clippedArea = 0;
  const v = tin.vertices;
  for (let t = 0; t < tin.triangles.length; t += 3) {
    const a = 3 * tin.triangles[t];
    const b = 3 * tin.triangles[t + 1];
    const c = 3 * tin.triangles[t + 2];
    clippedArea += ((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1])) / 2;
  }
  return { tin, area: clippedArea, faces: collapsed.faces.length / 3 };
}

interface EnvelopeParts {
  tins: Tin[];
  faces: number;
  cells: number;
  admitted: number;
  residuals: number[];
}

function envelope(
  components: MultiPolygon[],
  observed: Xyz,
  secondary: Xyz,
  pitch: number,
  window: number,
  tolerance: number,
  budget: number,
  threshold: number,
  fairing: [number, number],
  zone: MultiPolygon | null,
  notch: number,
): EnvelopeParts {
  const tins: Tin[] = [];
  const residuals: number[] = [];
  let faces = 0;
  let cells = 0;
  let admitted = 0;
  const total = components.reduce((sum, polygon) => sum + area(polygon), 0);
  for (const polygon of components) {
    let usable = observed;
    let extra: Xyz | null = null;
    if (secondary.count) {
      const established = componentSurface(polygon, observed, pitch, window, null, zone, tolerance, null);
      const keep: number[] = [];
      for (let k = 0; k < secondary.count; k++) {
        if (secondary.z[k] <= established.heights[established.raster.cellOf(secondary.x[k], secondary.y[k])] + tolerance) keep.push(k);
      }
      admitted += keep.length;
      extra = pick(secondary, keep);
      usable = concatXyz([observed, extra]);
    }
    const surface = componentSurface(polygon, observed, pitch, window, extra, zone, tolerance, notch);
    for (let c = 0; c < surface.observed.length; c++) cells += surface.observed[c];
    // Report how far the rank filter moved the surface off the raw upper
    // envelope; comparing to individual returns would measure the facade.
    const raw = surface.raster.upper(insideOf(usable, buffer(polygon, pitch)));
    for (let c = 0; c < raw.length; c++) if (Number.isFinite(raw[c])) residuals.push(Math.abs(surface.heights[c] - raw[c]));
    const share = Math.max(1, Math.floor((budget * area(polygon)) / total));
    const part = surfaces(polygon, surface.heights, surface.raster, threshold, share, tolerance, fairing);
    const expected = area(polygon);
    if (!part.tin.triangles.length || Math.abs(part.area - expected) > Math.max(0.00001, expected * 1e-5)) {
      throw new UnsupportedFit('incomplete clipped upper surface');
    }
    if (part.faces > share) throw new UnsupportedFit('upper surface facet budget');
    tins.push(part.tin);
    faces += part.faces;
  }
  return { tins, faces, cells, admitted, residuals };
}

/**
 * Upper-surface returns per m²: the median 1 m cell, counting its top 0.5 m.
 * A facade stacks many returns over a small plan area, so a plain count says
 * how much wall was scanned, not how densely the roof was sampled.
 */
function surfaceDensity(footprint: MultiPolygon, returns: Xyz): number | null {
  const inside = insideOf(returns, footprint);
  if (inside.count < 4) return null;
  const raster = new Raster(bounds(footprint), 1, 0);
  const top = raster.upper(inside);
  const counts = new Uint32Array(raster.size);
  for (let k = 0; k < inside.count; k++) {
    const c = raster.cellOf(inside.x[k], inside.y[k]);
    if (inside.z[k] >= top[c] - 0.5) counts[c]++;
  }
  const values: number[] = [];
  for (const n of counts) if (n > 0) values.push(n);
  return median(values);
}

/**
 * Returns per m² from how many half-metre cells hold any: d returns per m²
 * leave exp(-d/4) of them empty. Blind to height, so a castle's cones read as
 * dense as the flat roofs beside them.
 */
function scatterDensity(footprint: MultiPolygon, returns: Xyz): number | null {
  const inside = insideOf(returns, footprint);
  const raster = new Raster(bounds(footprint), 0.5, 0);
  const within = raster.mask(footprint);
  let withinCount = 0;
  for (const v of within) withinCount += v;
  if (!inside.count || !withinCount) return null;
  const top = raster.upper(inside);
  let seen = 0;
  for (let c = 0; c < top.length; c++) if (within[c] && Number.isFinite(top[c])) seen++;
  return -4 * Math.log(Math.max(1 - seen / withinCount, 1e-3));
}

function turn(points: Xyz, angle: number, origin: Vec2): Xyz {
  if (!points.count || !angle) return points;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const out: Xyz = { count: points.count, x: new Float64Array(points.count), y: new Float64Array(points.count), z: Float64Array.from(points.z) };
  for (let k = 0; k < points.count; k++) {
    const x = points.x[k] - origin[0];
    const y = points.y[k] - origin[1];
    out.x[k] = origin[0] + x * c - y * s;
    out.y[k] = origin[1] + x * s + y * c;
  }
  return out;
}

export interface EnvelopeFit {
  /** Lowest cap height above ground, the top of the foundation beneath it. */
  heightM: number;
  /** The cap in the metric frame, heights above ground, tiling the footprint exactly. */
  cap: Tin;
  roofFitP95M: number;
  diagnostics: Record<string, number | string>;
}

/**
 * A complete continuous envelope, or the reason there is none.
 *
 * `samples` are the per-cell upper observations proven by the coverage tests;
 * `returns` the individual returns behind them, which carry the facade.
 * `secondary` are returns filed under a vegetation class, admitted only where
 * the structural envelope already reaches that level. `neighbours` are the
 * mapped footprints around this one: a taller one's facade standing inside
 * this outline is not this roof.
 */
export function fitRoofEnvelope(
  footprint: MultiPolygon,
  samples: Xyz,
  cell: number,
  scale: [number, number] = DEFAULT_SURFACE_SCALE,
  returns: Xyz | null = null,
  secondarySamples: Xyz | null = null,
  neighbours: MultiPolygon[] = [],
): { fit: EnvelopeFit | null; reason: string | null } {
  if (!Number.isFinite(cell) || cell <= 0) throw new Error('Invalid upper surface sample spacing');
  if (samples.count < 4) return { fit: null, reason: 'insufficient upper surface samples' };
  const boundary = returns ?? { count: 0, x: new Float64Array(), y: new Float64Array(), z: new Float64Array() };
  let observed = boundary.count >= samples.count ? boundary : samples;
  let secondary = secondarySamples ?? { count: 0, x: new Float64Array(), y: new Float64Array(), z: new Float64Array() };
  // GEOS's union hands back a single valid polygon exactly as given. Clipper
  // rounds to its integer grid, which moves the raster laid out on it.
  let shape = footprint.length === 1 ? footprint : union(footprint);
  let density = surfaceDensity(shape, observed);
  let [pitch, window, tolerance] = envelopeParameters(scale, density);
  try {
    // Lay the raster along the building's long axis, so an ordinary
    // building's walls fall on grid lines. A quarter turn leaves the grid as
    // it is, so the angle is folded to within 45 degrees.
    const axis = longAxis(shape);
    let angle = pyMod(axis + Math.PI / 4, Math.PI / 2) - Math.PI / 4;
    if (Math.abs(angle) < 1e-9) angle = 0;
    const origin = centroid(shape);
    const near = buffer(shape, NEIGHBOUR_FACADE_M);
    const bands: MultiPolygon[] = [];
    for (const n of neighbours) {
      if (!n.length || !intersects(n, near)) continue;
      bands.push(difference(buffer(n, NEIGHBOUR_FACADE_M), buffer(n, -NEIGHBOUR_FACADE_M)));
    }
    let zone: MultiPolygon | null = bands.length ? union(...bands) : null;
    if (angle) {
      shape = rotate(shape, -angle, origin);
      observed = turn(observed, -angle, origin);
      secondary = turn(secondary, -angle, origin);
      if (zone) zone = rotate(zone, -angle, origin);
    }
    const components = pieces(shape);
    // The band reading grids a steep roof coarser too, and slender masses are
    // what a coarse grid costs: a cap that shows any is gridded as finely as
    // its cells are filled.
    const scatter = pitch > envelopeParameters(scale, 1e9)[0] ? scatterDensity(shape, observed) : null;
    if (scatter && envelopeParameters(scale, scatter)[0] < pitch && components.some((polygon) => hasSpires(polygon, observed, pitch, window, tolerance, zone))) {
      density = scatter;
      [pitch, window, tolerance] = envelopeParameters(scale, density);
    }
    const budget = facetBudget(pitch);
    const threshold = COLLAPSE_TOLERANCE * pitch * pitch;
    const parts = envelope(
      components,
      observed,
      secondary,
      pitch,
      window,
      tolerance,
      budget,
      threshold,
      [FAIR_WINDOW_MM / scale[0], FAIR_REACH_MM / scale[0]],
      zone,
      NOTCH_MM / scale[0],
    );
    let triangles = 0;
    for (const tin of parts.tins) triangles += tin.triangles.length / 3;
    if (triangles > MAX_ENVELOPE_FACETS) throw new UnsupportedFit('upper surface facet budget');
    const cap = mergeTins(parts.tins);
    // Round heights before choosing the base, so no vertex can end up under the base.
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let low = Infinity;
    for (let k = 0; k < cap.vertices.length; k += 3) {
      if (angle) {
        const x = cap.vertices[k] - origin[0];
        const y = cap.vertices[k + 1] - origin[1];
        cap.vertices[k] = origin[0] + x * c - y * s;
        cap.vertices[k + 1] = origin[1] + x * s + y * c;
      }
      cap.vertices[k + 2] = Math.round(cap.vertices[k + 2] * 1e4) / 1e4;
      low = Math.min(low, cap.vertices[k + 2]);
      if (!Number.isFinite(cap.vertices[k + 2])) low = NaN;
    }
    if (!(low > 0)) throw new UnsupportedFit('invalid upper surface heights');
    const residual = parts.residuals.length ? quantile(parts.residuals, 0.95) : 0;
    return {
      fit: {
        heightM: low,
        cap,
        roofFitP95M: residual,
        diagnostics: {
          envelope_raw_returns: boundary.count,
          envelope_observations: observed.count,
          envelope_secondary_returns: secondary.count,
          envelope_secondary_admitted: parts.admitted,
          envelope_cells: parts.cells,
          envelope_pitch_m: pitch,
          envelope_window_m: window,
          envelope_components: components.length,
          envelope_return_density_m2: Math.round((density ?? 0) * 100) / 100,
          surface_retained_samples: samples.count,
          envelope_collapsed_faces: parts.faces,
          envelope_collapse_tolerance_m2: threshold,
          envelope_smoothing_p95_m: residual,
        },
      },
      reason: null,
    };
  } catch (error) {
    if (error instanceof UnsupportedFit) return { fit: null, reason: error.message };
    throw error;
  }
}

function mergeTins(tins: Tin[]): Tin {
  let v = 0;
  let t = 0;
  for (const tin of tins) {
    v += tin.vertices.length;
    t += tin.triangles.length;
  }
  const vertices = new Float64Array(v);
  const triangles = new Uint32Array(t);
  let vo = 0;
  let to = 0;
  for (const tin of tins) {
    vertices.set(tin.vertices, vo);
    const base = vo / 3;
    for (let k = 0; k < tin.triangles.length; k++) triangles[to + k] = tin.triangles[k] + base;
    vo += tin.vertices.length;
    to += tin.triangles.length;
  }
  return { vertices, triangles };
}

/** Internal steps, for tests that compare them with the add-on's. */
export const internals = { componentSurface, spires, fair, rank, fill, soften, Raster, scatterDensity, surfaceDensity };
