// Roads drawn in the editor on a LiDAR only model. The surface holds every
// roof and crown, so draped on it a drawn road climbed the trees along a
// street and stood up the face of any building it met. It rests on the bare
// ground instead, the way an imported route does (dsm/route.ts): it rides
// decks and ramps the surface rises to gently, and stays down under trees,
// overhangs and overpasses.
//
// Routes have the trees and clutter over them cleared before the surface is
// meshed. The editor can't mesh the surface again, so they're cleared in a
// copy of the grid around the road for its profile, and the session cuts the
// same cells out of the meshed surface and fills them with the bare ground
// (session.ts, `surfaceCut`). Only what stands more than half the road's
// height over the ground is cleared. Anything lower doesn't hide it, and
// clutter is kept by default: clearing every parked car along a street cut
// holes all down it for nothing.

import { CLUTTER_M } from '../dsm/model';
import { CUT_CELL, routeProfile, TREE_CELL, WATER_CELL, type ProfileGrids, type RouteProfile } from '../dsm/route';
import { bufferLines, intersection, multiBounds, union } from '../geometry/polygon';
import { rowCrossings } from '../geometry/scanline';
import type { HeightFn } from '../geometry/solid';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { groundAt, type GroundGrid } from './ground';

export interface DrawnRoad {
  /** What the road rests on, near its line. */
  restsOn: HeightFn;
  /** The surface with what was cleared for the road, for its underside. */
  surfaceAt: HeightFn;
  /** Where the surface is cleared down to the ground. */
  cleared: MultiPolygon;
  /** How far its underside reaches into the surface, to meet the meshed surface wherever it strays from the grid. */
  sink: number;
  /** Cap edge for its draped top. */
  drape: number;
  /** The share of its line under the surface, inside a building or under an overpass, where it won't show. */
  hidden: number;
}

/** A road drawn along `line` (model mm), `width` wide and `height` tall, on a LiDAR only model. */
export function drawnRoad(line: readonly Vec2[], width: number, height: number, grids: ProfileGrids, embed: number): DrawnRoad {
  const { surface, ground, flags } = grids;
  const dx = ground.step;
  const dy = ground.stepY ?? ground.step;
  const cell = Math.min(dx, dy);
  // A cell either side, as routes have, so the road's walls don't stand against a crown.
  const reach = 2 * Math.max(dx, dy);
  const corridor = bufferLines([{ points: [...line], width: width + reach }], 'round');

  // The window of the grid around it, a couple of cells past the corridor.
  const [west, south, east, north] = multiBounds(corridor);
  const c0 = clampIndex(Math.floor((west - ground.minX) / dx) - 2, ground.cols);
  const c1 = Math.max(c0 + 1, clampIndex(Math.ceil((east - ground.minX) / dx) + 2, ground.cols));
  const r0 = clampIndex(Math.floor((south - ground.minY) / dy) - 2, ground.rows);
  const r1 = Math.max(r0 + 1, clampIndex(Math.ceil((north - ground.minY) / dy) + 2, ground.rows));
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  const window = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) window[r * cols + c] = surface.values[(r0 + r) * ground.cols + c0 + c];
  }

  // Trees and clutter in the corridor tall enough to hide the road come down to the ground.
  const clutterMm = CLUTTER_M * grids.mmPerMetre * grids.heightScale;
  const least = height / 2;
  const cleared = new Uint8Array(cols * rows);
  let any = false;
  const rings = corridor.flat();
  const crossings = rowCrossings(rings, ground.minY, dy, r0, rows);
  crossings.forEach((xs, r) => {
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(c0, Math.ceil((xs[k] - ground.minX) / dx));
      const to = Math.min(c1 + 1, Math.ceil((xs[k + 1] - ground.minX) / dx));
      for (let c = from; c < to; c++) {
        const i = (r0 + r) * ground.cols + c;
        const f = flags[i];
        if (f & (WATER_CELL | CUT_CELL)) continue;
        const g = ground.values[i];
        const over = surface.values[i] - g;
        if (!(over > least) || (!(f & TREE_CELL) && !(over < clutterMm))) continue;
        window[r * cols + (c - c0)] = g;
        cleared[r * cols + (c - c0)] = 1;
        any = true;
      }
    }
  });

  const local: GroundGrid = { minX: ground.minX + c0 * dx, minY: ground.minY + r0 * dy, step: dx, stepY: dy, cols, rows, values: window };
  const inside = (x: number, y: number) => x >= local.minX && x <= local.minX + (cols - 1) * dx && y >= local.minY && y <= local.minY + (rows - 1) * dy;
  const surfaceAt: HeightFn = (x, y) => groundAt(inside(x, y) ? local : surface, x, y);
  const profile = routeProfile(line, { ...grids, surface: local });
  const heights = new LineHeights(line, profile, Math.max(width, cell));
  const restsOn: HeightFn = (x, y) => {
    const z = heights.at(x, y);
    return z === z ? z : surfaceAt(x, y);
  };
  let under = 0;
  for (let k = 0; k < profile.x.length; k++) if (surfaceAt(profile.x[k], profile.y[k]) > restsOn(profile.x[k], profile.y[k]) + height) under++;
  return {
    restsOn,
    surfaceAt,
    cleared: any ? intersection(clearedCells(cleared, local), corridor) : [],
    sink: Math.max(embed, 1.5 * cell),
    drape: Math.max(2 * cell, 0.1),
    hidden: profile.x.length ? under / profile.x.length : 0,
  };
}

/**
 * The profile's heights near the line: those of the nearest point on it, by
 * distance along it. ProfileIndex does this for routes from the profile's
 * own samples, every half cell, bucketed by the route's width, and for a
 * 20 mm road each bucket held thousands of them: meshing one took minutes.
 * A drawn line has a few segments.
 */
class LineHeights {
  private readonly segments: { ax: number; ay: number; ex: number; ey: number; length2: number; from: number; length: number }[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly along: Float64Array;
  private readonly z: Float64Array;

  constructor(
    line: readonly Vec2[],
    profile: RouteProfile,
    private readonly cell: number,
  ) {
    let from = 0;
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const length = Math.hypot(bx - ax, by - ay);
      if (!(length > 0)) continue;
      const s = this.segments.length;
      this.segments.push({ ax, ay, ex: bx - ax, ey: by - ay, length2: length * length, from, length });
      from += length;
      for (let cx = Math.floor(Math.min(ax, bx) / cell); cx <= Math.floor(Math.max(ax, bx) / cell); cx++) {
        for (let cy = Math.floor(Math.min(ay, by) / cell); cy <= Math.floor(Math.max(ay, by) / cell); cy++) {
          const key = cellKey(cx, cy);
          const list = this.cells.get(key);
          if (list) list.push(s);
          else this.cells.set(key, [s]);
        }
      }
    }
    // The samples lie on the line, so their distance along it adds up sample to sample.
    const count = profile.x.length;
    this.along = new Float64Array(count);
    for (let k = 1; k < count; k++) this.along[k] = this.along[k - 1] + Math.hypot(profile.x[k] - profile.x[k - 1], profile.y[k] - profile.y[k - 1]);
    // A stretch with nothing to rest on takes the nearest height along the line.
    this.z = Float64Array.from(profile.z);
    let last = -1;
    for (let k = 0; k < count; k++) {
      if (this.z[k] === this.z[k]) {
        last = k;
        continue;
      }
      let next = k;
      while (next < count && !(profile.z[next] === profile.z[next])) next++;
      for (let j = k; j < next; j++) {
        const back = last >= 0 ? this.along[j] - this.along[last] : Infinity;
        const ahead = next < count ? this.along[next] - this.along[j] : Infinity;
        this.z[j] = back <= ahead ? (last >= 0 ? profile.z[last] : NaN) : profile.z[next];
      }
      k = next - 1;
    }
  }

  /** NaN more than four cells from the line, or with nothing on it to rest on. */
  at(x: number, y: number): number {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best = Infinity;
    let s = NaN;
    for (let reach = 0; reach <= 4 && !(best <= reach * this.cell); reach++) {
      for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < reach) continue;
          for (const i of this.cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
            const g = this.segments[i];
            const t = Math.max(0, Math.min(1, ((x - g.ax) * g.ex + (y - g.ay) * g.ey) / g.length2));
            const d = Math.hypot(g.ax + g.ex * t - x, g.ay + g.ey * t - y);
            if (d < best) {
              best = d;
              s = g.from + t * g.length;
            }
          }
        }
      }
    }
    if (!(s === s) || !this.along.length) return NaN;
    // The last sample at or before s, then towards the next.
    let lo = 0;
    let hi = this.along.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.along[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    if (lo === this.along.length - 1) return this.z[lo];
    const span = this.along[lo + 1] - this.along[lo];
    const t = span > 0 ? (s - this.along[lo]) / span : 0;
    return this.z[lo] + (this.z[lo + 1] - this.z[lo]) * t;
  }
}

function cellKey(cx: number, cy: number): number {
  return (cx + 2 ** 25) * 2 ** 26 + (cy + 2 ** 25);
}

function clampIndex(i: number, count: number): number {
  return Math.min(count - 1, Math.max(0, i));
}

/** Cells marked in `mask` as squares around their grid points, merged. */
function clearedCells(mask: Uint8Array, grid: GroundGrid): MultiPolygon {
  const dx = grid.step;
  const dy = grid.stepY ?? grid.step;
  const pieces: Polygon[] = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; ) {
      if (!mask[r * grid.cols + c]) {
        c++;
        continue;
      }
      const from = c;
      while (c < grid.cols && mask[r * grid.cols + c]) c++;
      const xa = grid.minX + (from - 0.5) * dx;
      const xb = grid.minX + (c - 0.5) * dx;
      const ya = grid.minY + (r - 0.5) * dy;
      const yb = grid.minY + (r + 0.5) * dy;
      pieces.push([
        [
          [xa, ya],
          [xb, ya],
          [xb, yb],
          [xa, yb],
        ],
      ]);
    }
  }
  return union(pieces);
}

/** The bare ground under a point of a LiDAR only model. */
export function bareGround(grids: ProfileGrids): HeightFn {
  return (x, y) => groundAt(grids.ground, x, y);
}
