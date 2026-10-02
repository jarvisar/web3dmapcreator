// Preparing LiDAR buildings for an area, ported from the add-on's
// download_lidar.prepare for streamed surveys. Buildings are measured in
// 400 m batches from their best survey; a rejection moves a building on to
// its next survey; one measurement is chosen per building at the end. Each
// batch is checkpointed, so changing an unrelated setting, or preparing an
// overlapping area, reuses it without downloading or measuring again.

import { areaGeoBounds, effectiveScale, shapeRing } from '../geo/area';
import { Projection } from '../geo/projection';
import { difference, intersection, multiArea, union } from '../geometry/polygon';
import type { SourceFeature } from '../pipeline/source';
import type { GeoBounds, LonLat, MultiPolygon, Polygon, Ring } from '../types';
import { measureFeatures, type MetricFeature } from './features';
import type { Points } from './points';
import { publish, type PublishedRecord } from './publish';
import { readTiles } from './read/tiles';
import { readEpt } from './read/ept';
import { readI3s } from './read/i3s';
import { Fetcher } from './read/fetcher';
import { lazDecoder } from './read/laz';
import { ALGORITHM_VERSION, type LidarRecord } from './records';
import { rockDomains } from './rock';
import { chooseMeasurement, type Observation } from './selection';
import { cellSize, DEFAULT_DETAIL_MM, gridSpec, requestedCell } from '../dsm/grid';
import { gridProber, readSurfaceBlock, type SurfaceRunner } from '../dsm/prepare';
import type { AreaShape, AreaSpec, ModelSettings, SurveyPreference } from '../settings';
import { area, bounds, boxShape, buffer, centroid, intersects } from './shapes';
import { checkNote, clipRingToBox, digest, measureDensities, orderSurveys, pickNote, rankOrder, surveyDensity, toMetric, type Ranked } from './ranking';
import type { SurveyQuery, SurveyRules } from './query';
import { chosenFirst, isChosen, surveyChoice, type SurveyChoice } from './choice';
import { advantage, approves, makeOffer, reopened, staged, tileKey, tilesIn, unreadable, type Approval, type LidarOffer } from './offers';
import type { Candidate, Failure, Tile } from './sources';
import { searchSurveys } from './search';
import { measuredProps, type SourcePart } from './source';
import type { SurfaceSettings } from './surface';

export interface PrepareSettings {
  roofMode: 'envelope' | 'heights';
  preferLidar: boolean;
  minFootprintMm2: number;
  rockSurfaces: boolean;
  /** Printed mm per ground metre, horizontal and vertical (height scale included). */
  xyScale: number;
  zScale: number;
  /** The cell measured roofs are cut from, metres: a LiDAR Only model's (requestedCell), never grown for the area. */
  cellM?: number;
  /** A survey to read first: its URL, or its name (`isChosen`). */
  survey?: string;
  /** How the others are put in order (lidar/ranking.ts). Balanced over 5 years by default. */
  surveyPreference?: SurveyPreference;
  olderYears?: number;
}

/** The area, so measured roofs follow the cells of a LiDAR Only model of it. */
export interface PrepareArea {
  center: LonLat;
  rotationDeg: number;
  widthM: number;
  heightM: number;
  /** Only buildings in this outline are measured. A rectangle without them. */
  shape?: AreaShape;
  cornerRadius?: number;
}

/** What prepareLidar takes from a model's area and settings. */
export function lidarRequest(area: AreaSpec, settings: ModelSettings): { area: PrepareArea; settings: PrepareSettings } {
  const scale = effectiveScale(area, settings.scale);
  return {
    area: { center: area.center, rotationDeg: area.rotationDeg, widthM: area.widthM, heightM: area.heightM, shape: area.shape, cornerRadius: area.cornerRadius },
    // The cell a LiDAR Only model asks for, but never grown for a large
    // area: only one batch at a time is gridded.
    settings: { ...settings.lidar, xyScale: scale, zScale: scale * settings.buildings.heightScale, cellM: requestedCell(settings.lidarModel, scale, 0, 0) },
  };
}

export interface PrepareInput {
  bounds: GeoBounds;
  /** Measures in the area's own frame when given, or one centred on `bounds`. */
  area?: PrepareArea;
  buildings: SourceFeature[];
  parts: SourceFeature[];
  land?: SourceFeature[];
  settings: PrepareSettings;
  signal?: AbortSignal;
  progress?: (label: string, fraction: number, detail?: string) => Promise<void> | void;
  /** Where batches are read and measured, and surveys probed. By default one at a time in this thread. */
  runner?: BatchRunner & Partial<Pick<SurfaceRunner, 'surface'>>;
  /** Tiles of whole-file surveys the user agreed to download. Other whole-file surveys are only offered. */
  approved?: Approval;
}

export interface SurveyUse {
  name: string;
  provider: string;
  format: string;
  attribution: string;
  license?: string;
  sourcePage: string;
  buildings: number;
}

export interface PreparedLidar {
  records: Record<string, PublishedRecord>;
  rejected: Record<string, string>;
  counts: Record<string, number>;
  surveys: SurveyUse[];
  failures: Failure[];
  candidates: number;
  downloadedBytes: number;
  reused: boolean;
  /** Whole-file surveys that would have measured buildings, waiting for the user's approval. */
  offers: LidarOffer[];
  /** Every survey found under the area, in the order they'd be picked without a choice. */
  found: SurveyChoice[];
}

/**
 * A warning for when no building was measured, or null. A failed read or an
 * offer says why on its own.
 */
export function nothingMeasured(lidar: PreparedLidar): string | null {
  if (!lidar.candidates || Object.keys(lidar.records).length || lidar.failures.length || lidar.offers?.length) return null;
  // With every building under the smallest footprint, no survey was even looked for.
  const small = Object.values(lidar.rejected).filter((reason) => reason === 'footprint_below_minimum').length;
  if (small === lidar.candidates) return 'Every building here is smaller than the Smallest footprint set for LiDAR, so none were measured and they keep their mapped shapes.';
  if (!lidar.found?.length) return 'No LiDAR survey that a browser can read covers these buildings, so they keep their mapped shapes.';
  return 'LiDAR covers these buildings, but none of them could be measured from it, so they keep their mapped shapes.';
}

// Measurements read a 25 m ground halo; acquisition keeps a 30 m margin.
const SUPPORT_HALO_M = 30;
// How far past the selection any acquisition may reach.
const SELECTION_HALO_M = 75;
// Buildings this close outside the area's outline are still measured, for
// the chords of a round outline.
const OUTLINE_MARGIN_M = 5;
const BATCH_M = 400;
const MIN_WIDTH_MM = 0.1;
const MIN_STEP_MM = 0.05;
const DAY_MS = 24 * 3600 * 1000;
/** Progress once the surveys are found and ranked, when reading starts. */
export const SURVEYS_FOUND = 0.08;
const MEASURED_ALL = 0.98;

let resultStore: { get(key: string): Promise<ArrayBuffer | undefined>; put(key: string, data: ArrayBuffer): Promise<void> } | null = null;

/** Where prepared results and batch checkpoints are kept (the LiDAR byte cache in the app). */
export function setCheckpointStore(store: typeof resultStore): void {
  resultStore = store;
}

/** The area's outline in its own frame, metres. */
function areaOutline(area: PrepareArea): Ring {
  const { widthM, heightM } = area;
  return shapeRing(area.shape ?? 'rectangle', widthM, heightM, (area.cornerRadius ?? 0) * Math.min(widthM, heightM), Math.max(widthM, heightM) / 2000);
}

async function loadJson<T>(key: string): Promise<T | null> {
  const bytes = resultStore ? await resultStore.get(key).catch(() => undefined) : undefined;
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown): void {
  if (!resultStore) return;
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value));
  } catch {
    // Past what a string can hold (about 512 MB in V8) it just isn't kept,
    // rather than failing a model that's already measured.
    return;
  }
  resultStore.put(key, bytes.buffer as ArrayBuffer).catch(() => undefined);
}

function geometryRings(geometry: SourceFeature['geometry'] | null | undefined): Polygon[] {
  if (!geometry) return [];
  const open = (ring: number[][]): Ring => {
    const out = ring.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]] as [number, number]);
    if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    return out;
  };
  if (geometry.type === 'Polygon') return [(geometry.coordinates as number[][][]).map(open)];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).map((p) => p.map(open));
  if (geometry.type === 'GeometryCollection') return (geometry.geometries ?? []).flatMap(geometryRings);
  return [];
}

/**
 * The surveys found under an area, for picking one by hand, in the order
 * they'd be read. Only catalogs and indexes are read. Probes made before for
 * this area and cell count, and new ones wait for Generate.
 */
export async function findSurveys(query: SurveyQuery, signal?: AbortSignal): Promise<{ surveys: SurveyChoice[]; failures: Failure[] }> {
  const { area: spec, rules } = query;
  const frame = new Projection(spec.center, spec.rotationDeg, 1);
  const rect = boxShape(-spec.widthM / 2, -spec.heightM / 2, spec.widthM / 2, spec.heightM / 2);
  const bbox = areaGeoBounds(spec);
  const fetcher = new Fetcher(signal);
  const found = await searchSurveys(fetcher, bbox);
  const box: [number, number, number, number] = [bbox.west, bbox.south, bbox.east, bbox.north];
  const ranked: Ranked[] = [];
  for (const candidate of found.candidates) {
    // Map models never read them for buildings, so they aren't offered there.
    if (candidate.unclassified && !query.tiered) continue;
    const clipped = candidate.coverage.map((polygon) => polygon.map((ring) => clipRingToBox(ring, box)).filter((ring) => ring.length >= 3)).filter((p) => p.length);
    const coverage = intersection(toMetric(clipped, frame), rect);
    if (!coverage.length) continue;
    ranked.push({ candidate, coverage, catalogCoverage: multiArea(coverage) / multiArea(rect) });
  }
  await measureDensities(fetcher, ranked, frame, signal);
  const tier = (r: Ranked) => (query.tiered && r.catalogCoverage < 0.99 ? 1 : 0);
  const compare = (a: Ranked, b: Ranked) => tier(a) - tier(b) || rankOrder(a, b);
  const probe = gridProber({ area: spec, grid: gridSpec(spec.widthM, spec.heightM, rules.cellM), runner: { surface: () => Promise.reject(new Error('Nothing is read while listing surveys')) }, savedOnly: true });
  const group = (a: Ranked, b: Ranked) => tier(a) === tier(b);
  const order = await orderSurveys(ranked, rules, { compare, group, probe });
  const note = pickNote(order, rules, compare) ?? checkNote(order, rules, compare, group);
  return { surveys: order.map((r, i) => surveyChoice(r, i ? null : note)), failures: found.failures };
}

export async function prepareLidar(input: PrepareInput): Promise<PreparedLidar> {
  const { bounds: bbox, settings } = input;
  const progress = async (label: string, fraction: number, detail?: string) => {
    input.signal?.throwIfAborted();
    await input.progress?.(label, fraction, detail);
  };
  const heightOnly = settings.roofMode === 'heights';
  // Height sampling is in real metres, independent of print scale; the
  // footprint filter still uses the actual scale.
  const xyScale = heightOnly ? 0.07 : settings.xyScale;
  const zScale = heightOnly ? 0.077 : settings.zScale;
  const minFootprintM2 = settings.minFootprintMm2 / settings.xyScale ** 2;
  const frame = input.area ? new Projection(input.area.center, input.area.rotationDeg, 1) : new Projection([(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2], 0, 1);
  const cellM = settings.cellM ?? cellSize(DEFAULT_DETAIL_MM, settings.xyScale, 0, 0);
  const rules: SurveyRules = { preference: settings.surveyPreference ?? 'balanced', years: settings.olderYears ?? 5, cellM };
  const surface: SurfaceSettings | undefined = heightOnly ? undefined : { cellM, widthM: input.area?.widthM, heightM: input.area?.heightM, xyScale, zScale };

  // ------------------------------------------------------------ footprints
  const geometries = new Map<string, MultiPolygon>();
  const features: MetricFeature[] = [];
  const seenIds = new Set<string>();
  for (const feature of input.buildings) {
    if (seenIds.has(feature.id)) continue;
    seenIds.add(feature.id);
    const geometry = toMetric(geometryRings(feature.geometry), frame);
    if (!geometry.length) continue;
    geometries.set(feature.id, geometry);
    features.push({ id: feature.id, props: feature.props, geometry });
  }
  if (settings.rockSurfaces && !heightOnly) {
    const rock = (input.land ?? [])
      .filter((f) => f.props.class === 'bare_rock')
      .map((f) => ({ id: f.id, geometry: toMetric(geometryRings(f.geometry), frame) }))
      .filter((f) => f.geometry.length);
    for (const domain of rockDomains(rock)) {
      geometries.set(domain.id, domain.geometry);
      features.push({ id: domain.id, props: { lidar_surface_kind: 'rock', source_land_ids: domain.members }, geometry: domain.geometry });
    }
  }
  // The bounds' corners, which a turned frame doesn't keep square to its axes.
  const selection: MultiPolygon = [[[frame.toLocal(bbox.west, bbox.south), frame.toLocal(bbox.east, bbox.south), frame.toLocal(bbox.east, bbox.north), frame.toLocal(bbox.west, bbox.north)]]];
  // Only buildings the model can show are measured. The bounds of a turned or
  // round area reach well past it: 60% of the buildings in a rectangle turned
  // 30 degrees, 75% for a circle. The bounds still set how far points are read.
  const outline = input.area ? buffer([[areaOutline(input.area)]], OUTLINE_MARGIN_M) : selection;
  const inArea = features.filter((f) => intersects(f.geometry, outline));
  const rejected: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const count = (reason: string) => (counts[reason] = (counts[reason] ?? 0) + 1);
  const eligible = inArea.filter((f) => {
    // Small parents keep their mapped shape; small parts of admitted buildings stay eligible.
    if (minFootprintM2 > 0 && f.props.lidar_surface_kind !== 'rock' && area(f.geometry) < minFootprintM2) {
      rejected[f.id] = 'footprint_below_minimum';
      count('footprint_below_minimum');
      return false;
    }
    return true;
  });

  const partsByParent = new Map<string, MultiPolygon[]>();
  const sourcePartsByParent = new Map<string, SourcePart[]>();
  for (const part of input.parts) {
    const parent = typeof part.props.building_id === 'string' ? part.props.building_id : '';
    if (!parent || part.props.is_underground) continue;
    const geometry = toMetric(geometryRings(part.geometry), frame);
    if (!geometry.length) continue;
    (partsByParent.get(parent) ?? partsByParent.set(parent, []).get(parent)!).push(geometry);
    (sourcePartsByParent.get(parent) ?? sourcePartsByParent.set(parent, []).get(parent)!).push({ id: part.id, props: part.props, geometry });
  }
  for (const f of features) {
    if (!f.id.startsWith('rock:')) continue;
    // A rock mass stands in for the source buildings wholly inside it.
    f.props.covered_buildings = [...geometries]
      .filter(([id, g]) => !id.startsWith('rock:') && multiArea(difference(g, f.geometry)) <= 1e-6 && (partsByParent.get(id) ?? []).every((p) => multiArea(difference(p, f.geometry)) <= 1e-6))
      .map(([id]) => id);
  }

  // ------------------------------------------------------------ signature
  const request = {
    algorithm: ALGORITHM_VERSION,
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(7)),
    frame: [...frame.center.map((v) => v.toFixed(7)), frame.rotationDeg],
    outline: input.area ? [input.area.widthM, input.area.heightM, input.area.shape ?? 'rectangle', input.area.cornerRadius ?? 0] : null,
    surface: surface ? [surface.cellM, surface.widthM ?? null, surface.heightM ?? null] : null,
    xyScale: Math.round(xyScale * 1e10) / 1e10,
    zScale: Math.round(zScale * 1e10) / 1e10,
    roofMode: settings.roofMode,
    preferLidar: settings.preferLidar,
    minFootprintM2: Math.round(minFootprintM2 * 1e6) / 1e6,
    rock: settings.rockSurfaces && !heightOnly,
    footprints: digest(features.map((f) => [f.id, f.geometry, measuredProps(f.props)])),
    parts: digest([...sourcePartsByParent].map(([k, v]) => [k, v.map((p) => [p.id, measuredProps(p.props), p.geometry])])),
    // Only when there is one, so results saved without a choice keep their keys.
    ...(settings.survey ? { survey: settings.survey } : {}),
    // The cell too, which orders surveys even where no roofs are cut from it (heights only).
    ranking: [RANKING_VERSION, rules.preference, rules.years, rules.cellM],
  };
  const requestKey = `prepared:${digest(request)}`;
  const previous = await loadJson<PreparedLidar & { saved: number }>(requestKey);
  // Not once a tile it offered has been approved: that's what the next run is for.
  if (previous && Date.now() - previous.saved < DAY_MS && !reopened(previous.offers, input.approved)) return { ...previous, offers: previous.offers ?? [], found: previous.found ?? [], reused: true, downloadedBytes: 0 };
  const fetcher = new Fetcher(input.signal);
  const result: PreparedLidar = { records: {}, rejected, counts, surveys: [], failures: [], candidates: inArea.length, downloadedBytes: 0, reused: false, offers: [], found: [] };
  if (!eligible.length) {
    saveJson(requestKey, { ...result, saved: Date.now() });
    return result;
  }
  // Nothing can be read without a decoder, so don't search or download.
  try {
    await lazDecoder();
  } catch (error) {
    result.failures.push({ source: 'every survey', reason: (error as Error).message });
    return result;
  }

  // Every footprint stays a neighbour: a skipped house still keeps its roof
  // returns out of an adjacent building's ground fit. Found after the cache
  // check and through a grid of footprint boxes: every pair took 8 s on a
  // city of 24,000 buildings, even with the answer cached.
  const reach = 30;
  const cell = 2 * reach;
  const order = new Map([...geometries.keys()].map((id, i) => [id, i]));
  const boxes = new Map([...geometries].map(([id, g]) => [id, bounds(g)]));
  const grid = new Map<number, string[]>();
  const gridKey = (cx: number, cy: number) => cx * 1_000_000 + cy;
  for (const [id, box] of boxes) {
    for (let cx = Math.floor(box[0] / cell); cx <= Math.floor(box[2] / cell); cx++) {
      for (let cy = Math.floor(box[1] / cell); cy <= Math.floor(box[3] / cell); cy++) {
        const list = grid.get(gridKey(cx, cy));
        if (list) list.push(id);
        else grid.set(gridKey(cx, cy), [id]);
      }
    }
  }
  const neighboursById = new Map<string, MultiPolygon[]>();
  for (let i = 0; i < eligible.length; i++) {
    if (i % 512 === 0) await progress('Finding LiDAR surveys', 0.01);
    const f = eligible[i];
    const zone = buffer(f.geometry, reach);
    const [x0, y0, x1, y1] = bounds(zone);
    const near = new Set<string>();
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
      for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
        for (const id of grid.get(gridKey(cx, cy)) ?? []) {
          if (id === f.id || near.has(id)) continue;
          const box = boxes.get(id)!;
          if (box[0] > x1 || box[2] < x0 || box[1] > y1 || box[3] < y0) continue;
          if (intersects(geometries.get(id)!, zone)) near.add(id);
        }
      }
    }
    // In footprint order, as before, so checkpoint keys don't depend on the grid.
    neighboursById.set(f.id, [...near].sort((a, b) => order.get(a)! - order.get(b)!).map((id) => geometries.get(id)!));
  }

  // ------------------------------------------------------------ discovery
  await progress('Finding LiDAR surveys', 0.02);
  const halo = buffer(selection, SELECTION_HALO_M);
  const [hx0, hy0, hx1, hy1] = bounds(halo);
  const corners = [frame.localToGeo(hx0, hy0), frame.localToGeo(hx1, hy0), frame.localToGeo(hx1, hy1), frame.localToGeo(hx0, hy1)];
  const query: GeoBounds = {
    west: Math.min(...corners.map((c) => c[0])),
    south: Math.min(...corners.map((c) => c[1])),
    east: Math.max(...corners.map((c) => c[0])),
    north: Math.max(...corners.map((c) => c[1])),
  };
  const found = await searchSurveys(fetcher, query, (message) => void progress('Finding LiDAR surveys', 0.04, message));
  result.failures.push(...found.failures);
  const box: [number, number, number, number] = [query.west, query.south, query.east, query.north];
  const haloArea = area(halo);
  const ranked: Ranked[] = [];
  for (const candidate of found.candidates) {
    // Measurement needs classified ground, so these would only be downloaded for nothing.
    if (candidate.unclassified) continue;
    const clipped = candidate.coverage.map((polygon) => polygon.map((ring) => clipRingToBox(ring, box)).filter((ring) => ring.length >= 3)).filter((p) => p.length);
    const coverage = intersection(toMetric(clipped, frame), halo);
    if (!coverage.length) continue;
    ranked.push({ candidate, coverage, catalogCoverage: area(coverage) / haloArea });
  }
  await progress('Finding LiDAR surveys', 0.05, 'Working out their returns per m² here');
  await measureDensities(fetcher, ranked, frame, input.signal);
  // Probed on the grid roofs are cut from: the blocks a LiDAR only model of the area would probe.
  const prober: Pick<SurfaceRunner, 'surface'> = { surface: input.runner?.surface ?? ((job, report) => readSurfaceBlock(job, fetcher, report)) };
  const probe = input.area
    ? gridProber({
        area: input.area,
        grid: gridSpec(input.area.widthM, input.area.heightM, cellM),
        runner: prober,
        approved: input.approved,
        signal: input.signal,
        progress: (name, detail) => progress('Measuring how finely the surveys fill the grid', 0.06, detail ?? name),
      })
    : undefined;
  const automatic = await orderSurveys(ranked, rules, { probe });
  result.found = automatic.map((r, i) => surveyChoice(r, i ? null : pickNote(automatic, rules)));
  // Per building: the surveys whose coverage holds its whole footprint, in the area's order.
  const chosen = chosenFirst(automatic, settings.survey);
  const orders = new Map(eligible.map((f) => [f.id, chosen.filter((r) => multiArea(difference(f.geometry, r.coverage)) <= 1e-6)]));
  const globalRank = new Map(chosen.map((r, i) => [r.candidate.url, i]));

  // ------------------------------------------------------------ acquisition
  const alternatives = new Map<string, LidarRecord[]>();
  const observations = new Map<string, Observation[]>();
  const resolved = new Set<string>();
  const tried = new Map<string, Set<string>>(eligible.map((f) => [f.id, new Set<string>()]));
  // Surveys whose points a building was measured from, or rejected on.
  const readBy = new Map<string, Candidate[]>();
  const used = new Map<string, SurveyUse>();
  // How far along reading is: buildings read, over those and every one known
  // to be still ahead, the survey's not read yet and any with a survey not
  // tried. Batches that only found whole-file tiles to offer cost nothing,
  // so they don't count. Shared out per survey, an offer-only survey read
  // first took 92% of the bar in an instant.
  let read = 0;
  let share = 0;
  const inFlight = new Set<string>();
  const reshare = () => {
    let ahead = inFlight.size;
    for (const f of eligible) {
      if (inFlight.has(f.id) || resolved.has(f.id)) continue;
      if (orders.get(f.id)!.some((r) => !tried.get(f.id)!.has(r.candidate.url))) ahead++;
    }
    share = Math.max(share, read / Math.max(1, read + ahead));
  };
  // The default runner shares the discovery fetcher, which counts its bytes.
  const runner: BatchRunner = input.runner ?? { concurrency: 1, run: async (job, report) => ({ outcome: await runBatch(job, fetcher, report), downloaded: 0 }) };
  // Batches a whole-file survey would have read without approval. Their
  // buildings go on to their next survey as if it had failed.
  const pending: { survey: Candidate; ids: string[]; tiles: Tile[] }[] = [];
  for (;;) {
    const groups = new Map<string, MetricFeature[]>();
    for (const f of eligible) {
      if (resolved.has(f.id)) continue;
      const next = orders.get(f.id)!.find((r) => !tried.get(f.id)!.has(r.candidate.url));
      if (!next) continue;
      const list = groups.get(next.candidate.url) ?? [];
      list.push(f);
      groups.set(next.candidate.url, list);
    }
    if (!groups.size) break;
    const url = [...groups.keys()].sort((a, b) => (globalRank.get(a)! - globalRank.get(b)!) || (a < b ? -1 : 1))[0];
    const survey = ranked.find((r) => r.candidate.url === url)!.candidate;
    const members = groups.get(url)!;
    for (const f of members) {
      tried.get(f.id)!.add(url);
      inFlight.add(f.id);
    }
    reshare();
    const batches = new Map<string, MetricFeature[]>();
    for (const f of members) {
      const [cx, cy] = centroid(f.geometry);
      const key = `${Math.floor(cx / BATCH_M)},${Math.floor(cy / BATCH_M)}`;
      (batches.get(key) ?? batches.set(key, []).get(key)!).push(f);
    }
    const queue = [...batches.keys()].sort().map((k) => batches.get(k)!);
    // Each building is in one batch per round, so the order batches finish in
    // doesn't change the result.
    const lane = async () => {
      while (queue.length) {
        const batch = queue.shift()!;
        const context = { frame, halo, settings: { ...settings, xyScale, zScale }, surface, partsByParent, sourcePartsByParent, neighboursById, runner, approved: input.approved, progress: (label: string, detail?: string) => progress(label, SURVEYS_FOUND + (MEASURED_ALL - SURVEYS_FOUND) * share, detail) };
        const outcome = await measureBatch(batch, survey, context).catch((error: unknown) => {
          if ((error as Error)?.name === 'BudgetExceeded' && batch.length > 1) {
            queue.unshift(...splitBatch(batch));
            return null;
          }
          if ((error as Error)?.name === 'AbortError' || input.signal?.aborted) throw error;
          // Once per survey and reason, not once per batch.
          const reason = (error as Error).message;
          if (!result.failures.some((f) => f.source === survey.name && f.reason === reason)) result.failures.push({ source: survey.name, reason });
          return undefined;
        });
        if (outcome === null) continue;
        for (const f of batch) inFlight.delete(f.id);
        if (!outcome?.pending) read += batch.length;
        if (!outcome) {
          reshare();
          continue;
        }
        if (outcome.pending) {
          pending.push({ survey, ids: batch.map((f) => f.id), tiles: outcome.pending });
          reshare();
          continue;
        }
        result.downloadedBytes += outcome.downloaded;
        for (const f of batch) {
          (readBy.get(f.id) ?? readBy.set(f.id, []).get(f.id)!).push(survey);
          const record = outcome.records[f.id];
          if (record) {
            const withSource: LidarRecord = { ...record, source: survey.name, sourceUrl: survey.url, sourceFormat: survey.format, projectYearHint: survey.projectYearHint };
            (alternatives.get(f.id) ?? alternatives.set(f.id, []).get(f.id)!).push(withSource);
            const choice = chooseMeasurement(alternatives.get(f.id)!, observations.get(f.id) ?? [], f.geometry, settings.preferLidar);
            if (choice.record) resolved.add(f.id);
          }
          const observation = outcome.observations[f.id];
          if (observation) (observations.get(f.id) ?? observations.set(f.id, []).get(f.id)!).push({ ...observation, source: survey.name });
          if (outcome.rejected[f.id]) rejected[f.id] = outcome.rejected[f.id];
        }
        reshare();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(runner.concurrency, queue.length)) }, lane));
  }

  // ------------------------------------------------------------ selection
  await progress('Choosing one survey per building', 0.99);
  const waiting = new Set(pending.flatMap((p) => p.ids));
  for (const f of eligible) {
    const candidates = alternatives.get(f.id);
    if (!candidates) {
      if (!rejected[f.id]) rejected[f.id] = waiting.has(f.id) ? 'tiles_not_downloaded' : orders.get(f.id)!.length ? 'no_compatible_measurement' : 'no_survey_coverage';
      continue;
    }
    const { record, audit } = chooseMeasurement(candidates, observations.get(f.id) ?? [], f.geometry, settings.preferLidar);
    if (!record) {
      rejected[f.id] = audit.reason;
      continue;
    }
    delete rejected[f.id];
    result.records[f.id] = publish({ ...record, selection: audit as unknown as Record<string, unknown> }, frame);
    const survey = ranked.find((r) => r.candidate.url === record.sourceUrl)?.candidate;
    if (survey) {
      const use = used.get(survey.url) ?? { name: survey.name, provider: survey.provider, format: survey.format, attribution: survey.attribution, license: survey.license, sourcePage: survey.sourcePage, buildings: 0 };
      use.buildings++;
      used.set(survey.url, use);
    }
  }
  for (const reason of Object.values(rejected)) if (reason !== 'footprint_below_minimum') count(reason);
  result.surveys = [...used.values()];
  if (pending.length) {
    await progress('Sizing LiDAR tiles to offer', 0.995);
    result.offers = await stagedOffers(pending, result, chosen, readBy, input.approved, fetcher, settings.survey, rules.preference === 'newest');
  }
  result.downloadedBytes += fetcher.downloaded + (runner.downloaded?.() ?? 0);
  // Keep the result only when every survey was read: a failed read is retried next time.
  if (!result.failures.length) saveJson(requestKey, { ...result, saved: Date.now() });
  return result;
}

// Rejections no other survey would change, from the add-on's
// SOURCE_INDEPENDENT_REJECTIONS.
const SOURCE_INDEPENDENT = new Set(['invalid_or_small_footprint', 'elevated_or_underground', 'incomplete_footprint_or_ground_halo']);

/**
 * Whole-file surveys worth asking about: for buildings nothing else measured,
 * or ones it beats by a wide margin (`advantage`). Each comes with every tile
 * its batches need, so approving it reads those batches in full next time.
 * `order` is the order surveys are read in, and `readBy` the surveys each
 * building was read from.
 */
async function stagedOffers(pending: { survey: Candidate; ids: string[]; tiles: Tile[] }[], result: PreparedLidar, order: Ranked[], readBy: Map<string, Candidate[]>, approved: Approval | undefined, fetcher: Fetcher, chosen: string | undefined, newestOnly: boolean): Promise<LidarOffer[]> {
  const surveys = new Map(order.map((r) => [r.candidate.url, r.candidate]));
  const rank = new Map(order.map((r, i) => [r.candidate.url, i]));
  const densities = new Map(order.map((r) => [r.candidate.url, surveyDensity(r) ?? undefined]));
  const density = (c: Candidate) => densities.get(c.url) ?? c.densityM2;
  // Each building is offered from one survey at most, the first it would be
  // read from. Copies of the same flight (OpenTopography's of São Paulo's,
  // ISGS's of USGS's Chicago) were offered next to it for the same buildings.
  const offered = new Set<string>();
  const problems = new Map<string, string | null>();
  const wanted = new Map<string, { survey: Candidate; tiles: Tile[]; buildings: Map<string, LidarOffer['reason']> }>();
  for (const { survey, ids, tiles } of [...pending].sort((a, b) => rank.get(a.survey.url)! - rank.get(b.survey.url)!)) {
    const taken = new Map<string, LidarOffer['reason']>();
    for (const id of ids) {
      if (offered.has(id)) continue;
      const from = result.records[id]?.sourceUrl;
      const current = from ? surveys.get(from) : undefined;
      // One the user picked is always offered: it's why they picked it.
      // Where another survey read the building and found nothing usable, this
      // one has to be clearly newer or denser to do better, like a measured one.
      const reason = isChosen(survey, chosen)
        ? 'chosen'
        : current
          ? advantage(survey, current, density, newestOnly)
          : SOURCE_INDEPENDENT.has(result.rejected[id]) || !(readBy.get(id) ?? []).every((other) => advantage(survey, other, density, newestOnly))
            ? null
            : 'gap';
      if (reason) taken.set(id, reason);
    }
    if (!taken.size) continue;
    const needed = tiles.filter((t) => !approves(approved, [t]));
    // One whose header shows it couldn't be read anyway is a failure, and
    // leaves its buildings to the next. The same tile makeOffer looks at.
    if (!problems.has(survey.url)) {
      const problem = await unreadable(fetcher, survey, needed);
      problems.set(survey.url, problem);
      if (problem) result.failures.push({ source: survey.name, reason: problem });
    }
    if (problems.get(survey.url)) continue;
    const entry = wanted.get(survey.url) ?? { survey, tiles: [], buildings: new Map<string, LidarOffer['reason']>() };
    wanted.set(survey.url, entry);
    for (const [id, reason] of taken) {
      entry.buildings.set(id, reason);
      offered.add(id);
    }
    entry.tiles.push(...needed);
  }
  const offers = await Promise.all(
    [...wanted.values()].map(({ survey, tiles, buildings }) => {
      const counts: NonNullable<LidarOffer['counts']> = {};
      for (const [id, reason] of buildings) if (!id.startsWith('rock:')) counts[reason] = (counts[reason] ?? 0) + 1;
      const reasons = new Set(buildings.values());
      const reason = reasons.has('chosen') ? 'chosen' : reasons.has('gap') ? 'gap' : reasons.has('newer') ? 'newer' : 'denser';
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      return makeOffer(fetcher, survey, tiles, reason, result.failures, total, counts);
    }),
  );
  return offers.filter((o): o is LidarOffer => o !== null);
}

function splitBatch(batch: MetricFeature[]): MetricFeature[][] {
  const centres = batch.map((f) => centroid(f.geometry));
  const xs = centres.map((c) => c[0]);
  const ys = centres.map((c) => c[1]);
  const axis = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? 0 : 1;
  const ordered = batch.map((f, i) => ({ f, key: centres[i][axis] })).sort((a, b) => a.key - b.key).map((e) => e.f);
  const mid = ordered.length >> 1;
  return [ordered.slice(0, mid), ordered.slice(mid)];
}

export interface BatchOutcome {
  records: Record<string, LidarRecord>;
  rejected: Record<string, string>;
  observations: Record<string, Observation>;
}

// Raised when the order surveys are read in changes, so prepared results from the old order aren't reused.
const RANKING_VERSION = 2;

/** One batch against one survey, as plain data so a worker can run it. */
export interface BatchJob {
  batch: MetricFeature[];
  survey: Candidate;
  /** Centre and rotation of the measurement frame, which has scale 1. */
  origin: [number, number];
  rotationDeg: number;
  /** The cells measured roofs are cut from. */
  surface?: SurfaceSettings;
  query: GeoBounds;
  roi: MultiPolygon;
  settings: PrepareSettings;
  partsByParent: Map<string, MultiPolygon[]>;
  sourcePartsByParent: Map<string, SourcePart[]>;
  neighboursById: Map<string, MultiPolygon[]>;
}

export type BatchProgress = (label: string, detail?: string) => void | Promise<void>;

/** Reads and measures batches, up to `concurrency` at once. */
export interface BatchRunner {
  concurrency: number;
  run(job: BatchJob, progress: BatchProgress): Promise<{ outcome: BatchOutcome; downloaded: number }>;
  /** Bytes it downloaded itself, beyond what each run reports. */
  downloaded?(): number;
}

interface BatchContext {
  frame: Projection;
  halo: MultiPolygon;
  settings: PrepareSettings;
  surface?: SurfaceSettings;
  partsByParent: Map<string, MultiPolygon[]>;
  sourcePartsByParent: Map<string, SourcePart[]>;
  neighboursById: Map<string, MultiPolygon[]>;
  runner: BatchRunner;
  approved?: Approval;
  progress: BatchProgress;
}

/** One batch of buildings against one survey, from a checkpoint when there is one. */
async function measureBatch(batch: MetricFeature[], survey: Candidate, ctx: BatchContext): Promise<BatchOutcome & { downloaded: number; pending?: Tile[] }> {
  const { frame, settings } = ctx;
  // Whole roofs and their ground, never past the selection's own halo.
  const [x0, y0, x1, y1] = bounds(union(...batch.map((f) => f.geometry)));
  const roi = intersection(boxShape(x0 - SUPPORT_HALO_M, y0 - SUPPORT_HALO_M, x1 + SUPPORT_HALO_M, y1 + SUPPORT_HALO_M), ctx.halo);
  const [rx0, ry0, rx1, ry1] = bounds(roi);
  const corners = [frame.localToGeo(rx0, ry0), frame.localToGeo(rx1, ry0), frame.localToGeo(rx1, ry1), frame.localToGeo(rx0, ry1)];
  const query: GeoBounds = {
    west: Math.min(...corners.map((c) => c[0])),
    south: Math.min(...corners.map((c) => c[1])),
    east: Math.max(...corners.map((c) => c[0])),
    north: Math.max(...corners.map((c) => c[1])),
  };
  const batchRoi: MultiPolygon = [[[frame.toLocal(query.west, query.south), frame.toLocal(query.east, query.south), frame.toLocal(query.east, query.north), frame.toLocal(query.west, query.north)]]];
  const tiles = survey.tiles ? tilesIn(survey, [query.west, query.south, query.east, query.north]) : null;
  // A checkpoint is keyed by everything its measurements depend on: the
  // survey, the buildings with their parts and neighbours, and the settings.
  const key = `batch:${digest([
    ALGORITHM_VERSION,
    survey.url,
    survey.format,
    batch.map((f) => [f.id, f.geometry, measuredProps(f.props)]),
    batch.map((f) => ctx.neighboursById.get(f.id)),
    batch.map((f) => (ctx.sourcePartsByParent.get(f.id) ?? []).map((p) => [p.id, measuredProps(p.props), p.geometry])),
    [query.west, query.south, query.east, query.north],
    [settings.xyScale, settings.zScale, settings.roofMode, settings.preferLidar],
    [frame.center, frame.rotationDeg, ctx.surface ?? null],
    // A tiled survey's tiles too, as for LiDAR only blocks, so a batch read
    // while its catalog lacked a tile isn't kept for good. EPT has none and
    // keeps its keys.
    ...(tiles ? [tiles.map(tileKey)] : []),
  ])}`;
  const cached = await loadJson<{ records: Record<string, ReturnType<typeof publish>>; rejected: Record<string, string>; observations: Record<string, Observation> }>(key);
  if (cached) {
    await ctx.progress(`Reusing measurements from ${survey.name}`, `${batch.length} buildings`);
    return { records: Object.fromEntries(Object.entries(cached.records).map(([id, r]) => [id, unpublish(r, frame)])), rejected: cached.rejected, observations: cached.observations, downloaded: 0 };
  }
  if (staged(survey) && !approves(ctx.approved, tiles ?? [])) return { records: {}, rejected: {}, observations: {}, downloaded: 0, pending: tiles ?? [] };
  const pick = <T>(lookup: Map<string, T>) => new Map(batch.flatMap((f) => (lookup.has(f.id) ? [[f.id, lookup.get(f.id)!] as const] : [])));
  const job: BatchJob = {
    batch,
    survey,
    origin: [frame.center[0], frame.center[1]],
    rotationDeg: frame.rotationDeg,
    surface: ctx.surface,
    query,
    roi: batchRoi,
    settings,
    partsByParent: pick(ctx.partsByParent),
    sourcePartsByParent: pick(ctx.sourcePartsByParent),
    neighboursById: pick(ctx.neighboursById),
  };
  let read: { outcome: BatchOutcome; downloaded: number };
  try {
    read = await ctx.runner.run(job, ctx.progress);
  } catch (error) {
    // A batch is split until it's one building. Over the budget alone, it
    // would be over it every time, so it's a rejection rather than a failed
    // read, which would keep the whole result from being saved.
    if ((error as Error)?.name !== 'BudgetExceeded' || batch.length > 1) throw error;
    read = { outcome: { records: {}, rejected: { [batch[0].id]: 'point_budget_exceeded' }, observations: {} }, downloaded: 0 };
  }
  const { outcome, downloaded } = read;
  saveJson(key, { records: Object.fromEntries(Object.entries(outcome.records).map(([id, r]) => [id, publish(r, frame)])), rejected: outcome.rejected, observations: outcome.observations });
  return { ...outcome, downloaded };
}

/** Read one batch's points and measure its buildings. */
export async function runBatch(job: BatchJob, fetcher: Fetcher, progress: BatchProgress): Promise<BatchOutcome> {
  const { batch, survey, settings } = job;
  const frame = new Projection(job.origin, job.rotationDeg ?? 0, 1);
  await progress(`Reading ${survey.name}`, `${batch.length} buildings`);
  const readOptions = {
    frame,
    // Finer than usual for cells under 0.7 m, read as a LiDAR Only model reads them.
    resolutionM: job.surface ? Math.min(0.35, job.surface.cellM / 2) : undefined,
    verticalUnits: survey.verticalUnits,
    classification: survey.classification,
    progress: (message: string) => progress(`Reading ${survey.name}`, message),
  };
  let points: Points;
  if (survey.format === 'EPT') points = (await readEpt(fetcher, survey.url, job.query, readOptions)).points;
  else if (survey.format === 'I3S') points = (await readI3s(fetcher, survey.url, job.query, readOptions)).points;
  else points = (await readTiles(fetcher, survey.tiles ?? [], job.query, readOptions)).points;
  // A reported single-year acquisition can date undated returns, never a multi-year survey.
  const start = survey.acquisitionStart ?? '';
  const end = survey.acquisitionEnd ?? '';
  let dated = false;
  for (let i = 0; i < points.count && !dated; i++) if (points.year[i]) dated = true;
  if (!dated && start && end && start.slice(0, 4) === end.slice(0, 4)) {
    points.year.fill(Number(start.slice(0, 4)));
    points.confidence.fill(0.75);
  }
  const heightOnly = settings.roofMode === 'heights';
  const measured = await measureFeatures(batch, points, {
    minWidthM: MIN_WIDTH_MM / settings.xyScale,
    minStepM: Math.max(0.25, MIN_STEP_MM / settings.zScale),
    roofPlanes: !heightOnly,
    roofMode: heightOnly ? 'HEIGHT_ONLY' : 'FACETED',
    surfaceScale: heightOnly ? undefined : [settings.xyScale, settings.zScale],
    preferLidar: settings.preferLidar,
    roi: job.roi,
    partsByParent: job.partsByParent,
    sourcePartsByParent: job.sourcePartsByParent,
    neighboursById: job.neighboursById,
    surfaceSettings: job.surface,
    onProgress: (position, count, name) => progress(heightOnly ? 'Measuring building heights' : 'Reconstructing roofs', `${Math.min(position + 1, count)} of ${count}${name ? `: ${name}` : ''}`),
  });
  for (const [id, record] of measured.records) {
    if (record.surfaceKind === 'rock') {
      const feature = batch.find((f) => f.id === id)!;
      record.surfaceGeometry = feature.geometry;
      record.sourceLandIds = feature.props.source_land_ids as string[];
      record.coveredBuildings = feature.props.covered_buildings as string[];
    }
  }
  return {
    records: Object.fromEntries(measured.records),
    rejected: Object.fromEntries(measured.rejected),
    observations: Object.fromEntries(measured.observations),
  };
}

/** A checkpointed record back in the measurement frame. */
function unpublish(record: PublishedRecord, frame: Projection): LidarRecord {
  const { cap, tiers, infillGeometry, surfaceGeometry, groundAnchor, roofSurfaces, ...rest } = record;
  const local = (shape: MultiPolygon) => shape.map((p) => p.map((ring) => ring.map(([lon, lat]) => frame.toLocal(lon, lat))));
  const out: LidarRecord = { ...rest, tiers: tiers.map((t) => ({ ...t, geometry: local(t.geometry) })) };
  if (cap) {
    const vertices = new Float64Array(cap.vertices.length);
    for (let k = 0; k < cap.vertices.length; k += 3) {
      const [x, y] = frame.toLocal(cap.vertices[k], cap.vertices[k + 1]);
      vertices[k] = x;
      vertices[k + 1] = y;
      vertices[k + 2] = cap.vertices[k + 2];
    }
    out.cap = { vertices, triangles: Uint32Array.from(cap.triangles) };
  }
  if (infillGeometry) out.infillGeometry = local(infillGeometry);
  if (surfaceGeometry) out.surfaceGeometry = local(surfaceGeometry);
  if (groundAnchor) out.groundAnchor = [...frame.toLocal(groundAnchor[0], groundAnchor[1]), groundAnchor[2]];
  if (roofSurfaces) out.roofSurfaces = roofSurfaces.map((s) => ({ bottomM: s.bottomM, rings: s.rings.map((ring) => ring.map(([lon, lat, z]) => [...frame.toLocal(lon, lat), z] as [number, number, number])) }));
  return out;
}

