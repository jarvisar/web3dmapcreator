// Random edits on a real area, checked for what someone printing it would run
// into: every exported part closed and finite, in one plate and in sections,
// no building part left standing on air, nothing in the water standing on
// air with the water left out, and the export the same as what the viewer
// shows, colour by colour. A failing step's edits are written as an
// options file, so `scripts/generate.ts --options <file>` rebuilds it.
//
//   npx tsx scripts/fuzz-edits.ts --preset "Chicago - The Loop (small)" [--steps 40] [--seed 1]
//     [--check-every 5] [--trees] [--bridges] [--no-supports] [--through] [--skip-thin] [--widen-thin] [--shape circle] [--rotation 30] [--lidar] [--lidar-only [--lidar-water cut|layer]]
//     [--route file.gpx] (routes in the model, which the edits remove and recolour too)
//
// --selftest exports without the last step's edits, which every check has to
// catch, to show the checks still catch something.
//
// Overture and elevation downloads are kept in out/fuzz-cache, LiDAR in out/lidar-cache.

import { normalizeArea } from '../src/app/lib/area';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { PRESET_GROUPS } from '../src/app/data/presets';
import { encodeOptions } from '../src/app/state/options';
import { defaultSvgSettings } from '../src/app/svgmap/settings';
import { entryColour } from '../src/app/viewer/shown';
import { fetchDem } from '../src/core/data/dem';
import { setByteCache } from '../src/core/data/http';
import { fetchOverture } from '../src/core/data/overture';
import { fetchRaceways, withRaceways } from '../src/core/data/raceways';
import { fixedCellLimit, reportedMemoryGb, requestedCell } from '../src/core/dsm/grid';
import { surfaceModel } from '../src/core/dsm/model';
import { prepareSurface } from '../src/core/dsm/prepare';
import { lidarRequest, prepareLidar } from '../src/core/lidar/prepare';
import { roadLines } from '../src/core/edit/lines';
import { addSplit, blockBounds, removeSplit, roadEdits, roadKey, writeRoads } from '../src/core/edit/blocks';
import { EditSession, excludedParts, SHAPES_PART, type EditUpdate, type ObjectMesh } from '../src/core/edit/session';
import { tinHeight } from '../src/core/edit/stand';
import { tinBounds } from '../src/core/geometry/cap';
import { emptyEdits, sanitizeEdits, SHAPE_KINDS, type AddedShape, type ModelEdits, type ObjectEdit } from '../src/core/edit/types';
import { areaFromBounds, effectiveScale, parseBoundsText } from '../src/core/geo/area';
import { Projection } from '../src/core/geo/projection';
import { boxesOverlap, intersection, multiArea, pointInPolygon, ringBounds } from '../src/core/geometry/polygon';
import type { CapSolid, PrismSolid } from '../src/core/geometry/solid';
import { edgeReport, signedVolume } from '../src/core/geometry/validate';
import { interiorPoints } from '../src/core/terrain/heightfield';
import { Progress } from '../src/core/pipeline/context';
import { dataPlan } from '../src/core/pipeline/dataPlan';
import { dataBoundsFor, generateModel, type ModelSpec } from '../src/core/pipeline/generate';
import { meshLayers } from '../src/core/pipeline/mesh';
import { buildPlates } from '../src/core/pipeline/plates';
import { cloneSettings, DEFAULT_EXPORT, DEFAULT_PALETTE, sanitizeSettings, type AreaShape, type ModelSettings } from '../src/core/settings';
import { FONTS } from '../src/core/svgmap/text/fonts';
import { FontLoader } from '../src/core/svgmap/text/loadFont';
import { ROLE_GROUP, type MeshPart } from '../src/core/types';
import { parseTrackFile } from '../src/core/tracks/parse';
import { decodeTrack, encodeTrack, type TrackLines } from '../src/core/tracks/track';
import { folderStore, setUpLidar, threadPool } from './lidar-node';
import { lidarPoolSize, surfacePoolSize } from '../src/worker/lidarPool';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

/** mulberry32: small, fast and the same on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function presetBounds(name: string): string {
  for (const group of PRESET_GROUPS) {
    for (const preset of group.presets) {
      if (preset.name.toLowerCase() !== name.toLowerCase()) continue;
      const b = preset.bounds;
      return `${b.west},${b.south},${b.east},${b.north}`;
    }
  }
  throw new Error(`Unknown preset: ${name}`);
}

const TEXTS = ['Chicago', 'HOME', 'Race Day 2026', 'i', '', ' ', 'ÅÉÎ øß', '日本語', '🏁 Finish', 'W'.repeat(40), 'a.b-c_d'];
const COLOURS = ['#E4002B', '#0057B8', '#FF8200', '#7A3E9D', '#009A44', '#E0A800', '#00A3AD', '#D62598', '#FFFFFF', '#000000'];
const GROUPS = ['buildings', 'roads', 'water', 'green', 'terrain', 'sand'];
const CLEARANCE_MM = 0.2;

/** Routes from --route files, stored and read back as the app does. */
function routes(): TrackLines[] {
  const out: TrackLines[] = [];
  process.argv.forEach((value, i) => {
    if (value !== '--route' || !process.argv[i + 1]) return;
    const bytes = readFileSync(process.argv[i + 1]);
    for (const track of parseTrackFile(process.argv[i + 1], bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)) {
      out.push({ id: `route${out.length + 1}`, name: track.name, lines: decodeTrack({ lines: encodeTrack(track.lines) }) });
    }
  });
  return out;
}

async function build(area: ReturnType<typeof areaFromBounds>, settings: ModelSettings): Promise<ModelSpec> {
  const tracks = routes();
  const progress = new Progress();
  if (settings.modelSource === 'lidar') {
    const cacheDir = 'out/lidar-cache';
    setUpLidar(cacheDir);
    const pool = threadPool(surfacePoolSize(), cacheDir);
    try {
      const scale = effectiveScale(area, settings.scale);
      const cell = requestedCell(settings.lidarModel, scale, area.widthM, area.heightM);
      const maxCells = settings.lidarModel.cellMode === 'metres' ? fixedCellLimit(reportedMemoryGb(totalmem())) : undefined;
      const surface = await prepareSurface({ area, cellM: cell, maxCells, runner: pool });
      return await surfaceModel({ area, settings, surface, progress, runTile: (tile) => pool.tile(tile), concurrency: pool.concurrency, releaseLayers: true, tracks });
    } finally {
      pool.close();
    }
  }
  const bounds = dataBoundsFor(area);
  const plan = dataPlan(settings, bounds);
  const [data, dem, raceways] = await Promise.all([
    fetchOverture({ bounds, types: plan.types, keep: plan.keep }),
    fetchDem({ bounds, targetSpacingM: Math.max(area.widthM, area.heightM) / settings.terrain.resolution }),
    plan.raceways ? fetchRaceways(bounds) : Promise.resolve(null),
  ]);
  let lidar;
  if (settings.lidar.enabled && settings.buildings.enabled) {
    setUpLidar('out/lidar-cache');
    const pool = threadPool(lidarPoolSize(), 'out/lidar-cache');
    try {
      lidar = await prepareLidar({ bounds, ...lidarRequest(area, settings), buildings: data.features.building ?? [], parts: data.features.building_part ?? [], land: data.features.land ?? [], runner: pool });
    } finally {
      pool.close();
    }
  }
  return generateModel({ area, settings, data: withRaceways(data, raceways), elevation: dem, progress, lidar, tracks });
}

/** Signed volume of a mesh's triangles from `from` to `to`. */
function volume(positions: Float32Array, indices: Uint32Array, from = 0, to = indices.length / 3): number {
  let sum = 0;
  for (let t = from; t < to; t++) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;
    sum +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return sum / 6;
}

async function main() {
  const seed = Number(arg('seed') ?? 1);
  const steps = Number(arg('steps') ?? 40);
  const checkEvery = Number(arg('check-every') ?? 5);
  const presetName = arg('preset') ?? 'Chicago - The Loop (small)';
  const rand = random(seed);
  // Its own stream, so a seed still makes the same edits.
  const hideRand = random(seed + 0x9e3779b9);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const chance = (p: number) => rand() < p;

  setByteCache(folderStore('out/fuzz-cache'));
  const area = areaFromBounds(parseBoundsText(presetBounds(presetName)), (arg('shape') as AreaShape) ?? 'rectangle');
  if (arg('rotation')) area.rotationDeg = Number(arg('rotation'));
  let settings = cloneSettings();
  if (flag('trees')) settings.trees.enabled = true;
  if (flag('bridges')) settings.bridges.enabled = true;
  if (flag('no-supports')) settings.supports = false;
  if (flag('through')) settings.water.mode = 'through';
  if (flag('skip-thin')) settings.water.skipThinGround = true;
  if (flag('widen-thin')) settings.water.widenThinGround = true;
  if (flag('lidar')) settings.lidar.enabled = true;
  if (flag('lidar-only')) settings.modelSource = 'lidar';
  const lidarWater = arg('lidar-water');
  if (lidarWater === 'cut' || lidarWater === 'layer') settings.lidarModel.waterMode = lidarWater;
  settings = sanitizeSettings(settings);

  const t0 = performance.now();
  const spec = await build(area, settings);
  console.log(`${presetName}, seed ${seed}: generated in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (!spec.edit) throw new Error('This model cannot be edited');
  const projection = new Projection(area.center, area.rotationDeg, spec.mmPerMetre);
  const fonts = new FontLoader(async (path) => {
    const bytes = readFileSync(join('public', path));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });
  const session = new EditSession(spec, settings, projection, { load: (id) => fonts.load(id, null) });
  const facts = session.describe();
  const keysOf = (kind: string) => Object.keys(facts).filter((key) => facts[key].kind === kind);
  const buildings = keysOf('building');
  const withParts = buildings.filter((key) => facts[key].parts?.length);
  const water = keysOf('water');
  const bridges = keysOf('bridge');
  const routeKeys = keysOf('route');
  const trees = [...new Set(spec.layers.flatMap((l) => l.solids.map((s) => s.key ?? '')).filter((key) => key.startsWith('t:')))];
  // Points in cut water and basins, to put shapes and roads in.
  const wetPoints = [
    ...spec.edit.bodies.filter((b) => b.kind !== 'sheet').map((b) => b.polygon),
    ...(spec.edit.surfaceWater ?? []).flatMap((w) => w.polygons),
  ].flatMap((polygon) => interiorPoints(polygon, 2, 400));
  const lines = spec.edit.roads.length ? roadLines(spec.edit, -spec.baseZ, settings.roads.thicknessMm) : null;
  const roads = lines ? [...new Set(lines.keys)] : [];
  const streets = new Map<string, string[]>();
  lines?.names.forEach((name, i) => {
    if (!name) return;
    const list = streets.get(name) ?? [];
    if (!list.includes(lines.keys[i])) list.push(lines.keys[i]);
    streets.set(name, list);
  });
  const streetNames = [...streets.keys()];
  const box = ringBounds(spec.crop[0]);
  const fontIds = FONTS.map((f) => f.id).filter((id) => id !== 'custom');
  console.log(
    `${buildings.length} buildings (${withParts.length} with parts), ${roads.length} roads, ${bridges.length} bridges, ${water.length} water, ${wetPoints.length} points in it, ${trees.length} trees, ${routeKeys.length} routes`,
  );

  // What the viewer has, as it would after each update.
  const generated = new Map((await meshLayers(spec.layers, { zShift: -spec.baseZ, objects: true })).parts.map((p) => [p.id, p]));
  const objectMeshes = new Map<string, ObjectMesh>();
  const replaced = new Map<string, MeshPart>();
  let hidden = new Set<string>();
  const record = (update: EditUpdate) => {
    if (update.reset) {
      objectMeshes.clear();
      replaced.clear();
    }
    for (const object of update.objects) {
      const id = `${object.part}|${object.key}`;
      if (object.mesh) objectMeshes.set(id, object);
      else objectMeshes.delete(id);
    }
    for (const { id, part } of update.parts) {
      if (part) replaced.set(id, part);
      else replaced.delete(id);
    }
    hidden = new Set(update.hidden);
  };

  // ------------------------------------------------------------ edits
  let edits: ModelEdits = emptyEdits();
  let counter = 0;
  const set = (key: string, patch: ObjectEdit) => {
    edits = { ...edits, objects: { ...edits.objects, [key]: { ...edits.objects[key], ...patch } } };
  };
  const layerId = (): string => {
    if (edits.layers.length && (edits.layers.length >= 6 || chance(0.7))) return pick(edits.layers).id;
    const id = `L${++counter}`;
    edits = { ...edits, layers: [...edits.layers, { id, name: `Layer ${counter}`, hex: pick(COLOURS), line: chance(0.5) ? 'PLA Basic' : 'PLA Matte' }] };
    return id;
  };
  const somewhere = (spread = 0.1): [number, number] => {
    const w = box[2] - box[0];
    const h = box[3] - box[1];
    return projection.modelToGeo(box[0] - w * spread + rand() * w * (1 + 2 * spread), box[1] - h * spread + rand() * h * (1 + 2 * spread));
  };
  const near = ([lon, lat]: [number, number], mm: number): [number, number] => {
    const [x, y] = projection.toModel(lon, lat);
    return projection.modelToGeo(x + (rand() - 0.5) * 2 * mm, y + (rand() - 0.5) * 2 * mm);
  };
  const newShape = (): AddedShape => {
    const kind = pick(SHAPE_KINDS);
    const at = somewhere();
    const points: [number, number][] = [];
    if (kind === 'path' || kind === 'area') {
      const count = 2 + Math.floor(rand() * 7);
      for (let i = 0; i < count; i++) points.push(chance(0.1) && points.length ? points[points.length - 1] : near(at, 30));
    }
    return {
      id: `s${++counter}`,
      kind,
      layer: chance(0.5) ? layerId() : pick(GROUPS),
      at: points[0] ?? at,
      points,
      rotationDeg: rand() * 360,
      sizeMm: pick([0.3, 0.8, 2, 5, 12, 40, 90]) * (0.5 + rand()),
      depthMm: pick([0.5, 2, 8, 30]) * (0.5 + rand()),
      heightMm: 0.1 + rand() * 12,
      liftMm: chance(0.3) ? rand() * 25 : 0,
      followGround: chance(0.5),
      text: pick(TEXTS),
      font: pick(fontIds),
    };
  };
  // Solids of each object as generated, for where a shape put on it lands.
  const layerSolids = new Map<string, PrismSolid[]>();
  for (const layer of spec.layers) {
    for (const solid of layer.solids) {
      if (solid.kind !== 'prism' || !solid.key) continue;
      const list = layerSolids.get(solid.key) ?? [];
      list.push(solid);
      layerSolids.set(solid.key, list);
    }
  }
  const heightAt = spec.edit.heightAt;
  const zOf = (z: PrismSolid['top'], x: number, y: number) => (typeof z === 'number' ? z : z(x, y));
  const raisedShape = (x: number, y: number, top: number): AddedShape => {
    const shape = newShape();
    const kind = pick(['pin', 'box', 'cylinder', 'text'] as const);
    return {
      ...shape,
      kind,
      at: projection.modelToGeo(x, y),
      points: [],
      sizeMm: 0.5 + rand() * (chance(0.2) ? 20 : 3),
      depthMm: 0.5 + rand() * 3,
      heightMm: 0.3 + rand() * 3,
      liftMm: Math.min(300, Math.max(0, Math.round((top - heightAt(x, y)) * 10) / 10)),
      followGround: false,
    };
  };
  const ops: [string, number, () => boolean][] = [
    ['remove building', 3, () => buildings.length > 0 && (set(pick(buildings), { removed: true }), true)],
    ['building height', 3, () => buildings.length > 0 && (set(pick(buildings), { heightM: 2 + rand() ** 2 * 450 }), true)],
    [
      'part edit',
      3,
      () => {
        if (!withParts.length) return false;
        const building = pick(withParts);
        const key = `${building}/${pick(facts[building].parts!).sub}`;
        set(key, chance(0.5) ? { removed: true } : { heightM: 1 + rand() * 150 });
        return true;
      },
    ],
    ['road width', 3, () => roads.length > 0 && (set(pick(roads), { widthMm: 0.2 + rand() * 6 }), true)],
    ['road height', 2, () => roads.length > 0 && (set(pick(roads), { heightMm: 0.1 + rand() * 3 }), true)],
    ['remove road', 2, () => roads.length > 0 && (set(pick(roads), { removed: true }), true)],
    [
      'road block',
      4,
      () => {
        // One block of a road, written as the editor writes it: set, or cleared and carved out of the edit around it.
        if (!roads.length) return false;
        const segment = pick(roads);
        const bounds = blockBounds(roadEdits(edits.objects).get(segment), spec.edit!.junctions?.get(segment));
        const i = Math.floor(rand() * (bounds.length - 1));
        const key = roadKey(segment, bounds[i], bounds[i + 1]);
        const patch = pick<Partial<ObjectEdit>>([
          { layer: layerId() },
          { widthMm: 0.2 + rand() * 6 },
          { heightMm: 0.1 + rand() * 3 },
          { removed: true },
          { layer: undefined },
          { removed: undefined },
          { widthMm: undefined, heightMm: undefined },
        ]);
        edits = { ...edits, objects: writeRoads(edits.objects, [key], patch).objects };
        return true;
      },
    ],
    [
      'split road',
      2,
      () => {
        if (!roads.length) return false;
        const segment = pick(roads);
        const objects = addSplit(edits.objects, segment, 0.02 + rand() * 0.96);
        if (objects) edits = { ...edits, objects };
        return Boolean(objects);
      },
    ],
    [
      'join split',
      1,
      () => {
        const split = [...roadEdits(edits.objects)].filter(([, entry]) => entry.splits.length);
        if (!split.length) return false;
        const [segment, entry] = pick(split);
        const joined = removeSplit(edits.objects, segment, pick(entry.splits), blockBounds(entry, spec.edit!.junctions?.get(segment)));
        if (joined) edits = { ...edits, objects: joined.objects };
        return Boolean(joined);
      },
    ],
    [
      'road range',
      1,
      () => {
        // Any range, overlapping others part way, as a link from another release can bring.
        if (!roads.length) return false;
        const a = rand();
        const b = Math.min(1, a + rand() * 0.6);
        if (b - a < 0.01) return false;
        set(roadKey(pick(roads), a, b), chance(0.5) ? { layer: layerId() } : { removed: true });
        return true;
      },
    ],
    [
      'street to a layer',
      2,
      () => {
        if (!streetNames.length) return false;
        const layer = layerId();
        const widthMm = 0.5 + rand() * 3;
        const heightMm = 0.3 + rand() * 2;
        for (const key of streets.get(pick(streetNames))!) set(key, { layer, widthMm, heightMm });
        return true;
      },
    ],
    [
      'into a layer',
      2,
      () => {
        const pool = [...buildings, ...roads, ...water, ...trees];
        return pool.length > 0 && (set(pick(pool), { layer: layerId() }), true);
      },
    ],
    ['leave out water', 2, () => water.length > 0 && (set(pick(water), chance(0.35) ? { removed: true, hollow: true } : { removed: true }), true)],
    ['bridge width', 2, () => bridges.length > 0 && (set(pick(bridges), { widthMm: 0.2 + rand() * 6 }), true)],
    ['remove bridge', 1, () => bridges.length > 0 && (set(pick(bridges), chance(0.5) ? { removed: true } : { removed: false }), true)],
    [
      'shape in water',
      3,
      () => {
        if (!wetPoints.length) return false;
        const [x, y] = pick(wetPoints);
        const shape = newShape();
        const at = projection.modelToGeo(x, y);
        const points = shape.points.length ? shape.points.map(() => near(at, 15)) : [];
        edits = { ...edits, shapes: [...edits.shapes, { ...shape, at: points[0] ?? at, points }] };
        return true;
      },
    ],
    ['remove tree', 1, () => trees.length > 0 && (set(pick(trees), { removed: true }), true)],
    ['remove route', 1, () => routeKeys.length > 0 && (set(pick(routeKeys), chance(0.7) ? { removed: true } : { removed: undefined }), true)],
    ['route to a layer', 1, () => routeKeys.length > 0 && (set(pick(routeKeys), { layer: layerId() }), true)],
    [
      'shape on a roof',
      2,
      () => {
        // Placed the way the editor does: on the roof where it lands, the lift from the ground there.
        const key = pick(buildings);
        const info = spec.edit!.objects.get(key);
        const pieces = info ? [...(info.ground?.values() ?? [])].flat() : [];
        if (!pieces.length) return false;
        const inside = interiorPoints(pick(pieces), 0.3, 20);
        if (!inside.length) return false;
        const [x, y] = pick(inside);
        const tops = (layerSolids.get(key) ?? []).filter((s) => pointInPolygon(x, y, s.polygon)).map((s) => zOf(s.top, x, y));
        if (!tops.length) return false;
        edits = { ...edits, shapes: [...edits.shapes, raisedShape(x, y, Math.max(...tops))] };
        return true;
      },
    ],
    [
      'shape on a bridge',
      2,
      () => {
        const decks = spec.edit!.decks;
        if (!decks.length) return false;
        const deck = pick(decks);
        if (deck.points.length < 2) return false;
        const i = Math.floor(rand() * (deck.points.length - 1));
        const t = rand();
        const x = deck.points[i][0] + (deck.points[i + 1][0] - deck.points[i][0]) * t;
        const y = deck.points[i][1] + (deck.points[i + 1][1] - deck.points[i][1]) * t;
        edits = { ...edits, shapes: [...edits.shapes, raisedShape(x, y, deck.top(x, y))] };
        return true;
      },
    ],
    ['add shape', 4, () => ((edits = { ...edits, shapes: [...edits.shapes, newShape()] }), true)],
    [
      'change shape',
      3,
      () => {
        if (!edits.shapes.length) return false;
        const target = pick(edits.shapes);
        const fresh = newShape();
        const changes: Partial<AddedShape>[] = [
          { at: near(target.at, 20), points: target.points.map((p) => near(p, 5)) },
          { sizeMm: fresh.sizeMm },
          { heightMm: fresh.heightMm, liftMm: fresh.liftMm },
          { rotationDeg: fresh.rotationDeg },
          { followGround: !target.followGround },
          { text: fresh.text, font: fresh.font },
          { layer: fresh.layer },
        ];
        const patch = pick(changes);
        edits = { ...edits, shapes: edits.shapes.map((s) => (s.id === target.id ? { ...s, ...patch } : s)) };
        return true;
      },
    ],
    [
      'delete shape',
      1,
      () => {
        if (!edits.shapes.length) return false;
        const target = pick(edits.shapes);
        edits = { ...edits, shapes: edits.shapes.filter((s) => s !== target) };
        return true;
      },
    ],
    [
      'delete layer',
      1,
      () => {
        if (!edits.layers.length) return false;
        const gone = pick(edits.layers).id;
        const objects: Record<string, ObjectEdit> = {};
        for (const [key, edit] of Object.entries(edits.objects)) {
          const { layer, ...rest } = edit;
          if (layer !== gone) objects[key] = edit;
          else if (Object.keys(rest).length) objects[key] = rest;
        }
        const shapes = edits.shapes.map((s) => (s.layer === gone ? { ...s, layer: 'buildings' } : s));
        edits = { ...edits, layers: edits.layers.filter((l) => l.id !== gone), objects, shapes };
        return true;
      },
    ],
    [
      'reset one',
      1,
      () => {
        const keys = Object.keys(edits.objects);
        if (!keys.length) return false;
        const gone = pick(keys);
        edits = { ...edits, objects: Object.fromEntries(Object.entries(edits.objects).filter(([key]) => key !== gone)) };
        return true;
      },
    ],
  ];
  const weighted = ops.flatMap((op) => Array.from({ length: op[1] }, () => op));

  // ----------------------------------------------------------- checks
  let problems = 0;
  const outDir = arg('out') ?? 'out/fuzz';
  const slug = presetName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const save = (step: number) => {
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${slug}-seed${seed}-step${step}.json`);
    const options = { output: 'model' as const, settings, palette: DEFAULT_PALETTE, exportSettings: { ...DEFAULT_EXPORT }, svg: defaultSvgSettings() };
    writeFileSync(file, encodeOptions(options, { area: normalizeArea(area), placeName: presetName, fileName: null, edits }));
    console.log(`  saved ${file}: npx tsx scripts/generate.ts --options ${file} --out out/fuzz/repro.3mf`);
  };

  const viewerVolumes = (hiddenParts: ReadonlySet<string> = new Set()): Map<string, number> => {
    const out = new Map<string, number>();
    const add = (colour: string, v: number) => out.set(colour, (out.get(colour) ?? 0) + v);
    const context = { edits, hiddenParts, implicitHidden: hidden, deckAt: (key: string) => facts[key]?.at };
    const ids = new Set([...generated.keys(), ...replaced.keys(), ...[...objectMeshes.values()].map((o) => o.part)]);
    for (const id of ids) {
      const base = replaced.get(id) ?? generated.get(id);
      const overrides = [...objectMeshes.values()].filter((o) => o.part === id && o.mesh);
      const overridden = new Set(overrides.map((o) => o.key));
      const role = base?.role ?? overrides.find((o) => o.role)?.role ?? 'building';
      const own = id.startsWith('layer:') ? id : ROLE_GROUP[role];
      const colourOf = (style: string) => (style === '' ? own : style.startsWith('group:') ? style.slice('group:'.length) : style);
      const sum = (positions: Float32Array, indices: Uint32Array, objects: MeshPart['objects'], key: string | null, isBase: boolean) => {
        const triangles = indices.length / 3;
        const owner = new Int32Array(triangles).fill(-1);
        if (objects) for (let r = 0; r < objects.runs.length; r += 5) owner.fill(objects.runs[r], objects.runs[r + 1], objects.runs[r + 2]);
        let start = 0;
        for (let t = 1; t <= triangles; t++) {
          if (t < triangles && owner[t] === owner[start]) continue;
          const entry = owner[start];
          const style =
            entry < 0
              ? key === null
                ? hiddenParts.has(id)
                  ? null
                  : ''
                : entryColour({ key, sub: '' }, context, false, id)
              : entryColour({ key: objects!.keys[entry], sub: objects!.subs[entry] }, context, isBase && overridden.has(objects!.keys[entry]), id);
          if (style !== null) add(colourOf(style), volume(positions, indices, start, t));
          start = t;
        }
      };
      if (base) sum(base.positions, base.indices, base.objects, null, true);
      for (const o of overrides) sum(o.mesh!.positions, o.mesh!.indices, o.mesh!.objects, o.mesh!.objects ? null : o.key, false);
    }
    return out;
  };

  const exportVolumes = (parts: MeshPart[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const part of parts) {
      const colour = part.id.startsWith('layer:') ? part.id.replace(/:water$/, '') : part.id.startsWith('added-') ? part.id.slice('added-'.length) : ROLE_GROUP[part.role];
      out.set(colour, (out.get(colour) ?? 0) + signedVolume(part.positions, part.indices));
    }
    return out;
  };

  const floating = (model: ModelSpec): Set<string> => {
    const out = new Set<string>();
    const byKey = new Map<string, PrismSolid[]>();
    for (const layer of model.layers) {
      for (const solid of layer.solids) {
        if (solid.kind !== 'prism' || !solid.key?.startsWith('b:')) continue;
        const list = byKey.get(solid.key) ?? [];
        list.push(solid);
        byKey.set(solid.key, list);
      }
    }
    const extent = (z: PrismSolid['top'], solid: PrismSolid, pickHigh: boolean) => {
      if (typeof z === 'number') return z;
      const values = solid.polygon[0].map(([x, y]) => z(x, y));
      return pickHigh ? Math.max(...values) : Math.min(...values);
    };
    for (const [key, solids] of byKey) {
      for (const solid of solids) {
        const bottom = solid.bottom;
        if (typeof bottom !== 'number') continue;
        const ground = Math.max(...solid.polygon[0].map(([x, y]) => heightAt(x, y)));
        if (bottom - ground < CLEARANCE_MM + 1e-6) continue;
        const bounds = ringBounds(solid.polygon[0]);
        const held = solids.some(
          (other) =>
            other !== solid &&
            extent(other.top, other, true) >= bottom - CLEARANCE_MM - 1e-6 &&
            extent(other.bottom, other, false) < bottom &&
            boxesOverlap(bounds, ringBounds(other.polygon[0])) &&
            multiArea(intersection([solid.polygon], [other.polygon])) > 1e-4,
        );
        if (!held) out.add(`${key}/${solid.sub ?? ''}`);
      }
    }
    return out;
  };
  const floatingBefore = floating(spec);
  if (floatingBefore.size) console.log(`  ${floatingBefore.size} building parts already float as generated, and aren't counted`);

  // Whatever stands in cut water or a basin has to stand on something other
  // than the water, since the water may be left out in the slicer: ground,
  // a floor, another solid, or the base. Bridge decks span between piers.
  const wetBoxes = [
    ...spec.edit.bodies.filter((b) => b.kind !== 'sheet').map((b) => b.polygon),
    // A LiDAR only model's water, cut out or a layer on a floor.
    ...(spec.edit.surfaceWater ?? []).flatMap((w) => w.polygons),
  ].map((polygon) => ({ polygon, box: ringBounds(polygon[0]) }));
  const unheld = (model: ModelSpec): string[] => {
    const out: string[] = [];
    const holders: { solid: PrismSolid; box: ReturnType<typeof ringBounds> }[] = [];
    const checked: { solid: PrismSolid; layer: string }[] = [];
    for (const layer of model.layers) {
      const role = layer.role;
      for (const solid of layer.solids) {
        if (solid.kind !== 'prism' || role === 'water') continue;
        const box = ringBounds(solid.polygon[0]);
        holders.push({ solid, box });
        if (role === 'terrain' || role === 'bridge' || solid.role === 'water' || solid.role === 'bridge' || solid.role === 'terrain') continue;
        if (!wetBoxes.some((w) => boxesOverlap(w.box, box))) continue;
        checked.push({ solid, layer: layer.id });
      }
    }
    for (const { solid, layer } of checked) {
      // One point well inside the solid, in the water.
      const inside = interiorPoints(solid.polygon, 0.3, 50).find(([x, y]) => wetBoxes.some((w) => pointInPolygon(x, y, w.polygon)));
      if (!inside) continue;
      const [x, y] = inside;
      const bottom = zOf(solid.bottom, x, y);
      if (bottom <= model.baseZ + 1e-6) continue;
      const held = holders.some(({ solid: other, box }) => {
        if (other === solid || x < box[0] || x > box[2] || y < box[1] || y > box[3] || !pointInPolygon(x, y, other.polygon)) return false;
        return zOf(other.bottom, x, y) <= bottom + 0.05 && zOf(other.top, x, y) >= bottom - 0.05;
      });
      if (!held) out.push(`${layer} ${solid.key ?? solid.role} at ${x.toFixed(2)}, ${y.toFixed(2)}`);
    }
    return out;
  };
  // No part of an added shape may hang in the air: it's on the ground, on
  // the base, or on something that holds it. A shape reaching under a high
  // bridge span once hung below the deck there.
  const shapesFloating = (model: ModelSpec): string[] => {
    const out: string[] = [];
    const solids: { solid: PrismSolid; box: ReturnType<typeof ringBounds> }[] = [];
    // Measured roofs, which hold a shape raised onto them like any roof.
    const caps: { cap: CapSolid; box: ReturnType<typeof ringBounds> }[] = [];
    for (const layer of model.layers) {
      if (layer.role === 'water') continue;
      for (const solid of layer.solids) {
        if (solid.kind === 'prism' && solid.role !== 'water') solids.push({ solid, box: ringBounds(solid.polygon[0]) });
        else if (solid.kind === 'cap') caps.push({ cap: solid, box: tinBounds(solid) });
      }
    }
    for (const { solid } of solids) {
      if (!solid.key?.startsWith('s:')) continue;
      for (const [x, y] of interiorPoints(solid.polygon, 0.5, 12)) {
        const bottom = zOf(solid.bottom, x, y);
        if (bottom <= model.baseZ + 1e-6 || bottom <= heightAt(x, y) + 0.05) continue;
        const held =
          solids.some(({ solid: other, box }) => {
            if (other === solid || x < box[0] || x > box[2] || y < box[1] || y > box[3] || !pointInPolygon(x, y, other.polygon)) return false;
            return zOf(other.bottom, x, y) <= bottom + 0.05 && zOf(other.top, x, y) >= bottom - 0.05;
          }) ||
          caps.some(({ cap, box }) => {
            if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) return false;
            const top = tinHeight(cap, x, y);
            return cap.bottom <= bottom + 0.05 && top >= bottom - 0.05;
          });
        if (!held) {
          out.push(`${solid.key} at ${x.toFixed(2)}, ${y.toFixed(2)} is ${(bottom - heightAt(x, y)).toFixed(2)} mm over the ground on nothing`);
          break;
        }
      }
    }
    return out;
  };

  const unheldBefore = new Set(unheld(spec));
  if (unheldBefore.size) console.log(`  ${unheldBefore.size} solids in water already stand on nothing but water as generated, and aren't counted`);

  const check = async (step: number): Promise<string[]> => {
    const found: string[] = [];
    const t = performance.now();
    const edited = await session.edited(flag('selftest') ? previous : edits, DEFAULT_PALETTE);
    for (const multiPlate of [false, true]) {
      const { plates, failed } = await buildPlates(edited, { multiPlate, sectionWidthMm: 80, sectionHeightMm: 80, bedWidth: 256, bedDepth: 256 });
      if (failed) found.push(`${failed} solids failed to mesh (${multiPlate ? 'sections' : 'one plate'})`);
      if (failed && !multiPlate) {
        // Which ones, one at a time.
        for (const layer of edited.layers) {
          for (const solid of layer.solids) {
            if ((await meshLayers([{ ...layer, solids: [solid] }], { zShift: -edited.baseZ })).failed) {
              found.push(`  ${layer.id} ${solid.key ?? solid.role} ${solid.kind === 'prism' ? `${JSON.stringify(solid.polygon).slice(0, 300)}` : solid.kind}`);
            }
          }
        }
      }
      for (const plate of plates) {
        for (const part of plate.parts) {
          if (!part.positions.every(Number.isFinite)) found.push(`${plate.name} ${part.name}: positions that aren't finite`);
          const report = edgeReport(part.indices, part.positions.length / 3);
          if (report.open || report.repeated) found.push(`${plate.name} ${part.name}: ${report.open} open and ${report.repeated} repeated edges`);
          if (signedVolume(part.positions, part.indices) <= 0) found.push(`${plate.name} ${part.name}: no volume, or turned inside out`);
        }
      }
      if (!multiPlate) {
        const compare = (shown: Map<string, number>, exported: Map<string, number>, suffix: string) => {
          for (const colour of new Set([...shown.keys(), ...exported.keys()])) {
            const a = shown.get(colour) ?? 0;
            const b = exported.get(colour) ?? 0;
            if (Math.abs(a - b) > Math.max(0.5, 0.003 * Math.max(Math.abs(a), Math.abs(b)))) {
              found.push(`${colour}: the viewer shows ${a.toFixed(1)} mm³, the export has ${b.toFixed(1)} mm³${suffix}`);
            }
          }
        };
        const parts = plates[0]?.parts ?? [];
        compare(viewerVolumes(), exportVolumes(parts), '');
        // Some of what the parts list offers hidden, which the download leaves out.
        const offered = [...generated.keys(), ...edits.layers.map((l) => `layer:${l.id}`), SHAPES_PART];
        const hiddenIds = offered.filter(() => hideRand() < 0.3);
        if (hiddenIds.length) {
          const excluded = new Set(excludedParts(edited, hiddenIds));
          compare(viewerVolumes(new Set(hiddenIds)), exportVolumes(parts.filter((p) => !excluded.has(p.id))), ` with ${hiddenIds.join(', ')} hidden`);
        }
      }
    }
    for (const part of floating(edited)) if (!floatingBefore.has(part)) found.push(`${part} floats`);
    for (const solid of unheld(edited)) if (!unheldBefore.has(solid)) found.push(`${solid} stands on nothing but water`);
    found.push(...shapesFloating(edited));
    console.log(`  check after step ${step}, ${((performance.now() - t) / 1000).toFixed(1)} s: ${found.length ? `${found.length} problems` : 'ok'}`);
    return found;
  };

  // ------------------------------------------------------------- run
  let previous = edits;
  for (let step = 1; step <= steps; step++) {
    previous = edits;
    const done: string[] = [];
    const count = 1 + Math.floor(rand() * 3);
    for (let tries = 0; done.length < count && tries < 20; tries++) {
      const [name, , run] = pick(weighted);
      if (run()) done.push(name);
    }
    edits = sanitizeEdits(edits);
    const t = performance.now();
    let update: EditUpdate;
    try {
      update = await session.update(edits, step);
    } catch (error) {
      problems++;
      console.log(`step ${step}: ${done.join(', ')}: update threw ${error instanceof Error ? error.stack : error}`);
      save(step);
      continue;
    }
    record(update);
    const notes = Object.keys(update.notes).length;
    console.log(
      `step ${step}: ${done.join(', ')} (${((performance.now() - t) / 1000).toFixed(2)} s, ${update.objects.length} objects, ${update.parts.length} parts${notes ? `, ${notes} notes` : ''}${update.warnings.length ? `, warnings: ${update.warnings.join(' | ')}` : ''})`,
    );
    if (step % checkEvery === 0 || step === steps) {
      const found = await check(step);
      if (found.length) {
        problems += found.length;
        for (const problem of found.slice(0, 12)) console.log(`  PROBLEM ${problem}`);
        if (found.length > 12) console.log(`  and ${found.length - 12} more`);
        save(step);
      }
    }
  }

  // Everything undone takes the viewer back to the generated model.
  edits = emptyEdits();
  record(await session.update(edits, steps + 1));
  if (objectMeshes.size || replaced.size || hidden.size) {
    problems++;
    console.log(`PROBLEM undoing everything left ${objectMeshes.size} objects, ${replaced.size} parts and ${hidden.size} hidden in the viewer`);
  }
  console.log(problems ? `${problems} problems` : 'no problems');
  process.exit(problems ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
