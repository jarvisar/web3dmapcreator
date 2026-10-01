// Measured roofs from the surface a LiDAR Only model is built from. A
// batch's returns are counted into cells of the area's own LiDAR grid
// (BlockRaster), composed by LiDAR Only's rules (composeSurface, fairFaces),
// and each building is meshed from the cells around it with LiDAR Only's
// mesher and limits. So a measured building comes out the way the same cells
// do in a LiDAR Only model of the area, with the same Detail or cell size.
//
// What differs is the edge. A map model's building fills its mapped
// outline, since the roads and land cover stop at it, so the roof is carried
// out to the outline (see `edges`) and clipped to it. Trees are taken down
// to what stands under them: a crown over a roof isn't the building, and map
// models have trees of their own.

import { composeSurface } from '../dsm/compose';
import { FAIR_REACH_MM, FAIR_WINDOW_MM, fairFaces, windowMax } from '../dsm/filters';
import { BLOCK_M, cellSize, cellsInside, DEFAULT_DETAIL_MM, gridSpec, type Block } from '../dsm/grid';
import { COUNT_LAYERS, emptyLayers, FLOAT_LAYERS } from '../dsm/layers';
import { meshGrid, straightenWalls, surfaceLimits, wallDetail, WALL_STEP_CELLS, type HeightGrid } from '../dsm/mesh';
import { BlockRaster, occupiedCell, ProbeSink, type GridOrigin } from '../dsm/raster';
import { difference, union } from '../geometry/polygon';
import { clipTin, tinArea, type Tin } from '../geometry/tinclip';
import type { MultiPolygon } from '../types';
import type { Points } from './points';
import { thinRim } from './rim';
import { area, bounds, buffer, intersects, nearestOnBoundary, type Box } from './shapes';

/** Printed mm per ground metre, horizontal and vertical, when none is given. */
export const DEFAULT_SURFACE_SCALE: [number, number] = [0.07, 0.077];
// The band along the outline where the roof is carried out to it, and where
// a mapped neighbour's facade standing inside the outline is taken down.
const FACADE_BAND_M = 1.5;
const NEIGHBOUR_FACADE_M = 4;
// Cells in the band lower than this over the building's ground are the
// street or pavement where the outline runs a little outside the wall.
const LOW_M = 2.5;
// Lowest a cap may come, over the building's ground.
const FLOOR_M = 0.05;
// Vertices this close to the outline in plan are moved onto it. An outline
// running a hair inside a grid line otherwise clips a row of faces into
// slivers thinner than float32 holds at print scale.
const SNAP_GAP = 0.0025;
// A batch grid past this many cells is left to the terrace fallback, about
// 1.5 km square at 0.25 m. Batches are 400 m, so only a huge building gets here.
const MAX_BATCH_CELLS = 36_000_000;

export interface SurfaceSettings {
  /** The cell asked for in metres. It grows where the survey is too sparse to fill it, as in a LiDAR Only model. */
  cellM: number;
  /** The area's size, when the measurement frame is the area's own: cells then sit where a LiDAR Only model's would. */
  widthM?: number;
  heightM?: number;
  /** Printed mm per ground metre, horizontal and vertical. */
  xyScale: number;
  zScale: number;
}

export interface SurfaceFit {
  /** Heights above `groundM`, in the measurement frame, tiling the footprint exactly. */
  cap: Tin;
  /** The lowest cap height, the top of the foundation beneath it. */
  heightM: number;
  diagnostics: Record<string, number | string>;
}

/** A rise this tall over a roof, 0.28 mm printed and never under 3 m, is a mass of its own rather than relief on it. */
export function massRise(xyScale: number): number {
  return Math.max(3, 0.28 / xyScale);
}

/**
 * A surface from one building's own returns, with its cell from the printed
 * detail and on a grid of its own, for a measurement made outside a batch.
 */
export function surfaceAround(footprint: MultiPolygon, points: Points, [xyScale, zScale]: [number, number]): BatchSurface | null {
  const [x0, y0, x1, y1] = bounds(footprint);
  const halo = 2 * FACADE_BAND_M + 10;
  return BatchSurface.build(points, [x0 - halo, y0 - halo, x1 + halo, y1 + halo], { cellM: cellSize(DEFAULT_DETAIL_MM, xyScale, 0, 0), xyScale, zScale });
}

/**
 * The cell a survey fills, measured on up to a block in the middle of the
 * batch the way a LiDAR Only model measures it (occupiedCell).
 */
function filledCell(points: Points, box: Box, requested: number): number {
  const side = Math.min(BLOCK_M, box[2] - box[0], box[3] - box[1]);
  if (!(side > 4 * requested)) return requested;
  const x0 = (box[0] + box[2] - side) / 2;
  const y0 = (box[1] + box[3] - side) / 2;
  const probe = new ProbeSink(x0, y0);
  for (let k = 0; k < points.count; k++) {
    const x = points.x[k];
    const y = points.y[k];
    if (x >= x0 && x < x0 + side && y >= y0 && y < y0 + side) probe.push(x, y, points.z[k], points.cls[k]);
  }
  const found = occupiedCell(probe, side, side, requested);
  return found ? Math.max(requested, found.cell) : requested;
}

/** One batch's surface, in printed mm over the batch's lowest ground, on the area's LiDAR grid. */
export class BatchSurface {
  private constructor(
    readonly origin: GridOrigin,
    /** Grid column and row of the first cell. */
    readonly c0: number,
    readonly r0: number,
    readonly nx: number,
    readonly ny: number,
    readonly heights: Float32Array,
    /** Canopy taken down to what stands under it. */
    readonly taken: Uint8Array,
    /** Metres in the survey's datum that height 0 stands for. */
    readonly datum: number,
    readonly xyScale: number,
    readonly zScale: number,
  ) {}

  get cell(): number {
    return Math.min(this.origin.dx, this.origin.dy);
  }

  /** The surface over `box` (measurement frame metres) from a batch's points, or null when it has no returns. */
  static build(points: Points, box: Box, settings: SurfaceSettings): BatchSurface | null {
    if (!points.count) return null;
    const cell = filledCell(points, box, settings.cellM);
    const spec = settings.widthM && settings.heightM ? gridSpec(settings.widthM, settings.heightM, cell) : null;
    const origin: GridOrigin = spec ? { x0: spec.x0, y0: spec.y0, dx: spec.dx, dy: spec.dy } : { x0: 0, y0: 0, dx: cell, dy: cell };
    const c0 = Math.floor((box[0] - origin.x0) / origin.dx);
    const r0 = Math.floor((box[1] - origin.y0) / origin.dy);
    const nx = Math.ceil((box[2] - origin.x0) / origin.dx) + 1 - c0;
    const ny = Math.ceil((box[3] - origin.y0) / origin.dy) + 1 - r0;
    if (nx < 2 || ny < 2 || nx * ny > MAX_BATCH_CELLS) return null;
    // In blocks, as a LiDAR Only model reads them: a raster keeps 24 returns
    // a cell, too much to hold for a whole batch at fine cells.
    const layers = emptyLayers(nx, ny);
    const stepX = Math.max(1, Math.round(BLOCK_M / origin.dx));
    const stepY = Math.max(1, Math.round(BLOCK_M / origin.dy));
    for (let r = r0; r < r0 + ny; r += stepY) {
      for (let c = c0; c < c0 + nx; c += stepX) {
        const block: Block = { rows: [r, Math.min(r0 + ny, r + stepY)], columns: [c, Math.min(c0 + nx, c + stepX)] };
        const raster = new BlockRaster(origin, block);
        for (let k = 0; k < points.count; k++) raster.push(points.x[k], points.y[k], points.z[k], points.cls[k], points.single[k]);
        const piece = raster.layers();
        const width = block.columns[1] - block.columns[0];
        for (let row = block.rows[0]; row < block.rows[1]; row++) {
          const from = (row - block.rows[0]) * width;
          const to = (row - r0) * nx + (block.columns[0] - c0);
          for (const name of FLOAT_LAYERS) layers[name].set(piece[name].subarray(from, from + width), to);
          for (const name of COUNT_LAYERS) layers[name].set(piece[name].subarray(from, from + width), to);
        }
      }
    }
    let composed: ReturnType<typeof composeSurface>;
    try {
      composed = composeSurface(layers, origin.dx, origin.dy, { trees: 'off', removeClutter: false, clutterHeightM: 2 });
    } catch {
      return null;
    }
    let datum = Infinity;
    for (const g of composed.ground) if (g < datum) datum = g;
    if (!Number.isFinite(datum)) return null;
    const heights = new Float32Array(nx * ny);
    for (let i = 0; i < heights.length; i++) heights[i] = (composed.surface[i] - datum) * settings.zScale;
    fairFaces(heights, nx, ny, Math.min(origin.dx, origin.dy) * settings.xyScale, FAIR_WINDOW_MM, FAIR_REACH_MM, composed.water);
    return new BatchSurface(origin, c0, r0, nx, ny, heights, composed.taken ?? new Uint8Array(nx * ny), datum, settings.xyScale, settings.zScale);
  }

  /**
   * The roof over `footprint` (measurement frame metres) with heights above
   * `groundM`, or the reason there is none. `neighbours` are the mapped
   * footprints around it. Rock keeps the survey's edge as it is.
   */
  fit(footprint: MultiPolygon, groundM: number, neighbours: MultiPolygon[] = [], kind: 'building' | 'rock' = 'building'): { fit: SurfaceFit | null; reason: string | null } {
    const { origin, xyScale, zScale } = this;
    const cell = this.cell;
    const band = Math.max(1, Math.round(FACADE_BAND_M / cell));
    const pad = band + 2;
    const [fx0, fy0, fx1, fy1] = bounds(footprint);
    const c0 = Math.floor((fx0 - origin.x0) / origin.dx) - pad;
    const r0 = Math.floor((fy0 - origin.y0) / origin.dy) - pad;
    const c1 = Math.ceil((fx1 - origin.x0) / origin.dx) + 1 + pad;
    const r1 = Math.ceil((fy1 - origin.y0) / origin.dy) + 1 + pad;
    if (c0 < this.c0 || r0 < this.r0 || c1 > this.c0 + this.nx || r1 > this.r0 + this.ny) return { fit: null, reason: 'footprint outside the surveyed surface' };
    const w = c1 - c0;
    const h = r1 - r0;
    const z = new Float32Array(w * h);
    const taken = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      const from = (r0 + r - this.r0) * this.nx + (c0 - this.c0);
      z.set(this.heights.subarray(from, from + w), r * w);
      taken.set(this.taken.subarray(from, from + w), r * w);
    }
    const block: Block = { rows: [r0, r1], columns: [c0, c1] };
    const inside = cellsInside(footprint, origin, block);
    let cells = 0;
    for (const v of inside) cells += v;
    if (!cells) return { fit: null, reason: 'footprint smaller than a surface cell' };
    const ground = (groundM - this.datum) * zScale;
    let lifted = 0;
    let lowered = 0;
    if (kind === 'building') {
      const core = erodeCross(inside, w, h, band);
      const near = buffer(footprint, NEIGHBOUR_FACADE_M);
      const zones: MultiPolygon[] = [];
      for (const n of neighbours) if (n.length && intersects(n, near)) zones.push(difference(buffer(n, NEIGHBOUR_FACADE_M), buffer(n, -NEIGHBOUR_FACADE_M)));
      if (zones.length) {
        const zone = cellsInside(union(...zones), origin, block);
        lowered = neighbourFacades(z, inside, core, zone, w, h, band, massRise(xyScale) * zScale);
      }
      lifted = carryToOutline(z, inside, core, taken, w, h, ground + LOW_M * zScale);
    }
    spread(z, inside, w, h);
    const floor = ground + FLOOR_M * zScale;
    for (let i = 0; i < z.length; i++) if (!(z[i] >= floor)) z[i] = floor;

    const step = cell * xyScale;
    const grid: HeightGrid = {
      heights: z,
      detail: wallDetail(z, new Float32Array(w * h).fill(1), w, h, WALL_STEP_CELLS * step),
      nx: w,
      ny: h,
      x0: (origin.x0 + c0 * origin.dx) * xyScale,
      y0: (origin.y0 + r0 * origin.dy) * xyScale,
      x1: (origin.x0 + (c1 - 1) * origin.dx) * xyScale,
      y1: (origin.y0 + (r1 - 1) * origin.dy) * xyScale,
      dx: origin.dx * xyScale,
      dy: origin.dy * xyScale,
    };
    const limits = surfaceLimits(step);
    let tin = meshGrid(grid, limits);
    // Twice, as for a LiDAR Only surface: the first pass joins up roof edges the second can straighten further.
    for (let pass = 0; pass < 2; pass++) tin = straightenWalls(tin, grid, limits, step);
    const faces = tin.triangles.length / 3;

    const vertices = new Float64Array(tin.vertices.length);
    for (let k = 0; k < vertices.length; k += 3) {
      vertices[k] = tin.vertices[k] / xyScale;
      vertices[k + 1] = tin.vertices[k + 1] / xyScale;
      // A collapse can leave a vertex up to the deviation below every cell at a wall's foot.
      vertices[k + 2] = Math.round((Math.max(tin.vertices[k + 2], floor) / zScale + this.datum - groundM) * 1e4) / 1e4;
    }
    snapToBoundary(vertices, footprint, SNAP_GAP);
    const clipped = clipTin({ vertices, triangles: tin.triangles }, footprint);
    if (!clipped?.triangles.length) return { fit: null, reason: 'incomplete clipped upper surface' };
    // The clip leaves a rim vertex at every edge it crosses, which only cost triangles along straight walls.
    const cap = thinRim(clipped, cell / 2);
    const expected = area(footprint);
    if (Math.abs(tinArea(cap) - expected) > Math.max(1e-5, expected * 1e-5)) return { fit: null, reason: 'incomplete clipped upper surface' };
    let low = Infinity;
    for (let k = 2; k < cap.vertices.length; k += 3) low = Math.min(low, cap.vertices[k]);
    if (!(low > 0)) return { fit: null, reason: 'invalid upper surface heights' };
    return {
      fit: {
        cap,
        heightM: low,
        diagnostics: { surface_cell_m: Math.round(cell * 1000) / 1000, surface_cells: cells, surface_faces: faces, surface_lifted_cells: lifted, surface_lowered_cells: lowered },
      },
      reason: null,
    };
  }
}

/** The mask shrunk by `times` cells, four-connected, the window's edge counting as outside. */
function erodeCross(mask: Uint8Array, w: number, h: number, times: number): Uint8Array {
  let core = Uint8Array.from(mask);
  for (let step = 0; step < times; step++) {
    const next = Uint8Array.from(core);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const c = j * w + i;
        if (!core[c]) continue;
        if (i === 0 || j === 0 || i === w - 1 || j === h - 1 || !core[c - 1] || !core[c + 1] || !core[c - w] || !core[c + w]) next[c] = 0;
      }
    }
    core = next;
  }
  return core;
}

/**
 * A mapped neighbour's facade standing inside our outline, brought down to
 * our roof. A cell in the band along the outline, near a neighbour's outline,
 * that stands `rise` above every cell behind the band within twice its
 * width takes that height, unless its raised mass reaches behind the band (a
 * parapet or front wall is ours). The building caps' rule before they were
 * taken from this surface. Returns the cells changed.
 */
function neighbourFacades(z: Float32Array, inside: Uint8Array, core: Uint8Array, zone: Uint8Array, w: number, h: number, band: number, rise: number): number {
  const n = w * h;
  let any = false;
  for (let c = 0; c < n && !any; c++) any = inside[c] === 1 && !core[c] && zone[c] === 1;
  if (!any || !core.includes(1)) return 0;
  const behind = new Float32Array(n).fill(-Infinity);
  for (let c = 0; c < n; c++) if (core[c]) behind[c] = z[c];
  const roof = windowMax(behind, w, h, 2 * band);
  const seeds: number[] = [];
  for (let c = 0; c < n; c++) if (inside[c] && !core[c] && zone[c] && Number.isFinite(roof[c]) && z[c] > roof[c] + rise) seeds.push(c);
  if (!seeds.length) return 0;
  // Each seed's mass: the cells inside, eight-connected, above its level.
  const seen = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const real = new Uint8Array(n);
  const done = new Uint8Array(n);
  for (const seed of seeds) {
    if (done[seed]) continue;
    const level = roof[seed] + rise;
    let top = 0;
    stack[top++] = seed;
    seen[seed] = seed;
    const mass: number[] = [];
    let reaches = false;
    while (top && !reaches) {
      const c = stack[--top];
      mass.push(c);
      const i = c % w;
      const j = (c - i) / w;
      for (let q = Math.max(0, j - 1); q <= Math.min(h - 1, j + 1); q++) {
        for (let p = Math.max(0, i - 1); p <= Math.min(w - 1, i + 1); p++) {
          const k = q * w + p;
          if (seen[k] === seed || !inside[k] || !(z[k] > level)) continue;
          if (core[k]) reaches = true;
          seen[k] = seed;
          stack[top++] = k;
        }
      }
    }
    for (const c of mass) {
      done[c] = 1;
      if (reaches) real[c] = 1;
    }
  }
  let changed = 0;
  for (const c of seeds) {
    if (real[c]) continue;
    z[c] = roof[c];
    changed++;
  }
  return changed;
}

/**
 * Low cells in the band along the outline (under `low`), and cells left on
 * the ground where a tree was taken off the roof, take the height of the
 * nearest cell of the building. That's the street or pavement where the
 * mapped outline runs outside the wall, and without this the building
 * stands back from the roads and land cover that stop at its outline, on a
 * strip of its own colour. Returns the cells raised.
 */
function carryToOutline(z: Float32Array, inside: Uint8Array, core: Uint8Array, taken: Uint8Array, w: number, h: number, low: number): number {
  const n = w * h;
  const target = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let c = 0; c < n; c++) {
    if (!inside[c]) continue;
    if (z[c] < low && (!core[c] || taken[c])) target[c] = 1;
    else queue[tail++] = c;
  }
  if (!tail) return 0;
  let raised = 0;
  while (head < tail) {
    const c = queue[head++];
    const i = c % w;
    const j = (c - i) / w;
    for (let q = Math.max(0, j - 1); q <= Math.min(h - 1, j + 1); q++) {
      for (let p = Math.max(0, i - 1); p <= Math.min(w - 1, i + 1); p++) {
        const k = q * w + p;
        if (!target[k]) continue;
        target[k] = 0;
        z[k] = z[c];
        queue[tail++] = k;
        raised++;
      }
    }
  }
  return raised;
}

/** Cells outside the outline take the height of the nearest cell inside, so the clip along it cuts through the roof. */
function spread(z: Float32Array, inside: Uint8Array, w: number, h: number): void {
  const n = w * h;
  const done = Uint8Array.from(inside);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let c = 0; c < n; c++) if (inside[c]) queue[tail++] = c;
  while (head < tail) {
    const c = queue[head++];
    const i = c % w;
    const j = (c - i) / w;
    for (let q = Math.max(0, j - 1); q <= Math.min(h - 1, j + 1); q++) {
      for (let p = Math.max(0, i - 1); p <= Math.min(w - 1, i + 1); p++) {
        const k = q * w + p;
        if (done[k]) continue;
        done[k] = 1;
        z[k] = z[c];
        queue[tail++] = k;
      }
    }
  }
}

function snapToBoundary(vertices: Float64Array, shape: MultiPolygon, gap: number): void {
  for (let k = 0; k < vertices.length; k += 3) {
    const { distance, point } = nearestOnBoundary(shape, vertices[k], vertices[k + 1]);
    if (distance <= gap) {
      vertices[k] = point[0];
      vertices[k + 1] = point[1];
    }
  }
}
