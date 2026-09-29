// Runs the generation stages in order and returns the model as layers of
// solids. Order matters: water flattens the terrain grid before anything is
// draped on it, and the ground kept under structures over water depends on
// the road and building footprints, so the terrain solid is built last.

import { areaGeoBounds, areaModelRing, effectiveScale } from '../geo/area';
import { Projection } from '../geo/projection';
import {
  ClipSet,
  difference,
  differenceSet,
  dropSmall,
  intersection,
  multiArea,
  multiBounds,
  clipToBox,
  offsetPolygons,
  polygonArea,
  ringBounds,
  ringPerimeter,
  union,
  type Box,
} from '../geometry/polygon';
import type { Layer, PrismSolid, Solid } from '../geometry/solid';
import type { PreparedLidar } from '../lidar/prepare';
import type { AreaSpec, ModelSettings, SurfaceCategory } from '../settings';
import { HeightField } from '../terrain/heightfield';
import type { MaterialRole, ModelStats, MultiPolygon, Polygon } from '../types';
import { buildBuildings } from './buildings';
import { isWaterDeck } from './classify';
import { Progress, type Context } from './context';
import { buildLand } from './land';
import { buildBridges, splitDecks } from './bridges';
import { buildAirports, bufferRoads, collectRoadPieces, type RoadPiece, type RoadResult } from './roads';
import { EdgeIndex } from '../geometry/edgeindex';
import { projectPolygons, type Elevation, type SourceData, type SourceType } from './source';
import { solveWater, waterBottom } from './water';
import { buildTrees } from './trees';

export interface ModelSpec {
  layers: Layer[];
  /** Model outline in mm, including the rim when there is one. */
  outline: Polygon;
  /** The outline without the rim, for an export with the rim left out. */
  crop: Polygon;
  /** Z of the model's underside; meshes are shifted so it lands on 0. */
  baseZ: number;
  mmPerMetre: number;
  stats: ModelStats;
  warnings: string[];
}

export interface GenerateInput {
  area: AreaSpec;
  settings: ModelSettings;
  data: SourceData;
  /** Null builds a flat base. */
  elevation: Elevation | null;
  /** Prepared LiDAR measurements; null or absent builds every building from the map. */
  lidar?: PreparedLidar | null;
  progress?: Progress;
}

const LAND_ROLES: Record<SurfaceCategory, MaterialRole> = {
  paved: 'paved',
  sand: 'sand',
  rock: 'rock',
  green: 'green',
  forest: 'forest',
};

const LAND_NAMES: Record<SurfaceCategory, string> = {
  paved: 'Paved',
  sand: 'Sand',
  rock: 'Rock',
  green: 'Parks',
  forest: 'Forest',
};

// A beach slopes within a few cells, so it gets a finer lattice. Split the
// same way, each of its triangles still lies in one terrain triangle. The
// split is kept to about this many cells a polygon: a wide sand area at the
// narrowest beach setting was tens of millions.
const BEACH_CELLS = 300_000;

function beachSplit(polygon: Polygon, step: number, beachWidth: number): number {
  const area = polygonArea(polygon);
  const length = polygon.reduce((sum, ring) => sum + ringPerimeter(ring), 0);
  for (let split = Math.max(1, Math.ceil((3 * step) / beachWidth)); split > 1; split--) {
    const fine = step / split;
    // Cells inside, and the ones along the outline latticeTin adds.
    if (area / fine ** 2 + (3 * length) / fine <= BEACH_CELLS) return split;
  }
  return 1;
}

/** The data bounds generation needs for an area: the shape plus a small margin. */
export function dataBoundsFor(area: AreaSpec) {
  return areaGeoBounds(area, 25);
}

export async function generateModel(input: GenerateInput): Promise<ModelSpec> {
  const { area, settings, data } = input;
  const progress = input.progress ?? new Progress();
  const mmPerMetre = effectiveScale(area, settings.scale);
  const projection = new Projection(area.center, area.rotationDeg, mmPerMetre);
  const crop = areaModelRing(area, mmPerMetre);
  const cropBox = ringBounds(crop);
  const features = (type: SourceType) => data.features[type] ?? [];

  // ------------------------------------------------------------- terrain grid
  progress.begin('terrain', 'Building the terrain grid', 0.3, 0.05);
  const resolution = settings.terrain.resolution;
  const pad = (Math.max(cropBox[2] - cropBox[0], cropBox[3] - cropBox[1]) / resolution) * 1.5;
  const gridBox: Box = [cropBox[0] - pad, cropBox[1] - pad, cropBox[2] + pad, cropBox[3] + pad];
  let heightfield: HeightField;
  if (input.elevation && settings.terrain.elevation) {
    const dem = input.elevation;
    const scale = mmPerMetre * settings.terrain.exaggeration;
    heightfield = HeightField.build(gridBox, resolution, (x, y) => {
      const [lon, lat] = projection.modelToGeo(x, y);
      return dem.sample(lon, lat) * scale;
    });
    heightfield.smooth(settings.terrain.smoothing);
    // Keep numbers small: the base is measured from the lowest point anyway.
    const low = heightfield.min();
    for (let i = 0; i < heightfield.values.length; i++) heightfield.values[i] -= low;
  } else {
    heightfield = HeightField.flat(gridBox, resolution, 0);
  }

  const ctx: Context = {
    settings,
    projection,
    crop: [crop],
    cropSet: [[crop]],
    cropBox,
    bounds: areaGeoBounds(area),
    heightfield,
    stats: {},
    warnings: [],
    progress,
  };
  ctx.stats.mm_per_metre = mmPerMetre;
  ctx.stats.terrain_grid = `${heightfield.cols} x ${heightfield.rows}`;

  // -------------------------------------------------------------------- water
  progress.begin('water', 'Solving water levels', 0.35, 0.08);
  const water = await solveWater(features('water'), ctx);

  // -------------------------------------------------------------------- roads
  progress.begin('roads', 'Laying out roads', 0.43, 0.12);
  let roads: RoadResult = { road: [], path: [], rail: [], footprint: [], bridgeLines: [] };
  let bridgeSolids: PrismSolid[] = [];
  let pierGround: MultiPolygon = [];
  if (settings.roads.enabled) {
    const collected = await collectRoadPieces(features('segment'), ctx);
    let groundPieces: RoadPiece[] = collected.pieces;
    let deckPieces: RoadPiece[] = [];
    if (settings.bridges.enabled) ({ ground: groundPieces, decks: deckPieces } = splitDecks(collected.pieces, ctx, water.cut));
    let ribbons = await bufferRoads(groundPieces, ctx);
    if (deckPieces.length) {
      const bridges = await buildBridges(deckPieces, ctx, { groundRoads: ribbons.footprint, cutWater: water.cut });
      bridgeSolids = bridges.solids;
      pierGround = bridges.pierGround;
      if (bridges.demoted.length) ribbons = await bufferRoads([...groundPieces, ...bridges.demoted], ctx);
    }
    roads = { ...ribbons, bridgeLines: collected.bridgeLines };
  }
  let airport: MultiPolygon = [];
  if (settings.roads.enabled && settings.roads.includeAirports) {
    airport = buildAirports(features('infrastructure'), ctx);
    if (airport.length) {
      airport = difference(airport, roads.footprint);
      roads.footprint = [...roads.footprint, ...airport];
    }
  }

  // Ground kept under structures that stand over cut water or basins.
  const noGround = union(water.cut, water.basins);
  const supportsOn = settings.supports;
  const structures: MultiPolygon[] = [];
  if (supportsOn) {
    if (roads.footprint.length) structures.push(intersection(roads.footprint, noGround));
    if (pierGround.length) structures.push(pierGround);
    const decks: Polygon[] = [];
    for (const type of ['infrastructure', 'land', 'land_use'] as SourceType[]) {
      for (const feature of features(type)) {
        if (isWaterDeck(type, feature)) decks.push(...projectPolygons(feature.geometry, projection));
      }
    }
    if (decks.length) structures.push(intersection(clipToBox(decks, cropBox), water.cut));
  } else if (noGround.length) {
    roads.road = difference(roads.road, noGround);
    roads.path = difference(roads.path, noGround);
    roads.rail = difference(roads.rail, noGround);
    airport = difference(airport, noGround);
    roads.footprint = difference(roads.footprint, noGround);
  }

  // ---------------------------------------------------------------- buildings
  progress.begin('buildings', 'Building footprints and roofs', 0.55, 0.2);
  const buildings = settings.buildings.enabled
    ? await buildBuildings(features('building'), features('building_part'), ctx, {
        clipAway: supportsOn ? [] : noGround,
        lidar: input.lidar ? { records: input.lidar.records, preferLidar: settings.lidar.preferLidar } : undefined,
      })
    : { solids: [] as PrismSolid[], measured: [] as Solid[], rock: [] as Solid[], footprint: [] as MultiPolygon };
  if (supportsOn && buildings.footprint.length && noGround.length) {
    structures.push(intersection(buildings.footprint, noGround));
  }
  const supports = union(...structures);
  const cutFinal = supports.length ? difference(water.cut, supports) : water.cut;
  const basinFinal = supports.length ? difference(water.basins, supports) : water.basins;
  // Every body lies inside the cut or basin set, so a body less the supports
  // is its share of cutFinal or basinFinal, found from the rings near it only.
  const supportSet = new ClipSet([supports]);
  const unsupported = (polygon: Polygon) => differenceSet([polygon], supportSet);
  ctx.stats.ground_kept_under_structures_mm2 = Math.round(multiArea(supports) * 10) / 10;

  // --------------------------------------------------------------- land cover
  progress.begin('land', 'Draping parks and land cover', 0.75, 0.1);
  const land = settings.land.enabled
    ? await buildLand(data, ctx, {
        water: water.all,
        roads: roads.footprint,
        buildings: buildings.footprint,
        bridgeLines: roads.bridgeLines,
      })
    : null;

  // ----------------------------------------------------------- terrain solid
  progress.begin('terrain', 'Closing the terrain solid', 0.85, 0.03);
  const ground = dropSmall(difference(ctx.cropSet, union(cutFinal, basinFinal)), 0.01);
  const hf = ctx.heightfield;
  let lowest = Infinity;
  for (const polygon of ground) {
    for (const n of hf.nodesInside(polygon)) lowest = Math.min(lowest, hf.values[n]);
    for (const ring of polygon) for (const [x, y] of ring) lowest = Math.min(lowest, hf.heightAt(x, y));
  }
  // Cut water and basins less the ground kept under structures. The water's
  // underside is the top of a terrain floor, which the base runs under like
  // any other ground, or null for cut water running down to the base.
  const settled: ({ polygons: Polygon[]; bottom: number | null } | null)[] = [];
  for (let i = 0; i < water.bodies.length; i++) {
    const body = water.bodies[i];
    if (i % 32 === 0) await progress.checkpoint(0.5 * (i / water.bodies.length));
    if (body.kind === 'sheet') {
      settled.push(null);
      continue;
    }
    const polygons = unsupported(body.polygon);
    const bottom = waterBottom(body, settings);
    if (bottom !== null && polygons.length) lowest = Math.min(lowest, bottom);
    settled.push({ polygons, bottom });
  }
  if (!Number.isFinite(lowest)) lowest = 0;
  const baseZ = lowest - settings.terrain.baseThicknessMm;

  // On flat ground a draped solid is its outline, so it isn't cut from the lattice.
  const flat = hf.flat;
  const lattice = flat ? undefined : hf.lattice;
  const drapeStep = flat ? 0 : hf.step;
  const terrainTop = (x: number, y: number) => hf.heightAt(x, y);
  const layers: Layer[] = [];
  const terrainSolids: Solid[] = ground.map((polygon) => ({
    kind: 'prism',
    role: 'terrain',
    polygon,
    top: terrainTop,
    bottom: baseZ,
    drape: drapeStep,
    lattice,
  }));
  // Floors under the water: the terrain built lower over it. With the water
  // turned off they're left as empty recesses.
  for (const entry of settled) {
    if (entry?.bottom == null) continue;
    for (const polygon of entry.polygons) {
      terrainSolids.push({ kind: 'prism', role: 'terrain', polygon, top: entry.bottom, bottom: baseZ, drape: 0 });
    }
  }
  layers.push({ id: 'terrain', name: 'Terrain', role: 'terrain', solids: terrainSolids });

  // -------------------------------------------------------------- water fill
  if (settings.water.enabled) {
    const fills: Solid[] = [];
    for (let i = 0; i < water.bodies.length; i++) {
      const body = water.bodies[i];
      const entry = settled[i];
      if (i % 32 === 0) await progress.checkpoint(0.5 + 0.5 * (i / water.bodies.length));
      if (entry) {
        for (const polygon of entry.polygons) {
          fills.push({ kind: 'prism', role: 'water', polygon, top: body.top, bottom: entry.bottom ?? baseZ, drape: 0 });
        }
      } else {
        const bottom = Math.max(waterBottom(body, settings)!, baseZ + 0.05);
        fills.push({ kind: 'prism', role: 'water', polygon: body.polygon, top: body.top, bottom, drape: 0 });
      }
    }
    if (fills.length) layers.push({ id: 'water', name: 'Water', role: 'water', solids: fills });
  }

  // ---------------------------------------------------------------- land cover
  if (land) {
    const rise = settings.land.riseMm;
    const embed = settings.land.embedMm;
    const flatTop = (x: number, y: number) => hf.heightAt(x, y) + rise;
    const bottom = (x: number, y: number) => hf.heightAt(x, y) - embed;
    // Sand beside cut water is a beach: slope it down to 0.1 mm at the waterline.
    const beachWidth = settings.land.beachWidthMm;
    const shore = settings.land.taperBeaches && cutFinal.length && beachWidth > 0 ? new EdgeIndex(cutFinal, beachWidth) : null;
    const beachTop = (x: number, y: number) => {
      const d = shore!.distance(x, y, beachWidth);
      const low = Math.min(0.1, rise);
      return hf.heightAt(x, y) + low + (rise - low) * Math.min(1, d / beachWidth);
    };
    for (const category of settings.land.priority) {
      const polygons = land[category];
      if (!polygons.length) continue;
      const top = category === 'sand' && shore ? beachTop : flatTop;
      const beach = category === 'sand' && shore;
      layers.push({
        id: `land-${category}`,
        name: LAND_NAMES[category],
        role: LAND_ROLES[category],
        solids: polygons.map((polygon) => {
          // A beach slopes even on flat ground.
          const drape = flat && !beach ? 0 : hf.step / (beach ? beachSplit(polygon, hf.step, beachWidth) : 1);
          return { kind: 'prism', role: LAND_ROLES[category], polygon, top, bottom, drape, lattice: drape > 0 ? { ...hf.lattice, step: drape } : undefined };
        }),
      });
    }
  }

  // --------------------------------------------------------------------- roads
  if (settings.roads.enabled) {
    const thickness = settings.roads.thicknessMm;
    const embed = settings.land.embedMm;
    const top = (x: number, y: number) => hf.heightAt(x, y) + thickness;
    const bottom = (x: number, y: number) => hf.heightAt(x, y) - embed;
    const groups: [string, string, MaterialRole, MultiPolygon][] = [
      ['roads', 'Roads', 'road', roads.road],
      ['rail', 'Railways', 'rail', roads.rail],
      ['paths', 'Paths', 'path', roads.path],
      ['airport', 'Airport Paving', 'airport', airport],
    ];
    for (const [id, name, role, polygons] of groups) {
      if (!polygons.length) continue;
      layers.push({ id, name, role, solids: polygons.map((polygon) => ({ kind: 'prism', role, polygon, top, bottom, drape: drapeStep, lattice })) });
    }
  }

  const decks = bridgeSolids.filter((s) => s.role === 'bridge');
  const piers = bridgeSolids.filter((s) => s.role === 'pier');
  if (decks.length) layers.push({ id: 'bridges', name: 'Bridges', role: 'bridge', solids: decks });
  if (piers.length) layers.push({ id: 'piers', name: 'Bridge Piers', role: 'pier', solids: piers });

  // ---------------------------------------------------------------- buildings
  const buildingSolids: Solid[] = [...buildings.solids, ...buildings.measured];
  if (buildingSolids.length) layers.push({ id: 'buildings', name: 'Buildings', role: 'building', solids: buildingSolids });
  if (buildings.rock.length) layers.push({ id: 'lidar-rock', name: 'Rock (LiDAR)', role: 'rock', solids: buildings.rock });

  // --------------------------------------------------------------------- trees
  if (settings.trees.enabled) {
    progress.begin('trees', 'Planting trees', 0.88, 0.04);
    const trees = await buildTrees(data, ctx, {
      roads: roads.footprint,
      structures: [...buildings.footprint, ...decks.map((deck) => deck.polygon)],
      noGround: union(cutFinal, basinFinal, water.sheets),
    });
    if (trees.length) layers.push({ id: 'trees', name: 'Trees', role: 'tree', solids: trees });
  }

  // ---------------------------------------------------------------------- rim
  let outline: Polygon = [crop];
  if (settings.rim.enabled && settings.rim.widthMm > 0) {
    const outer = offsetPolygons(ctx.cropSet, settings.rim.widthMm, 'miter');
    const ring = difference(outer, ctx.cropSet);
    const top = hf.max() + settings.rim.heightMm;
    layers.push({
      id: 'rim',
      name: 'Border Rim',
      role: 'rim',
      solids: ring.map((polygon) => ({ kind: 'prism', role: 'rim', polygon, top, bottom: baseZ, drape: 0 })),
    });
    // Sections are cut from the outline, so it has to take the rim in.
    if (outer.length === 1) outline = [outer[0][0]];
  }

  ctx.stats.model_bounds = multiBounds([outline]).map((v) => v.toFixed(1)).join(', ');
  return { layers, outline, crop: [crop], baseZ, mmPerMetre, stats: ctx.stats, warnings: ctx.warnings };
}
