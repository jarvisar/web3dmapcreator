// Generate a model from the command line, for testing the pipeline on real
// areas without the browser.
//
//   npx tsx scripts/generate.ts --bbox -87.64124,41.87626,-87.61552,41.89041 --out out/loop.3mf
//   npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --format stl-zip
//
// Options: --bbox w,s,e,n | --preset name | --area lon,lat,width,height[,rotation]
// (metres, as in a share link), --shape rectangle|rounded|circle|hexagon,
// --rotation deg, --scale mm-per-metre, --fit mm, --format bambu|prusa|3mf|stl-zip|stl,
// --printer P1S, --multi-plate, --section mm, --bridges, --trees, --satellite-cover
// (satellite land cover as surfaces), --flat, --out path,
// --settings path.json (merged onto the defaults), --no-filter (download every row,
// for checking that the row filter drops nothing generation uses), --lidar (measure
// buildings from streamed LiDAR), --lidar-cache dir (default out/lidar-cache),
// --lidar-records path.json (write the measured records, for comparing runs),
// --lidar-threads n (batches read and measured at once, 1 to stay in this thread),
// --lidar-only (the whole model from a LiDAR survey, no map data), --detail mm (its
// printed cell size), --cut-water (cut large water through the base, or away in a
// LiDAR only model), --water-layer (a LiDAR only model's water as a thin layer),
// --no-map-water (a LiDAR only model's water from the survey alone), --surface-out
// dir (write its grid layers as raw binaries), --reread (read its blocks again
// instead of from their checkpoints, after changing how blocks are read),
// --options path.json (an options file exported from the app with its map area:
// the area, settings, colours, export options and 3D edits, which the other
// flags override), --no-edits (leave the options file's edits out).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cellSize } from '../src/core/dsm/grid';
import { surfaceModel } from '../src/core/dsm/model';
import { prepareSurface, setSurfaceStore } from '../src/core/dsm/prepare';
import { fetchDem } from '../src/core/data/dem';
import { fetchOverture } from '../src/core/data/overture';
import { fetchRaceways, withRaceways } from '../src/core/data/raceways';
import { exportPlates } from '../src/core/export';
import { BAMBU_MAX_PLATES } from '../src/core/export/sections';
import { areaFromBounds, effectiveScale, parseBoundsText } from '../src/core/geo/area';
import { prepareLidar, type PreparedLidar } from '../src/core/lidar/prepare';
import { lidarPoolSize, surfacePoolSize } from '../src/worker/lidarPool';
import { setUpLidar, threadPool } from './lidar-node';
import { Progress } from '../src/core/pipeline/context';
import { dataPlan } from '../src/core/pipeline/dataPlan';
import { dataBoundsFor, generateModel } from '../src/core/pipeline/generate';
import { PRESET_GROUPS } from '../src/app/data/presets';
import { meshLayers, partsBounds } from '../src/core/pipeline/mesh';
import { buildPlates } from '../src/core/pipeline/plates';
import { edgeReport } from '../src/core/geometry/validate';
import { EditSession } from '../src/core/edit/session';
import { editCount, hasEdits, type ModelEdits } from '../src/core/edit/types';
import { Projection } from '../src/core/geo/projection';
import type { ModelSpec } from '../src/core/pipeline/generate';
import { FontLoader } from '../src/core/svgmap/text/loadFont';
import { decodeOptions, type Options } from '../src/app/state/options';
import {
  cloneSettings,
  DEFAULT_PALETTE,
  printerByKey,
  sanitizeSettings,
  type AreaShape,
  type AreaSpec,
  type ExportFormat,
  type ModelSettings,
  type Palette,
} from '../src/core/settings';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

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

function merge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return (patch as T) ?? base;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = typeof v === 'object' && v && !Array.isArray(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

function exactArea(text: string, shape: AreaShape): AreaSpec {
  const [lon, lat, widthM, heightM, rotationDeg = 0] = text.split(',').map(Number);
  if (![lon, lat, widthM, heightM, rotationDeg].every(Number.isFinite)) throw new Error('Pass --area lon,lat,width,height[,rotation]');
  return { center: [lon, lat], widthM, heightM, rotationDeg, shape, cornerRadius: 0.1 };
}

const options: Options | null = arg('options') ? decodeOptions(readFileSync(arg('options')!, 'utf8')) : null;
const palette: Palette = options?.palette ?? DEFAULT_PALETTE;

/** Export options from the flags, then the options file, then the defaults. */
function exportChoices() {
  const saved = options?.exportSettings;
  const format = (arg('format') as ExportFormat) ?? saved?.format ?? 'bambu';
  const printer = printerByKey(arg('printer') ?? saved?.printer ?? 'P1S');
  const multiPlate = flag('multi-plate') || (saved?.multiPlate ?? false);
  const width = Number(arg('section') ?? saved?.sectionWidthMm ?? 210);
  const depth = Number(arg('section') ?? saved?.sectionHeightMm ?? 210);
  return { format, printer, multiPlate, width, depth };
}

/** The model with the options file's edits applied, as the app exports it. */
async function withEdits(spec: ModelSpec, settings: ModelSettings, area: AreaSpec): Promise<ModelSpec> {
  const edits: ModelEdits | undefined = options?.map?.edits;
  if (flag('no-edits') || !edits || !hasEdits(edits)) return spec;
  if (!spec.edit) {
    console.log('warning: this model cannot be edited, so the edits are left out');
    return spec;
  }
  const fonts = new FontLoader(async (path) => {
    const bytes = readFileSync(join('public', path));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });
  const projection = new Projection(area.center, area.rotationDeg, spec.mmPerMetre);
  const session = new EditSession(spec, settings, projection, { load: (id) => fonts.load(id, null) });
  const edited = await session.edited(edits, palette);
  const layers = edits.layers.length;
  console.log(`edits: ${editCount(edits)} changes and ${layers} custom ${layers === 1 ? 'layer' : 'layers'} applied`);
  return edited;
}

async function main() {
  const shape = (arg('shape') as AreaShape) ?? options?.map?.area.shape ?? 'rectangle';
  const boundsText = arg('bbox') ?? (arg('preset') ? presetBounds(arg('preset')!) : undefined);
  if (!boundsText && !arg('area') && !options?.map) throw new Error('Pass --bbox w,s,e,n, --preset name, --area lon,lat,width,height or --options file.json');
  const area = arg('area') ? exactArea(arg('area')!, shape) : boundsText ? areaFromBounds(parseBoundsText(boundsText), shape) : { ...options!.map!.area };
  if (arg('rotation')) area.rotationDeg = Number(arg('rotation'));
  let settings: ModelSettings = options ? options.settings : cloneSettings();
  if (arg('settings')) settings = merge(settings, JSON.parse(readFileSync(arg('settings')!, 'utf8')));
  if (arg('scale')) settings.scale.mmPerMetre = Number(arg('scale'));
  if (arg('fit')) {
    settings.scale.mode = 'fit';
    settings.scale.fitMm = Number(arg('fit'));
  }
  if (flag('bridges')) settings.bridges.enabled = true;
  if (flag('trees')) settings.trees.enabled = true;
  if (flag('satellite-cover')) settings.land.satelliteCover = true;
  if (flag('flat')) settings.terrain.elevation = false;
  if (flag('lidar')) settings.lidar.enabled = true;
  if (flag('lidar-only')) settings.modelSource = 'lidar';
  if (arg('detail')) settings.lidarModel.detailMm = Number(arg('detail'));
  if (flag('cut-water')) {
    settings.water.mode = 'through';
    settings.lidarModel.waterMode = 'cut';
  }
  if (flag('water-layer')) settings.lidarModel.waterMode = 'layer';
  if (flag('no-map-water')) settings.lidarModel.mapWater = false;
  settings = sanitizeSettings(settings);
  if (settings.modelSource === 'lidar') return lidarOnly(area, settings);

  const t0 = performance.now();
  const bounds = dataBoundsFor(area);
  const plan = dataPlan(settings, bounds);
  let lastLabel = '';
  const log = (label: string) => {
    if (label !== lastLabel) console.log(`  ${((performance.now() - t0) / 1000).toFixed(1)}s ${label}`);
    lastLabel = label;
  };
  const [overture, dem, raceways] = await Promise.all([
    fetchOverture({ bounds, types: plan.types, keep: flag('no-filter') ? undefined : plan.keep, onProgress: (p) => log(p.message) }),
    settings.terrain.elevation
      ? fetchDem({ bounds, targetSpacingM: Math.max(area.widthM, area.heightM) / settings.terrain.resolution })
      : Promise.resolve(null),
    plan.raceways ? fetchRaceways(bounds) : Promise.resolve(null),
  ]);
  const data = withRaceways(overture, raceways);
  const t1 = performance.now();
  console.log(`data: ${(data.bytes / 1e6).toFixed(1)} MB in ${((t1 - t0) / 1000).toFixed(1)} s, release ${data.release}`);
  for (const [type, s] of Object.entries(data.stats)) if (s.features) console.log(`  ${type}: ${s.features} features`);
  if (raceways?.features.length) console.log(`  raceways: ${raceways.features.length} lines, ${(raceways.downloaded / 1e6).toFixed(2)} MB downloaded`);

  let lidar: PreparedLidar | null = null;
  if (settings.lidar.enabled && settings.buildings.enabled) {
    const cacheDir = arg('lidar-cache') ?? 'out/lidar-cache';
    setUpLidar(cacheDir);
    const scale = effectiveScale(area, settings.scale);
    const threads = Number(arg('lidar-threads') ?? lidarPoolSize());
    const pool = threads > 1 ? threadPool(threads, cacheDir) : null;
    try {
      lidar = await prepareLidar({
        bounds,
        buildings: data.features.building ?? [],
        parts: data.features.building_part ?? [],
        land: data.features.land ?? [],
        settings: { ...settings.lidar, xyScale: scale, zScale: scale * settings.buildings.heightScale },
        progress: (label) => log(label),
        runner: pool ?? undefined,
      });
    } finally {
      pool?.close();
    }
    const measured = Object.keys(lidar.records).filter((id) => !id.startsWith('rock:')).length;
    console.log(`lidar: ${measured} of ${lidar.candidates} buildings measured, ${(lidar.downloadedBytes / 1e6).toFixed(1)} MB in ${((performance.now() - t1) / 1000).toFixed(1)} s${lidar.reused ? ' (reused)' : ''}`);
    for (const survey of lidar.surveys) console.log(`  ${survey.provider} ${survey.name}: ${survey.buildings} buildings`);
    for (const failure of lidar.failures) console.log(`  failed: ${failure.source}: ${failure.reason}`);
    if (arg('lidar-records')) {
      mkdirSync(dirname(arg('lidar-records')!), { recursive: true });
      writeFileSync(arg('lidar-records')!, JSON.stringify(lidar));
    }
  }

  const generating = performance.now();
  const progress = new Progress((e) => log(e.label));
  const spec = await withEdits(await generateModel({ area, settings, data, elevation: dem, lidar, progress }), settings, area);
  const t2 = performance.now();
  const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ });
  const t3 = performance.now();
  const b = partsBounds(meshed.parts);
  console.log(`generate ${((t2 - generating) / 1000).toFixed(1)} s, mesh ${((t3 - t2) / 1000).toFixed(1)} s`);
  console.log(`size ${(b[3] - b[0]).toFixed(1)} x ${(b[4] - b[1]).toFixed(1)} x ${(b[5] - b[2]).toFixed(1)} mm`);
  for (const part of meshed.parts) {
    const r = edgeReport(part.indices, part.positions.length / 3);
    console.log(`  ${part.name.padEnd(16)} ${String(part.indices.length / 3).padStart(9)} tris  open ${r.open} repeated ${r.repeated}`);
  }
  if (meshed.failed) console.log(`  failed solids: ${meshed.failed}, fallbacks: ${meshed.fallbacks}`);
  console.log(JSON.stringify(spec.stats));
  for (const w of [...data.warnings, ...spec.warnings]) console.log(`warning: ${w}`);

  const out = arg('out');
  if (out) {
    const { format, printer, multiPlate, width, depth } = exportChoices();
    const { plates, failed } = await buildPlates(spec, {
      multiPlate,
      sectionWidthMm: width,
      sectionHeightMm: depth,
      bedWidth: printer.width,
      bedDepth: printer.depth,
      maxPlates: format === 'bambu' ? BAMBU_MAX_PLATES : undefined,
    });
    const credits = lidar ? [...new Set(lidar.surveys.map((s) => `LiDAR: ${s.attribution}`))] : [];
    const result = exportPlates(plates, {
      format,
      printer: printer.key,
      palette,
      multiPlate,
      sectionWidthMm: width,
      sectionHeightMm: depth,
      fileBase: 'model',
    }, credits);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, new Uint8Array(await result.data.arrayBuffer()));
    console.log(`wrote ${out} (${(result.data.size / 1e6).toFixed(1)} MB, ${result.plates} plate(s))`);
    for (const w of result.warnings) console.log(`warning: ${w}`);
    if (failed) console.log(`warning: ${failed} solids could not be meshed and are missing from the file`);
  }
}

async function lidarOnly(area: AreaSpec, settings: ModelSettings) {
  const t0 = performance.now();
  let lastLabel = '';
  const log = (label: string, detail?: string) => {
    if (label !== lastLabel) console.log(`  ${((performance.now() - t0) / 1000).toFixed(1)}s ${label}${detail ? `: ${detail}` : ''}`);
    lastLabel = label;
  };
  const cacheDir = arg('lidar-cache') ?? 'out/lidar-cache';
  setUpLidar(cacheDir);
  if (flag('reread')) setSurfaceStore(null);
  const scale = effectiveScale(area, settings.scale);
  const threads = Number(arg('lidar-threads') ?? surfacePoolSize());
  const pool = threads > 1 ? threadPool(threads, cacheDir) : null;
  try {
    const cell = cellSize(settings.lidarModel.detailMm, scale, area.widthM, area.heightM);
    const water = settings.lidarModel.mapWater
      ? fetchOverture({ bounds: dataBoundsFor(area), types: ['water'], keep: dataPlan(settings, dataBoundsFor(area)).keep }).then((data) => {
          console.log(`map water: ${data.features.water?.length ?? 0} features, ${(data.bytes / 1e6).toFixed(1)} MB, release ${data.release}`);
          return data.features.water ?? [];
        })
      : Promise.resolve(undefined);
    const surface = await prepareSurface({ area, cellM: cell, progress: (label, _fraction, detail) => log(label, detail), runner: pool ?? undefined });
    const mapWater = await water;
    const t1 = performance.now();
    const { grid } = surface;
    console.log(`lidar: ${grid.nx} x ${grid.ny} cells of ${grid.cell} m (asked ${surface.requestedCellM} m), ${Math.round(surface.coverage * 100)}% with returns, ${surface.points.toLocaleString('en-US')} returns (${surface.noise.toLocaleString('en-US')} floating left out), ${(surface.downloadedBytes / 1e6).toFixed(1)} MB in ${((t1 - t0) / 1000).toFixed(1)} s, ${surface.reusedBlocks} of ${surface.blocks} blocks reused`);
    for (const s of surface.surveys) console.log(`  ${s.provider} ${s.name} (${s.year ?? 'year unknown'}): ${s.points.toLocaleString('en-US')} returns in ${s.blocks} blocks`);
    for (const failure of surface.failures) console.log(`  failed: ${failure.source}: ${failure.reason}`);
    if (arg('surface-out')) {
      const dir = arg('surface-out')!;
      mkdirSync(dir, { recursive: true });
      const layers = surface.layers;
      for (const name of ['top', 'solid', 'ground', 'waterZ', 'count', 'vegetation', 'water', 'building'] as const) {
        const values = layers[name];
        writeFileSync(join(dir, `${name}.bin`), new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
      }
      writeFileSync(join(dir, 'grid.json'), JSON.stringify({ ...grid, requested: surface.requestedCellM, area }));
    }
    const progress = new Progress((e) => log(e.label));
    const spec = await withEdits(
      await surfaceModel({ area, settings, surface, progress, runTile: pool ? (tile) => pool.tile(tile) : undefined, concurrency: pool?.concurrency ?? 1, mapWater }),
      settings,
      area,
    );
    const t2 = performance.now();
    const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ });
    const t3 = performance.now();
    const b = partsBounds(meshed.parts);
    console.log(`generate ${((t2 - t1) / 1000).toFixed(1)} s, mesh ${((t3 - t2) / 1000).toFixed(1)} s`);
    console.log(`size ${(b[3] - b[0]).toFixed(1)} x ${(b[4] - b[1]).toFixed(1)} x ${(b[5] - b[2]).toFixed(1)} mm`);
    for (const part of meshed.parts) {
      const r = edgeReport(part.indices, part.positions.length / 3);
      console.log(`  ${part.name.padEnd(16)} ${String(part.indices.length / 3).padStart(9)} tris  open ${r.open} repeated ${r.repeated}`);
    }
    if (meshed.failed) console.log(`  failed solids: ${meshed.failed}`);
    console.log(JSON.stringify(spec.stats));
    for (const w of spec.warnings) console.log(`warning: ${w}`);
    const out = arg('out');
    if (out) {
      const { format, printer, multiPlate, width, depth } = exportChoices();
      const { plates, failed } = await buildPlates(spec, {
        multiPlate,
        sectionWidthMm: width,
        sectionHeightMm: depth,
        bedWidth: printer.width,
        bedDepth: printer.depth,
        maxPlates: format === 'bambu' ? BAMBU_MAX_PLATES : undefined,
      });
      const credits = [...new Set(surface.surveys.map((s) => `LiDAR: ${s.attribution}`))];
      const result = exportPlates(plates, { format, printer: printer.key, palette, multiPlate, sectionWidthMm: width, sectionHeightMm: depth, fileBase: 'model' }, credits, Boolean(mapWater?.length));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, new Uint8Array(await result.data.arrayBuffer()));
      console.log(`wrote ${out} (${(result.data.size / 1e6).toFixed(1)} MB, ${result.plates} plate(s))`);
      for (const w of result.warnings) console.log(`warning: ${w}`);
      if (failed) console.log(`warning: ${failed} solids could not be meshed and are missing from the file`);
    }
  } finally {
    pool?.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
