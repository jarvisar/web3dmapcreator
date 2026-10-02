// Elevation from the public Terrarium tiles on AWS, the source the Blender
// add-on used. Heights are metres above sea level, not above the WGS84
// ellipsoid. Tiles are decoded with fast-png, never through a canvas, because
// browser colour management can change pixel values.

import { convertIndexedToRgb, decode } from 'fast-png';
import type { GeoBounds } from '../types';
import { fetchBytes, HttpError } from './http';

export const TILE_SIZE = 256;
export const MIN_ZOOM = 8;
export const MAX_ZOOM = 15;
/** Tile budget: `chooseZoom` stays at a coarser zoom rather than go over it. */
export const MAX_TILES = 256;
const TILE_ROOT = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const EARTH_CIRCUMFERENCE_M = 40_075_016.685_578_49;
// Web Mercator ends here.
const MAX_LATITUDE = 85.05112878;
const PROGRESS_INTERVAL_MS = 100;

export function tileUrl(zoom: number, x: number, y: number): string {
  return `${TILE_ROOT}/${zoom}/${x}/${y}.png`;
}

/** Fractional slippy-map tile coordinates of a WGS84 position. */
export function tileFraction(lon: number, lat: number, zoom: number): [number, number] {
  const count = 2 ** zoom;
  const radians = (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI) / 180;
  return [
    ((lon + 180) / 360) * count,
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * count,
  ];
}

/** Metres per tile pixel at a latitude and zoom. */
export function groundResolutionM(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** zoom);
}

/** Inclusive tile columns x0..x1 and rows y0..y1 (row 0 is north) covering the bounds. */
export interface TileRange {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function tileRange(bounds: GeoBounds, zoom: number): TileRange {
  const [west, south] = tileFraction(bounds.west, bounds.south, zoom);
  const [east, north] = tileFraction(bounds.east, bounds.north, zoom);
  const last = 2 ** zoom - 1;
  const clamp = (value: number) => Math.max(0, Math.min(last, Math.floor(value)));
  return { x0: clamp(west), y0: clamp(north), x1: clamp(east), y1: clamp(south) };
}

export function tileCount(bounds: GeoBounds, zoom: number): number {
  const range = tileRange(bounds, zoom);
  return (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
}

/**
 * The coarsest zoom whose pixels are no larger than `targetSpacingM`, within
 * the tile budget. Finer tiles than the print can show only cost downloads
 * and add noise.
 */
export function chooseZoom(bounds: GeoBounds, targetSpacingM: number, maxTiles = MAX_TILES): number {
  const lat = (bounds.south + bounds.north) / 2;
  let chosen = MIN_ZOOM;
  for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom++) {
    if (tileCount(bounds, zoom) > maxTiles) break;
    chosen = zoom;
    if (groundResolutionM(lat, zoom) <= targetSpacingM) break;
  }
  return chosen;
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

/** Heights in metres of one 256 x 256 Terrarium tile, row 0 at the north edge. */
export function decodeTerrarium(png: ArrayBuffer | Uint8Array): Float32Array {
  let image: ReturnType<typeof decode>;
  try {
    image = decode(png);
  } catch (error) {
    throw new DecodeError(error instanceof Error ? error.message : String(error));
  }
  if (image.width !== TILE_SIZE || image.height !== TILE_SIZE) {
    throw new DecodeError(`the tile is ${image.width} x ${image.height} pixels, not ${TILE_SIZE} x ${TILE_SIZE}`);
  }
  let pixels = image.data;
  let channels = image.channels;
  if (image.palette) {
    pixels = convertIndexedToRgb(image);
    channels = image.palette[0]?.length ?? 3;
  } else if (image.depth !== 8) {
    throw new DecodeError(`the tile has ${image.depth}-bit channels, not 8`);
  }
  // A grey or misread tile would decode to plausible but wrong terrain.
  if (channels < 3) throw new DecodeError(`the tile has ${channels} colour channels, not 3`);
  const heights = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0, p = 0; i < heights.length; i++, p += channels) {
    heights[i] = pixels[p] * 256 + pixels[p + 1] + pixels[p + 2] / 256 - 32768;
  }
  return heights;
}

export interface DemGrid {
  zoom: number;
  /** Tile column and row of the mosaic's north-west tile. */
  tileX0: number;
  tileY0: number;
  /** Mosaic size in pixels. */
  columns: number;
  rows: number;
  /** Metres, row-major, row 0 at the north edge. Missing tiles are 0. */
  values: Float32Array;
}

export interface DemMosaic extends DemGrid {
  bounds: GeoBounds;
  /** Metres per pixel at the middle of the bounds. */
  groundResolutionM: number;
  tilesUsed: number;
  tilesMissing: number;
  /** Lowest and highest heights any sample inside the bounds can return. */
  min: number;
  max: number;
  /** Height in metres at a WGS84 position, bilinear, clamped to the mosaic. */
  sample(lon: number, lat: number): number;
}

// Terrarium's no data, an all-black pixel. Clearwater's causeway, Waikiki
// and Charleston have blocks of it at zoom 15.
export const VOID_M = -32768;
// Some coastal tiles also carry seabed garbage: lines and specks of -100 to
// -15,000 m one to five pixels wide, often on land (Sydney had -934 m beside
// +30 m). One of them sets the base for the whole model, so a 1.5 km area
// came out a metre tall. A pixel below sea level counts as garbage when it's
// more than PIT_MARGIN_M under what a 45 degree slope from anything within
// PIT_REACH pixels allows. Real ground above sea level is never touched, and
// polders, harbours and seabed are far gentler than that.
const PIT_SLOPE = 1;
const PIT_MARGIN_M = 20;
const PIT_REACH = 3;

/**
 * Fills voids and seabed garbage from the pixels around them, in place.
 * `pixelM` is the mosaic's pixel size in metres. `missing` marks the pixels
 * of tiles the server didn't have, which stay at sea level but aren't data:
 * beside one, seabed deeper than about 25 m at zoom 15 read as garbage and
 * was filled from the 0s. Returns the pixels filled.
 */
export function repairElevation(grid: DemGrid, pixelM: number, missing?: Uint8Array): number {
  const { columns, rows, values } = grid;
  const n = columns * rows;
  let any = false;
  for (let i = 0; i < n; i++) {
    if (values[i] < 0) {
      any = true;
      break;
    }
  }
  if (!any) return 0;

  const bad = new Uint8Array(n);
  const offX: number[] = [];
  const offY: number[] = [];
  const offDrop: number[] = [];
  for (let dy = -PIT_REACH; dy <= PIT_REACH; dy++) {
    for (let dx = -PIT_REACH; dx <= PIT_REACH; dx++) {
      if (!dx && !dy) continue;
      offX.push(dx);
      offY.push(dy);
      offDrop.push(PIT_SLOPE * pixelM * Math.hypot(dx, dy));
    }
  }
  let count = 0;
  let minC = columns;
  let minR = rows;
  let maxC = -1;
  let maxR = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      const v = values[i];
      if (v >= 0) continue;
      let pit = v === VOID_M;
      if (!pit) {
        let allowed = -Infinity;
        for (let k = 0; k < offX.length; k++) {
          const cc = c + offX[k];
          const rr = r + offY[k];
          if (cc < 0 || cc >= columns || rr < 0 || rr >= rows) continue;
          const j = rr * columns + cc;
          const q = values[j];
          if (q !== VOID_M && !missing?.[j] && q - offDrop[k] > allowed) allowed = q - offDrop[k];
        }
        pit = allowed - v > PIT_MARGIN_M;
      }
      if (!pit) continue;
      bad[i] = 1;
      count++;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  if (!count) return 0;
  count += enclosedPits(grid, bad, [minC, minR, maxC, maxR]);
  fillFromNeighbours(grid, bad, count, missing);
  return count;
}

/**
 * Marks what a ring of garbage encloses, when all of it is below sea level,
 * so a blob wider than the reach is filled whole instead of leaving its core
 * as a smaller pit. Returns the pixels marked.
 */
function enclosedPits(grid: DemGrid, bad: Uint8Array, [minC, minR, maxC, maxR]: [number, number, number, number]): number {
  const { columns, values } = grid;
  // Only what lies inside the marked pixels' box can be enclosed by them.
  const c0 = Math.max(0, minC - 1);
  const r0 = Math.max(0, minR - 1);
  const c1 = Math.min(columns - 1, maxC + 1);
  const r1 = Math.min(grid.rows - 1, maxR + 1);
  const width = c1 - c0 + 1;
  const height = r1 - r0 + 1;
  // 0 unseen, 1 reached from outside the box, 2 part of an enclosed component.
  const state = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const local = (c: number, r: number) => (r - r0) * width + (c - c0);
  const isOpen = (c: number, r: number) => !bad[r * columns + c];
  let head = 0;
  let tail = 0;
  const touchesOutside = (c: number, r: number) => c === c0 || c === c1 || r === r0 || r === r1;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!touchesOutside(c, r) || !isOpen(c, r)) continue;
      state[local(c, r)] = 1;
      queue[tail++] = local(c, r);
    }
  }
  const flood = (mark: number, inside?: number[]) => {
    while (head < tail) {
      const k = queue[head++];
      const c = c0 + (k % width);
      const r = r0 + Math.floor(k / width);
      inside?.push(r * columns + c);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cc = c + dx;
          const rr = r + dy;
          if (cc < c0 || cc > c1 || rr < r0 || rr > r1) continue;
          const j = local(cc, rr);
          if (state[j] || !isOpen(cc, rr)) continue;
          state[j] = mark;
          queue[tail++] = j;
        }
      }
    }
  };
  flood(1);
  let marked = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const k = local(c, r);
      if (state[k] || !isOpen(c, r)) continue;
      state[k] = 2;
      head = tail = 0;
      queue[tail++] = k;
      const inside: number[] = [];
      flood(2, inside);
      // An island ringed by steep seabed stays.
      if (inside.some((i) => values[i] >= 0)) continue;
      for (const i of inside) bad[i] = 1;
      marked += inside.length;
    }
  }
  return marked;
}

/** Each marked pixel gets the mean of its known neighbours, working in from the edges of what's marked. */
function fillFromNeighbours(grid: DemGrid, bad: Uint8Array, count: number, missing: Uint8Array | undefined): void {
  const { columns, rows, values } = grid;
  const queue = new Int32Array(count);
  const queued = new Uint8Array(bad.length);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    if (!queued[i]) {
      queued[i] = 1;
      queue[tail++] = i;
    }
  };
  const neighbours = (i: number, visit: (j: number) => void) => {
    const c = i % columns;
    const r = (i - c) / columns;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cc = c + dx;
        const rr = r + dy;
        if ((dx || dy) && cc >= 0 && cc < columns && rr >= 0 && rr < rows) visit(rr * columns + cc);
      }
    }
  };
  for (let i = 0; i < bad.length; i++) {
    if (!bad[i]) continue;
    let known = false;
    neighbours(i, (j) => {
      if (!bad[j] && !missing?.[j]) known = true;
    });
    if (known) push(i);
  }
  while (head < tail) {
    const i = queue[head++];
    let sum = 0;
    let n = 0;
    neighbours(i, (j) => {
      if (bad[j] || missing?.[j]) return;
      sum += values[j];
      n++;
    });
    values[i] = sum / n;
    bad[i] = 0;
    neighbours(i, (j) => {
      if (bad[j]) push(j);
    });
  }
  // Nothing known to fill from: the whole mosaic was void.
  for (let i = 0; i < bad.length; i++) {
    if (bad[i]) values[i] = 0;
  }
}

/** Bilinear sample of a row-major grid at pixel coordinates, clamped to the grid. */
export function bilinear(values: ArrayLike<number>, columns: number, rows: number, x: number, y: number): number {
  const cx = Math.min(Math.max(x, 0), columns - 1);
  const cy = Math.min(Math.max(y, 0), rows - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, columns - 1);
  const y1 = Math.min(y0 + 1, rows - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const top = values[y0 * columns + x0] * (1 - fx) + values[y0 * columns + x1] * fx;
  const bottom = values[y1 * columns + x0] * (1 - fx) + values[y1 * columns + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

export function createDemMosaic(grid: DemGrid, bounds: GeoBounds, tilesUsed = 0, tilesMissing = 0): DemMosaic {
  const { zoom, columns, rows, values } = grid;
  const originX = grid.tileX0 * TILE_SIZE;
  const originY = grid.tileY0 * TILE_SIZE;
  // A pixel holds the height of its whole square, so pixel i is centred at
  // i + 0.5. The Blender add-on sampled at i, half a pixel off: over hills,
  // zooms 12 and 14 agree 2 to 6 times better with the centre.
  const pixel = (lon: number, lat: number): [number, number] => {
    const [x, y] = tileFraction(lon, lat, zoom);
    return [x * TILE_SIZE - originX - 0.5, y * TILE_SIZE - originY - 0.5];
  };
  const [westX, northY] = pixel(bounds.west, bounds.north);
  const [eastX, southY] = pixel(bounds.east, bounds.south);
  const clampColumn = (x: number) => Math.max(0, Math.min(columns - 1, x));
  const clampRow = (y: number) => Math.max(0, Math.min(rows - 1, y));
  let min = Infinity;
  let max = -Infinity;
  for (let row = clampRow(Math.floor(northY)); row <= clampRow(Math.ceil(southY)); row++) {
    for (let column = clampColumn(Math.floor(westX)); column <= clampColumn(Math.ceil(eastX)); column++) {
      const value = values[row * columns + column];
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return {
    ...grid,
    bounds: { ...bounds },
    groundResolutionM: groundResolutionM((bounds.south + bounds.north) / 2, zoom),
    tilesUsed,
    tilesMissing,
    min,
    max,
    sample(lon: number, lat: number): number {
      const [x, y] = pixel(lon, lat);
      return bilinear(values, columns, rows, x, y);
    },
  };
}

export interface DemProgress {
  message: string;
  tilesDone: number;
  tilesTotal: number;
  /** Bytes read so far, from the network or the cache. */
  bytes: number;
  /** The part of `bytes` that came from the network. */
  downloaded: number;
}

export interface FetchDemOptions {
  bounds: GeoBounds;
  /** Ground distance in metres the elevation should resolve. Picks the zoom. */
  targetSpacingM: number;
  /** Overrides the zoom choice. */
  zoom?: number;
  signal?: AbortSignal;
  onProgress?: (progress: DemProgress) => void;
}

/**
 * Downloads and stitches the Terrarium tiles covering the bounds. Tiles the
 * server does not have (HTTP 403 or 404) read as sea level. Any other failure
 * is an error, and so is an area with no tiles at all.
 */
export async function fetchDem(options: FetchDemOptions): Promise<DemMosaic> {
  const { bounds, targetSpacingM } = options;
  const { west, south, east, north } = bounds;
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
    throw new Error('The area bounds are empty or not numbers');
  }
  if (options.zoom === undefined && !(targetSpacingM > 0)) throw new Error('The elevation spacing must be above 0');
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(options.zoom ?? chooseZoom(bounds, targetSpacingM))));
  const range = tileRange(bounds, zoom);
  const tilesX = range.x1 - range.x0 + 1;
  const tilesY = range.y1 - range.y0 + 1;
  const total = tilesX * tilesY;
  // Only a forced zoom or a continent-sized area gets here. 1024 tiles is a 268 MB mosaic.
  if (total > 4 * MAX_TILES) throw new Error(`The elevation for this area needs ${total} tiles. Make the area smaller.`);
  const columns = tilesX * TILE_SIZE;
  const rows = tilesY * TILE_SIZE;
  const values = new Float32Array(columns * rows);
  // Pixels of missing tiles, made only when there are some.
  let gaps: Uint8Array | undefined;
  let used = 0;
  let missing = 0;
  let bytes = 0;
  let downloaded = 0;
  let last = -Infinity;
  const report = (force = false) => {
    if (!options.onProgress) return;
    const now = performance.now();
    if (!force && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    const done = used + missing;
    options.onProgress({ message: `Downloading elevation tiles (${done}/${total})`, tilesDone: done, tilesTotal: total, bytes, downloaded });
  };

  const outer = options.signal;
  outer?.throwIfAborted();
  // Stops the other tiles as soon as one fails or the caller cancels.
  const controller = new AbortController();
  const forward = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', forward, { once: true });
  const signal = controller.signal;
  const onBytes = (count: number, fromCache: boolean) => {
    bytes += count;
    if (!fromCache) downloaded += count;
    report();
  };

  const readTile = async (x: number, y: number): Promise<Float32Array> => {
    const url = tileUrl(zoom, x, y);
    try {
      return decodeTerrarium(await fetchBytes(url, signal, { onBytes }));
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
    }
    // Perhaps a damaged cached copy: download it once more.
    return decodeTerrarium(await fetchBytes(url, signal, { onBytes, refresh: true }));
  };

  const loadTile = async (x: number, y: number): Promise<void> => {
    const left = (x - range.x0) * TILE_SIZE;
    const top = (y - range.y0) * TILE_SIZE;
    let heights: Float32Array;
    try {
      heights = await readTile(x, y);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
        gaps ??= new Uint8Array(columns * rows);
        for (let row = 0; row < TILE_SIZE; row++) gaps.fill(1, (top + row) * columns + left, (top + row) * columns + left + TILE_SIZE);
        missing++;
        report();
        return;
      }
      if (error instanceof DecodeError) throw new Error(`Elevation tile ${zoom}/${x}/${y} could not be read: ${error.message}`);
      throw error;
    }
    for (let row = 0; row < TILE_SIZE; row++) {
      values.set(heights.subarray(row * TILE_SIZE, (row + 1) * TILE_SIZE), (top + row) * columns + left);
    }
    used++;
    report();
  };

  try {
    report(true);
    const tiles: Promise<void>[] = [];
    for (let y = range.y0; y <= range.y1; y++) {
      for (let x = range.x0; x <= range.x1; x++) tiles.push(loadTile(x, y));
    }
    await Promise.all(tiles);
    if (!used) throw new Error('No elevation tiles are available for this area. Turn elevation off to build a flat base.');
    report(true);
    const grid: DemGrid = { zoom, tileX0: range.x0, tileY0: range.y0, columns, rows, values };
    // After decoding, so tiles from the byte cache are repaired too.
    repairElevation(grid, groundResolutionM((south + north) / 2, zoom), gaps);
    return createDemMosaic(grid, bounds, used, missing);
  } catch (error) {
    controller.abort(error);
    throw outer?.aborted ? outer.reason : error;
  } finally {
    outer?.removeEventListener('abort', forward);
  }
}
