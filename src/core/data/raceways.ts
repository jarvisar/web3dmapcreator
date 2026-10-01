// Racetracks for map models. Overture's transportation theme has no class for
// OSM's highway=raceway, so tracks like the Indianapolis Motor Speedway came
// out as bare ground. They're read from the OpenFreeMap tiles the SVG maps use
// instead and added to the segments as road class `raceway`.
//
// Zoom 12 is the first with raceways and its tiles are small, so it's only
// used to find them. Its lines are up to 3 m off, so zoom 14 tiles are read
// over the tracks it found.

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { TILE_EXTENT, worldToLonLat } from '../svgmap/geo/mercator';
import type { Point } from '../svgmap/lines/geometry';
import { weldPaths } from '../svgmap/lines/weld';
import { clipPolylineToBox } from '../svgmap/tiles/decode';
import { stitchSeams } from '../svgmap/tiles/stitch';
import type { GeoBounds } from '../types';
import { tileRange } from './dem';
import type { OvertureData, OvertureFeature } from './features';
import { fetchBytes, HttpError } from './http';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const FIND_ZOOM = 12;
const DETAIL_ZOOM = 14;
// A 60 km area fits away from the poles. Past it the area goes without racetracks.
const MAX_FIND_TILES = 196;
// Past this many the zoom 12 lines are used as they are.
const MAX_DETAIL_TILES = 64;
// Room for the zoom 12 lines being off when picking zoom 14 tiles, about 20 m.
const PAD_DEG = 0.0002;

export interface Raceways {
  features: OvertureFeature[];
  /** Bytes from the network, not the cache. */
  downloaded: number;
  /** Set when they couldn't be read. The model is still made, without them. */
  warning?: string;
}

interface Line {
  /** Bridge or tunnel. Lines only join their own kind. */
  key: string;
  path: Point[];
}

type Tile = [number, number];

async function tileTemplate(signal: AbortSignal): Promise<string> {
  // Not cached: it points at the current tile build, and old builds go away.
  const bytes = await fetchBytes(TILEJSON_URL, signal, { cache: false });
  const json = JSON.parse(new TextDecoder().decode(bytes)) as { tiles?: unknown };
  const template = Array.isArray(json.tiles) ? json.tiles[0] : undefined;
  if (typeof template !== 'string' || !template.includes('{z}')) throw new Error('OpenFreeMap sent no tile URL.');
  return template;
}

/** Raceway lines in one tile, in world units at its zoom, cut at the tile's edges. */
export function tileRaceways(buffer: ArrayBuffer, x: number, y: number): Line[] {
  const lines: Line[] = [];
  if (!buffer.byteLength) return lines;
  const layer = new VectorTile(new PbfReader(new Uint8Array(buffer))).layers.transportation;
  if (!layer) return lines;
  const k = TILE_EXTENT / layer.extent;
  const ox = x * TILE_EXTENT;
  const oy = y * TILE_EXTENT;
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2 || feature.properties.class !== 'raceway') continue;
    const brunnel = feature.properties.brunnel;
    const key = brunnel === 'bridge' || brunnel === 'tunnel' ? brunnel : '';
    for (const part of feature.loadGeometry()) {
      const path: Point[] = part.map((p) => [ox + p.x * k, oy + p.y * k]);
      for (const piece of clipPolylineToBox(path, ox, oy, ox + TILE_EXTENT, oy + TILE_EXTENT)) lines.push({ key, path: piece });
    }
  }
  return lines;
}

async function readTiles(
  template: string,
  zoom: number,
  tiles: Tile[],
  signal: AbortSignal,
  onBytes: (bytes: number, fromCache: boolean) => void,
): Promise<Line[]> {
  const read = async ([x, y]: Tile): Promise<Line[]> => {
    const url = template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
    let buffer: ArrayBuffer;
    try {
      buffer = await fetchBytes(url, signal, { onBytes });
    } catch (error) {
      // Nothing mapped there.
      if (error instanceof HttpError && error.status === 404) return [];
      throw error;
    }
    try {
      return tileRaceways(buffer, x, y);
    } catch {
      // Perhaps a damaged cached copy.
      return tileRaceways(await fetchBytes(url, signal, { onBytes, refresh: true }), x, y);
    }
  };
  return (await Promise.all(tiles.map(read))).flat();
}

function tilesIn(bounds: GeoBounds, zoom: number): Tile[] {
  const { x0, y0, x1, y1 } = tileRange(bounds, zoom);
  const tiles: Tile[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);
  return tiles;
}

function lineBounds(path: Point[], zoom: number): GeoBounds {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of path) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const sw = worldToLonLat(minX, maxY, zoom);
  const ne = worldToLonLat(maxX, minY, zoom);
  return { west: sw.lon, south: sw.lat, east: ne.lon, north: ne.lat };
}

function meets(a: GeoBounds, b: GeoBounds): boolean {
  return a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north;
}

/** Zoom 14 tiles over each line found, as far as it's in the area. */
function detailTiles(lines: Line[], bounds: GeoBounds): Tile[] {
  const tiles = new Map<string, Tile>();
  for (const line of lines) {
    const b = lineBounds(line.path, FIND_ZOOM);
    const padded = {
      west: Math.max(bounds.west, b.west - PAD_DEG),
      south: Math.max(bounds.south, b.south - PAD_DEG),
      east: Math.min(bounds.east, b.east + PAD_DEG),
      north: Math.min(bounds.north, b.north + PAD_DEG),
    };
    if (padded.west > padded.east || padded.south > padded.north) continue;
    for (const tile of tilesIn(padded, DETAIL_ZOOM)) tiles.set(tile.join(','), tile);
  }
  return [...tiles.values()];
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function lengthM(coordinates: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const [lon0, lat0] = coordinates[i - 1];
    const [lon1, lat1] = coordinates[i];
    const x = (lon1 - lon0) * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
    total += Math.hypot(x, lat1 - lat0) * 111_320;
  }
  return total;
}

/** Tile pieces joined back into whole lines, as segment features. */
export function racewayFeatures(lines: Line[], zoom: number, bounds: GeoBounds): OvertureFeature[] {
  stitchSeams(lines);
  // Quantum 1: finer and node keys overflow at zoom 14. Stitched ends are identical anyway.
  const welded = weldPaths(lines.map((line) => ({ key: line.key, rank: 0, path: line.path })), 1, { groupFn: (key) => key }).items;
  const features: OvertureFeature[] = [];
  const ids = new Set<string>();
  for (const { key, path } of welded) {
    if (path.length < 2) continue;
    const b = lineBounds(path, zoom);
    if (!meets(b, bounds)) continue;
    const coordinates = path.map(([x, y]): [number, number] => {
      const p = worldToLonLat(x, y, zoom);
      return [p.lon, p.lat];
    });
    // Tiles have no OSM ids. Edits are keyed by the ends and length instead,
    // which hold while the area and the tiles don't change around the line.
    const ends = [coordinates[0], coordinates[coordinates.length - 1]].map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`);
    const base = `raceway-${hash(`${ends.join(';')};${Math.round(lengthM(coordinates) / 10)}`)}`;
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    const props: Record<string, unknown> = { subtype: 'road', class: 'raceway' };
    if (key === 'bridge') props.road_flags = [{ values: ['is_bridge'] }];
    if (key === 'tunnel') props.road_flags = [{ values: ['is_tunnel'] }];
    features.push({ id, type: 'segment', geometry: { type: 'LineString', coordinates }, bbox: [b.west, b.south, b.east, b.north], props });
  }
  return features;
}

export async function fetchRaceways(bounds: GeoBounds, signal?: AbortSignal): Promise<Raceways> {
  const find = tilesIn(bounds, FIND_ZOOM);
  if (find.length > MAX_FIND_TILES) {
    return { features: [], downloaded: 0, warning: 'Racetracks were left out. The area is too large to look for them.' };
  }
  let downloaded = 0;
  const onBytes = (bytes: number, fromCache: boolean) => {
    if (!fromCache) downloaded += bytes;
  };
  // Stops the other tiles as soon as one fails or the caller cancels.
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  try {
    const template = await tileTemplate(controller.signal);
    let zoom = FIND_ZOOM;
    let lines = await readTiles(template, zoom, find, controller.signal, onBytes);
    if (lines.length) {
      const detail = detailTiles(lines, bounds);
      if (detail.length <= MAX_DETAIL_TILES) {
        zoom = DETAIL_ZOOM;
        lines = await readTiles(template, zoom, detail, controller.signal, onBytes);
      }
    }
    return { features: racewayFeatures(lines, zoom, bounds), downloaded };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const reason = error instanceof Error ? error.message : String(error);
    return { features: [], downloaded, warning: `Racetracks couldn't be downloaded from OpenFreeMap, so any in the area are missing. ${reason}` };
  } finally {
    signal?.removeEventListener('abort', forward);
    controller.abort();
  }
}

/** The map data with racetracks added to its segments. */
export function withRaceways(data: OvertureData, raceways: Raceways | null): OvertureData {
  if (!raceways || (!raceways.features.length && !raceways.warning)) return data;
  return {
    ...data,
    features: { ...data.features, segment: [...(data.features.segment ?? []), ...raceways.features] },
    warnings: raceways.warning ? [...data.warnings, raceways.warning] : data.warnings,
  };
}
