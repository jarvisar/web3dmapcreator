// Reading a LiDAR survey over the whole area into the grid a LiDAR Only
// model is built from, ported from the add-on's lidar_dsm.py for streamed
// surveys. The grid is read in blocks of about 256 m, in workers where there
// are some, and each block is checkpointed in the LiDAR cache: a cancelled
// read resumes after the blocks it finished, and changing a model setting
// reads nothing again.

import { deflateSync, inflateSync } from 'fflate';
import { lidarCache, type ByteCache } from '../data/cache';
import { areaGeoBounds, areaModelRing } from '../geo/area';
import { Projection } from '../geo/projection';
import { intersection, multiArea } from '../geometry/polygon';
import type { BatchProgress } from '../lidar/prepare';
import { clipRingToBox, coverTier, digest, measureDensities, orderSurveys, pickNote, rankOrder, surveyDensity, toMetric, type Ranked, type SurveyProbe, type SurveyRules } from '../lidar/ranking';
import { readTiles } from '../lidar/read/tiles';
import { readEpt } from '../lidar/read/ept';
import { readI3s } from '../lidar/read/i3s';
import { Fetcher } from '../lidar/read/fetcher';
import { lazDecoder } from '../lidar/read/laz';
import { chosenFirst, isChosen, surveyChoice, type SurveyChoice } from '../lidar/choice';
import { advantage, approves, makeOffer, OffersError, describeOffer, staged, tilesIn, type Approval, type LidarOffer } from '../lidar/offers';
import { projectYear } from '../lidar/selection';
import { boxShape } from '../lidar/shapes';
import { searchSurveys } from '../lidar/search';
import type { Candidate, Failure, Tile } from '../lidar/sources';
import type { AreaSpec } from '../settings';
import type { GeoBounds, LonLat, MultiPolygon } from '../types';
import { blockExtent, blocks, cellsInside, gridProblem, gridSpec, type Block, type GridSpec } from './grid';
import { emptyLayers, type SurfaceLayers } from './layers';
import { compactLabels, dilate, label } from './filters';
import { BlockRaster, MARGIN, occupiedCell, ProbeSink, type BlockLayers, type GridOrigin } from './raster';

// Raised when what a block stores changes, so old checkpoints aren't read.
// 5 leaves floating returns out (BlockRaster). 4 was a draft of that. 6 has
// the corrected RD New and Krovak datum shifts.
const VERSION = 6;
// The same for blocks filled in where an outline overclaims (overclaimed).
const FILL_VERSION = 1;
// The same for saved density probes. 8 takes unclassified returns near water
// returns for water (occupiedCell).
const PROBE_VERSION = 8;
// A block counts as covered once this share of it is inside a survey.
const COVERED = 0.995;
/** Progress once the surveys are found and ranked, when blocks start being read. */
export const BLOCKS_START = 0.1;
const BLOCK_POINTS = 40e6;
// Provider codes with a surface meaning, kept out of the provider's own
// mapping since that one shapes building measurement too.
const SURFACE_CODES: Record<string, Record<string, string>> = {
  'IGN France': { '64': 'unclassified' }, // permanent structures above ground
  // Rail and overhead structures, which Cook 2022 classifies.
  'Illinois State Geological Survey': { '10': 'unclassified', '19': 'unclassified' },
};
// Topobathy surveys file the seabed as 40, the water surface as 41 (42 where
// it's made up), submerged objects as 43 and the water column as 45. EPT
// builds are LAS 1.2, whose classes only have five bits, so those arrive as
// 8, 9, 10, 11 and 13. USGS's Florida Keys survey has the floor of Biscayne
// Bay as 8, and read as ground (model key points) it printed as land 2 m
// under the water. Labels SURFACE_SEMANTICS doesn't know are left out.
const TOPOBATHY_CODES: Record<string, string> = {
  '8': 'seabed',
  '10': 'water',
  '11': 'submerged object',
  '13': 'water column',
  '40': 'seabed',
  '41': 'water',
  '42': 'water',
  '43': 'submerged object',
  '45': 'water column',
};

const topobathy = (survey: Pick<Candidate, 'name'>) => /bathy/i.test(survey.name);

/** Codes on top of the provider's mapping for a surface read. */
export function surfaceCodes(survey: Pick<Candidate, 'provider' | 'name'>): Record<string, string> | undefined {
  const codes = SURFACE_CODES[survey.provider];
  return topobathy(survey) ? { ...codes, ...TOPOBATHY_CODES } : codes;
}

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
  /** Floating returns left out of the layers. */
  noise?: number;
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
  /** Empty (0 x 0) once surfaceModel has let them go (`releaseLayers`). */
  layers: SurfaceLayers;
  /** Every block as its checkpoint (encodeBlock), in blocks(grid) order: the layers at about a fifth of their size (unpackLayers). */
  checkpoints: ArrayBuffer[];
  grid: GridSpec;
  requestedCellM: number;
  /** Returns per m² on land, when the density was measured. */
  densityM2: number | null;
  /** Share of cells with a return. */
  coverage: number;
  /** Share of the cells in the area's shape that no survey read here covers. */
  uncovered?: number;
  points: number;
  /** Floating returns left out (BlockRaster). */
  noise: number;
  surveys: SurfaceSurvey[];
  failures: Failure[];
  downloadedBytes: number;
  blocks: number;
  reusedBlocks: number;
  /** Whole-file surveys that would have filled cells, waiting for the user's approval. */
  offers: LidarOffer[];
  /** Every survey found under the area, in the order they'd be read without a choice. */
  found: SurveyChoice[];
}

export interface SurfaceInput {
  area: AreaSpec;
  /** Cell size asked for, in metres. It grows where the survey is too sparse to fill it. */
  cellM: number;
  /** The most cells for a cell given in metres (fixedCellLimit). Without it the cell was grown for the area to stay under MAX_CELLS. */
  maxCells?: number;
  signal?: AbortSignal;
  progress?: (label: string, fraction: number, detail?: string) => Promise<void> | void;
  runner?: SurfaceRunner;
  /** Tiles of whole-file surveys the user agreed to download. Other whole-file surveys are only offered. */
  approved?: Approval;
  /** A survey to read first: its URL, or its name (`isChosen`). */
  survey?: string;
  /** How the others are put in order, at `cellM`. Balanced over 5 years by default. */
  rules?: Omit<SurveyRules, 'cellM'>;
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
    surfaceCodes: surfaceCodes(survey),
    sink,
    progress: (message: string) => progress(`Reading ${survey.name}`, message),
  };
  if (survey.format === 'EPT') await readEpt(fetcher, survey.url, job.query, options);
  else if (survey.format === 'I3S') await readI3s(fetcher, survey.url, job.query, options);
  else await readTiles(fetcher, survey.tiles ?? [], job.query, options);
  if (sink instanceof ProbeSink) return { probe: occupiedCell(sink, x1 - x0, y1 - y0, job.probe!), points: sink.count };
  const layers = sink.layers();
  return { layers, points: sink.kept, noise: sink.noise };
}

// ------------------------------------------------------------ checkpoints

const FLOATS = ['top', 'solid', 'ground', 'waterZ'] as const;
const COUNTS = ['count', 'vegetation', 'water', 'building'] as const;

interface Checkpoint {
  layers: BlockLayers;
  points: number;
  noise: number;
  /** Each survey read, with its returns. */
  sources: [string, number][];
}

export function encodeBlock(layers: BlockLayers, points: number, sources: [string, number][], noise = 0): ArrayBuffer {
  const head = new TextEncoder().encode(JSON.stringify({ rows: layers.rows, columns: layers.columns, points, sources, noise }));
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
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as { rows: [number, number]; columns: [number, number]; points: number; sources: [string, number][]; noise?: number };
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
    return { layers, points: head.points, sources: head.sources, noise: head.noise ?? 0 };
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

/** Copies one block's layers into the grid's. */
function placeBlock(layers: SurfaceLayers, grid: GridSpec, piece: BlockLayers): void {
  const [r0, r1] = piece.rows;
  const [c0, c1] = piece.columns;
  const width = c1 - c0;
  for (let r = r0; r < r1; r++) {
    const from = (r - r0) * width;
    const to = r * grid.nx + c0;
    for (const name of FLOATS) layers[name].set(piece[name].subarray(from, from + width), to);
    for (const name of COUNTS) layers[name].set(piece[name].subarray(from, from + width), to);
  }
}

/** The grid's layers again from its block checkpoints (PreparedSurface.checkpoints), exactly as they were read. */
export function unpackLayers(grid: GridSpec, checkpoints: ArrayBuffer[]): SurfaceLayers {
  const all = blocks(grid);
  if (checkpoints.length !== all.length) throw new Error('The saved LiDAR grid does not match its blocks');
  const layers = emptyLayers(grid.nx, grid.ny);
  for (let k = 0; k < all.length; k++) {
    const checkpoint = decodeBlock(checkpoints[k]);
    if (!checkpoint) throw new Error('A saved LiDAR block could not be read back');
    placeBlock(layers, grid, checkpoint.layers);
  }
  return layers;
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

// Blocks a probe tries, nearest the middle first. Three were all water off
// Brickell, and the cell came from the next survey instead. Water returns
// little, so trying one costs little.
const PROBE_BLOCKS = 6;

// A block counts as a gap for an offered survey when this share of it is
// left with no survey: less is usually two outlines disagreeing at an edge.
const GAP_SHARE = 0.02;

/** Cells of a block each survey claims, in order, until it's covered. */
function claims(surveys: Ranked[], grid: GridSpec, block: Block, blockBox: ReturnType<typeof boxShape>): Map<string, Uint8Array> {
  const size = (block.columns[1] - block.columns[0]) * (block.rows[1] - block.rows[0]);
  const claimed = new Uint8Array(size);
  let count = 0;
  const out = new Map<string, Uint8Array>();
  for (const survey of surveys) {
    const whole = multiArea(intersection(blockBox, survey.coverage)) >= 0.999 * multiArea(blockBox);
    const inside = whole ? new Uint8Array(size).fill(1) : cellsInside(survey.coverage, grid, block);
    let any = false;
    for (let k = 0; k < size; k++) {
      if (claimed[k]) inside[k] = 0;
      else if (inside[k]) any = true;
    }
    if (!any) continue;
    for (let k = 0; k < size; k++) {
      if (!inside[k]) continue;
      claimed[k] = 1;
      count++;
    }
    out.set(survey.candidate.url, inside);
    if (count >= COVERED * size) break;
  }
  return out;
}

// Catalog outlines can claim far more than a survey has points for. USGS's
// 2019 Florida Keys survey claims all of downtown Miami and stops 300 m short
// of its west side, and left with it the empty strip joined the Miami River
// as one hole and printed as water. So once every block is in, empty ground
// further than REACH_M from any return, at least RELEASE_M2 of it, goes to the
// next survey, with the empty cells within REACH_M of it. Only where it lies
// past the returns, not between them along its row or column (a river, a
// pond, a dark roof), and where the returns around it are mostly ground,
// buildings or trees. Where they're water the survey just saw no more of it.
// Handed on, Lake Michigan off Chicago read two USACE surveys, 80 MB, for
// water it had anyway.
const REACH_M = 20;
const RELEASE_M2 = 400;
// Worked out on cells about this size, so a large grid costs little.
const COARSE_M = 4;

/** Ground handed on, as a mask of coarse cells `step` grid cells across. */
export interface Overclaimed {
  step: number;
  nx: number;
  ny: number;
  mask: Uint8Array;
}

/** Ground the outlines claim with no returns near it (see REACH_M), or null for none. */
export function overclaimed(layers: SurfaceLayers, cellM: number): Overclaimed | null {
  const { count } = layers;
  const step = Math.max(1, Math.floor(COARSE_M / cellM));
  const nx = Math.ceil(layers.nx / step);
  const ny = Math.ceil(layers.ny / step);
  const n = nx * ny;
  const cell = step * cellM;
  // Coarse cells with returns, and how many of their cells are land and not.
  const seen = new Uint8Array(n);
  const land = new Int32Array(n);
  const other = new Int32Array(n);
  for (let j = 0; j < layers.ny; j++) {
    for (let i = 0; i < layers.nx; i++) {
      const k = j * layers.nx + i;
      if (!count[k]) continue;
      const c = Math.floor(j / step) * nx + Math.floor(i / step);
      seen[c] = 1;
      if (layers.water[k] * 2 < count[k] && (layers.ground[k] === layers.ground[k] || layers.building[k] > 0 || layers.vegetation[k] > 0)) land[c]++;
      else other[c]++;
    }
  }
  const r = Math.ceil(REACH_M / cell);
  const near = dilate(seen, nx, ny, r);
  // The first and last cell with returns along each row and column.
  const rows = new Int32Array(2 * ny).fill(-1);
  const columns = new Int32Array(2 * nx).fill(-1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!seen[j * nx + i]) continue;
      if (rows[2 * j] < 0) rows[2 * j] = i;
      rows[2 * j + 1] = i;
      if (columns[2 * i] < 0) columns[2 * i] = j;
      columns[2 * i + 1] = j;
    }
  }
  const far = new Uint8Array(n);
  let farCells = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (near[k]) continue;
      if ((rows[2 * j] >= 0 && rows[2 * j] < i && i < rows[2 * j + 1]) || (columns[2 * i] >= 0 && columns[2 * i] < j && j < columns[2 * i + 1])) continue;
      far[k] = 1;
      farCells++;
    }
  }
  if (farCells * cell * cell < RELEASE_M2) return null;
  // Each piece of it is judged by the returns around it, found by spreading
  // out from it until the returns stop the spread.
  const region = label(far, nx, ny);
  const regions = compactLabels(region);
  const size = new Int32Array(regions);
  const landAround = new Float64Array(regions);
  const around = new Float64Array(regions);
  const distance = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < n; k++) {
    if (!far[k]) continue;
    distance[k] = 0;
    size[region[k]]++;
    queue[tail++] = k;
  }
  while (head < tail) {
    const k = queue[head++];
    if (distance[k] > 2 * r + 2) continue;
    const x = k % nx;
    for (const j of [x > 0 ? k - 1 : -1, x + 1 < nx ? k + 1 : -1, k >= nx ? k - nx : -1, k + nx < n ? k + nx : -1]) {
      if (j < 0 || distance[j] >= 0) continue;
      distance[j] = distance[k] + 1;
      region[j] = region[k];
      if (seen[j]) {
        landAround[region[j]] += land[j];
        around[region[j]] += land[j] + other[j];
      } else queue[tail++] = j;
    }
  }
  const handed = new Uint8Array(n);
  let any = false;
  for (let k = 0; k < n; k++) {
    if (!far[k]) continue;
    const p = region[k];
    if (size[p] * cell * cell < RELEASE_M2 || (around[p] > 0 && landAround[p] < 0.5 * around[p])) continue;
    handed[k] = 1;
    any = true;
  }
  return any ? { step, nx, ny, mask: dilate(handed, nx, ny, r + 1) } : null;
}

/** Run lengths of a mask, from a 0 run, for keying it. */
function runs(mask: Uint8Array): number[] {
  const out: number[] = [];
  let value = 0;
  let length = 0;
  for (const v of mask) {
    if (v === value) {
      length++;
      continue;
    }
    out.push(length);
    value = v;
    length = 1;
  }
  out.push(length);
  return out;
}

interface Skipped {
  survey: Candidate;
  /** Its tiles over the block that weren't approved. */
  tiles: Tile[];
  size: number;
  /** Cells nothing read took instead. */
  gap: number;
  /** Its cells that each survey read took instead, by URL. */
  takenBy: Map<string, number>;
}

/** What skipping `blocked` surveys leaves a block with: their cells that others took, and those nothing took. */
function skippedCells(surveys: Ranked[], blocked: Ranked[], grid: GridSpec, block: Block, blockBox: ReturnType<typeof boxShape>, geo: GeoBounds, approved: Approval | undefined): Skipped[] {
  const all = claims(surveys, grid, block, blockBox);
  const readable = claims(surveys.filter((r) => !blocked.includes(r)), grid, block, blockBox);
  const out: Skipped[] = [];
  for (const r of blocked) {
    const mask = all.get(r.candidate.url);
    if (!mask) continue;
    let gap = 0;
    const takenBy = new Map<string, number>();
    for (let k = 0; k < mask.length; k++) {
      if (!mask[k]) continue;
      let owner = '';
      for (const [url, cells] of readable) {
        if (!cells[k]) continue;
        owner = url;
        break;
      }
      if (owner) takenBy.set(owner, (takenBy.get(owner) ?? 0) + 1);
      else gap++;
    }
    const tiles = tilesIn(r.candidate, [geo.west, geo.south, geo.east, geo.north]).filter((t) => !approves(approved, [t]));
    out.push({ survey: r.candidate, tiles, size: mask.length, gap, takenBy });
  }
  return out;
}

/**
 * Offered surveys: for blocks they'd fill where nothing else could, or for
 * every block they'd have been read for when they beat what was read there
 * by a wide margin (`advantage`).
 */
async function surfaceOffers(skipped: Skipped[], surveys: Map<string, Ranked>, fetcher: Fetcher, failures: Failure[], chosen: string | undefined, newestOnly: boolean): Promise<LidarOffer[]> {
  const density = (c: Candidate) => {
    const r = surveys.get(c.url);
    return (r ? surveyDensity(r) : c.densityM2) ?? undefined;
  };
  const bySurvey = new Map<string, Skipped[]>();
  for (const s of skipped) bySurvey.set(s.survey.url, [...(bySurvey.get(s.survey.url) ?? []), s]);
  const offers: Promise<LidarOffer | null>[] = [];
  for (const list of bySurvey.values()) {
    const survey = list[0].survey;
    const gaps = list.filter((s) => s.gap >= GAP_SHARE * s.size);
    const taken = new Map<string, number>();
    for (const s of list) for (const [url, cells] of s.takenBy) taken.set(url, (taken.get(url) ?? 0) + cells);
    const instead = [...taken].sort((a, b) => b[1] - a[1])[0]?.[0];
    const better = instead ? advantage(survey, surveys.get(instead)!.candidate, density, newestOnly) : null;
    // One the user picked is offered for every block it would be read for.
    const picked = isChosen(survey, chosen);
    if (!picked && !gaps.length && !better) continue;
    offers.push(makeOffer(fetcher, survey, (picked || better ? list : gaps).flatMap((s) => s.tiles), picked ? 'chosen' : gaps.length ? 'gap' : better!, failures));
  }
  return (await Promise.all(offers)).filter((o): o is LidarOffer => o !== null);
}

/** What a probe needs of the area: the frame and the rectangle its grid covers. */
export interface ProbeArea {
  center: LonLat;
  rotationDeg: number;
  widthM: number;
  heightM: number;
}

export interface ProberOptions {
  area: ProbeArea;
  grid: GridSpec;
  runner: Pick<SurfaceRunner, 'surface'>;
  approved?: Approval;
  signal?: AbortSignal;
  progress?: (name: string, detail?: string) => void | Promise<void>;
  /** Only answer from probes made before, reading nothing: for listing surveys. */
  savedOnly?: boolean;
}

/**
 * How finely a survey fills `grid`, measured on the first of the PROBE_BLOCKS
 * blocks nearest the middle that it covers and has land, and saved per block.
 * Null when it covers none of them, they're mostly water, its tiles there
 * weren't approved, or (savedOnly) nothing was saved.
 */
export function gridProber({ area, grid, runner, approved, signal, progress, savedOnly }: ProberOptions): (r: Ranked) => Promise<SurveyProbe | null> {
  const frame = new Projection(area.center, area.rotationDeg, 1);
  const middle = [(grid.ny - 1) / 2, (grid.nx - 1) / 2];
  const near = blocks(grid)
    .sort((a, b) => {
      const d = (block: Block) => ((block.rows[0] + block.rows[1]) / 2 - middle[0]) ** 2 + ((block.columns[0] + block.columns[1]) / 2 - middle[1]) ** 2;
      return d(a) - d(b);
    })
    .slice(0, PROBE_BLOCKS);
  return async (r) => {
    for (const block of near) {
      const extent = blockExtent(grid, block);
      if (multiArea(intersection(boxShape(...extent), r.coverage)) < 0.999 * (extent[2] - extent[0]) * (extent[3] - extent[1])) continue;
      const geo = geoBox(frame, extent);
      if (staged(r.candidate) && !approves(approved, tilesIn(r.candidate, [geo.west, geo.south, geo.east, geo.north]))) continue;
      // Topobathy surveys' floors stopped counting as land, so only theirs are measured again.
      const read = topobathy(r.candidate) ? [r.candidate.url, 'topobathy'] : r.candidate.url;
      const key = `surface-probe:${digest([VERSION, PROBE_VERSION, area.center, area.rotationDeg, area.widthM, area.heightM, grid.cell, block.rows, block.columns, read])}`;
      const saved = await load(key);
      let found: { cell: number; density: number } | null;
      if (saved) {
        found = (JSON.parse(new TextDecoder().decode(saved)) as { probe: { cell: number; density: number } | null }).probe;
      } else {
        if (savedOnly) return null;
        await progress?.(r.candidate.name);
        const job: SurfaceJob = { center: area.center, rotationDeg: area.rotationDeg, survey: slim(r.candidate, geo), query: geo, grid, block, resolutionM: Math.max(0.1, grid.cell / 2), probe: grid.cell };
        const outcome = await runner.surface(job, (_label, detail) => progress?.(r.candidate.name, detail)).catch((error: Error) => {
          if (error.name === 'AbortError' || signal?.aborted) throw error;
          return null;
        });
        // A failed read isn't saved, so it's tried again next time.
        if (!outcome) continue;
        found = outcome.probe ?? null;
        save(key, new TextEncoder().encode(JSON.stringify({ probe: found })).buffer as ArrayBuffer);
      }
      if (found) return { requested: grid.cell, cell: Math.max(grid.cell, found.cell), density: found.density };
    }
    return null;
  };
}

/**
 * What a block's checkpoint is keyed by for one survey. A tiled survey's
 * tiles count too, so one read while its catalog lacked a tile isn't kept for
 * good. EPT surveys have none, and keep their keys. Topobathy surveys'
 * floors stopped being read as ground (TOPOBATHY_CODES).
 */
function readKey(survey: Candidate, geo: GeoBounds): unknown {
  const read = survey.tiles ? [survey.url, slim(survey, geo).tiles!.map((t) => (t.member ? `${t.url}#${t.member}` : t.url))] : survey.url;
  return topobathy(survey) ? [read, 'topobathy'] : read;
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
  const problem = gridProblem(area.widthM, area.heightM, requested, input.maxCells);
  if (problem) throw new Error(problem);
  let grid = gridSpec(area.widthM, area.heightM, requested);
  const fetcher = new Fetcher(input.signal);
  // Nothing can be read without a decoder, so don't search or download.
  await lazDecoder();

  await progress('Finding LiDAR surveys', 0.02);
  const rect = boxShape(grid.x0, grid.y0, grid.x1, grid.y1);
  const query = areaGeoBounds(area, 2 * requested);
  const found = await searchSurveys(fetcher, query, (message) => void progress('Finding LiDAR surveys', 0.04, message));
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
  const runner: SurfaceRunner = input.runner ?? { concurrency: 1, surface: (job, report) => readSurfaceBlock(job, fetcher, report) };
  const origin = { center: area.center, rotationDeg: area.rotationDeg };
  await progress('Finding LiDAR surveys', 0.05, 'Working out their returns per m² here');
  await measureDensities(fetcher, ranked, frame, input.signal, [grid.x0, grid.y0, grid.x1, grid.y1]);
  // Outlines that hold the area where the survey has no points at all.
  const here = ranked.filter((r) => r.measuredCoverage !== 0);
  // Measured on blocks of the grid asked for, before it grows for a sparse survey.
  const probe = gridProber({
    area,
    grid,
    runner,
    approved: input.approved,
    signal: input.signal,
    progress: (name, detail) => progress('Measuring how finely the surveys fill the grid', 0.06, detail ?? name),
  });
  // The surveys covering the most of the area go first, so blocks don't mix
  // years, then the order the settings ask for (lidar/ranking.ts).
  const tier = coverTier(here);
  const compare = (a: Ranked, b: Ranked) => tier(a) - tier(b) || rankOrder(a, b);
  const rules: SurveyRules = { preference: input.rules?.preference ?? 'balanced', years: input.rules?.years ?? 5, cellM: requested };
  const automatic = await orderSurveys(here, rules, { compare, group: (a, b) => tier(a) === tier(b), probe });
  // A chosen survey goes first even when it covers part of the area.
  const order = chosenFirst(automatic, input.survey);
  if (!order.length) {
    const reason = failures.length ? ` (${failures[0].source}: ${failures[0].reason})` : '';
    throw new Error(`No LiDAR survey that a browser can read covers this area${reason}.`);
  }

  // ------------------------------------------------------------ cell size
  // Grown from the cell asked for where the first survey that can be read
  // doesn't fill it, measured near the middle (already, if it was ranked by it).
  // Whole-file surveys are only read where their tiles were approved.
  const readableIn = (r: Ranked, geo: GeoBounds) => !staged(r.candidate) || approves(input.approved, tilesIn(r.candidate, [geo.west, geo.south, geo.east, geo.north]));
  let measured: SurveyProbe | null = null;
  for (const r of order.filter((r) => readableIn(r, query)).slice(0, 3)) {
    measured = r.probe ?? (await probe(r));
    if (measured) break;
  }
  const densityM2 = measured?.density ?? null;
  if (measured && measured.cell > requested) grid = gridSpec(area.widthM, area.heightM, measured.cell);

  // ---------------------------------------------------------------- blocks
  const layers = emptyLayers(grid.nx, grid.ny);
  const all = blocks(grid);
  const checkpoints: ArrayBuffer[] = new Array(all.length);
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
  let noise = 0;
  let reusedBlocks = 0;
  const shape: MultiPolygon = [[areaModelRing(area, 1)]];
  let shapeCells = 0;
  let outsideSurveys = 0;
  let done = 0;
  const resolutionM = Math.max(0.1, grid.cell / 2);
  const identity = [VERSION, area.center, area.rotationDeg, area.widthM, area.heightM, grid.cell];
  const skipped: Skipped[] = [];

  const readBlock = async (block: Block, index: number) => {
    const extent = blockExtent(grid, block, MARGIN * grid.dx);
    const blockBox = boxShape(...extent);
    const surveys = order.filter((r) => intersection(blockBox, r.coverage).length);
    const geo = geoBox(frame, extent);
    const reads = surveys.map((r) => readKey(r.candidate, geo));
    const blocked = surveys.filter((r) => !readableIn(r, geo));
    // Cells no survey read covers, inside the area's shape. Saved blocks don't
    // keep this, so it's worked out from the outlines every time.
    const inShape = area.shape === 'rectangle' ? null : cellsInside(shape, grid, block);
    const covered = new Uint8Array((block.columns[1] - block.columns[0]) * (block.rows[1] - block.rows[0]));
    for (const mask of claims(surveys.filter((r) => !blocked.includes(r)), grid, block, blockBox).values()) for (let k = 0; k < covered.length; k++) covered[k] |= mask[k];
    for (let k = 0; k < covered.length; k++) {
      if (inShape && !inShape[k]) continue;
      shapeCells++;
      if (!covered[k]) outsideSurveys++;
    }
    let key = `surface-block:${digest([identity, block.rows, block.columns, reads])}`;
    let saved = await load(key);
    // A block read before with an offered survey stays as it was read. Otherwise
    // it's read without it, under a key that says so, which an approval changes.
    if (!saved && blocked.length) {
      key = `surface-block:${digest([identity, block.rows, block.columns, reads.map((read, i) => (blocked.includes(surveys[i]) ? ['offered', surveys[i].candidate.url] : read))])}`;
      saved = await load(key);
      skipped.push(...skippedCells(surveys, blocked, grid, block, blockBox, geo, input.approved));
    }
    const checkpoint = saved ? decodeBlock(saved) : null;
    let piece: BlockLayers;
    let blockPoints = 0;
    let blockNoise = 0;
    let sources: [string, number][] = [];
    if (checkpoint) {
      checkpoints[index] = saved!;
      piece = checkpoint.layers;
      blockPoints = checkpoint.points;
      blockNoise = checkpoint.noise;
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
      for (const survey of surveys) {
        if (blocked.includes(survey)) continue;
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
          outcome = await runner.surface(job, (_label, detail) => progress(`Reading LiDAR block ${done + 1} of ${all.length}`, BLOCKS_START + ((1 - BLOCKS_START) * done) / all.length, detail ?? name));
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
        // be another year's surface. Ground its outline claims with no points
        // anywhere near is handed on once every block is in (overclaimed).
        const read = outcome.layers!;
        for (let k = 0; k < size; k++) {
          if (!inside[k]) continue;
          for (const name of FLOATS) piece[name][k] = read[name][k];
          for (const name of COUNTS) piece[name][k] = read[name][k];
          claimed[k] = 1;
          claimedCount++;
        }
        blockPoints += outcome.points;
        blockNoise += outcome.noise ?? 0;
        sources.push([survey.candidate.url, outcome.points]);
        note(survey.candidate.url, outcome.points);
        if (claimedCount >= COVERED * size) break;
      }
      const packed = encodeBlock(piece, blockPoints, sources, blockNoise);
      checkpoints[index] = packed;
      // A failed read is tried again next time rather than kept with a hole.
      if (!failed) save(key, packed);
    }
    points += blockPoints;
    noise += blockNoise;
    placeBlock(layers, grid, piece);
    done++;
    await progress(`Reading LiDAR block ${Math.min(done + 1, all.length)} of ${all.length}`, BLOCKS_START + ((1 - BLOCKS_START) * done) / all.length, `${points.toLocaleString('en-US')} returns`);
  };

  let next = 0;
  const lane = async () => {
    while (next < all.length) {
      const index = next++;
      await readBlock(all[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(runner.concurrency, all.length)) }, lane));

  // ------------------------------------------------------------- handed on
  // Ground a survey's outline claims with no returns near it (overclaimed):
  // each empty cell there takes the returns of the first survey after it in
  // order that has some.
  const handed = overclaimed(layers, grid.cell);
  const handedAt = (row: number, column: number) => handed!.mask[Math.floor(row / handed!.step) * handed!.nx + Math.floor(column / handed!.step)];
  const fills = handed ? all.map((block, index) => ({ block, index })).filter(({ block }) => {
    for (let r = block.rows[0]; r < block.rows[1]; r += handed.step) for (let c = block.columns[0]; c < block.columns[1]; c += handed.step) if (handedAt(r, c)) return true;
    return false;
  }) : [];
  let filled = 0;
  const fillBlock = async (block: Block, index: number) => {
    const extent = blockExtent(grid, block, MARGIN * grid.dx);
    const blockBox = boxShape(...extent);
    const geo = geoBox(frame, extent);
    const surveys = order.filter((r) => intersection(blockBox, r.coverage).length && readableIn(r, geo));
    const width = block.columns[1] - block.columns[0];
    const size = width * (block.rows[1] - block.rows[0]);
    const current = decodeBlock(checkpoints[index])!;
    const piece = current.layers;
    const open = new Uint8Array(size);
    let any = false;
    for (let k = 0; k < size; k++) {
      if (piece.count[k] || !handedAt(block.rows[0] + Math.floor(k / width), block.columns[0] + (k % width))) continue;
      open[k] = 1;
      any = true;
    }
    if (!any || surveys.length < 2) return;
    // The survey each cell came from, the first whose outline holds it.
    const insides = surveys.map((r) => (multiArea(intersection(blockBox, r.coverage)) >= 0.999 * multiArea(blockBox) ? new Uint8Array(size).fill(1) : cellsInside(r.coverage, grid, block)));
    const first = new Int32Array(size).fill(-1);
    for (let k = 0; k < size; k++) if (open[k]) first[k] = insides.findIndex((inside) => inside[k] === 1);
    const key = `surface-fill:${digest([identity, FILL_VERSION, block.rows, block.columns, surveys.map((r) => readKey(r.candidate, geo)), runs(open)])}`;
    const saved = await load(key);
    const reused = saved ? decodeBlock(saved) : null;
    if (reused) {
      checkpoints[index] = saved!;
      for (const [url, count] of reused.sources.slice(current.sources.length)) note(url, count);
      points += reused.points - current.points;
      placeBlock(layers, grid, reused.layers);
      return;
    }
    const sources = [...current.sources];
    let added = 0;
    let addedNoise = 0;
    let failed = false;
    for (let s = 1; s < surveys.length; s++) {
      const want = new Uint8Array(size);
      let wanted = false;
      for (let k = 0; k < size; k++) {
        if (!open[k] || piece.count[k] || first[k] < 0 || first[k] >= s || !insides[s][k]) continue;
        want[k] = 1;
        wanted = true;
      }
      if (!wanted) continue;
      const name = surveys[s].candidate.name;
      let outcome: SurfaceOutcome;
      try {
        const job: SurfaceJob = { ...origin, survey: slim(surveys[s].candidate, geo), query: geo, grid, block, resolutionM };
        outcome = await runner.surface(job, (_label, detail) => progress('Filling in from other surveys', 1, detail ?? name));
      } catch (error) {
        if ((error as Error).name === 'AbortError' || input.signal?.aborted) throw error;
        const reason = (error as Error).message;
        if (!failures.some((f) => f.source === name && f.reason === reason)) failures.push({ source: name, reason });
        failed = true;
        continue;
      }
      const read = outcome.layers!;
      for (let k = 0; k < size; k++) {
        if (!want[k] || !read.count[k]) continue;
        for (const layer of FLOATS) piece[layer][k] = read[layer][k];
        for (const layer of COUNTS) piece[layer][k] = read[layer][k];
      }
      // Empty cells near its returns are this survey's own holes, not ground
      // to hand on again: they took five more surveys and 400 MB in Miami.
      const seen = new Uint8Array(size);
      for (let k = 0; k < size; k++) seen[k] = read.count[k] ? 1 : 0;
      const near = dilate(seen, width, size / width, Math.ceil(REACH_M / grid.cell));
      for (let k = 0; k < size; k++) if (want[k] && near[k]) open[k] = 0;
      added += outcome.points;
      addedNoise += outcome.noise ?? 0;
      sources.push([surveys[s].candidate.url, outcome.points]);
      note(surveys[s].candidate.url, outcome.points);
    }
    const packed = encodeBlock(piece, current.points + added, sources, current.noise + addedNoise);
    checkpoints[index] = packed;
    if (!failed) save(key, packed);
    points += added;
    noise += addedNoise;
    placeBlock(layers, grid, piece);
    filled++;
    await progress('Filling in from other surveys', 1, `${filled} of ${fills.length} blocks`);
  };
  let nextFill = 0;
  const fillLane = async () => {
    while (nextFill < fills.length) {
      const { block, index } = fills[nextFill++];
      await fillBlock(block, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(runner.concurrency, fills.length)) }, fillLane));

  let covered = 0;
  for (let k = 0; k < layers.count.length; k++) if (layers.count[k]) covered++;
  const offers = skipped.length ? await surfaceOffers(skipped, byUrl, fetcher, failures, input.survey, rules.preference === 'newest') : [];
  if (!covered && offers.length) {
    // A survey that could be read failed: that's what to fix, and the offer
    // is no longer the only LiDAR here.
    if (failures.length) {
      const failure = `${failures[0].source}: ${failures[0].reason}`;
      throw new OffersError(`Some of the LiDAR here couldn't be read or searched (${failure}). Try again, or download whole tiles instead: ${offers.map(describeOffer).join('; ')}.`, offers.map((offer) => ({ ...offer, failure })));
    }
    throw new OffersError(`The LiDAR here only comes as whole tiles, which aren't downloaded without asking: ${offers.map(describeOffer).join('; ')}.`, offers);
  }
  if (!covered) {
    const reason = failures.length ? ` (${failures[0].source}: ${failures[0].reason})` : '';
    throw new Error(`The LiDAR surveys returned no points for this area${reason}.`);
  }
  return {
    layers,
    checkpoints,
    grid,
    requestedCellM: requested,
    densityM2,
    coverage: covered / layers.count.length,
    uncovered: shapeCells ? outsideSurveys / shapeCells : 0,
    points,
    noise,
    surveys: [...used.values()],
    failures,
    downloadedBytes: fetcher.downloaded + (runner.downloaded?.() ?? 0),
    blocks: all.length,
    reusedBlocks,
    offers,
    found: automatic.map((r, i) => surveyChoice(r, i ? null : pickNote(automatic, rules, compare))),
  };
}

