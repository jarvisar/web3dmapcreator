// The generation worker: downloads map and elevation data, runs the pipeline
// and meshes the model, then exports plates on request. The last download is
// kept for the session, so changing a setting regenerates without
// downloading again, and the byte cache survives reloads.

import { fetchDem, type DemMosaic } from '../core/data/dem';
import type { OvertureData } from '../core/data/features';
import { fetchOverture } from '../core/data/overture';
import type { ExportRequest, FromWorker, GenerateRequest, GenerateResult, ProgressEvent, ToWorker } from '../core/engine/protocol';
import { exportPlates } from '../core/export';
import { BAMBU_MAX_PLATES } from '../core/export/sections';
import { CancelError, Progress } from '../core/pipeline/context';
import { rowFilter } from '../core/pipeline/filter';
import { dataBoundsFor, generateModel, neededTypes, type ModelSpec } from '../core/pipeline/generate';
import { meshLayers, partsBounds } from '../core/pipeline/mesh';
import { buildPlates } from '../core/pipeline/plates';
import { printerByKey, sanitizeSettings, type ModelSettings } from '../core/settings';
import type { GeoBounds, ModelStats } from '../core/types';

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
let overture: { key: string; data: OvertureData } | null = null;
let elevation: { key: string; dem: DemMosaic } | null = null;

function boundsKey(b: GeoBounds): string {
  return [b.west, b.south, b.east, b.north].map((v) => v.toFixed(6)).join(',');
}

/** The settings that decide which rows are downloaded. */
function downloadKey(s: ModelSettings): string {
  return JSON.stringify([
    neededTypes(s),
    s.roads.includeRail,
    s.roads.includePaths,
    s.roads.includeAirports,
    s.land.enabled,
    s.trees.enabled,
    s.trees.mapped,
    s.trees.forestScatter,
    s.trees.landCoverScatter,
    s.supports,
  ]);
}

function post(message: FromWorker, transfer?: Transferable[]) {
  ctx.postMessage(message, transfer);
}

async function loadData(request: GenerateRequest, job: Running, report: (e: ProgressEvent) => void) {
  const { area, settings } = request;
  const bounds = dataBoundsFor(area);
  const key = `${boundsKey(bounds)}|${downloadKey(settings)}`;
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
      types: neededTypes(settings),
      keep: rowFilter(settings, bounds),
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

async function generate(id: number, request: GenerateRequest) {
  request = { ...request, settings: sanitizeSettings(request.settings) };
  const started = performance.now();
  const timings: Record<string, number> = {};
  const report = (event: ProgressEvent) => post({ type: 'progress', id, progress: event });
  const job: Running = { id, progress: new Progress(report), abort: new AbortController() };
  running = job;
  try {
    report({ stage: 'data', label: 'Finding map data', fraction: 0.01 });
    const { data, dem, downloaded } = await loadData(request, job, report);
    timings.download = (performance.now() - started) / 1000;
    if (job.progress.cancelled) throw new CancelError();

    const t1 = performance.now();
    const spec = await generateModel({
      area: request.area,
      settings: request.settings,
      data,
      elevation: dem,
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
    const result: GenerateResult = {
      parts: meshed.parts,
      bounds: partsBounds(meshed.parts),
      mmPerMetre: spec.mmPerMetre,
      release: data.release,
      stats: userStats(spec.stats, downloaded),
      warnings,
      timings,
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

async function exportModel(id: number, request: ExportRequest) {
  try {
    if (!lastSpec) throw new Error('Generate a model first.');
    const printer = printerByKey(request.printer);
    const progress = new Progress((event) => post({ type: 'progress', id, progress: { ...event, stage: 'export' } }));
    progress.begin('export', 'Preparing parts', 0, 0.8);
    const plates = await buildPlates(lastSpec, {
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
    const result = exportPlates(plates, request);
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
