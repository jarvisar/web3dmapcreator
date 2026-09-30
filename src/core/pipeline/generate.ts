// Runs the generation stages in order and returns the model as layers of
// solids. Order matters: water flattens the terrain grid before anything is
// draped on it, and the ground kept under structures over water depends on
// the road and building footprints, so the terrain solid is built last.

import type { GroundGrid } from '../edit/ground';
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
  ringBounds,
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
import { describeObject, Progress, type Context, type ObjectInfo } from './context';
import { buildLand } from './land';
import { buildBridges, splitDecks, type DeckPiece } from './bridges';
import { Wading } from './wading';
import { buildAirports, bufferRoads, collectRoadPieces, type RoadPiece, type RoadResult } from './roads';
import { projectPolygons, type Elevation, type SourceData, type SourceType } from './source';
import { solveWater, waterBottom, type WaterKind } from './water';
import { shapeBeaches } from './beaches';
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
  /** What the editor needs beyond the layers (core/edit). */
  edit?: EditContext;
}

export interface EditContext {
  /** Height of the ground (the surface, in a LiDAR only model) in unshifted model mm. */
  heightAt: (x: number, y: number) => number;
  /** The terrain grid, when there is one. Draped shapes are cut from it. */
  heightfield?: HeightField;
  /** A LiDAR only model's surface grid, in place of a terrain grid. */
  grid?: GroundGrid;
  /**
   * A LiDAR only model's water, with the floor under it, or null where it's
   * cut out through the base.
   */
  surfaceWater?: { polygons: MultiPolygon; floor: number | null }[];
  /** Ground road pieces as they were widened: bridges left out, demoted decks back in. */
  roads: RoadPiece[];
  /** Water bodies with their levels, for editing water and what stands in it (edit/earth.ts). */
  bodies: EditWater[];
  /** Cut water and basins before any ground was kept in them. */
  noGround: MultiPolygon;
  /**
   * What stands in cut water and basins, by what it is, which the water is
   * cut around. The ground under it is kept with supports on, and only under
   * mapped piers and the like with them off. Roads include airport paving,
   * which is also on its own.
   */
  kept: { roads: MultiPolygon; buildings: MultiPolygon; piers: MultiPolygon; decks: MultiPolygon; airport: MultiPolygon };
  /** The terrain as built: ground draped on the grid, and flat floors under water. */
  terrain?: { ground: MultiPolygon };
  /** Bridge decks as laid out, to build again at another width. */
  decks: DeckPiece[];
  /** Everything selectable, by key. */
  objects: Map<string, ObjectInfo>;
  /**
   * Land cover before water, roads and buildings were cleared from it, so a
   * removed road or building can have its ground back (edit/land.ts).
   */
  land?: { regions: Partial<Record<SurfaceCategory, MultiPolygon>>; water: MultiPolygon };
}

export interface EditWater {
  key?: string;
  kind: WaterKind;
  /** The whole body, ground kept in it included. */
  polygon: Polygon;
  /** Where it's water: the body less what stands in it. */
  water: Polygon[];
  /** Where there's no ground in it, which its floor covers: the body less the ground kept in it. */
  floors: Polygon[];
  top: number;
  /** The bank's level, which the terrain under the body was flattened to. */
  bed: number;
  /** Top of the terrain floor under it, or null where it runs down to the base (and for sheets). */
  floor: number | null;
  /** Underside of its water. */
  bottom: number;
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

export const LAND_ROLES: Record<SurfaceCategory, MaterialRole> = {
  paved: 'paved',
  sand: 'sand',
  rock: 'rock',
  green: 'green',
  forest: 'forest',
};

const WATER_KINDS: Record<WaterKind, string> = {
  cut: 'River, lake or sea',
  basin: 'Pond or fountain',
  sheet: 'Stream or pool',
};

export const LAND_NAMES: Record<SurfaceCategory, string> = {
  paved: 'Paved',
  sand: 'Sand',
  rock: 'Rock',
  green: 'Parks',
  forest: 'Forest',
};

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
    objects: new Map<string, ObjectInfo>(),
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
  let deckPieces: DeckPiece[] = [];
  let groundRoads: RoadPiece[] = [];
  if (settings.roads.enabled) {
    const collected = await collectRoadPieces(features('segment'), ctx);
    let groundPieces: RoadPiece[] = collected.pieces;
    let decks: RoadPiece[] = [];
    if (settings.bridges.enabled) ({ ground: groundPieces, decks } = splitDecks(collected.pieces, ctx, water.cut));
    let ribbons = await bufferRoads(groundPieces, ctx);
    groundRoads = groundPieces;
    if (decks.length) {
      const bridges = await buildBridges(decks, ctx, { groundRoads: ribbons.footprint, cutWater: water.cut });
      bridgeSolids = bridges.solids;
      pierGround = bridges.pierGround;
      deckPieces = bridges.decks;
      if (bridges.demoted.length) {
        groundRoads = [...groundPieces, ...bridges.demoted];
        ribbons = await bufferRoads(groundRoads, ctx);
      }
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

  // What stands in cut water and basins. The water is cut around all of it.
  // With supports on it stands on ground kept under it, and with them off
  // it's built down through the water itself (wading.ts). Mapped piers,
  // quays and dams are ground either way.
  const noGround = union(water.cut, water.basins);
  const supportsOn = settings.supports;
  const structures: MultiPolygon[] = [];
  const kept: EditContext['kept'] = { roads: [], buildings: [], piers: [], decks: [], airport: [] };
  if (roads.footprint.length) structures.push((kept.roads = intersection(roads.footprint, noGround)));
  if (airport.length && kept.roads.length) kept.airport = intersection(airport, noGround);
  // Every pier in the water, not only those whose middle is: one on the bank
  // reaching into a river, or standing in a pond, stood on air.
  const pierFootprints = bridgeSolids.flatMap((solid) => (solid.role === 'pier' ? [solid.polygon] : []));
  if (pierFootprints.length && noGround.length) structures.push((kept.piers = intersection(pierFootprints, noGround)));
  const mappedDecks: Polygon[] = [];
  for (const type of ['infrastructure', 'land', 'land_use'] as SourceType[]) {
    for (const feature of features(type)) {
      if (isWaterDeck(type, feature)) mappedDecks.push(...projectPolygons(feature.geometry, projection));
    }
  }
  if (mappedDecks.length) structures.push((kept.decks = intersection(clipToBox(mappedDecks, cropBox), water.cut)));

  // ---------------------------------------------------------------- buildings
  progress.begin('buildings', 'Building footprints and roofs', 0.55, 0.2);
  const buildings = settings.buildings.enabled
    ? await buildBuildings(features('building'), features('building_part'), ctx, {
        clipAway: [],
        lidar: input.lidar ? { records: input.lidar.records, preferLidar: settings.lidar.preferLidar } : undefined,
      })
    : { solids: [] as PrismSolid[], measured: [] as Solid[], rock: [] as Solid[], footprint: [] as MultiPolygon };
  if (buildings.footprint.length && noGround.length) {
    structures.push((kept.buildings = intersection(buildings.footprint, noGround)));
  }
  const standing = union(...structures);
  const cutFinal = standing.length ? difference(water.cut, standing) : water.cut;
  const basinFinal = standing.length ? difference(water.basins, standing) : water.basins;
  // Every body lies inside the cut or basin set, so a body less what stands
  // in it is its share of cutFinal or basinFinal, found from the rings near
  // it only.
  const standingSet = new ClipSet([standing]);
  const unsupported = (polygon: Polygon) => differenceSet([polygon], standingSet);
  // Where there's no ground: the water, and with supports off what stands in it.
  const groundKept = supportsOn ? standing : kept.decks;
  const groundSet = supportsOn ? standingSet : new ClipSet([groundKept]);
  const cutOpen = supportsOn ? cutFinal : groundKept.length ? difference(water.cut, groundKept) : water.cut;
  const basinOpen = supportsOn ? basinFinal : groundKept.length ? difference(water.basins, groundKept) : water.basins;
  ctx.stats.ground_kept_under_structures_mm2 = Math.round(multiArea(groundKept) * 10) / 10;

  // --------------------------------------------------------------- land cover
  progress.begin('land', 'Draping parks and land cover', 0.75, 0.1);
  const landRegions: Partial<Record<SurfaceCategory, MultiPolygon>> = {};
  const land = settings.land.enabled
    ? await buildLand(
        data,
        ctx,
        {
          water: water.all,
          roads: roads.footprint,
          buildings: buildings.footprint,
          bridgeLines: roads.bridgeLines,
        },
        landRegions,
      )
    : null;

  // ----------------------------------------------------------- terrain solid
  progress.begin('terrain', 'Closing the terrain solid', 0.85, 0.03);
  const hf = ctx.heightfield;
  // Cut water and basins less the ground kept under structures. The water's
  // underside is the top of a terrain floor, which the base runs under like
  // any other ground, or null for cut water running down to the base.
  // A body's floor runs under what stands in it on its own.
  const settled: ({ polygons: Polygon[]; floor: Polygon[]; bottom: number | null } | null)[] = [];
  for (let i = 0; i < water.bodies.length; i++) {
    const body = water.bodies[i];
    if (i % 32 === 0) await progress.checkpoint(0.5 * (i / water.bodies.length));
    if (body.kind === 'sheet') {
      settled.push(null);
      continue;
    }
    const polygons = unsupported(body.polygon);
    settled.push({ polygons, floor: supportsOn ? polygons : differenceSet([body.polygon], groundSet), bottom: waterBottom(body, settings) });
  }

  const ground = dropSmall(difference(ctx.cropSet, union(cutOpen, basinOpen)), 0.01);
  // Beaches slope the ground itself down to the water. Everything draped on
  // the grid is laid out by now, so what isn't beach can keep its ground.
  const beaches =
    land && settings.land.taperBeaches
      ? shapeBeaches(hf, {
          cut: water.bodies.flatMap((body, i) => (body.kind === 'cut' && settled[i]!.polygons.length ? [{ polygons: settled[i]!.polygons, top: body.top }] : [])),
          crop: ctx.cropSet,
          ground,
          sand: land.sand,
          blockers: [
            ...roads.footprint,
            ...buildings.footprint,
            ...bridgeSolids.map((solid) => solid.polygon),
            ...pierGround,
            ...basinFinal,
            ...water.sheets,
          ],
          cover: settings.land.priority.filter((category) => category !== 'sand').flatMap((category) => land[category]),
          width: settings.land.beachWidthMm,
        })
      : null;
  if (beaches && land) {
    land.sand = beaches.sand;
    ctx.stats.beach_sand_added_mm2 = Math.round(beaches.filled * 10) / 10;
    ctx.stats.beach_points_lowered = beaches.lowered;
  }

  let lowest = Infinity;
  for (const polygon of ground) {
    for (const n of hf.nodesInside(polygon)) lowest = Math.min(lowest, hf.values[n]);
    for (const ring of polygon) for (const [x, y] of ring) lowest = Math.min(lowest, hf.heightAt(x, y));
  }
  for (const entry of settled) if (entry?.bottom != null && entry.floor.length) lowest = Math.min(lowest, entry.bottom);
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
    for (const polygon of entry.floor) {
      terrainSolids.push({ kind: 'prism', role: 'terrain', polygon, top: entry.bottom, bottom: baseZ, drape: 0 });
    }
  }
  layers.push({ id: 'terrain', name: 'Terrain', role: 'terrain', solids: terrainSolids });
  // With supports off, what stands in the water goes down to the floor under it, or the base.
  const embed = settings.land.embedMm;
  const wading = supportsOn
    ? null
    : new Wading(settled.flatMap((entry) => (entry ? [{ polygons: entry.floor, footing: entry.bottom !== null ? entry.bottom - embed : baseZ }] : [])));
  const wade = (solid: Solid): Solid[] => (wading && solid.kind === 'prism' ? wading.wade(solid) : [solid]);

  // -------------------------------------------------------------- water fill
  if (settings.water.enabled) {
    const fills: Solid[] = [];
    for (let i = 0; i < water.bodies.length; i++) {
      const body = water.bodies[i];
      const entry = settled[i];
      if (i % 32 === 0) await progress.checkpoint(0.5 + 0.5 * (i / water.bodies.length));
      const key = body.source ? `w:${body.source}` : undefined;
      if (key) describeObject(ctx, key, { kind: 'water', name: body.name, detail: WATER_KINDS[body.kind] });
      if (entry) {
        for (const polygon of entry.polygons) {
          fills.push({ kind: 'prism', role: 'water', polygon, top: body.top, bottom: entry.bottom ?? baseZ, drape: 0, key });
        }
      } else {
        const bottom = Math.max(waterBottom(body, settings)!, baseZ + 0.05);
        fills.push({ kind: 'prism', role: 'water', polygon: body.polygon, top: body.top, bottom, drape: 0, key });
      }
    }
    if (fills.length) layers.push({ id: 'water', name: 'Water', role: 'water', solids: fills });
  }

  // ---------------------------------------------------------------- land cover
  if (land) {
    const rise = settings.land.riseMm;
    const embed = settings.land.embedMm;
    const top = (x: number, y: number) => hf.heightAt(x, y) + rise;
    const bottom = (x: number, y: number) => hf.heightAt(x, y) - embed;
    for (const category of settings.land.priority) {
      const polygons = land[category];
      if (!polygons.length) continue;
      layers.push({
        id: `land-${category}`,
        name: LAND_NAMES[category],
        role: LAND_ROLES[category],
        solids: polygons.map((polygon) => ({ kind: 'prism', role: LAND_ROLES[category], polygon, top, bottom, drape: drapeStep, lattice: drapeStep > 0 ? hf.lattice : undefined })),
      });
    }
  }

  // --------------------------------------------------------------------- roads
  if (settings.roads.enabled) {
    const thickness = settings.roads.thicknessMm;
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
      layers.push({ id, name, role, solids: polygons.flatMap((polygon) => wade({ kind: 'prism', role, polygon, top, bottom, drape: drapeStep, lattice })) });
    }
  }

  const decks = bridgeSolids.filter((s) => s.role === 'bridge');
  const piers = bridgeSolids.filter((s) => s.role === 'pier').flatMap(wade);
  if (decks.length) layers.push({ id: 'bridges', name: 'Bridges', role: 'bridge', solids: decks });
  if (piers.length) layers.push({ id: 'piers', name: 'Bridge Piers', role: 'pier', solids: piers });

  // ---------------------------------------------------------------- buildings
  const buildingSolids: Solid[] = [...buildings.solids, ...buildings.measured].flatMap(wade);
  if (buildingSolids.length) layers.push({ id: 'buildings', name: 'Buildings', role: 'building', solids: buildingSolids });
  if (buildings.rock.length) layers.push({ id: 'lidar-rock', name: 'Rock (LiDAR)', role: 'rock', solids: buildings.rock });

  // --------------------------------------------------------------------- trees
  if (settings.trees.enabled) {
    progress.begin('trees', 'Planting trees', 0.88, 0.04);
    const trees = await buildTrees(data, ctx, {
      roads: roads.footprint,
      structures: [...buildings.footprint, ...decks.map((deck) => deck.polygon)],
      noGround: union(cutOpen, basinOpen, water.sheets),
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
  const edit: EditContext = {
    heightAt: (x, y) => hf.heightAt(x, y),
    heightfield: hf,
    roads: groundRoads,
    // Recorded with the water off too, since the recesses stay.
    bodies: water.bodies.map((body, i): EditWater => {
      const entry = settled[i];
      return {
        key: body.source ? `w:${body.source}` : undefined,
        kind: body.kind,
        polygon: body.polygon,
        water: entry ? entry.polygons : [body.polygon],
        floors: entry ? entry.floor : [],
        top: body.top,
        bed: body.bed,
        floor: entry ? entry.bottom : null,
        bottom: entry ? (entry.bottom ?? baseZ) : Math.max(waterBottom(body, settings)!, baseZ + 0.05),
      };
    }),
    noGround,
    kept,
    terrain: { ground },
    decks: deckPieces,
    objects: ctx.objects!,
    land: land ? { regions: landRegions, water: water.all } : undefined,
  };
  return { layers, outline, crop: [crop], baseZ, mmPerMetre, stats: ctx.stats, warnings: ctx.warnings, edit };
}
