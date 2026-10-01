// What every provider returns, and the helpers they share: lon/lat boxes,
// GeoJSON outlines, paged feature services, S3 listings and tile grids.

import type { GeoBounds, Polygon, Ring } from '../../types';
import { crsFromEpsg, lonLatTransforms, type Transform } from '../read/crs';
import type { Fetcher } from '../read/fetcher';

/** EPT and I3S (an Esri scene layer) are one tree for a survey. COPC and LAZ come as tiles; LAZ tiles have no index, so they're read whole. */
export type Format = 'EPT' | 'I3S' | 'COPC' | 'LAZ';

export type Box = [number, number, number, number];

export interface Tile {
  url: string;
  /** West, south, east, north. */
  bbox: Box;
  horizontalCrs?: string;
  /** File size in bytes, when the catalog gives it. */
  size?: number;
  /** What reading it downloads, where that's less than the file: one member of a ZIP holding many. */
  bytes?: number;
  /** For a ZIP, the member holding the points; by default its first .laz or .las. */
  member?: string;
  /** The server ignores Range, so the file is read whole. */
  whole?: boolean;
  /** Class codes for this tile alone, where one survey mixes schemes. */
  classification?: Record<string, string>;
  /** Metres added to every height, where a copy moved them to another datum. */
  zOffset?: number;
}

export interface Candidate {
  provider: string;
  /** Survey identity within its provider. */
  id: string;
  name: string;
  /** EPT: its ept.json. I3S: its layer, `.../SceneServer/layers/0`. Tiled: a stable survey key; points come from `tiles`. */
  url: string;
  format: Format;
  /** Where the survey has points, as lon/lat polygons. */
  coverage: Polygon[];
  tiles?: Tile[];
  verticalUnits?: string;
  /** Class code to meaning, where the provider declares its own. */
  classification?: Record<string, string>;
  acquisitionStart?: string;
  acquisitionEnd?: string;
  densityM2?: number;
  classificationQuality?: number;
  license?: string;
  attribution: string;
  sourcePage: string;
  /** The original publisher, not a mirror. Breaks quality ties. */
  authoritative?: boolean;
  /** No ground or building classes at all, so only LiDAR only models read it. */
  unclassified?: boolean;
  projectYearHint: number | null;
}

export interface Failure {
  source: string;
  reason: string;
  /** Its catalog couldn't be searched, so none of its surveys were considered. */
  search?: boolean;
}

export type Discover = (fetcher: Fetcher, bbox: GeoBounds, failures: Failure[]) => Promise<Candidate[]>;

export interface Provider {
  /** Short name, used in progress and tests. */
  id: string;
  /** The publisher as people know it, for messages. */
  name?: string;
  /** Generous lon/lat boxes around its territory. It isn't asked about areas outside them: some services answer slowly or with errors elsewhere. Omitted for worldwide catalogs. */
  areas?: Box[];
  /** How long its discovery may take before it counts as failed. */
  timeoutMs?: number;
  discover: Discover;
}

export const overlaps = (a: Box, b: GeoBounds) => a[0] <= b.east && a[2] >= b.west && a[1] <= b.north && a[3] >= b.south;

export function ringBox(rings: Ring[]): Box {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      w = Math.min(w, x);
      s = Math.min(s, y);
      e = Math.max(e, x);
      n = Math.max(n, y);
    }
  }
  return [w, s, e, n];
}

/** GeoJSON Polygon/MultiPolygon, or a Feature or FeatureCollection of them, to polygons with open rings. */
export function geoPolygons(geometry: { type: string; coordinates?: unknown; geometry?: unknown; features?: unknown[] } | null | undefined): Polygon[] {
  if (!geometry) return [];
  if (geometry.type === 'Feature') return geoPolygons(geometry.geometry as typeof geometry);
  if (geometry.type === 'FeatureCollection') return (geometry.features ?? []).flatMap((f) => geoPolygons(f as typeof geometry));
  const open = (ring: number[][]): Ring => {
    const out = ring.map((p) => [p[0], p[1]] as [number, number]);
    if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    return out;
  };
  if (geometry.type === 'Polygon') return [(geometry.coordinates as number[][][]).map(open)];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).map((p) => p.map(open));
  return [];
}

export function dateOnly(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value.trim());
  return match ? match[0] : undefined;
}

/** Area of lon/lat polygons on the sphere, in m². */
export function sphericalArea(polygons: Polygon[]): number {
  const R = 6378137;
  const rad = Math.PI / 180;
  let total = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, r) => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        a += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
      }
      total += (r === 0 ? 1 : -1) * Math.abs((a * R * R) / 2);
    });
  }
  return total;
}

export type Feature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };

const PAGE = 500;
const MAX_FEATURES = 10000;

/** Every feature of a paged GeoJSON service (WFS 2 or ArcGIS REST), up to a budget. */
export async function pagedFeatures(fetcher: Fetcher, page: (offset: number, count: number) => string): Promise<Feature[]> {
  const out: Feature[] = [];
  for (let offset = 0; offset < MAX_FEATURES; ) {
    const document = (await fetcher.json(page(offset, PAGE))) as Record<string, unknown>;
    if (document.error && typeof document.error === 'object') throw new Error(`Catalog error: ${String((document.error as { message?: string }).message ?? 'unknown')}`);
    // Some servers leave `features` out of an empty collection.
    const rows = document.features ?? (document.type === 'FeatureCollection' ? [] : undefined);
    if (document.type !== 'FeatureCollection' || !Array.isArray(rows)) throw new Error('Catalog returned no FeatureCollection');
    out.push(...(rows as Feature[]));
    offset += rows.length;
    const total = Number(document.numberMatched ?? document.totalFeatures ?? NaN);
    const more = Boolean(document.exceededTransferLimit || (document.properties as Record<string, unknown> | undefined)?.exceededTransferLimit);
    if (!rows.length || (Number.isFinite(total) && offset >= total) || (!Number.isFinite(total) && rows.length < PAGE && !more)) return out;
  }
  throw new Error('Catalog feature budget reached; discovery is partial');
}

/** Keys, sizes and ETags from an S3 ListObjectsV2 answer; no DOMParser in a worker. */
export function s3Listing(xml: string): { keys: Map<string, { size: number; etag: string }>; truncated: boolean; next: string | null } {
  const keys = new Map<string, { size: number; etag: string }>();
  const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([^<]*)<\/Key>/.exec(block[1])?.[1];
    const size = Number(/<Size>(\d+)<\/Size>/.exec(block[1])?.[1] ?? NaN);
    const etag = /<ETag>([^<]*)<\/ETag>/.exec(block[1])?.[1] ?? '';
    if (key) keys.set(unescape(key), { size, etag });
  }
  const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { keys, truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml), next: next ? unescape(next) : null };
}

/** Every key under a prefix of a public S3 bucket, following continuation tokens up to `pages`. */
export async function s3Keys(fetcher: Fetcher, bucket: string, prefix: string, pages = 20): Promise<Map<string, { size: number; etag: string }>> {
  const out = new Map<string, { size: number; etag: string }>();
  let token: string | null = null;
  for (let page = 0; page < pages; page++) {
    const query = `list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const listing = s3Listing(await fetcher.text(`${bucket}?${query}`));
    for (const [key, value] of listing.keys) out.set(key, value);
    if (!listing.truncated) return out;
    token = listing.next;
    if (!token) break;
  }
  throw new Error(`The listing of ${prefix} is incomplete`);
}

/** An S3 key as a URL path, each part encoded. */
export function keyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Grid squares of `sizeM` metres in a projected CRS that meet a lon/lat box,
 * as their lower-left corners. Most national tile grids are named by these.
 */
export function gridSquares(epsg: number, bbox: GeoBounds, sizeM: number, limit = 400): { x: number; y: number }[] {
  const { fromLonLat } = lonLatTransforms(crsFromEpsg(epsg));
  const corners: [number, number][] = [];
  // Densified, since lines of longitude and latitude bend in a projected grid.
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const lon = bbox.west + (bbox.east - bbox.west) * t;
    const lat = bbox.south + (bbox.north - bbox.south) * t;
    corners.push(fromLonLat(lon, bbox.south), fromLonLat(lon, bbox.north), fromLonLat(bbox.west, lat), fromLonLat(bbox.east, lat));
  }
  const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) / sizeM);
  const x1 = Math.floor(Math.max(...corners.map((c) => c[0])) / sizeM);
  const y0 = Math.floor(Math.min(...corners.map((c) => c[1])) / sizeM);
  const y1 = Math.floor(Math.max(...corners.map((c) => c[1])) / sizeM);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > limit) throw new Error('The area covers too many tiles of this survey');
  const out: { x: number; y: number }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ x: x * sizeM, y: y * sizeM });
  return out;
}

/** A projected square as a lon/lat polygon, densified along its sides. */
export function squarePolygon(toLonLat: Transform, x: number, y: number, size: number, steps = 4): Polygon {
  const ring: Ring = [];
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    for (let k = 0; k < steps; k++) ring.push(toLonLat(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps));
  };
  edge(x, y, x + size, y);
  edge(x + size, y, x + size, y + size);
  edge(x + size, y + size, x, y + size);
  edge(x, y + size, x, y);
  return [ring];
}

/** Tiles gathered into surveys by a key, each survey made on first sight. */
export class Surveys {
  private readonly byKey = new Map<string, Candidate>();

  add(key: string, make: () => Omit<Candidate, 'coverage' | 'tiles'>, tile: Tile, coverage: Polygon[]): void {
    let survey = this.byKey.get(key);
    if (!survey) this.byKey.set(key, (survey = { ...make(), coverage: [], tiles: [] }));
    survey.coverage.push(...coverage);
    survey.tiles!.push(tile);
  }

  /** In the order they were first seen, tiles in the catalog's order. */
  list(): Candidate[] {
    return [...this.byKey.values()];
  }
}
