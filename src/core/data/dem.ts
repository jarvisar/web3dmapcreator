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
    let heights: Float32Array;
    try {
      heights = await readTile(x, y);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
        missing++;
        report();
        return;
      }
      if (error instanceof DecodeError) throw new Error(`Elevation tile ${zoom}/${x}/${y} could not be read: ${error.message}`);
      throw error;
    }
    const left = (x - range.x0) * TILE_SIZE;
    const top = (y - range.y0) * TILE_SIZE;
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
    return createDemMosaic({ zoom, tileX0: range.x0, tileY0: range.y0, columns, rows, values }, bounds, used, missing);
  } catch (error) {
    controller.abort(error);
    throw outer?.aborted ? outer.reason : error;
  } finally {
    outer?.removeEventListener('abort', forward);
  }
}
