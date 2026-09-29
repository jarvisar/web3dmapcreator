// Reading a LiDAR survey over the whole area into the grid a LiDAR Only
// model is built from, ported from the add-on's lidar_dsm.py for streamed
// surveys. The grid is read in blocks of about 256 m, in workers where there
// are some, and each block is checkpointed in the LiDAR cache: a cancelled
// read resumes after the blocks it finished, and changing a model setting
// reads nothing again.

import { deflateSync, inflateSync } from 'fflate';
import { lidarCache, type ByteCache } from '../data/cache';
import { areaGeoBounds } from '../geo/area';
import { Projection } from '../geo/projection';
import { intersection, multiArea } from '../geometry/polygon';
import { rowCrossings } from '../geometry/scanline';
import { digest, rankOrder, toMetric, clipRingToBox, type BatchProgress, type Ranked } from '../lidar/prepare';
import { readCopc } from '../lidar/read/copc';
import { readEpt } from '../lidar/read/ept';
import { Fetcher } from '../lidar/read/fetcher';
import { lazDecoder } from '../lidar/read/laz';
import { projectYear } from '../lidar/selection';
import { boxShape } from '../lidar/shapes';
import { discover, type Candidate, type Failure } from '../lidar/sources';
import type { AreaSpec } from '../settings';
import type { GeoBounds, LonLat, MultiPolygon } from '../types';
import { blockExtent, blocks, gridProblem, gridSpec, type Block, type GridSpec } from './grid';
import { emptyLayers, type SurfaceLayers } from './layers';
import { BlockRaster, occupiedCell, ProbeSink, type BlockLayers, type GridOrigin } from './raster';

// Raised when what a block stores changes, so old checkpoints aren't read.
const VERSION = 3;
// The same for saved density probes.
const PROBE_VERSION = 2;
// A block counts as covered once this share of it is inside a survey.
const COVERED = 0.995;
const BLOCK_POINTS = 40e6;
// Returns per cell a survey needs on average to leave few cells empty.
const FILLED = 4;
// Provider codes with a surface meaning, kept out of the provider's own
// mapping since that one shapes building measurement too.
const SURFACE_CODES: Record<string, Record<string, string>> = {
  'IGN France': { '64': 'unclassified' }, // permanent structures above ground
};

let store: ByteCache | null = lidarCache;

/** Where block checkpoints are kept: the LiDAR cache, a folder in Node, or nowhere. */
export function setSurfaceStore(value: ByteCache | null): void {
  store = value;
}

/** One block read from one survey (or a density probe), as plain data so a worker can run it. */
export interface SurfaceJob {
  survey: Candidate;
  /** The area's frame: centre and rotation, metres. */
  center: LonLat;
  rotationDeg: number;
  query: GeoBounds;
  grid: GridOrigin;
  block: Block;
  resolutionM: number;
  /** Measure the cell the survey fills instead, starting from this one. */
  probe?: number;
}

export interface SurfaceOutcome {
  layers?: BlockLayers;
  probe?: { cell: number; density: number } | null;
  points: number;
}

export interface SurfaceRunner {
  concurrency: number;
  surface(job: SurfaceJob, progress: BatchProgress): Promise<SurfaceOutcome>;
  /** Bytes it downloaded itself. */
  downloaded?(): number;
}

export interface SurfaceSurvey {
  name: string;
  provider: string;
  format: string;
  attribution: string;
  license?: string;
  sourcePage: string;
  year: number | null;
  points: number;
  blocks: number;
}

export interface PreparedSurface {
  layers: SurfaceLayers;
  grid: GridSpec;
  requestedCellM: number;
  /** Returns per m² on land, when the density was measured. */
  densityM2: number | null;
  /** Share of cells with a return. */
  coverage: number;
  points: number;
  surveys: SurfaceSurvey[];
  failures: Failure[];
  downloadedBytes: number;
  blocks: number;
  reusedBlocks: number;
  /** Blocks with a failed read. They are left with a hole and not saved. */
  failedBlocks: number;
}

export interface SurfaceInput {
  area: AreaSpec;
  /** Cell size asked for, in metres. It grows where the survey is too sparse to fill it. */
  cellM: number;
  signal?: AbortSignal;
  progress?: (label: string, fraction: number, detail?: string) => Promise<void> | void;
  runner?: SurfaceRunner;
}

export function surveyYear(c: Candidate): number | null {
  const date = c.acquisitionEnd ?? c.acquisitionStart;
  if (date && /^\d{4}/.test(date)) return Number(date.slice(0, 4));
  return c.projectYearHint ?? projectYear(c.name);
}

/** Read one block, or probe it, in whatever thread this is. */
export async function readSurfaceBlock(job: SurfaceJob, fetcher: Fetcher, progress: BatchProgress): Promise<SurfaceOutcome> {
  const { survey, block, grid } = job;
  const frame = new Projection(job.center, job.rotationDeg, 1);
  const [x0, y0, x1, y1] = [
    grid.x0 + (block.columns[0] - 0.5) * grid.dx,
    grid.y0 + (block.rows[0] - 0.5) * grid.dy,
    grid.x0 + (block.columns[1] - 0.5) * grid.dx,
    grid.y0 + (block.rows[1] - 0.5) * grid.dy,
  ];
  const sink = job.probe !== undefined ? new ProbeSink(x0, y0) : new BlockRaster(grid, block);
  const options = {
    frame,
    resolutionM: job.resolutionM,
    maxPoints: BLOCK_POINTS,
    verticalUnits: survey.verticalUnits,
    classification: survey.classification,
    surface: true,
    surfaceCodes: SURFACE_CODES[survey.provider],
    sink,
    progress: (message: string) => progress(`Reading ${survey.name}`, message),
  };
  if (survey.format === 'EPT') await readEpt(fetcher, survey.url, job.query, options);
  else await readCopc(fetcher, survey.tiles ?? [], job.query, options);
  if (sink instanceof ProbeSink) return { probe: occupiedCell(sink, x1 - x0, y1 - y0, job.probe!), points: sink.count };
  return { layers: sink.layers(), points: sink.kept };
}

// ------------------------------------------------------------ checkpoints

const FLOATS = ['top', 'solid', 'ground', 'waterZ'] as const;
const COUNTS = ['count', 'vegetation', 'water', 'building'] as const;

interface Checkpoint {
  layers: BlockLayers;
  points: number;
  /** Each survey read, with its returns. */
  sources: [string, number][];
}

export function encodeBlock(layers: BlockLayers, points: number, sources: [string, number][]): ArrayBuffer {
  const head = new TextEncoder().encode(JSON.stringify({ rows: layers.rows, columns: layers.columns, points, sources }));
  const size = layers.count.length;
  const at = 4 + Math.ceil(head.length / 4) * 4;
  const buffer = new ArrayBuffer(at + size * (4 * 4 + 2 * 4));
  new DataView(buffer).setUint32(0, head.length, true);
  new Uint8Array(buffer, 4, head.length).set(head);
  let offset = at;
  for (const name of FLOATS) {
    new Float32Array(buffer, offset, size).set(layers[name]);
    offset += 4 * size;
  }
  for (const name of COUNTS) {
    new Uint16Array(buffer, offset, size).set(layers[name]);
    offset += 2 * size;
  }
  // Mostly empty water layers and sparse counts: a fifth of the size deflated.
  return deflateSync(new Uint8Array(buffer), { level: 1 }).buffer as ArrayBuffer;
}

export function decodeBlock(packed: ArrayBuffer): Checkpoint | null {
  try {
    const buffer = inflateSync(new Uint8Array(packed)).buffer as ArrayBuffer;
    const length = new DataView(buffer).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as { rows: [number, number]; columns: [number, number]; points: number; sources: [string, number][] };
    const size = (head.rows[1] - head.rows[0]) * (head.columns[1] - head.columns[0]);
    let offset = 4 + Math.ceil(length / 4) * 4;
    if (buffer.byteLength !== offset + size * 24) return null;
    const layers = { rows: head.rows, columns: head.columns } as BlockLayers;
    for (const name of FLOATS) {
      layers[name] = new Float32Array(buffer.slice(offset, offset + 4 * size));
      offset += 4 * size;
    }
    for (const name of COUNTS) {
      layers[name] = new Uint16Array(buffer.slice(offset, offset + 2 * size));
      offset += 2 * size;
    }
    return { layers, points: head.points, sources: head.sources };
  } catch {
    return null;
  }
}

async function load(key: string): Promise<ArrayBuffer | undefined> {
  return store ? await store.get(key).catch(() => undefined) : undefined;
}

function save(key: string, data: ArrayBuffer): void {
  store?.put(key, data).catch(() => undefined);
}

// ------------------------------------------------------------------ cells

/** Cells of a block whose centre lies in `shape`, one byte each. */
export function cellsInside(shape: MultiPolygon, grid: GridOrigin, block: Block): Uint8Array {
  const width = block.columns[1] - block.columns[0];
  const height = block.rows[1] - block.rows[0];
  const out = new Uint8Array(width * height);
  const rows = rowCrossings(shape.flat(), grid.y0, grid.dy, block.rows[0], height);
  for (let r = 0; r < height; r++) {
    const xs = rows[r];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(block.columns[0], Math.ceil((xs[k] - grid.x0) / grid.dx));
      const c1 = Math.min(block.columns[1], Math.ceil((xs[k + 1] - grid.x0) / grid.dx));
      for (let c = c0; c < c1; c++) out[r * width + (c - block.columns[0])] = 1;
    }
  }
  return out;
}

/** The lon/lat box around a rectangle of the area's frame. */
function geoBox(frame: Projection, [x0, y0, x1, y1]: [number, number, number, number]): GeoBounds {
  const corners = [frame.localToGeo(x0, y0), frame.localToGeo(x1, y0), frame.localToGeo(x1, y1), frame.localToGeo(x0, y1), frame.localToGeo((x0 + x1) / 2, y0), frame.localToGeo((x0 + x1) / 2, y1), frame.localToGeo(x0, (y0 + y1) / 2), frame.localToGeo(x1, (y0 + y1) / 2)];
  return {
    west: Math.min(...corners.map((c) => c[0])),
    south: Math.min(...corners.map((c) => c[1])),
    east: Math.max(...corners.map((c) => c[0])),
    north: Math.max(...corners.map((c) => c[1])),
  };
}

/** The survey without what a worker doesn't need: its outline, and tiles away from the block. */
function slim(survey: Candidate, query: GeoBounds): Candidate {
  const tiles = survey.tiles?.filter((t) => t.bbox[0] <= query.east && t.bbox[2] >= query.west && t.bbox[1] <= query.north && t.bbox[3] >= query.south);
  return { ...survey, coverage: [], tiles };
}

// ------------------------------------------------------------------ prepare

export async function prepareSurface(input: SurfaceInput): Promise<PreparedSurface> {
  const { area } = input;
  const progress = async (label: string, fraction: number, detail?: string) => {
    input.signal?.throwIfAborted();
    await input.progress?.(label, fraction, detail);
  };
  const frame = new Projection(area.center, area.rotationDeg, 1);
  const requested = input.cellM;
  const problem = gridProblem(area.widthM, area.heightM, requested);
  if (problem) throw new Error(problem);
  let grid = gridSpec(area.widthM, area.heightM, requested);
  const fetcher = new Fetcher(input.signal);
  // Nothing can be read without a decoder, so don't search or download.
  await lazDecoder();

  await progress('Finding LiDAR surveys', 0.02);
  const rect = boxShape(grid.x0, grid.y0, grid.x1, grid.y1);
  const query = areaGeoBounds(area, 2 * requested);
  const found = await discover(fetcher, query, (message) => void progress('Finding LiDAR surveys', 0.04, message));
  const failures: Failure[] = [...found.failures];
  const box: [number, number, number, number] = [query.west, query.south, query.east, query.north];
  const rectArea = multiArea(rect);
  const ranked: Ranked[] = [];
  for (const candidate of found.candidates) {
    const clipped = candidate.coverage.map((polygon) => polygon.map((ring) => clipRingToBox(ring, box)).filter((ring) => ring.length >= 3)).filter((p) => p.length);
    const coverage = toMetric(clipped, frame);
    const inside = intersection(coverage, rect);
    if (!inside.length) continue;
    ranked.push({ candidate, coverage, catalogCoverage: multiArea(inside) / rectArea });
  }
  // A survey covering the whole area goes first, so blocks don't mix years.
  // Then one dense enough to fill the cells, since a sparse survey only gives
  // a model of blobs however new it is, and among those the usual ranking.
  const fill = (r: Ranked) => (r.candidate.densityM2 ? Math.min(1, r.candidate.densityM2 / (FILLED / requested ** 2)) : 1);
  const order = ranked.sort((a, b) => (a.catalogCoverage >= 0.99 ? 0 : 1) - (b.catalogCoverage >= 0.99 ? 0 : 1) || fill(b) - fill(a) || rankOrder(a, b));
  if (!order.length) {
    const reason = failures.length ? ` (${failures[0].source}: ${failures[0].reason})` : '';
    throw new Error(`No LiDAR survey that a browser can read covers this area${reason}.`);
  }
  const runner: SurfaceRunner = input.runner ?? { concurrency: 1, surface: (job, report) => readSurfaceBlock(job, fetcher, report) };
  const origin = { center: area.center, rotationDeg: area.rotationDeg };

  // ------------------------------------------------------------ cell size
  // Measured on up to three blocks near the middle that one survey covers.
  let densityM2: number | null = null;
  const probeKey = `surface-probe:${digest([VERSION, PROBE_VERSION, area.center, area.rotationDeg, area.widthM, area.heightM, requested, order[0].candidate.url])}`;
  const probed = await load(probeKey);
  if (probed) {
    const saved = JSON.parse(new TextDecoder().decode(probed)) as { cell: number; density: number | null };
    densityM2 = saved.density;
    if (saved.cell > requested) grid = gridSpec(area.widthM, area.heightM, saved.cell);
  } else {
    await progress("Measuring the survey's point density", 0.06);
    const middle = [(grid.ny - 1) / 2, (grid.nx - 1) / 2];
    const near = blocks(grid).sort((a, b) => {
      const d = (block: Block) => ((block.rows[0] + block.rows[1]) / 2 - middle[0]) ** 2 + ((block.columns[0] + block.columns[1]) / 2 - middle[1]) ** 2;
      return d(a) - d(b);
    });
    let cell = requested;
    let measured = false;
    for (const block of near.slice(0, 3)) {
      const extent = blockExtent(grid, block);
      const covering = order.find((r) => multiArea(intersection(boxShape(...extent), r.coverage)) >= 0.999 * (extent[2] - extent[0]) * (extent[3] - extent[1]));
      if (!covering) continue;
      const job: SurfaceJob = { ...origin, survey: slim(covering.candidate, geoBox(frame, extent)), query: geoBox(frame, extent), grid, block, resolutionM: Math.max(0.1, requested / 2), probe: requested };
      const outcome = await runner.surface(job, (_label, detail) => progress("Measuring the survey's point density", 0.07, detail)).catch((error: Error) => {
        if (error.name === 'AbortError' || input.signal?.aborted) throw error;
        return null;
      });
      if (!outcome?.probe) continue;
      cell = Math.max(requested, outcome.probe.cell);
      densityM2 = outcome.probe.density;
      measured = true;
      break;
    }
    if (measured) save(probeKey, new TextEncoder().encode(JSON.stringify({ cell, density: densityM2 })).buffer as ArrayBuffer);
    if (cell > requested) grid = gridSpec(area.widthM, area.heightM, cell);
  }

  // ---------------------------------------------------------------- blocks
  const layers = emptyLayers(grid.nx, grid.ny);
  const all = blocks(grid);
  const used = new Map<string, SurfaceSurvey>();
  const byUrl = new Map(order.map((r) => [r.candidate.url, r]));
  const note = (url: string, points: number) => {
    const c = byUrl.get(url)?.candidate;
    if (!c) return;
    const entry = used.get(url) ?? { name: c.name, provider: c.provider, format: c.format, attribution: c.attribution, license: c.license, sourcePage: c.sourcePage, year: surveyYear(c), points: 0, blocks: 0 };
    entry.points += points;
    entry.blocks++;
    used.set(url, entry);
  };
  let points = 0;
  let reusedBlocks = 0;
  let failedBlocks = 0;
  let done = 0;
  const resolutionM = Math.max(0.1, grid.cell / 2);
  const identity = [VERSION, area.center, area.rotationDeg, area.widthM, area.heightM, grid.cell];

  const readBlock = async (block: Block) => {
    const extent = blockExtent(grid, block, grid.dx);
    const blockBox = boxShape(...extent);
    const surveys = order.filter((r) => intersection(blockBox, r.coverage).length);
    const key = `surface-block:${digest([identity, block.rows, block.columns, surveys.map((r) => r.candidate.url)])}`;
    const saved = await load(key);
    const checkpoint = saved ? decodeBlock(saved) : null;
    let piece: BlockLayers;
    let blockPoints = 0;
    let sources: [string, number][] = [];
    if (checkpoint) {
      piece = checkpoint.layers;
      blockPoints = checkpoint.points;
      sources = checkpoint.sources;
      reusedBlocks++;
      for (const [url, count] of sources) note(url, count);
    } else {
      const width = block.columns[1] - block.columns[0];
      const size = width * (block.rows[1] - block.rows[0]);
      const empty = emptyLayers(width, size / width);
      piece = { rows: block.rows, columns: block.columns, top: empty.top, solid: empty.solid, ground: empty.ground, waterZ: empty.waterZ, count: empty.count, vegetation: empty.vegetation, water: empty.water, building: empty.building };
      const claimed = new Uint8Array(size);
      let claimedCount = 0;
      let failed = false;
      const geo = geoBox(frame, extent);
      for (const survey of surveys) {
        const whole = multiArea(intersection(blockBox, survey.coverage)) >= 0.999 * multiArea(blockBox);
        const inside = whole ? new Uint8Array(size).fill(1) : cellsInside(survey.coverage, grid, block);
        let any = false;
        for (let k = 0; k < size; k++) {
          if (claimed[k]) inside[k] = 0;
          else if (inside[k]) any = true;
        }
        if (!any) continue;
        const name = survey.candidate.name;
        let outcome: SurfaceOutcome;
        try {
          const job: SurfaceJob = { ...origin, survey: slim(survey.candidate, geo), query: geo, grid, block, resolutionM };
          outcome = await runner.surface(job, (_label, detail) => progress(`Reading LiDAR block ${done + 1} of ${all.length}`, 0.1 + (0.9 * done) / all.length, detail ?? name));
        } catch (error) {
          if ((error as Error).name === 'AbortError' || input.signal?.aborted) throw error;
          // Once per survey and reason, not once per block.
          const reason = (error as Error).message;
          if (!failures.some((f) => f.source === name && f.reason === reason)) failures.push({ source: name, reason });
          failed = true;
          continue;
        }
        // Cells inside a survey belong to it even with no returns: water and
        // dark roofs return nothing, and another survey's returns there would
        // be another year's surface.
        const read = outcome.layers!;
        for (let k = 0; k < size; k++) {
          if (!inside[k]) continue;
          for (const name of FLOATS) piece[name][k] = read[name][k];
          for (const name of COUNTS) piece[name][k] = read[name][k];
          claimed[k] = 1;
          claimedCount++;
        }
        blockPoints += outcome.points;
        sources.push([survey.candidate.url, outcome.points]);
        note(survey.candidate.url, outcome.points);
        if (claimedCount >= COVERED * size) break;
      }
      // A failed read is tried again next time rather than kept with a hole.
      if (!failed) save(key, encodeBlock(piece, blockPoints, sources));
      else failedBlocks++;
    }
    points += blockPoints;
    const [r0, r1] = block.rows;
    const [c0, c1] = block.columns;
    const width = c1 - c0;
    for (let r = r0; r < r1; r++) {
      const from = (r - r0) * width;
      const to = r * grid.nx + c0;
      for (const name of FLOATS) layers[name].set(piece[name].subarray(from, from + width), to);
      for (const name of COUNTS) layers[name].set(piece[name].subarray(from, from + width), to);
    }
    done++;
    await progress(`Reading LiDAR block ${Math.min(done + 1, all.length)} of ${all.length}`, 0.1 + (0.9 * done) / all.length, `${points.toLocaleString('en-US')} returns`);
  };

  const queue = [...all];
  const lane = async () => {
    while (queue.length) await readBlock(queue.shift()!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(runner.concurrency, queue.length)) }, lane));

  let covered = 0;
  for (let k = 0; k < layers.count.length; k++) if (layers.count[k]) covered++;
  if (!covered) {
    const reason = failures.length ? ` (${failures[0].source}: ${failures[0].reason})` : '';
    throw new Error(`The LiDAR surveys returned no points for this area${reason}.`);
  }
  return {
    layers,
    grid,
    requestedCellM: requested,
    densityM2,
    coverage: covered / layers.count.length,
    points,
    surveys: [...used.values()],
    failures,
    downloadedBytes: fetcher.downloaded + (runner.downloaded?.() ?? 0),
    blocks: all.length,
    reusedBlocks,
    failedBlocks,
  };
}

