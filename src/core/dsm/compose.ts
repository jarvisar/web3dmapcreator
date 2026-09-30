// Printable heights for a LiDAR Only model, from the per-cell layers in
// layers.ts. A port of compose and its helpers from the add-on's
// geometry/dsm_model.py, with the same rules, constants and order, since
// they were tuned on real surveys. Its docs/LIDAR_MODEL.md explains most of
// them.
//
// Grids are float32 here where the add-on works in float64. That moves
// heights by around 1e-5 m and can flip a threshold on a few cells.

import type { LidarWaterMode, TreeStyle } from '../settings';
import type { SurfaceLayers } from './layers';
import {
  BoxSums,
  boxMean,
  compactLabels,
  countSet,
  despike,
  dilate,
  erode,
  evenOut,
  fillSmooth,
  fillVoids,
  label,
  straighten,
  windowMax,
  windowMin,
} from './filters';

// A hole in the returns or a patch of water returns this large can be water.
// Smaller ones (a skylight, a shadow beside a tower) take their neighbours.
const WATER_MIN_M2 = 150;
const BANK_BAND_M = 3;
// In a survey that files no water returns at all, a hole has to be this large
// with this share of its shore within the bank band of the ground. Scan
// shadows at the foot of towers are a few hundred square metres.
const HOLE_WATER_M2 = 1000;
const BANK_SHARE = 0.7;
// A body grows into cells beside it with any water returns whose top is
// this close to its level, and takes in specks of land under SPECK_M2 that
// stand within SPECK_M of it (see findWater).
const GROW_M = 0.3;
const SPECK_M2 = 10;
const SPECK_M = 1;
// A body whose edge is mostly (UNFILED_SHARE) cells with no water, ground,
// building or vegetation returns, at most SURFACE_M over its level and with
// no more than twice the returns of the water cells within SURFACE_REACH,
// grows over those too: open water nobody classified. New York's survey
// files a third of the harbour's returns as water and leaves the rest
// unclassified, a flight line reading 0.2 m higher, so the harbour came out
// as a web of land at the water's level. Boats and piers stand higher and
// docks return more, and a river filed properly never qualifies.
const SURFACE_M = 0.5;
const SURFACE_REACH = 3;
const UNFILED_SHARE = 0.5;
// And into ground within LEVEL_M of its level where everything within
// FLAT_REACH_M is that flat: water filed as ground. Cook County's 2017
// survey files a tile of Lake Michigan as ground at the lake's level. A
// beach or a bank rises more than that within a few metres.
const LEVEL_M = 0.2;
const FLAT_REACH_M = 8;
// Without clutter, land standing alone in water smaller than this, no longer
// than BOAT_M, with half of it no higher than BOAT_HIGH_M over the water (a
// mast doesn't count), ground returns in under half of it and mostly not
// filed as building, is a boat, a buoy or a piling and goes with the water.
// A detached breakwater is longer, and a bridge house or a scrap of building
// cut off by the river stays as it was.
const BOAT_M2 = 1000;
const BOAT_M = 80;
const BOAT_HIGH_M = 6;
// A large hole that isn't water, with this share of its shore on the ground,
// is street in a tower's scan shadow. With less, it's a dark roof.
const SHADOW_SHARE = 0.5;
// A hole whose neighbours differ by more than this sits at a wall and takes
// the lowest neighbour. Anywhere else it takes the median.
export const STEP_M = 2;
// Trees rarely stand taller than this in a city. Vegetation-filed returns
// higher up are facades and roofs (Cook County files many that way).
const TREE_MAX_M = 35;
const TREE_MIN_M = 2;
// Share of vegetation-like returns over 5 x 5 cells that makes a canopy, and
// the mean roughness it needs. A rail deck or a steel roof returns twice like
// a crown but is flat.
const TREE_SHARE = 0.3;
const TREE_ROUGH_M = 0.5;
// Share of a canopy's cells whose highest other return lies well below its
// top, or in a survey without vegetation and building classes, the share
// with ground returns under the top.
const TREE_HOLLOW = 0.25;
const TREE_THROUGH = 0.15;
// A survey counts as classified when this share of its tall cells has
// building returns.
const CLASSIFIED_SHARE = 0.01;
// A cell is flat within this of its 3 x 3 mean, and a neighbourhood this
// share flat is a roof or a deck, not a crown.
const FLAT_STEP_M = 0.15;
const FLAT_SHARE = 0.6;
// Gaps closed inside a crown, in cells, then box means that round it: about
// 4 m of smoothing at 0.5-0.7 m cells.
const CROWN_CLOSE = 2;
const CROWN_RADII = [3, 2];
// The mesher may move a crown's surface this share of what it allows a roof,
// so a crown keeps enough facets to read round rather than crystalline.
export const TREE_DETAIL = 0.4;
// Neighbours closer than this in height are the same surface and get averaged.
const EVEN_M = 0.5;
const SPIKE_M = 1;
// Gaps under three cells wide and deeper than PIT_M are filled. A standing
// feature under three cells wide and SLIVER_M tall goes when it's
// SLIVER_LONG_M long (a crane jib, a wire) or stands within SLIVER_BASE_M of
// the ground (a pole, a mast). A short one on a roof is a spire and stays.
const PIT_M = 0.5;
const SLIVER_M = 2;
const SLIVER_LONG_M = 8;
const SLIVER_BASE_M = 6;
// Cut water has to be this wide printed. A narrower opening doesn't print as
// one, so that water stays recessed.
const CUT_MIN_WIDTH_MM = 0.4;
// Bridges split a river into bodies. Bodies closer than this count toward one
// area, or a short stretch between two bridges stays recessed while the rest
// of the river is cut.
const BRIDGE_GAP_M = 40;
// Land the cut leaves standing on its own and smaller than this printed is a
// boat, a buoy or a piling, and goes with the water.
export const ISLAND_MIN_MM2 = 4;
// Water this far above the ground is on a roof or a podium (a pool, a garden
// pond). It stays recessed, since a cut would go down through the building.
const RAISED_WATER_M = 3;
// Not in the add-on: with mapped water, a hole this share inside it is water
// even where the survey files water elsewhere (see findWater).
const MAPPED_SHARE = 0.5;
// Not in the add-on: along a sea or lake shore (`shore`), the survey's
// waterline is the tide or lake level of the survey day, often tens of
// metres off the map's coastline. Bare ground within BEACH_M of the water's
// level inside the mapped sea or lake turns to water, and water outside any
// mapped water with such ground behind it turns to land at the water's
// level, as long as the whole strip is within SHORE_M of the other line
// (see followShore).
const BEACH_M = 1.5;
const SHORE_M = 60;
// Standing no more than this over its own ground returns, a cell is bare.
const BARE_M = 0.3;
// Share of the land behind a strip of water that has to be beach.
const BEACH_SHARE = 0.8;
/**
 * Where mapped water's outline runs within this of the survey's shore, cuts
 * follow the map's smooth line (model.ts), so the bank's height reaches this
 * much further into cut water.
 */
export const MAP_EDGE_M = 3;

export interface ComposeSettings {
  /** Crowns as scanned (lightly smoothed), smoothed domes, or taken down to what stands under them. */
  trees: TreeStyle;
  /**
   * Flatten anything lower than `clutterHeightM` above the ground (cars,
   * fences, benches). Poles, crane jibs and wires go either way.
   */
  removeClutter: boolean;
  clutterHeightM: number;
  waterDepthMm: number;
  heightScale: number;
  terrainExaggeration: number;
  baseMm: number;
  /**
   * Water recessed in the surface, cut out of it for a layer of its own, or
   * cut away through the base. A layer takes the water cutWater picks at any
   * size and leaves islands, a cut only bodies of at least `cutMinAreaM2`.
   */
  water: LidarWaterMode;
  /** Thickness of the water layer. The base goes under the floor beneath it. */
  waterLayerMm: number;
  /** How far a water layer's surface sits below its lowest bank. Water left recessed takes `waterDepthMm`. */
  layerDepthMm: number;
  /** Smallest body cut away, in m². Shared with map models. */
  cutMinAreaM2: number;
}

// The add-on's settings. The app's own defaults are in settings.ts.
export const DEFAULT_COMPOSE: ComposeSettings = {
  trees: 'rounded',
  removeClutter: true,
  clutterHeightM: 2,
  waterDepthMm: 0.6,
  heightScale: 1,
  terrainExaggeration: 1,
  baseMm: 1.3,
  water: 'recess',
  waterLayerMm: 1,
  layerDepthMm: 0.25,
  cutMinAreaM2: 5000,
};

export interface ComposeResult {
  /** Model mm at every grid vertex, row 0 south, bottom of the base at 0. */
  heights: Float32Array;
  water: Uint8Array;
  /**
   * Water cut out of the surface (cutWater), for the layer or through the
   * base. Cells near the shore hold the height of their bank.
   */
  cut: Uint8Array;
  /** With a water layer, the water surface over cut cells that are water, NaN elsewhere. */
  waterTop: Float32Array | null;
  /** Per-vertex factor on the mesher's allowed deviation: 1, or TREE_DETAIL on canopy and its skirt. */
  detail: Float32Array;
  /** Highest ground (not buildings or trees) in model mm, same datum as heights. */
  groundMaxMm: number;
  counts: Record<string, number>;
}

/**
 * Heights for every cell of `layers`. `dx` and `dy` are the cell size in
 * metres, and `scaleXY` and `scaleZ` model mm per metre. The horizontal
 * scale only sizes cut water, like in the add-on. With `inside` (1 per cell
 * in the area's shape), only those cells decide where the base is and the
 * highest ground. `mapped` (1 per cell in mapped water) adds water the
 * survey missed (see findWater), and `shore` (the mapped sea and lakes)
 * moves the waterline on beaches to the map's (see followShore).
 */
export function compose(
  layers: SurfaceLayers,
  dx: number,
  dy: number,
  scaleXY: number,
  scaleZ: number,
  settings: Partial<ComposeSettings> = {},
  inside?: Uint8Array,
  mapped?: Uint8Array,
  shore?: Uint8Array,
): ComposeResult {
  const s = { ...DEFAULT_COMPOSE, ...settings };
  const { nx, ny } = layers;
  const n = nx * ny;
  let returns = false;
  for (let i = 0; i < n && !returns; i++) returns = layers.count[i] > 0;
  if (!returns) throw new Error('The prepared LiDAR model has no returns');

  const counts: Record<string, number> = {};
  const ground = groundGrid(layers, dx, counts);
  const { surface, water } = fillSurface(layers, ground, dx, dy, counts, mapped);
  if (shore?.includes(1)) Object.assign(counts, followShore(layers, surface, ground, water, shore, mapped ?? shore, dx, dy));
  if (s.removeClutter) counts.boat_cells = clearBoats(layers, surface, water, dx, dy);
  const canopy = treeMask(layers, surface, ground);
  for (let i = 0; i < n; i++) if (water[i]) canopy[i] = 0;
  counts.tree_cells = countSet(canopy);

  if (s.removeClutter) {
    let clutter = 0;
    for (let i = 0; i < n; i++) {
      if (water[i] || canopy[i]) continue;
      const above = surface[i] - ground[i];
      if (!(above < s.clutterHeightM)) continue;
      if (above > 0.2) clutter++;
      surface[i] = ground[i];
    }
    counts.clutter_cells = clutter;
  }

  let skirt: Uint8Array;
  if (s.trees === 'rounded') {
    skirt = domes(surface, ground, canopy, water, s.clutterHeightM, nx, ny);
  } else if (s.trees === 'natural') {
    skirt = new Uint8Array(n);
    naturalCrowns(surface, ground, canopy, nx, ny);
  } else {
    // Taken down to what stands under them, these are ordinary cells again.
    // The add-on kept them out of the cleanup below and meshed them as finely
    // as crowns, which left the cars and benches under trees.
    skirt = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!canopy[i]) continue;
      const under = layers.solid[i];
      surface[i] = under === under ? Math.max(under, ground[i]) : ground[i];
      if (s.removeClutter && surface[i] - ground[i] < s.clutterHeightM) surface[i] = ground[i];
      canopy[i] = 0;
    }
  }

  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) keep[i] = water[i] | canopy[i] | skirt[i];
  const narrowed = narrow(surface, nx, ny, ground, keep, true, dx, surface);
  counts.pit_cells = narrowed.pits;
  counts.sliver_cells = narrowed.slivers;
  evenOut(surface, nx, ny, keep, EVEN_M, surface);
  counts.spikes_removed = despike(surface, nx, ny, SPIKE_M, water, surface).count;

  let cut: Uint8Array = new Uint8Array(n);
  const layer = s.water === 'layer';
  if (s.water !== 'recess') {
    // A layer takes water of any size and leaves islands, boats and pilings
    // standing in it: nothing falls out, so only a cut needs them gone.
    const chosen = layer ? cutWater(water, surface, ground, nx, ny, dx, dy, scaleXY, 0, 0) : cutWater(water, surface, ground, nx, ny, dx, dy, scaleXY, s.cutMinAreaM2);
    cut = chosen.cut;
    counts.cut_water_bodies = chosen.bodies;
    counts.cut_islands = chosen.islands;
  }
  counts.cut_water_cells = countSet(cut);

  // Water cells hold their level. The add-on measures from the lowest ground
  // or water level first, which only matters for rounding.
  let base = Infinity;
  for (let i = 0; i < n; i++) base = Math.min(base, water[i] ? surface[i] : ground[i]);
  const within = inside && inside.includes(1) ? inside : null;
  const h = { base, te: s.terrainExaggeration, hs: s.heightScale, scaleZ, depth: s.waterDepthMm };
  // A layer has its own colour, so it only needs to sit a little below the
  // bank, like map models' water. Recessed water has to read by its depth.
  const hl = { ...h, depth: s.layerDepthMm };
  const scaled = (i: number) => (layer && cut[i] && water[i] ? hl : h);
  // Cut water leaves the surface, so the base goes under what's left, and
  // under the floor beneath a water layer.
  let lowest = Infinity;
  for (let i = 0; i < n; i++) {
    if (within && !within[i]) continue;
    if (!cut[i]) lowest = Math.min(lowest, heightMm(surface[i], ground[i], water[i], h));
    else if (layer && water[i]) lowest = Math.min(lowest, heightMm(surface[i], ground[i], 1, hl) - s.waterLayerMm);
  }
  const shift = s.baseMm - lowest;
  let groundMax = -Infinity;
  const detail = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if ((!within || within[i]) && !cut[i]) groundMax = Math.max(groundMax, heightMm(ground[i], ground[i], 0, h));
    surface[i] = heightMm(surface[i], ground[i], water[i], scaled(i)) + shift;
    detail[i] = canopy[i] | skirt[i] ? TREE_DETAIL : 1;
  }
  let waterTop: Float32Array | null = null;
  if (layer && counts.cut_water_cells) {
    waterTop = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (cut[i] && water[i]) waterTop[i] = surface[i];
  }
  if (counts.cut_water_cells) bankHeights(surface, cut, nx, ny, BANK_RINGS + (mapped ? Math.ceil(MAP_EDGE_M / Math.min(dx, dy)) : 0));
  return { heights: surface, water, cut, waterTop, detail, groundMaxMm: groundMax + shift, counts };
}

/**
 * Boats, buoys and pilings (see BOAT_M2). They become water at the lowest
 * level beside them. Returns the cells.
 */
function clearBoats(layers: SurfaceLayers, surface: Float32Array, water: Uint8Array, dx: number, dy: number): number {
  const { nx, ny } = layers;
  const n = nx * ny;
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = water[i] ^ 1;
  const pieces = label(land, nx, ny);
  const count = compactLabels(pieces);
  const cells = new Int32Array(count);
  const grounded = new Int32Array(count);
  const returns = new Float64Array(count);
  const filed = new Float64Array(count);
  const tops: number[][] = Array.from({ length: count }, () => []);
  const x0 = new Int32Array(count).fill(nx);
  const x1 = new Int32Array(count).fill(-1);
  const y0 = new Int32Array(count).fill(ny);
  const y1 = new Int32Array(count).fill(-1);
  const level = new Float64Array(count).fill(Infinity);
  const edge = new Uint8Array(count);
  for (let i = 0; i < n; i++) {
    const p = pieces[i];
    if (p < 0) continue;
    const x = i % nx;
    const y = (i - x) / nx;
    cells[p]++;
    if (layers.ground[i] === layers.ground[i]) grounded[p]++;
    returns[p] += layers.count[i];
    filed[p] += layers.building[i];
    if (cells[p] <= BOAT_M2 / (dx * dy) && layers.top[i] === layers.top[i]) tops[p].push(layers.top[i]);
    x0[p] = Math.min(x0[p], x);
    x1[p] = Math.max(x1[p], x);
    y0[p] = Math.min(y0[p], y);
    y1[p] = Math.max(y1[p], y);
    if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) edge[p] = 1;
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < nx ? i + 1 : -1, y > 0 ? i - nx : -1, y + 1 < ny ? i + nx : -1]) {
      if (j >= 0 && water[j]) level[p] = Math.min(level[p], surface[j]);
    }
  }
  const boat = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    const long = Math.max((x1[p] - x0[p] + 1) * dx, (y1[p] - y0[p] + 1) * dy);
    const middle = tops[p].sort((a, b) => a - b)[tops[p].length >> 1];
    const small = cells[p] * dx * dy <= BOAT_M2 && long <= BOAT_M && !(middle - level[p] > BOAT_HIGH_M);
    boat[p] = !edge[p] && small && 2 * grounded[p] < cells[p] && 2 * filed[p] < returns[p] && level[p] < Infinity ? 1 : 0;
  }
  let cleared = 0;
  for (let i = 0; i < n; i++) {
    const p = pieces[i];
    if (p < 0 || !boat[p]) continue;
    water[i] = 1;
    surface[i] = level[p];
    cleared++;
  }
  return cleared;
}

/**
 * The waterline on beaches moved to the map's coastline. Bare ground in the
 * mapped sea or lake (`shore`) within BEACH_M of the water beside it becomes
 * water at its level, and water outside all mapped water (`mapped`) becomes
 * land at the water's level where most of the land behind it is such ground.
 * Either only when the whole strip lies within SHORE_M of the other line, so
 * a pier, a boat or a dock (none of them bare ground), a quay or a river
 * running into the lake keeps the survey's shore. Returns the cells each way.
 */
function followShore(
  layers: SurfaceLayers,
  surface: Float32Array,
  ground: Float32Array,
  water: Uint8Array,
  shore: Uint8Array,
  mapped: Uint8Array,
  dx: number,
  dy: number,
): { shore_water_cells: number; shore_land_cells: number } {
  const { nx, ny } = layers;
  const n = nx * ny;
  const reach = SHORE_M / Math.min(dx, dy);
  const bare = (i: number, level: number) => {
    const g = layers.ground[i];
    return g === g && surface[i] - g < BARE_M && surface[i] < level + BEACH_M && surface[i] > level - BEACH_M;
  };
  const neighbours = (i: number, visit: (j: number) => void) => {
    const x = i % nx;
    const y = (i - x) / nx;
    for (let b = -1; b <= 1; b++) {
      for (let a = -1; a <= 1; a++) {
        if ((a || b) && x + a >= 0 && x + a < nx && y + b >= 0 && y + b < ny) visit(i + b * nx + a);
      }
    }
  };
  // Water that reaches into the mapped sea or lake is on the coast.
  const bodies = label(water, nx, ny);
  const coastal = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (water[i] && shore[i]) coastal[bodies[i]] = 1;
  const onCoast = (i: number) => water[i] === 1 && coastal[bodies[i]] === 1;

  // Beach in the map's water: out from the coast's water over bare ground,
  // each cell taking the level of the water it was reached from.
  const level = new Float32Array(n).fill(NaN);
  const steps = new Float32Array(n).fill(Infinity);
  let queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!onCoast(i)) continue;
    neighbours(i, (j) => {
      if (water[j] || !shore[j] || steps[j] <= 1 || !bare(j, surface[i])) return;
      steps[j] = 1;
      level[j] = surface[i];
      queue.push(j);
    });
  }
  for (let at = 0; at < queue.length; at++) {
    const i = queue[at];
    neighbours(i, (j) => {
      if (water[j] || !shore[j] || steps[j] <= steps[i] + 1 || !bare(j, level[i])) return;
      steps[j] = steps[i] + 1;
      level[j] = level[i];
      queue.push(j);
    });
  }
  const beach = new Uint8Array(n);
  for (const i of queue) beach[i] = 1;
  const strips = label(beach, nx, ny);
  const far = new Uint8Array(n);
  for (const i of queue) if (steps[i] > reach) far[strips[i]] = 1;
  let wet = 0;
  for (const i of queue) {
    if (!beach[i] || far[strips[i]]) continue;
    beach[i] = 0;
    water[i] = 1;
    surface[i] = level[i];
    wet++;
  }

  // Water out of the map's: strips of the coast's water outside all mapped
  // water, near enough to the sea or lake, with beach behind them.
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (onCoast(i) && !mapped[i]) out[i] = 1;
  const pieces = label(out, nx, ny);
  steps.fill(Infinity);
  queue = [];
  for (let i = 0; i < n; i++) {
    if (!out[i]) continue;
    neighbours(i, (j) => {
      if (steps[i] > 1 && water[j] && shore[j]) steps[i] = 1;
    });
    if (steps[i] === 1) queue.push(i);
  }
  for (let at = 0; at < queue.length; at++) {
    const i = queue[at];
    neighbours(i, (j) => {
      if (!out[j] || steps[j] <= steps[i] + 1) return;
      steps[j] = steps[i] + 1;
      queue.push(j);
    });
  }
  const ids = compactLabels(pieces);
  const worst = new Float32Array(ids);
  const behind = new Int32Array(ids);
  const sandy = new Int32Array(ids);
  for (let i = 0; i < n; i++) {
    if (!out[i]) continue;
    const p = pieces[i];
    worst[p] = Math.max(worst[p], steps[i]);
    neighbours(i, (j) => {
      if (water[j]) return;
      behind[p]++;
      if (bare(j, surface[i])) sandy[p]++;
    });
  }
  let dry = 0;
  for (let i = 0; i < n; i++) {
    if (!out[i]) continue;
    const p = pieces[i];
    if (!(worst[p] <= reach && behind[p] > 0 && sandy[p] >= BEACH_SHARE * behind[p])) continue;
    water[i] = 0;
    ground[i] = surface[i];
    dry++;
  }
  return { shore_water_cells: wet, shore_land_cells: dry };
}

/**
 * The water that goes right through the base, as the add-on's cut_water
 * picks it: bodies of at least `minArea` m², counting water within
 * BRIDGE_GAP_M as one body and leaving out raised water, opened so the cut is
 * CUT_MIN_WIDTH_MM wide everywhere, plus whatever land that leaves on its own
 * below `islandMm2` (ISLAND_MIN_MM2 for a cut). The opening doesn't eat in
 * from the grid's edge, so a river leaving the area is cut all the way to the
 * edge. Water cells hold their level in `surface`.
 */
export function cutWater(
  water: Uint8Array,
  surface: Float32Array,
  ground: Float32Array,
  nx: number,
  ny: number,
  dx: number,
  dy: number,
  scaleXY: number,
  minArea: number,
  islandMm2 = ISLAND_MIN_MM2,
): { cut: Uint8Array; bodies: number; islands: number } {
  const n = nx * ny;
  const none = { cut: new Uint8Array(n), bodies: 0, islands: 0 };
  const low = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (water[i] && !(surface[i] - ground[i] > RAISED_WATER_M)) low[i] = 1;
  if (!low.includes(1)) return none;
  const reach = Math.max(1, roundHalfEven(BRIDGE_GAP_M / 2 / Math.min(dx, dy)));
  const groups = label(dilate(low, nx, ny, reach), nx, ny);
  const sizes = new Float64Array(compactLabels(groups));
  for (let i = 0; i < n; i++) if (low[i]) sizes[groups[i]]++;
  let cut: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (low[i] && sizes[groups[i]] * dx * dy >= minArea) cut[i] = 1;
  const radius = Math.max(1, Math.ceil(CUT_MIN_WIDTH_MM / 2 / (Math.min(dx, dy) * scaleXY)));
  // Not in the add-on: specks of land under SPECK_M2 are filled before the
  // opening too. San Francisco's 2023 survey leaves stray cells of bay as
  // land every few metres, and the opening took the water around each of
  // them, which left half the bay recessed and speckled. Boats and islets
  // still go the add-on's way, after it.
  if (smallLand(cut, nx, ny, (cells) => cells * dx * dy < SPECK_M2) < 0) return none;
  cut = dilate(erode(cut, nx, ny, radius), nx, ny, radius);
  const islands = smallLand(cut, nx, ny, (cells) => cells * dx * dy * scaleXY ** 2 < islandMm2);
  if (islands < 0) return none;
  return { cut, bodies: compactLabels(label(cut, nx, ny)), islands };
}

/**
 * Cuts the land pieces `small` picks by cell count along with the water, and
 * returns how many there were: -1 when there's no cut or every piece is that
 * small, so nothing should be cut at all.
 */
function smallLand(cut: Uint8Array, nx: number, ny: number, small: (cells: number) => boolean): number {
  const n = nx * ny;
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = cut[i] ^ 1;
  if (!cut.includes(1) || !land.includes(1)) return -1;
  const pieces = label(land, nx, ny);
  const areas = new Float64Array(compactLabels(pieces));
  for (let i = 0; i < n; i++) if (land[i]) areas[pieces[i]]++;
  const picked = Array.from(areas, small);
  if (picked.every(Boolean)) return -1;
  for (let i = 0; i < n; i++) if (land[i] && picked[pieces[i]]) cut[i] = 1;
  return picked.filter(Boolean).length;
}

// Rings of cut water that take their bank's height. The cut runs within
// about a cell and a quarter of the bank, and past that the water stays
// flat: carried across a river, a riverside tower's roof only makes work
// for the mesher.
const BANK_RINGS = 3;

/**
 * Cut water next to the shore takes the height of its bank, ring by ring,
 * so the surface is level where the cut crosses it and the shore becomes a
 * vertical wall. Recessed, the cut would run down the slope to the water
 * and leave a bevel along every bank.
 */
function bankHeights(z: Float32Array, cut: Uint8Array, nx: number, ny: number, rings: number): void {
  const n = nx * ny;
  const done = new Uint8Array(n);
  let front: number[] = [];
  for (let i = 0; i < n; i++) if (!cut[i]) done[i] = 1;
  for (let i = 0; i < n; i++) if (cut[i] && touches(done, i, nx, ny)) front.push(i);
  for (let ring = 0; ring < rings && front.length; ring++) {
    const next: number[] = [];
    const values = front.map((i) => highestNeighbour(z, done, i, nx, ny));
    front.forEach((i, k) => {
      z[i] = values[k];
      done[i] = 1;
    });
    for (const i of front) {
      const x = i % nx;
      const y = (i - x) / nx;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
          const j = yy * nx + xx;
          if (done[j]) continue;
          done[j] = 2;
          next.push(j);
        }
      }
    }
    for (const j of next) done[j] = 0;
    front = next;
  }
}

function touches(done: Uint8Array, i: number, nx: number, ny: number): boolean {
  const x = i % nx;
  const y = (i - x) / nx;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if ((dx || dy) && xx >= 0 && yy >= 0 && xx < nx && yy < ny && done[yy * nx + xx] === 1) return true;
    }
  }
  return false;
}

function highestNeighbour(z: Float32Array, done: Uint8Array, i: number, nx: number, ny: number): number {
  const x = i % nx;
  const y = (i - x) / nx;
  let high = -Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if ((dx || dy) && xx >= 0 && yy >= 0 && xx < nx && yy < ny && done[yy * nx + xx] === 1) high = Math.max(high, z[yy * nx + xx]);
    }
  }
  return high;
}

interface HeightScale {
  base: number;
  te: number;
  hs: number;
  scaleZ: number;
  depth: number;
}

// The add-on's float64 expression, in its order, before the base shift.
function heightMm(z: number, g: number, water: number, h: HeightScale): number {
  if (water) return (z - h.base) * h.te * h.scaleZ - h.depth;
  return ((g - h.base) * h.te + (z - g) * h.hs) * h.scaleZ;
}

function groundGrid(layers: SurfaceLayers, dx: number, counts: Record<string, number>): Float32Array {
  const { nx, ny } = layers;
  const n = nx * ny;
  let known = 0;
  for (let i = 0; i < n; i++) if (layers.ground[i] === layers.ground[i]) known++;
  counts.ground_cells = known;
  let ground: Float32Array;
  if (known / n < 0.01) {
    // No classified ground: the lowest surface over a window wider than most
    // buildings, which an opening (min then max) leaves standing.
    const radius = Math.max(1, roundHalfEven(15 / dx));
    ground = fillSmooth(layers.top, nx, ny);
    windowMin(ground, nx, ny, radius, ground);
    windowMax(ground, nx, ny, radius, ground);
    counts.ground_estimated = 1;
  } else {
    ground = fillSmooth(layers.ground, nx, ny);
  }
  return boxMean(ground, nx, ny, 1, ground);
}

// Python's round(), which takes halves to the even side.
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  if (x - floor !== 0.5) return Math.round(x);
  return floor % 2 === 0 ? floor : floor + 1;
}

// Water first, then every other hole filled, then walls straightened.
function fillSurface(
  layers: SurfaceLayers,
  ground: Float32Array,
  dx: number,
  dy: number,
  counts: Record<string, number>,
  mapped?: Uint8Array,
): { surface: Float32Array; water: Uint8Array } {
  const { nx, ny, top } = layers;
  const n = nx * ny;
  const { water, shadow, level, bodies, grown, fromMap } = findWater(layers, ground, dx, dy, mapped?.includes(1) ? mapped : undefined);
  counts.water_bodies = bodies;
  counts.water_cells = countSet(water);
  counts.water_grown_cells = grown;
  if (mapped) counts.water_map_cells = fromMap;
  counts.shadow_cells = countSet(shadow);
  const surface = new Float32Array(n);
  const land = new Uint8Array(n);
  let holes = 0;
  for (let i = 0; i < n; i++) {
    if (water[i]) {
      surface[i] = NaN;
      continue;
    }
    land[i] = 1;
    const z = shadow[i] ? ground[i] : top[i];
    surface[i] = z;
    if (z !== z) holes++;
  }
  counts.filled_cells = holes;
  fillVoids(surface, nx, ny, land, 12, STEP_M, surface);
  for (let i = 0, k = 0; i < n; i++) {
    if (water[i]) surface[i] = level[k++];
    else if (surface[i] !== surface[i]) surface[i] = ground[i];
  }
  straighten(surface, nx, ny, water, surface);
  return { surface, water };
}

interface Water {
  water: Uint8Array;
  /** Large holes on the ground that aren't water: scan shadows at the foot of towers. */
  shadow: Uint8Array;
  /** Level of each water cell, in cell order. */
  level: Float32Array;
  bodies: number;
  /** Cells the bodies grew into. */
  grown: number;
  /** Cells that are water because of mapped water. */
  fromMap: number;
}

// Flat water with one level per body. A survey that files water says where
// it is. In one that doesn't, a hole can also be a dark roof or the scan
// shadow at the foot of a tower (Philadelphia's came out as pits in its
// streets), so it has to be large with its shore mostly on the ground.
// Mapped water only ever fills cells the survey has no returns in, so it
// can't take a bridge, a pier or a boat (mappedHoles, and the growth below).
function findWater(layers: SurfaceLayers, ground: Float32Array, dx: number, dy: number, mapped?: Uint8Array): Water {
  const { nx, ny, count, top, waterZ } = layers;
  const n = nx * ny;
  const water = new Uint8Array(n);
  const shadow = new Uint8Array(n);
  const none: Water = { water, shadow, level: new Float32Array(0), bodies: 0, grown: 0, fromMap: 0 };

  // No returns at all, or mostly water returns.
  const candidate = new Uint8Array(n);
  let anyCandidate = false;
  let filesWater = false;
  for (let i = 0; i < n; i++) {
    const wet = layers.water[i];
    if (wet > 0) filesWater = true;
    if (count[i] === 0 || (wet > 0 && wet * 2 >= count[i])) {
      candidate[i] = 1;
      anyCandidate = true;
    }
  }
  if (!anyCandidate) return none;
  const region = label(candidate, nx, ny);
  const components = compactLabels(region);
  const sizes = new Int32Array(components);
  for (let i = 0; i < n; i++) if (region[i] >= 0) sizes[region[i]]++;
  const index = new Int32Array(components);
  const area: number[] = [];
  for (let c = 0; c < components; c++) {
    const a = sizes[c] * dx * dy;
    if (a >= WATER_MIN_M2) {
      index[c] = area.length;
      area.push(a);
    } else {
      index[c] = -1;
    }
  }
  const regions = area.length;
  if (!regions) return none;
  for (let i = 0; i < n; i++) if (region[i] >= 0) region[i] = index[region[i]];

  // Shore cells: observed land next to a large region. One touching two
  // regions goes with the one north of it, then south, east, west, which is
  // where the add-on's last write lands.
  const shoreCount = new Int32Array(regions);
  const nearCount = new Int32Array(regions);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (candidate[i] || top[i] !== top[i]) continue;
      const r = shoreRegion(region, i, x, y, nx, ny);
      if (r < 0) continue;
      shoreCount[r]++;
      if (top[i] - ground[i] < BANK_BAND_M) nearCount[r]++;
    }
  }
  const shoreStart = offsets(shoreCount);
  const shoreZ = new Float32Array(shoreStart[regions]);
  const at = shoreStart.slice();
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (candidate[i] || top[i] !== top[i]) continue;
      const r = shoreRegion(region, i, x, y, nx, ny);
      if (r >= 0) shoreZ[at[r]++] = top[i];
    }
  }
  for (let r = 0; r < regions; r++) shoreZ.subarray(shoreStart[r], shoreStart[r + 1]).sort();

  const wetCount = new Int32Array(regions);
  for (let i = 0; i < n; i++) if (region[i] >= 0 && waterZ[i] === waterZ[i]) wetCount[region[i]]++;
  const wetStart = offsets(wetCount);
  const wetZ = new Float32Array(wetStart[regions]);
  at.set(wetStart);
  for (let i = 0; i < n; i++) if (region[i] >= 0 && waterZ[i] === waterZ[i]) wetZ[at[region[i]]++] = waterZ[i];
  for (let r = 0; r < regions; r++) wetZ.subarray(wetStart[r], wetStart[r + 1]).sort();

  // Water returns give the median water level, capped at the shore's low
  // tenth. Otherwise the level is the shore's low tenth.
  const levels = new Float64Array(regions).fill(NaN);
  const onGround = new Uint8Array(regions);
  const shoreLow = new Float64Array(regions).fill(NaN);
  for (let r = 0; r < regions; r++) {
    const wet = wetCount[r] ? wetZ[wetStart[r] + (wetCount[r] >> 1)] : NaN;
    const shore = shoreCount[r];
    if (!shore) {
      levels[r] = wet;
      continue;
    }
    const low = shoreZ[shoreStart[r] + Math.trunc(0.1 * shore)];
    const near = nearCount[r] / shore;
    shoreLow[r] = low;
    if (wet === wet) levels[r] = Math.min(wet, low);
    else if (!filesWater && area[r] >= HOLE_WATER_M2 && near >= BANK_SHARE) levels[r] = low;
    else onGround[r] = near >= SHADOW_SHARE ? 1 : 0;
  }
  let fromMap = mapped ? mappedHoles(region, levels, onGround, shoreLow, mapped, nx, ny) : 0;

  let bodies = 0;
  for (let r = 0; r < regions; r++) if (levels[r] === levels[r]) bodies++;
  let cells = 0;
  for (let i = 0; i < n; i++) {
    const r = region[i];
    if (r < 0) continue;
    if (levels[r] === levels[r]) {
      water[i] = 1;
      cells++;
    } else if (count[i] === 0 && onGround[r]) {
      shadow[i] = 1;
    }
  }

  // Not in the add-on: each body grows into cells beside it that have some
  // water returns and stand at its level. San Francisco's 2023 survey files
  // open bay with fewer than half its returns as water, so the bay came out
  // as land at the water level, and in 36 pieces once cut. Not onto raised
  // water, which in Philadelphia is bridge decks filed as water. Mapped
  // cells with no returns join too, never one the survey saw something in.
  // Returns in the cells with water returns around each cell, where flight
  // lines overlap as well as where they don't.
  const wetReturns = new Float32Array(n);
  const wetOnes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!layers.water[i]) continue;
    wetReturns[i] = count[i];
    wetOnes[i] = 1;
  }
  const localReturns = boxMean(wetReturns, nx, ny, SURFACE_REACH);
  const localWet = boxMean(wetOnes, nx, ny, SURFACE_REACH);
  const surface = (j: number, z: number) => {
    const g = layers.ground[j];
    const above = top[j] - z;
    const usual = localWet[j] > 0 ? localReturns[j] / localWet[j] : 1;
    return layers.water[j] === 0 && g !== g && !layers.building[j] && !layers.vegetation[j] && count[j] <= 2 * Math.max(1, usual) && above <= SURFACE_M && above >= -GROW_M;
  };
  // How far the tops within FLAT_REACH_M spread, holes left out.
  const reach = Math.max(1, Math.round(FLAT_REACH_M / Math.min(dx, dy)));
  const high = windowMax(Float32Array.from(top, (z) => (z === z ? z : -Infinity)), nx, ny, reach);
  const low = windowMin(Float32Array.from(top, (z) => (z === z ? z : Infinity)), nx, ny, reach);
  const filedAsGround = (j: number, z: number) => {
    const g = layers.ground[j];
    return g === g && top[j] - g < LEVEL_M && Math.abs(top[j] - z) <= LEVEL_M && high[j] - low[j] <= LEVEL_M;
  };
  let grown = 0;
  const queue = new Int32Array(n);
  const open = new Uint8Array(regions);
  let head = 0;
  let tail = 0;
  const grow = () => {
  while (head < tail) {
    const i = queue[head++];
    const r = region[i];
    const z = levels[r];
    const x = i % nx;
    for (let d = 0; d < 4; d++) {
      const j = d === 0 ? (x > 0 ? i - 1 : -1) : d === 1 ? (x + 1 < nx ? i + 1 : -1) : d === 2 ? i - nx : i + nx;
      if (j < 0 || j >= n || water[j]) continue;
      const empty = mapped !== undefined && mapped[j] === 1 && count[j] === 0;
      if (!empty && !(layers.water[j] > 0 && Math.abs(top[j] - z) <= GROW_M) && !(open[r] && surface(j, z)) && !filedAsGround(j, z)) continue;
      if (z - ground[j] > RAISED_WATER_M) continue;
      water[j] = 1;
      region[j] = r;
      grown++;
      if (empty) fromMap++;
      queue[tail++] = j;
    }
  }
  };
  for (let i = 0; i < n; i++) if (water[i]) queue[tail++] = i;
  grow();
  // Bodies mostly bordered by cells that look like open water nobody
  // classified grow over those too.
  const edge = new Int32Array(regions);
  const unfiled = new Int32Array(regions);
  for (let i = 0; i < n; i++) {
    if (!water[i]) continue;
    const r = region[i];
    const x = i % nx;
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < nx ? i + 1 : -1, i - nx, i + nx]) {
      if (j < 0 || j >= n || water[j]) continue;
      edge[r]++;
      if (surface(j, levels[r])) unfiled[r]++;
    }
  }
  head = 0;
  tail = 0;
  for (let r = 0; r < regions; r++) open[r] = unfiled[r] >= UNFILED_SHARE * edge[r] && edge[r] > 0 ? 1 : 0;
  for (let i = 0; i < n; i++) if (water[i] && open[region[i]]) queue[tail++] = i;
  grow();
  if (cells) grown += takeSpecks(water, region, levels, top, nx, ny, dx * dy);

  const level = new Float32Array(cells + grown);
  for (let i = 0, k = 0; i < n; i++) if (water[i]) level[k++] = levels[region[i]];
  return { water, shadow, level, bodies, grown, fromMap };
}

/**
 * Not in the add-on: holes mostly inside mapped water are water even where
 * the survey files water elsewhere. IGN files few water returns in Paris,
 * and the Petit Bras beside Notre-Dame is three holes with none. Only holes
 * that would be filled as ground, with their shore mostly on it: one read
 * as a dark roof (a pier shed inside a harbour's outline) stays a roof. Each
 * takes the level of the survey's water in the same mapped water, or its
 * shore's low tenth where that's lower or there is none. Sets `levels` for
 * the holes it takes and returns their cells.
 */
function mappedHoles(
  region: Int32Array,
  levels: Float64Array,
  onGround: Uint8Array,
  shoreLow: Float64Array,
  mapped: Uint8Array,
  nx: number,
  ny: number,
): number {
  const n = nx * ny;
  const regions = levels.length;
  const size = new Int32Array(regions);
  const inside = new Int32Array(regions);
  for (let i = 0; i < n; i++) {
    const r = region[i];
    if (r < 0) continue;
    size[r]++;
    inside[r] += mapped[i];
  }
  const holes: number[] = [];
  for (let r = 0; r < regions; r++) {
    if (onGround[r] && inside[r] >= MAPPED_SHARE * size[r]) holes.push(r);
  }
  if (!holes.length) return 0;
  const piece = label(mapped, nx, ny);
  const pieceLevel = new Float64Array(compactLabels(piece)).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const r = region[i];
    if (r >= 0 && piece[i] >= 0 && levels[r] === levels[r]) pieceLevel[piece[i]] = Math.min(pieceLevel[piece[i]], levels[r]);
  }
  const surveyed = new Float64Array(regions).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const r = region[i];
    if (r >= 0 && piece[i] >= 0) surveyed[r] = Math.min(surveyed[r], pieceLevel[piece[i]]);
  }
  let cells = 0;
  for (const r of holes) {
    levels[r] = Math.min(shoreLow[r], surveyed[r]);
    onGround[r] = 0;
    cells += size[r];
  }
  return cells;
}

/**
 * Land pieces under SPECK_M2 inside a water body, clear of the grid's edge,
 * whose returns all sit within SPECK_M of its level, join the body. The same
 * survey leaves thousands in the bay, mostly one cell with one stray return,
 * and clutter removal raised each to the ground interpolated from the shore:
 * a field of spikes over the recessed water. Pilings and boats stand higher
 * and stay. Returns how many cells joined.
 */
function takeSpecks(water: Uint8Array, region: Int32Array, levels: Float64Array, top: Float32Array, nx: number, ny: number, cellArea: number): number {
  const n = nx * ny;
  const dry = new Uint8Array(n);
  for (let i = 0; i < n; i++) dry[i] = water[i] ^ 1;
  const pieces = label(dry, nx, ny);
  const count = compactLabels(pieces);
  const size = new Int32Array(count);
  const ok = new Uint8Array(count).fill(1);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = pieces[y * nx + x];
      if (p < 0) continue;
      size[p]++;
      if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) ok[p] = 0;
    }
  }
  for (let p = 0; p < count; p++) if (size[p] * cellArea >= SPECK_M2) ok[p] = 0;
  // A piece's first cell has water to its south, or that cell would be in the
  // piece, so the body is known before any of its cells is checked.
  const body = new Int32Array(count).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = pieces[i];
    if (p < 0 || !ok[p]) continue;
    if (body[p] < 0) body[p] = region[i - nx];
    if (top[i] === top[i] && !(Math.abs(top[i] - levels[body[p]]) <= SPECK_M)) ok[p] = 0;
  }
  let joined = 0;
  for (let i = 0; i < n; i++) {
    const p = pieces[i];
    if (p < 0 || !ok[p]) continue;
    water[i] = 1;
    region[i] = body[p];
    joined++;
  }
  return joined;
}

function shoreRegion(region: Int32Array, i: number, x: number, y: number, nx: number, ny: number): number {
  if (y + 1 < ny && region[i + nx] >= 0) return region[i + nx];
  if (y > 0 && region[i - nx] >= 0) return region[i - nx];
  if (x + 1 < nx && region[i + 1] >= 0) return region[i + 1];
  if (x > 0 && region[i - 1] >= 0) return region[i - 1];
  return -1;
}

function offsets(counts: Int32Array): Int32Array {
  const start = new Int32Array(counts.length + 1);
  for (let k = 0; k < counts.length; k++) start[k + 1] = start[k] + counts[k];
  return start;
}

// Tree canopy: rough blobs of vegetation-like returns. Unclassified multiple
// returns look like vegetation, and so does a wall's edge (roof, then
// street), so the share is taken over 5 x 5 cells and a cell has to sit in a
// rough neighbourhood. Then each blob is judged whole. The add-on's
// tree_mask has the surveys behind each test.
function treeMask(layers: SurfaceLayers, surface: Float32Array, ground: Float32Array): Uint8Array {
  const { nx, ny, building, solid } = layers;
  const n = nx * ny;
  const tall = new Uint8Array(n);
  const through = new Uint8Array(n);
  let tallCells = 0;
  let buildingCells = 0;
  for (let i = 0; i < n; i++) {
    const above = surface[i] - ground[i];
    if (above > TREE_MIN_M && above < TREE_MAX_M) {
      tall[i] = 1;
      tallCells++;
      if (layers.ground[i] === layers.ground[i]) through[i] = 1;
    }
    if (building[i] > 0) buildingCells++;
  }
  const classified = buildingCells > CLASSIFIED_SHARE * Math.max(1, tallCells);

  // Without vegetation and building classes (Philadelphia 2015), many crowns
  // return once and ornate roofs twice, so a tall cell with ground returns
  // under it counts as vegetation-like too.
  const likely = new Uint8Array(n);
  const vegetation = new BoxSums(layers.vegetation, nx, ny, 2);
  const returns = new BoxSums(layers.count, nx, ny, 2);
  const seen = classified ? null : new BoxSums(through, nx, ny, 2);
  const tallShare = classified ? null : new BoxSums(tall, nx, ny, 2);
  for (let y = 0; y < ny; y++) {
    const v = vegetation.row(y);
    const c = returns.row(y);
    const s = seen?.row(y);
    const t = tallShare?.row(y);
    const rows = vegetation.height(y);
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (!tall[i] || building[i]) continue;
      const cells = rows * vegetation.width[x];
      if (v[x] / cells / Math.max(c[x] / cells, 1e-9) >= TREE_SHARE) likely[i] = 1;
      else if (s && t && s[x] / cells >= TREE_SHARE * (t[x] / cells)) likely[i] = 1;
    }
  }

  // How far each cell lies from its 3 x 3 mean. A crown is rough all over, a
  // rail deck or a planted roof is flat away from its edges.
  const step = new Float32Array(n);
  const flat = new Uint8Array(n);
  const local = new BoxSums(surface, nx, ny, 1);
  for (let y = 0; y < ny; y++) {
    const sums = local.row(y);
    const rows = local.height(y);
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      const d = Math.abs(surface[i] - sums[x] / (rows * local.width[x]));
      step[i] = d;
      flat[i] = d < FLAT_STEP_M ? 1 : 0;
    }
  }
  const canopy = new Uint8Array(n);
  const flatShare = new BoxSums(flat, nx, ny, 2);
  for (let y = 0; y < ny; y++) {
    const sums = flatShare.row(y);
    const rows = flatShare.height(y);
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (likely[i] && sums[x] / (rows * flatShare.width[x]) < FLAT_SHARE) canopy[i] = 1;
    }
  }
  dilate(erode(canopy, nx, ny, 1, canopy), nx, ny, 1, canopy);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (!canopy[i]) continue;
    if (surface[i] - ground[i] > TREE_MIN_M) any = true;
    else canopy[i] = 0;
  }
  if (!any) return canopy;

  // Each blob has to be rough on average, thick enough to survive two more
  // erosions (a strip along a facade isn't), and open below in places: under
  // a crown the highest other return is often the ground, under a roof edge
  // it's the roof.
  const blob = label(canopy, nx, ny);
  const blobs = compactLabels(blob);
  const size = new Int32Array(blobs);
  const rough = new Float64Array(blobs);
  const open = new Int32Array(blobs);
  const roughness = new BoxSums(step, nx, ny, 2);
  for (let y = 0; y < ny; y++) {
    const sums = roughness.row(y);
    const rows = roughness.height(y);
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      const b = blob[i];
      if (b < 0) continue;
      size[b]++;
      rough[b] += sums[x] / (rows * roughness.width[x]);
      if (!classified) open[b] += through[i];
      else if (solid[i] !== solid[i] || surface[i] - solid[i] > TREE_MIN_M) open[b]++;
    }
  }
  const core = erode(canopy, nx, ny, 2);
  const pass = new Uint8Array(blobs);
  for (let i = 0; i < n; i++) if (core[i]) pass[blob[i]] = 1;
  const openShare = classified ? TREE_HOLLOW : TREE_THROUGH;
  for (let b = 0; b < blobs; b++) {
    if (!(rough[b] / size[b] >= TREE_ROUGH_M && open[b] / size[b] >= openShare)) pass[b] = 0;
  }
  for (let i = 0; i < n; i++) if (blob[i] >= 0 && !pass[blob[i]]) canopy[i] = 0;

  // A crown touching a building takes the strip of edge cells along its wall
  // with it (roof on top, street at the foot). Strips go, then the crown
  // grows back over its own rim.
  dilate(erode(canopy, nx, ny, 2, core), nx, ny, 2, core);
  for (let i = 0; i < n; i++) canopy[i] &= core[i];
  for (let k = 0; k < 2; k++) {
    dilate(canopy, nx, ny, 1, core);
    for (let i = 0; i < n; i++) if (core[i] && likely[i]) canopy[i] = 1;
  }
  return canopy;
}

// Crowns as the survey saw them: gaps a cell or two across closed (the
// laser went through to a branch or the lawn), then a 3 x 3 mean over canopy
// cells only, which softens speckle and leaves the crown's edge where it is.
function naturalCrowns(surface: Float32Array, ground: Float32Array, canopy: Uint8Array, nx: number, ny: number): void {
  const n = nx * ny;
  if (!canopy.includes(1)) return;
  const closed = windowMin(windowMax(surface, nx, ny, 1), nx, ny, 1);
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = canopy[i] ? Math.max(surface[i], closed[i]) : 0;
  const sums = new BoxSums(z, nx, ny, 1);
  const cells = new BoxSums(canopy, nx, ny, 1);
  for (let y = 0; y < ny; y++) {
    const total = sums.row(y);
    const count = cells.row(y);
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (canopy[i]) surface[i] = Math.max(total[x] / count[x], ground[i] + TREE_MIN_M / 2);
    }
  }
}

// Kept trees become domes: gaps inside a crown closed, then crown and what
// stands around it smoothed together, so a crown's edge slopes down to the
// street. The surroundings count at their own height up to the crown's top,
// so a plaza or roof a crown stands on keeps it up (against the street,
// Chicago's roof gardens came out as trenches 10-20 m deep) and a tower
// beside it doesn't lift it. Returns the skirt the slope runs out over.
function domes(
  surface: Float32Array,
  ground: Float32Array,
  canopy: Uint8Array,
  water: Uint8Array,
  clutterHeightM: number,
  nx: number,
  ny: number,
): Uint8Array {
  const n = nx * ny;
  const skirt = new Uint8Array(n);
  if (!canopy.includes(1)) return skirt;
  const reach = 2 * CROWN_CLOSE + CROWN_RADII[0] + CROWN_RADII[1];
  const around = new Float32Array(n);
  for (let i = 0; i < n; i++) around[i] = canopy[i] ? surface[i] : ground[i];
  windowMax(around, nx, ny, reach, around);
  for (let i = 0; i < n; i++) around[i] = Math.min(surface[i], around[i]);
  const crowns = new Float32Array(n);
  for (let i = 0; i < n; i++) crowns[i] = canopy[i] ? surface[i] : around[i];
  windowMin(windowMax(crowns, nx, ny, CROWN_CLOSE, crowns), nx, ny, CROWN_CLOSE, crowns);
  for (let i = 0; i < n; i++) if (!canopy[i]) crowns[i] = around[i];
  for (const radius of CROWN_RADII) boxMean(crowns, nx, ny, radius, crowns);
  for (let i = 0; i < n; i++) if (canopy[i]) surface[i] = Math.max(crowns[i], ground[i] + TREE_MIN_M / 2);
  // The slope runs out over the street or lawn beside a crown, never over a building.
  dilate(canopy, nx, ny, CROWN_RADII[0], skirt);
  for (let i = 0; i < n; i++) {
    if (!skirt[i]) continue;
    if (canopy[i] || water[i] || !(surface[i] - ground[i] < clutterHeightM)) skirt[i] = 0;
    else surface[i] = Math.max(surface[i], crowns[i]);
  }
  return skirt;
}

/**
 * What's narrower than three cells. A 3 x 3 closing fills every gap that
 * narrow and deeper than PIT_M, and nothing wider, so walls, corners and
 * diagonal edges stay put. Those gaps are mostly cells with two or three
 * returns where one came off the street past a roof edge or through glass
 * (they ran down the Comcast Center to the street). With `clear`, standing
 * features that thin go down to what's around them when they're long or
 * stand near the ground.
 */
export function narrow(
  z: Float32Array,
  nx: number,
  ny: number,
  ground: Float32Array,
  keep: Uint8Array,
  clear: boolean,
  dx: number,
  out: Float32Array = new Float32Array(nx * ny),
): { z: Float32Array; pits: number; slivers: number } {
  if (out !== z) out.set(z);
  const n = nx * ny;
  const closed = windowMax(out, nx, ny, 1);
  windowMin(closed, nx, ny, 1, closed);
  let pits = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i] && closed[i] > out[i] + PIT_M) {
      out[i] = closed[i];
      pits++;
    }
  }
  if (!clear) return { z: out, pits, slivers: 0 };

  const opened = windowMax(windowMin(out, nx, ny, 1, closed), nx, ny, 1, closed);
  const thin = new Uint8Array(n);
  let anyThin = false;
  for (let i = 0; i < n; i++) {
    if (!keep[i] && out[i] - opened[i] > SLIVER_M) {
      thin[i] = 1;
      anyThin = true;
    }
  }
  if (!anyThin) return { z: out, pits, slivers: 0 };
  // Diagonal neighbours join too, or a jib at 45 degrees falls apart into single cells.
  const group = label(dilate(thin, nx, ny, 1), nx, ny);
  const groups = compactLabels(group);
  const x0 = new Int32Array(groups).fill(nx);
  const x1 = new Int32Array(groups).fill(-1);
  const y0 = new Int32Array(groups).fill(ny);
  const y1 = new Int32Array(groups).fill(-1);
  const base = new Float64Array(groups).fill(Infinity);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (!thin[i]) continue;
      const g = group[i];
      x0[g] = Math.min(x0[g], x);
      x1[g] = Math.max(x1[g], x);
      y0[g] = Math.min(y0[g], y);
      y1[g] = Math.max(y1[g], y);
      base[g] = Math.min(base[g], opened[i] - ground[i]);
    }
  }
  const gone = new Uint8Array(groups);
  for (let g = 0; g < groups; g++) {
    const extent = Math.max(y1[g] - y0[g] + 1, x1[g] - x0[g] + 1);
    gone[g] = extent * dx >= SLIVER_LONG_M || base[g] < SLIVER_BASE_M ? 1 : 0;
  }
  let slivers = 0;
  for (let i = 0; i < n; i++) {
    if (thin[i] && gone[group[i]]) {
      out[i] = opened[i];
      slivers++;
    }
  }
  return { z: out, pits, slivers };
}
