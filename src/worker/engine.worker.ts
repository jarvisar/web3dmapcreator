// The generation worker: downloads map and elevation data, runs the pipeline
// and meshes the model, then exports plates on request. The last download is
// kept for the session, so changing a setting regenerates without
// downloading again, and the byte cache survives reloads. A LiDAR Only model
// reads a survey into a grid instead, kept for the session the same way, and
// only downloads map data for its water.

import lazWasmUrl from '@voxelkloud/wasm-codecs/voxelkloud_wasm_codecs_bg.wasm?url';
import { lidarCache } from '../core/data/cache';
import { setCorsProxy } from '../core/data/corsProxy';
import { fetchDem, type DemMosaic } from '../core/data/dem';
import type { OvertureData } from '../core/data/features';
import { fetchOverture } from '../core/data/overture';
import { fetchRaceways, withRaceways, type Raceways } from '../core/data/raceways';
import { MAX_FIXED_CELLS, requestedCell } from '../core/dsm/grid';
import { surfaceModel } from '../core/dsm/model';
import { emptyLayers } from '../core/dsm/layers';
import { prepareSurface, unpackLayers, type PreparedSurface } from '../core/dsm/prepare';
import { groundGrid } from '../core/edit/ground';
import { roadLines } from '../core/edit/lines';
import { EditSession, excludedParts, type EditUpdate } from '../core/edit/session';
import { emptyEdits, hasEdits, sanitizeEdits } from '../core/edit/types';
import type { EditRequest, ExportRequest, FromWorker, GenerateRequest, GenerateResult, LidarSummary, ProgressEvent, SurfaceSummary, SurveyChoice, ToWorker } from '../core/engine/protocol';
import { effectiveScale } from '../core/geo/area';
import { Projection } from '../core/geo/projection';
import { download } from '../core/svgmap/download';
import { FontLoader } from '../core/svgmap/text/loadFont';
import { findSurveys, lidarRequest, prepareLidar, setCheckpointStore, type PreparedLidar } from '../core/lidar/prepare';
import type { SurveyQuery } from '../core/lidar/query';
import { OffersError, reopened } from '../core/lidar/offers';
import type { Failure } from '../core/lidar/sources';
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
/** Exports under way, so a cancel reaches their progress. */
const exporting = new Map<number, Progress>();
let lastSpec: ModelSpec | null = null;
let session: EditSession | null = null;
/** The newest edit request not applied yet. Older ones waiting are dropped. */
let pendingEdit: { id: number; request: EditRequest } | null = null;
let applying = false;
let baseUrl = '';
let lastCredits: string[] = [];
// A LiDAR Only model uses no map data unless it used mapped water, so its
// exports can credit only the surveys.
let lastMapData = true;
let overture: { key: string; data: OvertureData } | null = null;
let raceways: { key: string; found: Raceways } | null = null;
let elevation: { key: string; dem: DemMosaic } | null = null;
let prepared: { key: string; lidar: PreparedLidar } | null = null;
// Kept as its block checkpoints, not its layers (unpackLayers).
let surface: { key: string; prepared: PreparedSurface } | null = null;

setCheckpointStore(lidarCache);
installLidarCodecs(lazWasmUrl);
// The CORS proxy for LiDAR hosts without CORS headers, set when the site is built. Without it those sources are left out.
setCorsProxy(import.meta.env.VITE_LIDAR_PROXY);

// Fonts for text shapes, cached by the service worker, so normally instant.
const fonts = new FontLoader(async (path) => {
  const { status, bytes } = await download(new URL(path, baseUrl || self.location.href).href, 30_000);
  if (!bytes) throw new Error(`Could not load ${path} (${status}).`);
  return bytes;
});

function meshTransfers(update: EditUpdate): Transferable[] {
  const out: Transferable[] = [];
  for (const object of update.objects) {
    if (!object.mesh) continue;
    out.push(object.mesh.positions.buffer, object.mesh.indices.buffer);
    if (object.mesh.objects) out.push(object.mesh.objects.runs.buffer);
  }
  for (const { part } of update.parts) {
    if (!part) continue;
    out.push(part.positions.buffer, part.indices.buffer);
    if (part.objects) out.push(part.objects.runs.buffer);
  }
  return out;
}

function partTransfers(parts: GenerateResult['parts']): Transferable[] {
  return parts.flatMap((p) => [p.positions.buffer, p.indices.buffer, ...(p.objects ? [p.objects.runs.buffer] : [])]);
}

/**
 * The editor's hold on a new model, with the request's edits applied. A model
 * that can't be edited still generates.
 */
async function startSession(id: number, spec: ModelSpec, request: GenerateRequest, result: GenerateResult): Promise<Transferable[]> {
  session = null;
  result.modelId = id;
  if (request.baseUrl) baseUrl = request.baseUrl;
  if (!spec.edit) {
    result.editable = false;
    return [];
  }
  let transfers: Transferable[];
  try {
    const projection = new Projection(request.area.center, request.area.rotationDeg, spec.mmPerMetre);
    const created = new EditSession(spec, request.settings, projection, { load: (font) => fonts.load(font, null) }, id);
    result.objects = created.describe();
    result.buildingMmPerMetre = created.buildingScale;
    if (spec.edit.roads.length) result.roads = roadLines(spec.edit, -spec.baseZ, request.settings.roads.thicknessMm);
    result.ground = groundGrid(spec.edit, -spec.baseZ) ?? undefined;
    transfers = [...(result.roads ? roadTransfers(result.roads) : []), ...(result.ground ? [result.ground.values.buffer] : [])];
    session = created;
    result.editable = true;
  } catch (error) {
    session = null;
    result.editable = false;
    result.objects = undefined;
    result.roads = undefined;
    result.ground = undefined;
    result.warnings.push(`The model can't be edited: ${describe(error)}`);
    return [];
  }
  // Edits that fail here leave the model editable. The session sends
  // everything again with the next change, and exports try them afresh.
  const edits = sanitizeEdits(request.edits ?? emptyEdits());
  if (!hasEdits(edits)) return transfers;
  try {
    result.edit = await session.update(edits, request.editsVersion ?? 0);
    return [...meshTransfers(result.edit), ...transfers];
  } catch (error) {
    result.warnings.push(`The edits couldn't be applied to this model: ${describe(error)}`);
    return transfers;
  }
}

function roadTransfers(lines: NonNullable<GenerateResult['roads']>): Transferable[] {
  return [lines.groups.buffer, lines.widths.buffer, lines.starts.buffer, lines.points.buffer];
}

/** Applies the newest edit request, one at a time, never during a generation. */
async function applyEdits(): Promise<void> {
  if (applying) return;
  applying = true;
  try {
    while (pendingEdit && !running) {
      const { id, request } = pendingEdit;
      pendingEdit = null;
      if (request.baseUrl) baseUrl = request.baseUrl;
      if (!session) {
        post({ type: 'error', id, message: 'Generate a model first.' });
        continue;
      }
      try {
        const update = await session.update(sanitizeEdits(request.edits), request.version);
        post({ type: 'edited', id, update }, meshTransfers(update));
      } catch (error) {
        post({ type: 'error', id, message: describe(error) });
      }
    }
  } finally {
    applying = false;
  }
}

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

  const loadRaceways = async (): Promise<Raceways | null> => {
    if (!plan.raceways) return null;
    const racewayKey = boundsKey(bounds);
    if (raceways?.key === racewayKey) return raceways.found;
    const found = await fetchRaceways(bounds, job.abort.signal);
    downloaded += found.downloaded;
    // A failed download is tried again next time.
    raceways = found.warning ? null : { key: racewayKey, found };
    return found;
  };

  const [data, dem, found] = await Promise.all([loadOverture(), loadElevation(), loadRaceways()]);
  return { data: withRaceways(data, found), dem, downloaded };
}

// LiDAR takes this share of the progress bar, and generation the rest after it.
const LIDAR_START = 0.3;
const LIDAR_END = 0.6;

const APPROVED_KEY = 'lidar-approved-tiles';

/**
 * Offered LiDAR tiles the user agreed to download, with any the request
 * brings. They're kept in the LiDAR cache, so clearing it asks again.
 */
async function approvedTiles(request: GenerateRequest): Promise<Set<string>> {
  const saved = await lidarCache.get(APPROVED_KEY).catch(() => undefined);
  let list: unknown = [];
  try {
    if (saved) list = JSON.parse(new TextDecoder().decode(saved));
  } catch {
    list = [];
  }
  const approved = new Set(Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string') : []);
  const before = approved.size;
  for (const key of request.approveTiles ?? []) if (typeof key === 'string' && key.length <= 2048) approved.add(key);
  if (approved.size !== before) await lidarCache.put(APPROVED_KEY, new TextEncoder().encode(JSON.stringify([...approved])).buffer as ArrayBuffer).catch(() => undefined);
  return approved;
}

/**
 * Measured buildings for the area. Preparation checkpoints each batch in the
 * LiDAR cache, and the last result is kept for the session, so changing a
 * setting that LiDAR does not depend on regenerates straight away.
 */
async function loadLidar(request: GenerateRequest, data: OvertureData, job: Running): Promise<PreparedLidar> {
  const { area, settings } = request;
  const bounds = dataBoundsFor(area);
  const measure = lidarRequest(area, settings);
  const key = JSON.stringify([boundsKey(bounds), data.release, measure]);
  const approved = await approvedTiles(request);
  if (prepared?.key === key && !reopened(prepared.lidar.offers, approved)) return prepared.lidar;
  prepared = null;
  const progress = job.progress;
  progress.begin('lidar', 'Preparing LiDAR buildings', LIDAR_START, LIDAR_END - LIDAR_START);
  // Browsers without nested workers read and measure in this worker instead.
  const pool = typeof Worker === 'undefined' ? null : lidarPool(lidarPoolSize(), job.abort.signal);
  let lidar: PreparedLidar;
  try {
    lidar = await prepareLidar({
      bounds,
      ...measure,
      buildings: data.features.building ?? [],
      parts: data.features.building_part ?? [],
      land: data.features.land ?? [],
      signal: job.abort.signal,
      progress: (label, fraction, detail) => progress.checkpoint(fraction, detail, label),
      runner: pool ?? undefined,
      approved,
    });
  } finally {
    pool?.close();
  }
  // Like the saved copy, a result with a failed read is tried again next time.
  // What did get read is checkpointed, so only the failures download again.
  if (!lidar.failures.length) prepared = { key, lidar };
  return lidar;
}

/** A warning when the survey picked by hand wasn't among those found here. */
function missingChoice(survey: string, found: SurveyChoice[]): string | null {
  if (!survey || !found.length || found.some((s) => s.url === survey || s.name === survey)) return null;
  return "The LiDAR survey picked under Layers doesn't cover this area, so surveys were picked automatically.";
}

/** The surveys under an area, for picking one by hand. */
async function listSurveys(id: number, query: SurveyQuery) {
  try {
    const { surveys, failures } = await findSurveys(query);
    post({ type: 'surveys', id, result: { surveys, failures: failures.map(lidarFailure) } });
  } catch (error) {
    post({ type: 'error', id, message: describe(error) });
  }
}

/** A LiDAR failure as a warning: a catalog that couldn't be searched, or a survey that couldn't be read. */
function lidarFailure(failure: Failure): string {
  return failure.search ? `Couldn't search ${failure.source} for LiDAR (${failure.reason}), so its surveys weren't used.` : `LiDAR from ${failure.source} could not be read: ${failure.reason}`;
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
    // A result saved before offers existed has none.
    offers: lidar.offers ?? [],
    found: lidar.found ?? [],
  };
}

type Pool = ReturnType<typeof lidarPool>;

/**
 * The survey read into a grid for the area. Blocks are checkpointed in the
 * LiDAR cache and the last grid is kept for the session, so changing a
 * setting other than the area, scale or detail builds straight away. The
 * session keeps the blocks packed, about a fifth of the layers, so the
 * layers can go while the model is meshed (releaseLayers).
 */
async function loadSurface(request: GenerateRequest, job: Running, pool: Pool | null): Promise<PreparedSurface> {
  const { area, settings } = request;
  const cell = requestedCell(settings.lidarModel, effectiveScale(area, settings.scale), area.widthM, area.heightM);
  const key = JSON.stringify([area.center, area.rotationDeg, area.widthM, area.heightM, cell, settings.lidar.survey, settings.lidar.surveyPreference, settings.lidar.olderYears]);
  const approved = await approvedTiles(request);
  if (surface?.key === key && !reopened(surface.prepared.offers, approved)) {
    const kept = surface.prepared;
    return { ...kept, layers: unpackLayers(kept.grid, kept.checkpoints), downloadedBytes: 0, reusedBlocks: kept.blocks };
  }
  // Let the last grid go before the next one comes in.
  surface = null;
  const progress = job.progress;
  progress.begin('lidar', 'Reading the LiDAR survey', 0.02, 0.58);
  const result = await prepareSurface({
    area,
    cellM: cell,
    maxCells: settings.lidarModel.cellMode === 'metres' ? (request.maxCells ?? MAX_FIXED_CELLS) : undefined,
    signal: job.abort.signal,
    progress: (label, fraction, detail) => progress.checkpoint(fraction, detail, label),
    runner: pool ?? undefined,
    approved,
    survey: settings.lidar.survey || undefined,
    rules: { preference: settings.lidar.surveyPreference, years: settings.lidar.olderYears },
  });
  // A failed read leaves a hole, and a survey whose catalog failed can leave
  // half the area without one, so try again next time. Blocks that were read
  // come from their checkpoints.
  if (!result.failures.length) surface = { key, prepared: { ...result, layers: emptyLayers(0, 0) } };
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
    offers: prepared.offers,
    found: prepared.found,
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
      releaseLayers: true,
    });
    timings.generate = (performance.now() - t1) / 1000;
    const t2 = performance.now();
    job.progress.begin('mesh', 'Building meshes', 0.92, 0.08);
    const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ, progress: job.progress, span: [0, 1], objects: true });
    timings.mesh = (performance.now() - t2) / 1000;
    lastSpec = spec;
    lastCredits = [...new Set(prepared.surveys.map((s) => `LiDAR: ${s.attribution}`))];
    lastMapData = Boolean(mapWater?.features.length);
    const warnings = [...spec.warnings];
    if (water instanceof Error) warnings.push(`Map water could not be downloaded, so the water is the survey's alone. ${describe(water)}`);
    if (meshed.failed) warnings.push('The LiDAR surface could not be closed into a solid. Try another area shape, or report this.');
    for (const failure of prepared.failures.slice(0, 3)) warnings.push(lidarFailure(failure));
    const missing = missingChoice(request.settings.lidar.survey, prepared.found);
    if (missing) warnings.push(missing);
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
    const transfers = await startSession(id, spec, request, result);
    post({ type: 'generated', id, result }, [...partTransfers(meshed.parts), ...transfers]);
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
    const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ, progress: job.progress, span: [0, 1], objects: true });
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
      if (!lidar.surveys.length && lidar.candidates && !lidar.failures.length && !lidar.offers?.length && !Object.keys(lidar.records).length) {
        warnings.push('No LiDAR survey that a browser can read covers these buildings, so they keep their mapped shapes.');
      }
      for (const failure of lidar.failures.slice(0, 3)) warnings.push(lidarFailure(failure));
      const missing = missingChoice(request.settings.lidar.survey, lidar.found ?? []);
      if (missing) warnings.push(missing);
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
    const transfers = await startSession(id, spec, request, result);
    post({ type: 'generated', id, result }, [...partTransfers(meshed.parts), ...transfers]);
  } catch (error) {
    const cancelled = error instanceof CancelError || job.progress.cancelled || (error as Error)?.name === 'AbortError';
    post({ type: 'error', id, message: cancelled ? 'Cancelled' : describe(error), cancelled, offers: error instanceof OffersError ? error.offers : undefined });
  } finally {
    // If one download failed, stop the other one too.
    job.abort.abort();
    if (running === job) running = null;
    // Edits that came in meanwhile, for the new model or the one still shown.
    void applyEdits();
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
    post({ type: 'error', id, message: cancelled ? 'Cancelled' : describe(error), cancelled, offers: error instanceof OffersError ? error.offers : undefined });
  } finally {
    job.abort.abort();
    if (running === job) running = null;
    void applyEdits();
  }
}

async function exportModel(id: number, request: ExportRequest) {
  const progress = new Progress((event) => post({ type: 'progress', id, progress: { ...event, stage: 'export' } }));
  exporting.set(id, progress);
  try {
    if (!lastSpec) throw new Error('Generate a model first.');
    const printer = printerByKey(request.printer);
    progress.begin('export', 'Preparing parts', 0, 0.8);
    const edits = request.edits ? sanitizeEdits(request.edits) : null;
    const withEdits = edits !== null && hasEdits(edits);
    const spec = session && withEdits ? await session.edited(edits, request.palette) : lastSpec;
    const { plates, failed } = await buildPlates(spec, {
      multiPlate: request.multiPlate,
      sectionWidthMm: request.sectionWidthMm,
      sectionHeightMm: request.sectionHeightMm,
      bedWidth: printer.width,
      bedDepth: printer.depth,
      exclude: excludedParts(spec, request.excludeParts),
      maxPlates: request.format === 'bambu' ? BAMBU_MAX_PLATES : undefined,
      progress,
    });
    post({ type: 'progress', id, progress: { stage: 'export', label: 'Writing the file', fraction: 0.85 } });
    const result = exportPlates(plates, request, lastCredits, lastMapData);
    // Said, not skipped quietly: the file looks finished either way.
    if (withEdits && !session) result.warnings.unshift("This model couldn't be edited, so the file is the model as generated, without your edits.");
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
    const cancelled = error instanceof CancelError || progress.cancelled;
    post({ type: 'error', id, message: cancelled ? 'Cancelled' : describe(error), cancelled, offers: error instanceof OffersError ? error.offers : undefined });
  } finally {
    exporting.delete(id);
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
    // What a typed array the browser can't find memory for throws. Running
    // out of the JS heap closes the tab instead, with nothing to catch.
    if (error instanceof RangeError && /allocation failed|Invalid typed array length|Invalid array buffer length/i.test(error.message)) {
      return 'The browser ran out of memory building this model. Try a smaller area, or larger cells for a LiDAR only model.';
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
    const progress = exporting.get(message.id);
    if (progress) progress.cancelled = true;
    return;
  }
  if (message.type === 'generate') void generate(message.id, message.request);
  else if (message.type === 'export') void exportModel(message.id, message.request);
  else if (message.type === 'surveys') void listSurveys(message.id, message.query);
  else if (message.type === 'edit') {
    // Only the newest edits matter: an older request still waiting is dropped.
    if (pendingEdit) post({ type: 'error', id: pendingEdit.id, message: 'Superseded', cancelled: true });
    pendingEdit = { id: message.id, request: message.request };
    void applyEdits();
  }
};
