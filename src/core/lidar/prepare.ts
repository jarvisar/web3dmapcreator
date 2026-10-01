// Preparing LiDAR buildings for an area, ported from the add-on's
// download_lidar.prepare for streamed surveys. Buildings are measured in
// 400 m batches from their best survey; a rejection moves a building on to
// its next survey; one measurement is chosen per building at the end. Each
// batch is checkpointed, so changing an unrelated setting, or preparing an
// overlapping area, reuses it without downloading or measuring again.

import { Projection } from '../geo/projection';
import { difference, intersection, multiArea, union } from '../geometry/polygon';
import type { SourceFeature } from '../pipeline/source';
import type { GeoBounds, MultiPolygon, Polygon, Ring } from '../types';
import { measureFeatures, type MetricFeature } from './features';
import type { Points } from './points';
import { publish, type PublishedRecord } from './publish';
import { readTiles } from './read/tiles';
import { readEpt } from './read/ept';
import { Fetcher } from './read/fetcher';
import { lazDecoder } from './read/laz';
import { ALGORITHM_VERSION, type LidarRecord } from './records';
import { rockDomains, shortHash } from './rock';
import { chooseMeasurement, projectYear, type Observation } from './selection';
import { area, bounds, boxShape, buffer, centroid, intersects, keepStart } from './shapes';
import { discover, type Candidate, type Failure } from './sources';
import { measuredProps, type SourcePart } from './source';

export interface PrepareSettings {
  roofMode: 'envelope' | 'heights';
  preferLidar: boolean;
  minFootprintMm2: number;
  rockSurfaces: boolean;
  /** Printed mm per ground metre, horizontal and vertical (height scale included). */
  xyScale: number;
  zScale: number;
}

export interface PrepareInput {
  bounds: GeoBounds;
  buildings: SourceFeature[];
  parts: SourceFeature[];
  land?: SourceFeature[];
  settings: PrepareSettings;
  signal?: AbortSignal;
  progress?: (label: string, fraction: number, detail?: string) => Promise<void> | void;
  /** Where batches are read and measured. By default one at a time in this thread. */
  runner?: BatchRunner;
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
}

// Measurements read a 25 m ground halo; acquisition keeps a 30 m margin.
const SUPPORT_HALO_M = 30;
// How far past the selection any acquisition may reach.
const SELECTION_HALO_M = 75;
const BATCH_M = 400;
const MIN_WIDTH_MM = 0.1;
const MIN_STEP_MM = 0.05;
const DAY_MS = 24 * 3600 * 1000;

let resultStore: { get(key: string): Promise<ArrayBuffer | undefined>; put(key: string, data: ArrayBuffer): Promise<void> } | null = null;

/** Where prepared results and batch checkpoints are kept (the LiDAR byte cache in the app). */
export function setCheckpointStore(store: typeof resultStore): void {
  resultStore = store;
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
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  resultStore.put(key, bytes.buffer as ArrayBuffer).catch(() => undefined);
}

/** A stable short hash of any JSON-able value. */
export function digest(value: unknown): string {
  return shortHash(JSON.stringify(value));
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

export function toMetric(polygons: Polygon[], frame: Projection): MultiPolygon {
  const projected = polygons.map((polygon) => polygon.filter((ring) => ring.length >= 3).map((ring) => ring.map(([lon, lat]) => frame.toLocal(lon, lat))));
  const valid = projected.filter((p) => p.length);
  return keepStart(union(valid), valid);
}

/** Sutherland-Hodgman of lon/lat rings against a lon/lat box, before projecting huge catalog outlines. */
export function clipRingToBox(ring: Ring, [w, s, e, n]: [number, number, number, number]): Ring {
  let points = ring;
  const sides: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= w, (a, b) => [w, a[1] + ((w - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]],
    [(p) => p[0] <= e, (a, b) => [e, a[1] + ((e - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]],
    [(p) => p[1] >= s, (a, b) => [a[0] + ((s - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), s]],
    [(p) => p[1] <= n, (a, b) => [a[0] + ((n - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), n]],
  ];
  for (const [inside, cross] of sides) {
    const out: Ring = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length];
      const b = points[i];
      if (inside(a) !== inside(b)) out.push(cross(a, b));
      if (inside(b)) out.push(b);
    }
    points = out;
    if (!points.length) break;
  }
  return points;
}

// Ranking of surveys for one building, after the add-on's metadata_order:
// newest acquisition first, then coverage, resolution and classification,
// EPT before COPC before plain LAZ (read whole) on ties, the original
// publisher before a mirror.
export interface Ranked {
  candidate: Candidate;
  coverage: MultiPolygon;
  catalogCoverage: number;
}

function acquisitionOrdinal(c: Candidate): number {
  const date = c.acquisitionStart ?? c.acquisitionEnd;
  if (date) return Date.parse(date) / DAY_MS;
  const hint = c.projectYearHint ?? projectYear(c.name);
  return hint ? Date.UTC(hint, 0, 1) / DAY_MS : 0;
}

export function rankOrder(a: Ranked, b: Ranked): number {
  const key = (r: Ranked) => {
    const density = r.candidate.densityM2;
    return [
      -acquisitionOrdinal(r.candidate),
      r.catalogCoverage < 0.98 ? 1 : 0,
      -(density ? density / (1 + density) : 0),
      -(r.candidate.classificationQuality ?? 0),
      -r.catalogCoverage,
      r.candidate.format === 'EPT' ? 0 : r.candidate.format === 'COPC' ? 1 : 2,
      r.candidate.authoritative ? 0 : 1,
    ];
  };
  const [p, q] = [key(a), key(b)];
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] - q[i];
  return a.candidate.url < b.candidate.url ? -1 : a.candidate.url > b.candidate.url ? 1 : 0;
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
  const frame = new Projection([(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2], 0, 1);

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
  const [bx0, by0] = frame.toLocal(bbox.west, bbox.south);
  const [bx1, by1] = frame.toLocal(bbox.east, bbox.north);
  const selection = boxShape(Math.min(bx0, bx1), Math.min(by0, by1), Math.max(bx0, bx1), Math.max(by0, by1));
  const inArea = features.filter((f) => intersects(f.geometry, selection));
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
    xyScale: Math.round(xyScale * 1e10) / 1e10,
    zScale: Math.round(zScale * 1e10) / 1e10,
    roofMode: settings.roofMode,
    preferLidar: settings.preferLidar,
    minFootprintM2: Math.round(minFootprintM2 * 1e6) / 1e6,
    rock: settings.rockSurfaces && !heightOnly,
    footprints: digest(features.map((f) => [f.id, f.geometry, measuredProps(f.props)])),
    parts: digest([...sourcePartsByParent].map(([k, v]) => [k, v.map((p) => [p.id, measuredProps(p.props), p.geometry])])),
  };
  const requestKey = `prepared:${digest(request)}`;
  const previous = await loadJson<PreparedLidar & { saved: number }>(requestKey);
  if (previous && Date.now() - previous.saved < DAY_MS) return { ...previous, reused: true, downloadedBytes: 0 };
  const fetcher = new Fetcher(input.signal);
  const result: PreparedLidar = { records: {}, rejected, counts, surveys: [], failures: [], candidates: inArea.length, downloadedBytes: 0, reused: false };
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
  const found = await discover(fetcher, query, (message) => void progress('Finding LiDAR surveys', 0.04, message));
  result.failures.push(...found.failures);
  const box: [number, number, number, number] = [query.west, query.south, query.east, query.north];
  const haloArea = area(halo);
  const ranked: Ranked[] = [];
  for (const candidate of found.candidates) {
    const clipped = candidate.coverage.map((polygon) => polygon.map((ring) => clipRingToBox(ring, box)).filter((ring) => ring.length >= 3)).filter((p) => p.length);
    const coverage = intersection(toMetric(clipped, frame), halo);
    if (!coverage.length) continue;
    ranked.push({ candidate, coverage, catalogCoverage: area(coverage) / haloArea });
  }
  // Per building: the surveys whose coverage holds its whole footprint.
  const orders = new Map<string, Ranked[]>();
  const rankings = new Map<string, Ranked[]>();
  for (const f of eligible) {
    const usable = ranked.filter((r) => multiArea(difference(f.geometry, r.coverage)) <= 1e-6);
    const key = usable.map((r) => r.candidate.url).join('|');
    let order = rankings.get(key);
    if (!order) rankings.set(key, (order = [...usable].sort(rankOrder)));
    orders.set(f.id, order);
  }
  const globalRank = new Map([...ranked].sort(rankOrder).map((r, i) => [r.candidate.url, i]));

  // ------------------------------------------------------------ acquisition
  const alternatives = new Map<string, LidarRecord[]>();
  const observations = new Map<string, Observation[]>();
  const resolved = new Set<string>();
  const tried = new Map<string, Set<string>>(eligible.map((f) => [f.id, new Set<string>()]));
  const used = new Map<string, SurveyUse>();
  let done = 0;
  const total = eligible.length;
  // The default runner shares the discovery fetcher, which counts its bytes.
  const runner: BatchRunner = input.runner ?? { concurrency: 1, run: async (job, report) => ({ outcome: await runBatch(job, fetcher, report), downloaded: 0 }) };
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
    for (const f of members) tried.get(f.id)!.add(url);
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
        const context = { frame, halo, settings: { ...settings, xyScale, zScale }, partsByParent, sourcePartsByParent, neighboursById, runner, progress: (label: string, detail?: string) => progress(label, 0.08 + 0.9 * (done / total), detail) };
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
        done += batch.length;
        if (!outcome) continue;
        result.downloadedBytes += outcome.downloaded;
        for (const f of batch) {
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
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(runner.concurrency, queue.length)) }, lane));
  }

  // ------------------------------------------------------------ selection
  await progress('Choosing one survey per building', 0.99);
  for (const f of eligible) {
    const candidates = alternatives.get(f.id);
    if (!candidates) {
      if (!rejected[f.id]) rejected[f.id] = orders.get(f.id)!.length ? 'no_compatible_measurement' : 'no_survey_coverage';
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
  result.downloadedBytes += fetcher.downloaded + (runner.downloaded?.() ?? 0);
  // Keep the result only when every survey was read: a failed read is retried next time.
  if (!result.failures.length) saveJson(requestKey, { ...result, saved: Date.now() });
  return result;
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

/** One batch against one survey, as plain data so a worker can run it. */
export interface BatchJob {
  batch: MetricFeature[];
  survey: Candidate;
  /** Centre of the measurement frame, which has no rotation and scale 1. */
  origin: [number, number];
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
  partsByParent: Map<string, MultiPolygon[]>;
  sourcePartsByParent: Map<string, SourcePart[]>;
  neighboursById: Map<string, MultiPolygon[]>;
  runner: BatchRunner;
  progress: BatchProgress;
}

/** One batch of buildings against one survey, from a checkpoint when there is one. */
async function measureBatch(batch: MetricFeature[], survey: Candidate, ctx: BatchContext): Promise<BatchOutcome & { downloaded: number }> {
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
  ])}`;
  const cached = await loadJson<{ records: Record<string, ReturnType<typeof publish>>; rejected: Record<string, string>; observations: Record<string, Observation> }>(key);
  if (cached) {
    await ctx.progress(`Reusing measurements from ${survey.name}`, `${batch.length} buildings`);
    return { records: Object.fromEntries(Object.entries(cached.records).map(([id, r]) => [id, unpublish(r, frame)])), rejected: cached.rejected, observations: cached.observations, downloaded: 0 };
  }
  const pick = <T>(lookup: Map<string, T>) => new Map(batch.flatMap((f) => (lookup.has(f.id) ? [[f.id, lookup.get(f.id)!] as const] : [])));
  const job: BatchJob = {
    batch,
    survey,
    origin: [frame.center[0], frame.center[1]],
    query,
    roi: batchRoi,
    settings,
    partsByParent: pick(ctx.partsByParent),
    sourcePartsByParent: pick(ctx.sourcePartsByParent),
    neighboursById: pick(ctx.neighboursById),
  };
  const { outcome, downloaded } = await ctx.runner.run(job, ctx.progress);
  saveJson(key, { records: Object.fromEntries(Object.entries(outcome.records).map(([id, r]) => [id, publish(r, frame)])), rejected: outcome.rejected, observations: outcome.observations });
  return { ...outcome, downloaded };
}

/** Read one batch's points and measure its buildings. */
export async function runBatch(job: BatchJob, fetcher: Fetcher, progress: BatchProgress): Promise<BatchOutcome> {
  const { batch, survey, settings } = job;
  const frame = new Projection(job.origin, 0, 1);
  await progress(`Reading ${survey.name}`, `${batch.length} buildings`);
  const readOptions = {
    frame,
    verticalUnits: survey.verticalUnits,
    classification: survey.classification,
    progress: (message: string) => progress(`Reading ${survey.name}`, message),
  };
  let points: Points;
  if (survey.format === 'EPT') points = (await readEpt(fetcher, survey.url, job.query, readOptions)).points;
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

