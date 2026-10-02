// A LiDAR Only model from a prepared grid: one closed solid in the terrain
// colour, with ground, buildings, trees and bridges as the survey saw them,
// standing on a flat base. compose decides the heights and mesh.ts the
// triangles. The solid is a cap (a TIN top with walls down to a flat
// underside), so cutting it to the area's shape or into print sections is a
// 2D clip like everything else. A water layer is the cap cut along the water,
// with a terrain floor and a slab of water in each opening.

import { areaModelRing, effectiveScale } from '../geo/area';
import { Projection } from '../geo/projection';
import { capBoundary } from '../geometry/cap';
import { clipToBox, difference, intersection, offsetPolygons, openSharp, ringArea, ringBounds, simplifyPolygons, union } from '../geometry/polygon';
import { rowCrossings } from '../geometry/scanline';
import type { CapSolid, Layer, PrismSolid } from '../geometry/solid';
import { clipTin, type Tin } from '../geometry/tinclip';
import { isPrintableWater } from '../pipeline/classify';
import { WATER_DROP_MM } from '../pipeline/water';
import { Progress } from '../pipeline/context';
import type { EditContext, ModelSpec } from '../pipeline/generate';
import { groundAt, type GroundGrid } from '../edit/ground';
import { projectPolygons, type SourceFeature } from '../pipeline/source';
import type { AreaSpec, ModelSettings } from '../settings';
import type { ModelStats, MultiPolygon, Polygon, Ring } from '../types';
import { compose, ISLAND_MIN_MM2, MAP_EDGE_M } from './compose';
import { FAIR_REACH_MM, FAIR_WINDOW_MM, fairFaces } from './filters';
import { emptyLayers } from './layers';
import { meshSurface, straightenWalls, surfaceLimits, wallDetail, WALL_STEP_CELLS, type HeightGrid, type TileJob, type TileResult } from './mesh';
import type { PreparedSurface } from './prepare';

const CLUTTER_M = 2;
// Land narrower than twice this beside cut water is opened away: it would
// print as a wall too thin to stand between water. Pieces under
// ISLAND_MIN_MM2 go, as compose does on the grid, since the area's shape
// can cut off new ones.
const SLIVER_MM = 0.1;
// The cut outline may run this many cells off the cells it follows. Each
// stretch of it is a flat panel of bank wall, and at three quarters of a cell
// a gently curving shore came out as a row of narrow panels, ribbed like
// the walls were. Past about two, the outline cuts into the detail beside
// the bank instead of the level strip bankHeights leaves.
const OUTLINE_CELLS = 1.5;
// Thick parts grow by this before they're taken out of a shape, so float
// rounding along their edges leaves no slivers behind.
const SEAM_MM = 0.005;
// Steps a cut takes from the map's shoreline back to the survey's (followMap).
const TAPER_STEPS = 4;
// The share of the surface step meshSurface takes. Straightening the walls takes the rest.
const SURFACE_MESHED = 0.8;

export interface SurfaceModelInput {
  area: AreaSpec;
  settings: ModelSettings;
  surface: PreparedSurface;
  progress?: Progress;
  /** Simplifies mesh tiles, e.g. in the LiDAR workers. */
  runTile?: (job: TileJob) => Promise<TileResult>;
  concurrency?: number;
  /** Mapped water (lidarModel.mapWater): its shorelines for cuts and layers, and water where the survey has no returns. */
  mapWater?: SourceFeature[];
  /**
   * Takes `surface.layers` off once compose is done, so they can go while
   * meshing, which is where memory peaks. For a caller that doesn't hold
   * them anywhere else and can rebuild them from `surface.checkpoints`.
   */
  releaseLayers?: boolean;
}

/** The grid in model mm: vertex (i, j) at (x0 + i dx, y0 + j dy). */
interface CellGrid {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
}

/** Calls `visit` with the runs of cells whose centre is inside the polygon (holes left out), as [from, to) indices. */
function cellRuns(polygon: Polygon, { nx, ny, x0, y0, dx, dy }: CellGrid, visit: (from: number, to: number) => void): void {
  let low = Infinity;
  let high = -Infinity;
  for (const ring of polygon) {
    for (const p of ring) {
      low = Math.min(low, p[1]);
      high = Math.max(high, p[1]);
    }
  }
  const j0 = Math.max(0, Math.floor((low - y0) / dy));
  const j1 = Math.min(ny, Math.ceil((high - y0) / dy) + 1);
  if (j1 <= j0) return;
  const rows = rowCrossings(polygon, y0, dy, j0, j1 - j0);
  for (let r = 0; r < rows.length; r++) {
    const xs = rows[r];
    const row = (j0 + r) * nx;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / dx));
      const i1 = Math.min(nx, Math.ceil((xs[k + 1] - x0) / dx));
      if (i1 > i0) visit(row + i0, row + i1);
    }
  }
}

/** Grid cells whose centre is inside any of the polygons, one byte each. */
function cellsIn(polygons: Polygon[], grid: CellGrid): Uint8Array {
  const out = new Uint8Array(grid.nx * grid.ny);
  for (const polygon of polygons) cellRuns(polygon, grid, (from, to) => out.fill(1, from, to));
  return out;
}

// Water whose shore moves with the tide or the lake's level (followShore in compose.ts).
const COAST = new Set(['ocean', 'sea', 'bay', 'lagoon', 'strait', 'lake']);
const coastal = (feature: SourceFeature) => COAST.has(String(feature.props.subtype ?? '')) || COAST.has(String(feature.props.class ?? ''));

/** Mapped water over the grid, in model mm. Pools and fountains aren't open water (as for map models). */
function mappedWater(features: SourceFeature[], area: AreaSpec, mmPerMetre: number, grid: CellGrid): MultiPolygon {
  const projection = new Projection(area.center, area.rotationDeg, mmPerMetre);
  const polygons: Polygon[] = [];
  for (const feature of features) if (isPrintableWater(feature)) polygons.push(...projectPolygons(feature.geometry, projection));
  const { nx, ny, x0, y0, dx, dy } = grid;
  return clipToBox(polygons, [x0, y0, x0 + (nx - 1) * dx, y0 + (ny - 1) * dy], 2 * Math.max(dx, dy));
}

/**
 * Water cut along the map's smooth outline where it runs within `width` of
 * the survey's shore, which is most of a river's banks (maps sit a metre or
 * two off the scanned edge). Where the two part by more, the survey decides:
 * a bridge, a pier or a moored boat inside the map's water stays, and so
 * does water the map doesn't have. Only the shoreline moves: the map's
 * islands and ponds under twice `width` across (mapped pilings, mostly) are
 * left to the survey too.
 *
 * Between `width` and twice that apart, the line runs from one to the other
 * in TAPER_STEPS steps. Switching at `width` left a jog of that size in
 * the map's clean line wherever the two parted.
 */
export function followMap(survey: MultiPolygon, water: MultiPolygon, width: number): MultiPolygon {
  if (!survey.length || !water.length) return survey;
  const small = (2 * width) ** 2;
  const map: MultiPolygon = [];
  for (const polygon of water) {
    if (Math.abs(ringArea(polygon[0])) >= small) map.push(polygon.filter((ring, k) => !k || Math.abs(ringArea(ring)) >= small));
  }
  // The parts of mp narrower than w.
  const thin = (mp: MultiPolygon, w: number) => difference(mp, offsetPolygons(offsetPolygons(mp, -w / 2, 'miter'), w / 2 + SEAM_MM, 'miter'));
  const outside = difference(map, survey);
  const inside = difference(survey, map);
  const add: MultiPolygon[] = [];
  const drop: MultiPolygon[] = [];
  for (let step = 1; step <= TAPER_STEPS; step++) {
    // Up to `reach` from the survey's line where the two are at most `apart`
    // apart: all of a gap under `width`, none of one over twice that.
    const reach = (width * step) / TAPER_STEPS;
    const apart = width + Math.sqrt(width * (width - reach));
    add.push(intersection(thin(outside, apart), offsetPolygons(survey, reach, 'miter')));
    drop.push(difference(thin(inside, apart), offsetPolygons(survey, -reach, 'miter')));
  }
  // The offsets leave edges a Clipper unit long where the pieces meet, and
  // a print section cut beside one left prisms the mesher couldn't close.
  return simplifyPolygons(difference(union(survey, ...add), union(...drop)), SEAM_MM);
}

/**
 * A terrain floor and a slab of water in each piece of the region cut for
 * water, at the lowest water surface the piece holds, so where two bodies
 * meet the water never stands over a bank.
 */
function waterLayer(wet: MultiPolygon, waterTop: Float32Array, thickness: number, grid: CellGrid): { floors: PrismSolid[]; water: PrismSolid[] } {
  const floors: PrismSolid[] = [];
  const water: PrismSolid[] = [];
  const lowest = (from: number, to: number, level: number) => {
    for (let i = from; i < to; i++) if (waterTop[i] < level) level = waterTop[i];
    return level;
  };
  for (const polygon of wet) {
    let top = Infinity;
    cellRuns(polygon, grid, (from, to) => (top = lowest(from, to, top)));
    // A sliver narrower than a cell holds no cell centre: take the water beside it.
    if (top === Infinity) top = nearbyLevel(polygon, waterTop, grid);
    if (top === Infinity) continue;
    const floor = top - thickness;
    if (floor > 0) floors.push({ kind: 'prism', role: 'terrain', polygon, top: floor, bottom: 0, drape: 0 });
    water.push({ kind: 'prism', role: 'water', polygon, top, bottom: Math.max(floor, 0), drape: 0 });
  }
  return { floors, water };
}

function nearbyLevel(polygon: Polygon, waterTop: Float32Array, { nx, ny, x0, y0, dx, dy }: CellGrid): number {
  const [west, south, east, north] = ringBounds(polygon[0]);
  const i0 = Math.max(0, Math.floor((west - x0) / dx) - 2);
  const i1 = Math.min(nx - 1, Math.ceil((east - x0) / dx) + 2);
  const j0 = Math.max(0, Math.floor((south - y0) / dy) - 2);
  const j1 = Math.min(ny - 1, Math.ceil((north - y0) / dy) + 2);
  let level = Infinity;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (waterTop[j * nx + i] < level) level = waterTop[j * nx + i];
  return level;
}

/**
 * Cells of a mask as squares around their grid points, merged, with the
 * one-cell stairs of a diagonal shore taken out.
 */
export function maskOutline(mask: Uint8Array, nx: number, ny: number, x0: number, y0: number, dx: number, dy: number): MultiPolygon {
  const pieces: Polygon[] = [];
  const box = (i0: number, i1: number, j0: number, j1: number) => {
    const [xa, xb] = [x0 + (i0 - 0.5) * dx, x0 + (i1 - 0.5) * dx];
    const [ya, yb] = [y0 + (j0 - 0.5) * dy, y0 + (j1 - 0.5) * dy];
    pieces.push([[[xa, ya], [xb, ya], [xb, yb], [xa, yb]]]);
  };
  // Runs along each row, grown upwards while the next row repeats them.
  let open = new Map<number, number>();
  for (let j = 0; j <= ny; j++) {
    const next = new Map<number, number>();
    for (let i = 0; j < ny && i < nx; ) {
      if (!mask[j * nx + i]) {
        i++;
        continue;
      }
      const i0 = i;
      while (i < nx && mask[j * nx + i]) i++;
      const key = i0 * (nx + 1) + i;
      next.set(key, open.get(key) ?? j);
      open.delete(key);
    }
    for (const [key, j0] of open) box(Math.floor(key / (nx + 1)), key % (nx + 1), j0, j);
    open = next;
  }
  return simplifyPolygons(union(pieces), OUTLINE_CELLS * Math.min(dx, dy));
}

/**
 * The area's shape less the cut water, with land too thin to print opened
 * away and pieces under `minIsland` mm² left out. The opening keeps corners
 * (rounded, every bank corner lost 0.1 mm), and land well clear of the water
 * keeps the shape's own. It isn't kept inside `land`, since that keeps every
 * point where the water's outline touched itself, and a pinched region made
 * the cut fall back to pulling the land in by a micron all round.
 */
function landRegion(crop: Ring, water: MultiPolygon, minIsland: number): MultiPolygon {
  const shape: MultiPolygon = [[crop]];
  const land = difference(shape, water);
  const opened = openSharp(land, SLIVER_MM, false);
  const clear = difference(shape, offsetPolygons(water, 2 * SLIVER_MM, 'round'));
  // Holes are cut water and all stay.
  return union(opened, clear).filter((polygon) => Math.abs(ringArea(polygon[0])) >= minIsland);
}

/** What meshing needs from compose. */
interface Composed {
  heights: Float32Array;
  cut: Uint8Array;
  waterTop: Float32Array | null;
  /** The mesher's detail, raised beside walls (wallDetail). */
  detail: Float32Array;
  groundMaxMm: number;
  counts: Record<string, number>;
}

/**
 * compose and the passes over its heights before meshing. Kept out of
 * surfaceModel, which as an async function holds its locals over every
 * await: the masks, compose's water and its own detail would stay for as
 * long as meshing takes.
 */
function composeHeights(input: SurfaceModelInput, mmPerMetre: number, crop: Ring, rectangle: boolean, cells: CellGrid, mapOutline: MultiPolygon | null, stats: ModelStats): Composed {
  const { area, settings } = input;
  const { layers, grid } = input.surface;
  const { nx, ny } = cells;
  const inside = rectangle ? undefined : cellsIn([[crop]], cells);
  const mapped = mapOutline ? cellsIn(mapOutline, cells) : undefined;
  const coast = input.mapWater?.some(coastal) ? cellsIn(mappedWater(input.mapWater.filter(coastal), area, mmPerMetre, cells), cells) : undefined;
  const lidar = settings.lidarModel;
  const result = compose(
    layers,
    grid.dx,
    grid.dy,
    mmPerMetre,
    mmPerMetre,
    {
      trees: lidar.trees,
      removeClutter: !lidar.keepClutter,
      clutterHeightM: CLUTTER_M,
      waterDepthMm: lidar.waterDepthMm,
      heightScale: lidar.heightScale,
      terrainExaggeration: settings.terrain.exaggeration,
      baseMm: settings.terrain.baseThicknessMm,
      water: lidar.waterMode,
      waterLayerMm: settings.water.thicknessMm,
      layerDepthMm: WATER_DROP_MM,
      cutMinAreaM2: settings.water.cutMinAreaM2,
    },
    inside,
    mapped,
    coast,
  );
  for (const [key, value] of Object.entries(result.counts)) stats[`lidar_model_${key}`] = value;
  const cell = Math.min(cells.dx, cells.dy);
  const n = nx * ny;
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) keep[i] = result.water[i] | result.cut[i] | (result.detail[i] < 1 ? 1 : 0);
  stats.lidar_model_faired_cells = fairFaces(result.heights, nx, ny, cell, FAIR_WINDOW_MM, FAIR_REACH_MM, keep);
  const detail = wallDetail(result.heights, result.detail, nx, ny, WALL_STEP_CELLS * cell);
  return { heights: result.heights, cut: result.cut, waterTop: result.waterTop, detail, groundMaxMm: result.groundMaxMm, counts: result.counts };
}

/** The surface cut to a region, pulled a micron apart where two outlines only meet at a point. */
function cutSurface(tin: Tin, region: MultiPolygon): Tin {
  let clipped = clipTin(tin, region);
  if (clipped && !capBoundary(clipped)) clipped = clipTin(tin, offsetPolygons(region, -1e-3, 'miter'));
  if (!clipped?.triangles.length || !capBoundary(clipped)) throw new Error('The LiDAR surface could not be cut to the area shape. Try the rectangle shape.');
  return clipped;
}

export async function surfaceModel(input: SurfaceModelInput): Promise<ModelSpec> {
  const { area, settings, surface } = input;
  const progress = input.progress ?? new Progress();
  const mmPerMetre = effectiveScale(area, settings.scale);
  const crop = areaModelRing(area, mmPerMetre);
  const { grid } = surface;
  const { nx, ny } = surface.layers;
  // The same expressions areaModelRing uses, so a rectangle's surface ends exactly on its outline.
  const x1 = (area.widthM * mmPerMetre) / 2;
  const y1 = (area.heightM * mmPerMetre) / 2;
  const x0 = -x1;
  const y0 = -y1;
  const dx = (x1 - x0) / (nx - 1);
  const dy = (y1 - y0) / (ny - 1);
  const rectangle = area.shape === 'rectangle' || (area.shape === 'rounded' && area.cornerRadius <= 0);
  const stats: ModelStats = {};
  const warnings: string[] = [];
  const cells: CellGrid = { nx, ny, x0, y0, dx, dy };

  progress.begin('compose', 'Finding ground, water and trees');
  await progress.checkpoint();
  const mapOutline = input.mapWater?.length ? mappedWater(input.mapWater, area, mmPerMetre, cells) : null;
  const result = composeHeights(input, mmPerMetre, crop, rectangle, cells, mapOutline, stats);
  if (input.releaseLayers) surface.layers = emptyLayers(0, 0);
  const cell = Math.min(dx, dy);

  progress.begin('surface', 'Meshing the LiDAR surface');
  const field: HeightGrid = { heights: result.heights, detail: result.detail, nx, ny, x0, y0, x1, y1, dx, dy };
  const limits = surfaceLimits(cell);
  let tin: Tin = await meshSurface(field, limits, { runTile: input.runTile, concurrency: input.concurrency, progress: (fraction) => progress.checkpoint(SURFACE_MESHED * fraction) });
  // Twice, since the first pass joins up roof edges the second can straighten further.
  for (let pass = 0; pass < 2; pass++) {
    await progress.checkpoint(SURFACE_MESHED + ((1 - SURFACE_MESHED) * pass) / 2);
    tin = straightenWalls(tin, field, limits, cell);
  }
  stats.lidar_model_surface_triangles = tin.triangles.length / 3;
  let floors: PrismSolid[] = [];
  let water: PrismSolid[] = [];
  // Where a shape added in the editor goes down to a floor, or through a cut to the base.
  let surfaceWater: { polygons: MultiPolygon; floor: number | null }[] = [];
  if (result.counts.cut_water_cells || !rectangle) progress.begin('cut', 'Cutting the surface to shape');
  if (result.counts.cut_water_cells) {
    let cut = maskOutline(result.cut, nx, ny, x0, y0, dx, dy);
    if (mapOutline) cut = followMap(cut, mapOutline, MAP_EDGE_M * mmPerMetre);
    // A layer keeps every island the opening leaves, since nothing falls out.
    const region = landRegion(crop, cut, result.waterTop ? 0 : ISLAND_MIN_MM2);
    if (!region.length) throw new Error('Nothing but water is left in this area. Move it onto land, or recess the water.');
    tin = cutSurface(tin, region);
    const wet = difference([[crop]], region);
    if (result.waterTop) {
      ({ floors, water } = waterLayer(wet, result.waterTop, settings.water.thicknessMm, cells));
      surfaceWater = water.map((w) => ({ polygons: [w.polygon], floor: typeof w.bottom === 'number' && w.bottom > 0 ? w.bottom : null }));
    } else if (wet.length) {
      surfaceWater = [{ polygons: wet, floor: null }];
    }
  } else if (!rectangle) {
    tin = cutSurface(tin, [[crop]]);
  }
  const solid: CapSolid = { kind: 'cap', role: 'terrain', vertices: tin.vertices, triangles: tin.triangles, bottom: 0 };
  const layersOut: Layer[] = [{ id: 'city', name: 'City', role: 'terrain', solids: [solid, ...floors] }];
  if (water.length) layersOut.push({ id: 'water', name: 'Water', role: 'water', solids: water });

  let outline: Polygon = [crop];
  if (settings.rim.enabled && settings.rim.widthMm > 0) {
    const outer = offsetPolygons([[crop]], settings.rim.widthMm, 'miter');
    const ring = difference(outer, [[crop]]);
    // Above the ground, not the tallest tower.
    const top = result.groundMaxMm + settings.rim.heightMm;
    layersOut.push({ id: 'rim', name: 'Border Rim', role: 'rim', solids: ring.map((polygon) => ({ kind: 'prism', role: 'rim', polygon, top, bottom: 0, drape: 0 })) });
    if (outer.length === 1) outline = [outer[0][0]];
  }

  stats.lidar_model_cell_m = Math.round(grid.cell * 100) / 100;
  stats.lidar_model_grid = `${nx} x ${ny}`;
  stats.lidar_model_coverage = Math.round(surface.coverage * 1000) / 1000;
  if (surface.coverage < 0.5) warnings.push('Much of the area has no LiDAR returns. It may be water, or outside the survey.');
  if (grid.cell > surface.requestedCellM + 1e-9) {
    warnings.push(
      `The survey is too sparse for ${surface.requestedCellM.toFixed(2)} m cells, so the model uses ${grid.cell.toFixed(2)} m cells. Smaller cells won't add points the survey doesn't have.`,
    );
  }
  // Failed reads are added by the caller (lidarFailure in the worker), which words searches apart.
  // Nothing in the surface can be picked out, but shapes can stand on it.
  const surfaceGrid: GroundGrid = { minX: x0, minY: y0, step: dx, stepY: dy, cols: nx, rows: ny, values: result.heights };
  const edit: EditContext = {
    heightAt: (x, y) => groundAt(surfaceGrid, x, y),
    grid: surfaceGrid,
    surfaceWater,
    roads: [],
    bodies: [],
    noGround: [],
    kept: { roads: [], buildings: [], piers: [], decks: [], airport: [] },
    decks: [],
    objects: new Map(),
  };
  return { layers: layersOut, outline, crop: [crop], baseZ: 0, mmPerMetre, stats, warnings, edit };
}
