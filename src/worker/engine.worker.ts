// The generation worker: downloads map and elevation data, runs the pipeline
// and meshes the model, then exports plates on request. The last download is
// kept for the session, so changing a setting regenerates without
// downloading again, and the byte cache survives reloads. A LiDAR Only model
// reads a survey into a grid instead, kept for the session the same way, and
// only downloads map data for its water.

import lazWasmUrl from '@voxelkloud/wasm-codecs/voxelkloud_wasm_codecs_bg.wasm?url';
import { lidarCache } from '../core/data/cache';
import { fetchDem, type DemMosaic } from '../core/data/dem';
import type { OvertureData } from '../core/data/features';
import { fetchOverture } from '../core/data/overture';
import { cellSize } from '../core/dsm/grid';
import { surfaceModel } from '../core/dsm/model';
import { prepareSurface, type PreparedSurface } from '../core/dsm/prepare';
import type { ExportRequest, FromWorker, GenerateRequest, GenerateResult, LidarSummary, ProgressEvent, SurfaceSummary, ToWorker } from '../core/engine/protocol';
import { effectiveScale } from '../core/geo/area';
import { prepareLidar, setCheckpointStore, type PreparedLidar } from '../core/lidar/prepare';
import { exportPlates } from '../core/export';
import { BAMBU_MAX_PLATES } from '../core/export/sections';
import { CancelError, Progress } from '../core/pipeline/context';
import { dataPlan } from '../core/pipeline/dataPlan';
import { dataBoundsFor, generateModel, type ModelSpec } from '../core/pipeline/generate';
import { meshLayers, partsBounds } from '../core/pipeline/mesh';
import { buildPlates } from '../core/pipeline/plates';
import type { SourceFeature } from '../core/pipeline/source';
import { printerByKey, sanitizeSettings } from '../core/settings';
import type { GeoBounds, ModelStats } from '../core/types';
import { installLidarCodecs } from './lidarCodecs';
import { lidarPool, lidarPoolSize, surfacePoolSize } from './lidarPool';

const ctx = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

interface Running {
  id: number;
  progress: Progress;
  abort: AbortController;
}

let running: Running | null = null;
let lastSpec: ModelSpec | null = null;
let lastCredits: string[] = [];
// A LiDAR Only model uses no map data unless it used mapped water, so its
// exports can credit only the surveys.
let lastMapData = true;
let overture: { key: string; data: OvertureData } | null = null;
let elevation: { key: string; dem: DemMosaic } | null = null;
let prepared: { key: string; lidar: PreparedLidar } | null = null;
let surface: { key: string; prepared: PreparedSurface } | null = null;

setCheckpointStore(lidarCache);
installLidarCodecs(lazWasmUrl);

function boundsKey(b: GeoBounds): string {
  return [b.west, b.south, b.east, b.north].map((v) => v.toFixed(6)).join(',');
}

function post(message: FromWorker, transfer?: Transferable[]) {
  ctx.postMessage(message, transfer);
}

async function loadData(request: GenerateRequest, job: Running, report: (e: ProgressEvent) => void) {
  const { area, settings } = request;
  const bounds = dataBoundsFor(area);
  const plan = dataPlan(settings, bounds);
  const key = `${boundsKey(bounds)}|${plan.key}`;
  const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
  let downloaded = 0;
  let overtureDone = false;

  const loadOverture = async (): Promise<OvertureData> => {
    if (overture?.key === key) {
      overtureDone = true;
      return overture.data;
    }
    // Let the last area's data go before the next one comes in.
    overture = null;
    const data = await fetchOverture({
      bounds,
      types: plan.types,
      keep: plan.keep,
      signal: job.abort.signal,
      onProgress: (p) =>
        report({
          stage: 'data',
          label: p.message,
          fraction: 0.02 + 0.26 * Math.min(1, p.bytesTotal ? p.bytes / p.bytesTotal : 0),
          detail: p.bytesTotal ? `${mb(p.bytes)} of ${mb(p.bytesTotal)}` : undefined,
        }),
    });
    overture = { key, data };
    overtureDone = true;
    for (const stats of Object.values(data.stats)) downloaded += stats.bytes - stats.cachedBytes;
    return data;
  };

  const loadElevation = async (): Promise<DemMosaic | null> => {
    if (!settings.terrain.elevation) return null;
    // The elevation needs to be about as fine as the terrain grid.
    const cellM = Math.max(area.widthM, area.heightM) / settings.terrain.resolution;
    const demKey = `${boundsKey(bounds)}|${Math.round(cellM * 10)}`;
    if (elevation?.key === demKey) return elevation.dem;
    elevation = null;
    let demDownloaded = 0;
    const dem = await fetchDem({
      bounds,
      targetSpacingM: cellM,
      signal: job.abort.signal,
      onProgress: (p) => {
        demDownloaded = p.downloaded;
        // The map data drives the bar. Elevation only shows if it is still going after that.
        if (overtureDone) {
          report({ stage: 'elevation', label: 'Downloading elevation', fraction: 0.28, detail: `${p.tilesDone} of ${p.tilesTotal} tiles` });
        }
      },
    });
    elevation = { key: demKey, dem };
    downloaded += demDownloaded;
    return dem;
  };

  const [data, dem] = await Promise.all([loadOverture(), loadElevation()]);
  return { data, dem, downloaded };
}

// LiDAR takes this share of the progress bar, and generation the rest after it.
const LIDAR_START = 0.3;
const LIDAR_END = 0.6;

/**
 * Measured buildings for the area. Preparation checkpoints each batch in the
 * LiDAR cache, and the last result is kept for the session, so changing a
 * setting that LiDAR does not depend on regenerates straight away.
 */
async function loadLidar(request: GenerateRequest, data: OvertureData, job: Running): Promise<PreparedLidar> {
  const { area, settings } = request;
  const scale = effectiveScale(area, settings.scale);
  const bounds = dataBoundsFor(area);
  const key = JSON.stringify([boundsKey(bounds), data.release, settings.lidar, scale, settings.buildings.heightScale]);
  if (prepared?.key === key) return prepared.lidar;
  prepared = null;
  const progress = job.progress;
  progress.begin('lidar', 'Preparing LiDAR buildings', LIDAR_START, LIDAR_END - LIDAR_START);
  // Browsers without nested workers read and measure in this worker instead.
  const pool = typeof Worker === 'undefined' ? null : lidarPool(lidarPoolSize(), job.abort.signal);
  let lidar: PreparedLidar;
  try {
    lidar = await prepareLidar({
      bounds,
      buildings: data.features.building ?? [],
      parts: data.features.building_part ?? [],
      land: data.features.land ?? [],
      settings: { ...settings.lidar, xyScale: scale, zScale: scale * settings.buildings.heightScale },
      signal: job.abort.signal,
      progress: (label, fraction, detail) => progress.checkpoint(fraction, detail, label),
      runner: pool ?? undefined,
    });
  } finally {
    pool?.close();
  }
  // Like the saved copy, a result with a failed read is tried again next time.
  // What did get read is checkpointed, so only the failures download again.
  if (!lidar.failures.length) prepared = { key, lidar };
  return lidar;
}

function lidarSummary(lidar: PreparedLidar): LidarSummary {
  const skipped: Record<string, number> = {};
  for (const reason of Object.values(lidar.rejected)) skipped[reason] = (skipped[reason] ?? 0) + 1;
  return {
    measured: Object.keys(lidar.records).filter((id) => !id.startsWith('rock:')).length,
    candidates: lidar.candidates,
    skipped,
    surveys: lidar.surveys.map(({ name, provider, buildings, attribution, sourcePage }) => ({ name, provider, buildings, attribution, sourcePage })),
    failures: lidar.failures.map((f) => `${f.source}: ${f.reason}`),
    downloadedBytes: lidar.downloadedBytes,
    reused: lidar.reused,
  };
}

type Pool = ReturnType<typeof lidarPool>;

/**
 * The survey read into a grid for the area. Blocks are checkpointed in the
 * LiDAR cache and the last grid is kept for the session, so changing a
 * setting other than the area, scale or detail builds straight away.
 */
async function loadSurface(request: GenerateRequest, job: Running, pool: Pool | null): Promise<PreparedSurface> {
  const { area, settings } = request;
  const cell = cellSize(settings.lidarModel.detailMm, effectiveScale(area, settings.scale), area.widthM, area.heightM);
  const key = JSON.stringify([area.center, area.rotationDeg, area.widthM, area.heightM, cell]);
  if (surface?.key === key) return { ...surface.prepared, downloadedBytes: 0, reusedBlocks: surface.prepared.blocks };
  // Let the last grid go before the next one comes in.
  surface = null;
  const progress = job.progress;
  progress.begin('lidar', 'Reading the LiDAR survey', 0.02, 0.58);
  const result = await prepareSurface({
    area,
    cellM: cell,
    signal: job.abort.signal,
    progress: (label, fraction, detail) => progress.checkpoint(fraction, detail, label),
    runner: pool ?? undefined,
  });
  // A failed read leaves a hole, and a survey whose catalog failed can leave
  // half the area without one, so try again next time. Blocks that were read
  // come from their checkpoints.
  if (!result.failures.length) surface = { key, prepared: result };
  return result;
}

interface MapWater {
  features: SourceFeature[];
  release: string;
  downloaded: number;
}

/**
 * Mapped water for a LiDAR Only model: a map model's download of the same
 * area if there is one, or the water alone.
 */
async function loadMapWater(request: GenerateRequest, job: Running): Promise<MapWater> {
  const bounds = dataBoundsFor(request.area);
  const prefix = `${boundsKey(bounds)}|`;
  if (overture?.key.startsWith(prefix)) return { features: overture.data.features.water ?? [], release: overture.data.release, downloaded: 0 };
  const data = await fetchOverture({ bounds, types: ['water'], keep: dataPlan(request.settings, bounds).keep, signal: job.abort.signal });
  overture = { key: `${prefix}water`, data };
  let downloaded = 0;
  for (const stats of Object.values(data.stats)) downloaded += stats.bytes - stats.cachedBytes;
  return { features: data.features.water ?? [], release: data.release, downloaded };
}

function surfaceSummary(prepared: PreparedSurface): SurfaceSummary {
  return {
    cellM: prepared.grid.cell,
    requestedCellM: prepared.requestedCellM,
    coverage: prepared.coverage,
    surveys: prepared.surveys.map(({ name, provider, year, attribution, sourcePage }) => ({ name, provider, year, attribution, sourcePage })),
    failures: prepared.failures.map((f) => `${f.source}: ${f.reason}`),
    downloadedBytes: prepared.downloadedBytes,
    reused: prepared.reusedBlocks === prepared.blocks,
  };
}

async function generateSurface(id: number, request: GenerateRequest, job: Running) {
  const started = performance.now();
  const timings: Record<string, number> = {};
  // Browsers without nested workers read and mesh in this worker instead.
  const pool = typeof Worker === 'undefined' ? null : lidarPool(surfacePoolSize(), job.abort.signal);
  // Downloaded while the survey is read. The model is still built without it.
  const pending = request.settings.lidarModel.mapWater ? loadMapWater(request, job).catch((error: Error) => error) : null;
  try {
    const prepared = await loadSurface(request, job, pool);
    timings.lidar = (performance.now() - started) / 1000;
    const t1 = performance.now();
    job.progress.begin('data', 'Downloading map water', 0.6, 0.02);
    const water = await pending;
    if (water instanceof Error && (water.name === 'AbortError' || job.abort.signal.aborted)) throw water;
    const mapWater = water instanceof Error ? null : water;
    const spec = await surfaceModel({
      area: request.area,
      settings: request.settings,
      surface: prepared,
      progress: job.progress,
      runTile: pool ? (tile) => pool.tile(tile) : undefined,
      concurrency: pool?.concurrency ?? 1,
      mapWater: mapWater?.features,
    });
    timings.generate = (performance.now() - t1) / 1000;
    const t2 = performance.now();
    job.progress.begin('mesh', 'Building meshes', 0.92, 0.08);
    const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ, progress: job.progress, span: [0, 1] });
    timings.mesh = (performance.now() - t2) / 1000;
    lastSpec = spec;
    lastCredits = [...new Set(prepared.surveys.map((s) => `LiDAR: ${s.attribution}`))];
    lastMapData = Boolean(mapWater?.features.length);
    const warnings = [...spec.warnings];
    if (water instanceof Error) warnings.push(`Map water could not be downloaded, so the water is the survey's alone. ${describe(water)}`);
    if (meshed.failed) warnings.push('The LiDAR surface could not be closed into a solid. Try another area shape, or report this.');
    const result: GenerateResult = {
      parts: meshed.parts,
      bounds: partsBounds(meshed.parts),
      mmPerMetre: spec.mmPerMetre,
      release: lastMapData ? mapWater!.release : '',
      stats: surfaceStats(spec.stats, prepared, mapWater?.downloaded ?? 0),
      warnings,
      timings,
      surface: surfaceSummary(prepared),
    };
    post({ type: 'generated', id, result }, meshed.parts.flatMap((p) => [p.positions.buffer, p.indices.buffer]));
  } finally {
    pool?.close();
  }
}

async function generate(id: number, request: GenerateRequest) {
  request = { ...request, settings: sanitizeSettings(request.settings) };
  if (request.settings.modelSource === 'lidar') return generateLidarOnly(id, request);
  const started = performance.now();
  const timings: Record<string, number> = {};
  const report = (event: ProgressEvent) => post({ type: 'progress', id, progress: event });
  const useLidar = request.settings.lidar.enabled && request.settings.buildings.enabled;
  // With LiDAR on, generation's own fractions (from 0.3) are squeezed in after it.
  const remapped = (event: ProgressEvent) => {
    if (!useLidar || event.stage === 'lidar' || event.fraction < LIDAR_START) report(event);
    else report({ ...event, fraction: LIDAR_END + ((event.fraction - LIDAR_START) * (1 - LIDAR_END)) / (1 - LIDAR_START) });
  };
  const job: Running = { id, progress: new Progress(remapped), abort: new AbortController() };
  running = job;
  try {
    report({ stage: 'data', label: 'Finding map data', fraction: 0.01 });
    const { data, dem, downloaded } = await loadData(request, job, report);
    timings.download = (performance.now() - started) / 1000;
    if (job.progress.cancelled) throw new CancelError();

    let lidar: PreparedLidar | null = null;
    if (useLidar) {
      const t0 = performance.now();
      lidar = await loadLidar(request, data, job);
      timings.lidar = (performance.now() - t0) / 1000;
    }

    const t1 = performance.now();
    const spec = await generateModel({
      area: request.area,
      settings: request.settings,
      data,
      elevation: dem,
      lidar,
      progress: job.progress,
    });
    timings.generate = (performance.now() - t1) / 1000;

    const t2 = performance.now();
    job.progress.begin('mesh', 'Building meshes', 0.9, 0.1);
    const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ, progress: job.progress, span: [0, 1] });
    timings.mesh = (performance.now() - t2) / 1000;
    lastSpec = spec;

    const warnings = [...data.warnings, ...spec.warnings];
    if (dem?.tilesMissing) {
      warnings.push(
        `${dem.tilesMissing} of ${dem.tilesUsed + dem.tilesMissing} elevation tiles were missing and read as sea level, so the terrain may have a step.`,
      );
    }
    if (meshed.failed) warnings.push(`${meshed.failed} small pieces could not be meshed and were left out.`);
    if (meshed.fallbacks) warnings.push(`${meshed.fallbacks} pieces only follow the terrain along their edges and may show flat spots.`);
    lastCredits = [];
    lastMapData = true;
    if (lidar) {
      lastCredits = [...new Set(lidar.surveys.map((s) => `LiDAR: ${s.attribution}`))];
      if (!lidar.surveys.length && lidar.candidates && !lidar.failures.length && !Object.keys(lidar.records).length) {
        warnings.push('No LiDAR survey that a browser can read covers these buildings, so they keep their mapped shapes.');
      }
      for (const failure of lidar.failures.slice(0, 3)) warnings.push(`LiDAR from ${failure.source} could not be read: ${failure.reason}`);
      const fallbacks = typeof spec.stats.lidar_geometry_fallbacks === 'number' ? spec.stats.lidar_geometry_fallbacks : 0;
      if (fallbacks) warnings.push(`${fallbacks} measured buildings could not be built cleanly and keep their mapped shapes.`);
    }
    const result: GenerateResult = {
      parts: meshed.parts,
      bounds: partsBounds(meshed.parts),
      mmPerMetre: spec.mmPerMetre,
      release: data.release,
      stats: userStats(spec.stats, downloaded + (lidar?.downloadedBytes ?? 0)),
      warnings,
      timings,
      lidar: lidar ? lidarSummary(lidar) : undefined,
    };
    post({ type: 'generated', id, result }, meshed.parts.flatMap((p) => [p.positions.buffer, p.indices.buffer]));
  } catch (error) {
    const cancelled = error instanceof CancelError || job.progress.cancelled || (error as Error)?.name === 'AbortError';
    post({ type: 'error', id, message: cancelled ? 'Cancelled' : describe(error), cancelled });
  } finally {
    // If one download failed, stop the other one too.
    job.abort.abort();
    if (running === job) running = null;
  }
}

async function generateLidarOnly(id: number, request: GenerateRequest) {
  const report = (event: ProgressEvent) => post({ type: 'progress', id, progress: event });
  const job: Running = { id, progress: new Progress(report), abort: new AbortController() };
  running = job;
  try {
    await generateSurface(id, request, job);
  } catch (error) {
    const cancelled = error instanceof CancelError || job.progress.cancelled || (error as Error)?.name === 'AbortError';
    post({ type: 'error', id, message: cancelled ? 'Cancelled' : describe(error), cancelled });
  } finally {
    job.abort.abort();
    if (running === job) running = null;
  }
}

async function exportModel(id: number, request: ExportRequest) {
  try {
    if (!lastSpec) throw new Error('Generate a model first.');
    const printer = printerByKey(request.printer);
    const progress = new Progress((event) => post({ type: 'progress', id, progress: { ...event, stage: 'export' } }));
    progress.begin('export', 'Preparing parts', 0, 0.8);
    const { plates, failed } = await buildPlates(lastSpec, {
      multiPlate: request.multiPlate,
      sectionWidthMm: request.sectionWidthMm,
      sectionHeightMm: request.sectionHeightMm,
      bedWidth: printer.width,
      bedDepth: printer.depth,
      exclude: request.excludeParts,
      maxPlates: request.format === 'bambu' ? BAMBU_MAX_PLATES : undefined,
      progress,
    });
    post({ type: 'progress', id, progress: { stage: 'export', label: 'Writing the file', fraction: 0.85 } });
    const result = exportPlates(plates, request, lastCredits, lastMapData);
    if (failed) {
      // A section cut can fail where the whole model meshed, and cutting elsewhere usually works.
      const retry = request.multiPlate ? ' Try another section size.' : '';
      result.warnings.unshift(
        lastMapData
          ? `${failed} ${failed === 1 ? 'piece' : 'pieces'} could not be meshed and ${failed === 1 ? 'is' : 'are'} missing from the file.${retry}`
          : `Part of the LiDAR surface could not be closed into a solid and is missing from the file.${retry}`,
      );
      result.missing = failed;
    }
    post({ type: 'exported', id, result });
  } catch (error) {
    post({ type: 'error', id, message: describe(error) });
  }
}

/** The handful of counts worth showing, under readable names. The pipeline keeps many more. */
function userStats(stats: ModelStats, downloaded: number): ModelStats {
  const n = (key: string) => (typeof stats[key] === 'number' ? (stats[key] as number) : 0);
  const out: ModelStats = {};
  const add = (label: string, value: number | string) => {
    if (value !== 0 && value !== '') out[label] = value;
  };
  add('Buildings', n('buildings'));
  add('Measured with LiDAR', n('lidar_buildings'));
  add('Building parts', n('building_parts'));
  add('Shaped roofs', n('roofs_shaped'));
  add('Rivers, lakes and sea', n('water_cut_bodies'));
  add('Ponds and fountains', n('water_basins'));
  add('Road pieces', n('road_pieces'));
  add('Parks and land cover areas', ['paved', 'sand', 'rock', 'green', 'forest'].reduce((s, c) => s + n(`land_${c}_polygons`), 0));
  add('Bridge decks', n('bridge_decks'));
  add('Bridge piers', n('bridge_piers'));
  add('Trees', n('trees'));
  add('Terrain grid', typeof stats.terrain_grid === 'string' ? `${stats.terrain_grid} cells` : '');
  add('Data downloaded', downloaded > 0 ? `${(downloaded / 1e6).toFixed(1)} MB` : 'None, all cached');
  return out;
}

function surfaceStats(stats: ModelStats, prepared: PreparedSurface, mapBytes: number): ModelStats {
  const n = (key: string) => (typeof stats[key] === 'number' ? (stats[key] as number) : 0);
  const out: ModelStats = {};
  const add = (label: string, value: number | string) => {
    if (value !== 0 && value !== '') out[label] = value;
  };
  add('Grid', `${stats.lidar_model_grid} cells of ${prepared.grid.cell.toFixed(2)} m`);
  add('Area with LiDAR returns', `${Math.round(prepared.coverage * 100)}%`);
  add('LiDAR returns', prepared.points);
  add('Floating returns left out', prepared.noise);
  add('Rivers, lakes and sea', n('lidar_model_water_bodies'));
  add('Tree canopy cells', n('lidar_model_tree_cells'));
  add('Surface triangles', n('lidar_model_surface_triangles'));
  const downloaded = prepared.downloadedBytes + mapBytes;
  add('Data downloaded', downloaded > 0 ? `${(downloaded / 1e6).toFixed(1)} MB` : 'None, all cached');
  return out;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NetworkError' || /Failed to fetch|NetworkError|network/i.test(error.message)) {
      return 'Could not reach the map data server. Check your connection and try again.';
    }
    return error.message || error.name;
  }
  return String(error);
}

ctx.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (running && running.id === message.id) {
      running.progress.cancelled = true;
      running.abort.abort();
    }
    return;
  }
  if (message.type === 'generate') void generate(message.id, message.request);
  else if (message.type === 'export') void exportModel(message.id, message.request);
};
