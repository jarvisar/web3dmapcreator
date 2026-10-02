// Imported routes on a LiDAR only model. The surface holds everything the
// survey saw, roofs and crowns included, and a GPS track drifts onto them,
// so draped on the surface a run along a street climbed every building and
// tree it brushed. The route rests on the bare ground instead (compose's
// ground grid, in model mm like the surface).
//
// Where the surface stands higher than that, the route is either on it (a
// bridge deck, a ramp, an elevated road) or under it (a tree, a building's
// overhang, an overpass). It's on it when the surface rises to it gently
// along the route: a deck has ramps, a wall or a crown has an edge. Over
// water it's on the water, or on a deck whose ramps carry it there. Trees
// and clutter are cleared from the surface along the route first (compose's
// `clear`), so a run through a park shows instead of disappearing under the
// canopy.
//
// Something that isn't a building and runs along over the route for a long
// way carries it on top instead: Chicago's elevated railway over Wells
// Street hid six blocks of a run under it. Only in surveys that file
// buildings, since in one that doesn't, a recording that wanders into a
// building would climb onto its roof.
//
// The model's own surface is listed after the route in an export, so
// anything of the route under a roof or an overpass prints in the surface's
// colour, as the viewer shows it.
//
// Roads drawn in the editor rest on the ground the same way (edit/drawn.ts),
// with the trees over them cleared from a copy of the surface instead.

import { groundAt, type GroundGrid } from '../edit/ground';
import type { HeightFn } from '../geometry/solid';
import type { Vec2 } from '../types';

// Standing more than this over the ground, a surface is something the route
// is on or under, in real metres. Less is the ground with clutter on it.
const RAISED_M = 2.5;
// The steepest a surface can rise along the route and still carry it, as
// measured over WINDOW_CELLS. Ramps and decks are a few percent, and walls
// and crowns are near vertical, so this has room for noise.
const MAX_GRADE = 0.25;
const WINDOW_CELLS = 2;
// Stretches on or off a deck shorter than this, in cells, are noise: GPS
// drifting off the side of a bridge onto the water beside it.
const GAP_CELLS = 6;
// Steps between the ground and a deck become ramps no steeper than this.
const MAX_STEP_SLOPE = 1;
// Over the route for this far, in real metres, and less than COVER_BUILDINGS
// of it filed as building, a structure carries the route. Gaps in it under
// COVER_GAP_M (a cross street under the tracks) don't break it. On top, the
// route takes the median of the surface within COVER_MEDIAN_M, so stations
// and stray returns don't make it jagged.
const COVER_M = 40;
const COVER_GAP_M = 10;
const COVER_BUILDINGS = 0.3;
const COVER_MEDIAN_M = 15;

/** The centreline samples of one route line and the height the route rests on at each, NaN where there's nothing to rest on. */
export interface RouteProfile {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}

// What a cell of the surface is, in ProfileGrids.flags.
export const WATER_CELL = 1;
/** Cut out of the surface for water (compose's `cut`), through the base unless there's a water layer. */
export const CUT_CELL = 2;
/** The survey filed building returns there. */
export const BUILDING_CELL = 4;
/** Canopy or the skirt around it, or mostly vegetation returns with nothing solid over the ground. */
export const TREE_CELL = 8;

export interface ProfileGrids {
  /**
   * The surface as meshed, model mm. It can be a window of the model's grid
   * (a drawn road's cleared copy), so cells are found on `ground`.
   */
  surface: GroundGrid;
  /** The bare ground, model mm. */
  ground: GroundGrid;
  /** Per cell of `ground`, the bits above. */
  flags: Uint8Array;
  /** Per cell, with a water layer: its surface, NaN elsewhere. Cut cells without one go through the base. */
  waterTop: Float32Array | null;
  /** The survey files buildings at all. In one that doesn't, BUILDING_CELL says nothing. */
  filesBuildings: boolean;
  /** Model mm per real metre across. */
  mmPerMetre: number;
  /** What heights over the ground are multiplied by, and the ground's own rise. */
  heightScale: number;
  exaggeration: number;
}

export function cellIndex(grid: GroundGrid, x: number, y: number): number {
  const c = Math.min(grid.cols - 1, Math.max(0, Math.round((x - grid.minX) / grid.step)));
  const r = Math.min(grid.rows - 1, Math.max(0, Math.round((y - grid.minY) / (grid.stepY ?? grid.step))));
  return r * grid.cols + c;
}

/** Fills runs of 0 shorter than `gap` between 1s, then drops runs of 1 shorter than it. */
function closeOpen(mask: Uint8Array, gap: number): void {
  const runs = (value: number, fill: number, inner: boolean) => {
    let k = 0;
    while (k < mask.length) {
      if (mask[k] !== value) {
        k++;
        continue;
      }
      let end = k;
      while (end < mask.length && mask[end] === value) end++;
      const bounded = k > 0 && end < mask.length;
      if (end - k < gap && (!inner || bounded)) mask.fill(fill, k, end);
      k = end;
    }
  };
  runs(0, 1, true);
  runs(1, 0, false);
}

/** Heights a route line rests on, sampled every half cell. */
export function routeProfile(line: readonly Vec2[], grids: ProfileGrids): RouteProfile {
  const { surface, ground, flags, waterTop, filesBuildings, mmPerMetre, heightScale, exaggeration } = grids;
  // Cut water with no layer leaves nothing to rest on.
  const through = waterTop ? 0 : CUT_CELL;
  const cell = Math.min(surface.step, surface.stepY ?? surface.step);
  const step = cell / 2;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      xs.push(ax + ((bx - ax) * k) / n);
      ys.push(ay + ((by - ay) * k) / n);
    }
  }
  const count = xs.length;
  const h = new Float64Array(count);
  const g = new Float64Array(count);
  const wet = new Uint8Array(count);
  const z = new Float64Array(count);
  const raised = new Uint8Array(count);
  const filed = new Uint8Array(count);
  const raisedMm = RAISED_M * mmPerMetre * heightScale;
  // A real grade as it is in the model, where heights are scaled and lengths aren't.
  const maxGrade = MAX_GRADE * Math.max(heightScale, exaggeration);
  for (let k = 0; k < count; k++) {
    h[k] = groundAt(surface, xs[k], ys[k]);
    g[k] = groundAt(ground, xs[k], ys[k]);
    const f = flags[cellIndex(ground, xs[k], ys[k])];
    wet[k] = f & (WATER_CELL | through) ? 1 : 0;
    raised[k] = !wet[k] && h[k] - g[k] > raisedMm ? 1 : 0;
    filed[k] = filesBuildings && f & BUILDING_CELL ? 1 : 0;
  }

  // Raised stretches the surface rises to gently carry the route. Water
  // between two of them is under the deck carrying it.
  const window = Math.max(1, Math.round((WINDOW_CELLS * cell) / step));
  const margin = window * 2;
  // A deck's side drops sheer to the water, which the route only crosses by
  // drifting off it. The grade isn't measured there.
  const shore = new Uint8Array(count);
  for (let j = 0; j < count; j++) {
    if (!wet[j]) continue;
    for (let d = Math.max(0, j - window); d <= Math.min(count - 1, j + window); d++) shore[d] = 1;
  }
  const on = new Uint8Array(count);
  let k = 0;
  while (k < count) {
    if (!raised[k]) {
      k++;
      continue;
    }
    let end = k;
    while (end < count && raised[end]) end++;
    let steepest = 0;
    const from = Math.max(0, k - margin);
    const to = Math.min(count - 1, end - 1 + margin);
    for (let j = from; j + window <= to; j++) {
      if (shore[j] || shore[j + window]) continue;
      steepest = Math.max(steepest, Math.abs(h[j + window] - h[j]) / (window * step));
    }
    if (steepest <= maxGrade) on.fill(1, k, end);
    k = end;
  }
  closeOpen(on, Math.round((GAP_CELLS * cell) / step));

  // Long stretches under something that isn't a building.
  const cover = new Uint8Array(count);
  if (filesBuildings) {
    const covered = raised.slice();
    const gap = Math.round((COVER_GAP_M * mmPerMetre) / step);
    for (let j = 0; j < count; ) {
      if (covered[j]) {
        j++;
        continue;
      }
      let end = j;
      while (end < count && !covered[end]) end++;
      if (j > 0 && end < count && end - j < gap) covered.fill(1, j, end);
      j = end;
    }
    const long = (COVER_M * mmPerMetre) / step;
    for (let j = 0; j < count; ) {
      if (!covered[j] || on[j]) {
        j++;
        continue;
      }
      let end = j;
      let filedCount = 0;
      while (end < count && covered[end] && !on[end]) filedCount += filed[end++];
      if (end - j >= long && filedCount < COVER_BUILDINGS * (end - j)) cover.fill(1, j, end);
      j = end;
    }
  }
  const reach = Math.round((COVER_MEDIAN_M * mmPerMetre) / step);
  const coverLevel = (j: number) => {
    const heights: number[] = [];
    for (let d = Math.max(0, j - reach); d <= Math.min(count - 1, j + reach); d++) if (cover[d] && raised[d]) heights.push(h[d]);
    if (!heights.length) return h[j];
    heights.sort((a, b) => a - b);
    return heights[heights.length >> 1];
  };

  for (let j = 0; j < count; j++) {
    if (cover[j]) z[j] = Math.max(g[j], coverLevel(j));
    else if (on[j] && !shore[j]) z[j] = h[j];
    else if (on[j]) {
      // Off the side of a deck onto the water beside it: the deck's height,
      // carried across from either side of where the surface dips to the water.
      let a = j;
      while (a >= 0 && on[a] && shore[a]) a--;
      let b = j;
      while (b < count && on[b] && shore[b]) b++;
      const from = a >= 0 && on[a] ? h[a] : NaN;
      const to = b < count && on[b] ? h[b] : NaN;
      z[j] = from === from && to === to ? from + ((to - from) * (j - a)) / (b - a) : from === from ? from : to === to ? to : h[j];
    } else if (wet[j]) {
      const i = cellIndex(ground, xs[j], ys[j]);
      if (flags[i] & through) z[j] = NaN;
      else if (waterTop && waterTop[i] === waterTop[i]) z[j] = waterTop[i];
      else z[j] = h[j];
    } else z[j] = g[j];
  }
  // Steps become ramps, raised on the low side.
  const rise = MAX_STEP_SLOPE * step;
  for (let j = 1; j < count; j++) if (z[j - 1] === z[j - 1] && z[j] === z[j] && z[j] < z[j - 1] - rise) z[j] = z[j - 1] - rise;
  for (let j = count - 2; j >= 0; j--) if (z[j + 1] === z[j + 1] && z[j] === z[j] && z[j] < z[j + 1] - rise) z[j] = z[j + 1] - rise;
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), z };
}

/**
 * The profiles' heights anywhere near them: those of the nearest centreline,
 * interpolated along it. Off the routes it's the nearest one's, so markers
 * and a ribbon's edges take their centreline's height.
 */
export class ProfileIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly bx: number[] = [];
  private readonly by: number[] = [];
  private readonly az: number[] = [];
  private readonly bz: number[] = [];

  constructor(
    profiles: readonly RouteProfile[],
    private readonly cell: number,
  ) {
    for (const p of profiles) {
      for (let k = 1; k < p.x.length; k++) {
        // A stretch with nothing to rest on takes the height beside it.
        const za = p.z[k - 1] === p.z[k - 1] ? p.z[k - 1] : p.z[k];
        const zb = p.z[k] === p.z[k] ? p.z[k] : p.z[k - 1];
        if (!(za === za) || !(zb === zb)) continue;
        const s = this.ax.length;
        this.ax.push(p.x[k - 1]);
        this.ay.push(p.y[k - 1]);
        this.bx.push(p.x[k]);
        this.by.push(p.y[k]);
        this.az.push(za);
        this.bz.push(zb);
        const x0 = Math.floor(Math.min(p.x[k - 1], p.x[k]) / cell);
        const x1 = Math.floor(Math.max(p.x[k - 1], p.x[k]) / cell);
        const y0 = Math.floor(Math.min(p.y[k - 1], p.y[k]) / cell);
        const y1 = Math.floor(Math.max(p.y[k - 1], p.y[k]) / cell);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const key = this.key(cx, cy);
            const list = this.cells.get(key);
            if (list) list.push(s);
            else this.cells.set(key, [s]);
          }
        }
      }
    }
  }

  private key(cx: number, cy: number): number {
    return (cx + 2 ** 25) * 2 ** 26 + (cy + 2 ** 25);
  }

  get empty(): boolean {
    return this.ax.length === 0;
  }

  at: HeightFn = (x, y) => {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best = Infinity;
    let z = NaN;
    for (let reach = 1; reach <= 4 && !(best <= reach * this.cell); reach++) {
      for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < reach && reach > 1) continue;
          for (const s of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
            const ex = this.bx[s] - this.ax[s];
            const ey = this.by[s] - this.ay[s];
            const length2 = ex * ex + ey * ey;
            const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - this.ax[s]) * ex + (y - this.ay[s]) * ey) / length2)) : 0;
            const d = Math.hypot(this.ax[s] + ex * t - x, this.ay[s] + ey * t - y);
            if (d < best) {
              best = d;
              z = this.az[s] + (this.bz[s] - this.az[s]) * t;
            }
          }
        }
      }
    }
    return z;
  };
}
