// The downloaded features as the pipeline sees them, and their projection
// into model millimetres. Kept structural so the data layer's types fit.

import type { Projection } from '../geo/projection';
import { cleanRing, ringArea } from '../geometry/polygon';
import type { GeoBounds, Polygon, Ring, Vec2 } from '../types';

export type SourceType =
  | 'building'
  | 'building_part'
  | 'segment'
  | 'water'
  | 'land'
  | 'land_use'
  | 'land_cover'
  | 'infrastructure';

export interface GeoGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: GeoGeometry[];
}

export interface SourceFeature {
  id: string;
  geometry: GeoGeometry;
  props: Record<string, unknown>;
}

export interface SourceData {
  release: string;
  features: Partial<Record<SourceType, SourceFeature[]>>;
}

export interface Elevation {
  /** Metres above sea level. */
  sample(lon: number, lat: number): number;
}

type Position = number[];

function projectRing(coords: Position[], projection: Projection): Ring {
  const ring: Ring = [];
  for (const p of coords) {
    if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    ring.push(projection.toModel(p[0], p[1]));
  }
  return cleanRing(ring);
}

/** Polygon rings of a feature in model mm, unvalidated (run them through `normalize`). */
export function projectPolygons(geometry: GeoGeometry | null | undefined, projection: Projection): Polygon[] {
  const out: Polygon[] = [];
  if (!geometry) return out;
  const add = (rings: Position[][]) => {
    const polygon: Polygon = [];
    for (const coords of rings) {
      const ring = projectRing(coords, projection);
      if (ring.length >= 3 && Math.abs(ringArea(ring)) > 1e-10) polygon.push(ring);
      else if (!polygon.length) return;
    }
    if (polygon.length) out.push(polygon);
  };
  if (geometry.type === 'Polygon') add(geometry.coordinates as Position[][]);
  else if (geometry.type === 'MultiPolygon') for (const p of geometry.coordinates as Position[][][]) add(p);
  else if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries ?? []) out.push(...projectPolygons(g, projection));
  }
  return out;
}

export function projectLines(geometry: GeoGeometry | null | undefined, projection: Projection): Vec2[][] {
  const out: Vec2[][] = [];
  if (!geometry) return out;
  const add = (coords: Position[]) => {
    const line: Vec2[] = [];
    for (const p of coords) {
      if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      const q = projection.toModel(p[0], p[1]);
      const last = line[line.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) line.push(q);
    }
    if (line.length >= 2) out.push(line);
  };
  if (geometry.type === 'LineString') add(geometry.coordinates as Position[]);
  else if (geometry.type === 'MultiLineString') for (const l of geometry.coordinates as Position[][]) add(l);
  else if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries ?? []) out.push(...projectLines(g, projection));
  }
  return out;
}

export function projectPoints(geometry: GeoGeometry | null | undefined, projection: Projection): Vec2[] {
  if (!geometry) return [];
  if (geometry.type === 'Point') {
    const p = geometry.coordinates as Position;
    return p && p.length >= 2 ? [projection.toModel(p[0], p[1])] : [];
  }
  if (geometry.type === 'MultiPoint') {
    return (geometry.coordinates as Position[]).filter((p) => p.length >= 2).map((p) => projection.toModel(p[0], p[1]));
  }
  return [];
}

export function isPolygonal(geometry: GeoGeometry | null | undefined): boolean {
  return geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';
}

/** Width x height of the outer rings in degrees, for the regional-feature test. */
export function geometryExtentDegrees(geometry: GeoGeometry): [number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (rings: Position[][]) => {
    for (const p of rings[0] ?? []) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  };
  if (geometry.type === 'Polygon') visit(geometry.coordinates as Position[][]);
  else if (geometry.type === 'MultiPolygon') for (const p of geometry.coordinates as Position[][][]) visit(p);
  if (!Number.isFinite(minX)) return null;
  return [maxX - minX, maxY - minY];
}

// Overture's bbox filter returns every feature that intersects the
// selection, including mapped outlines of whole regions, like a nature
// reserve with towns in it. Land cover has its own test (isDetailedCover).
export const MAXIMUM_EXTENT_RATIO = 8;

export function isRegional(geometry: GeoGeometry, bounds: GeoBounds, ratio = MAXIMUM_EXTENT_RATIO): boolean {
  const extent = geometryExtentDegrees(geometry);
  if (!extent) return false;
  const selection = Math.max((bounds.east - bounds.west) * (bounds.north - bounds.south), 1e-12);
  return (extent[0] * extent[1]) / selection > ratio;
}

// Land cover comes twice: zoom 0-7 polygons for small scale maps, some of
// them continent sized, and zoom 8-15 ones cut to zoom 10 tiles. Picking by
// zoom rather than by size against the selection keeps a place's cover the
// same whatever the size of the area around it. The size test dropped a
// 25 x 30 km forest tile from areas under about 10 km across and kept it
// over whole neighbourhoods in larger ones.
const COVER_ZOOM = 14;
// Only used when a release has no zoom levels: no detailed polygon is wider
// than a zoom 10 tile (0.35 degrees).
const COVER_TILE_DEGREES = 0.36;

/** A land cover polygon of the detailed level, from its zoom range or else its extent in degrees. */
export function isDetailedCover(props: Record<string, unknown>, extent: [number, number] | null): boolean {
  const cartography = props.cartography as Record<string, unknown> | null | undefined;
  const min = num(cartography?.min_zoom);
  const max = num(cartography?.max_zoom);
  if (min !== null || max !== null) return (min ?? 0) <= COVER_ZOOM && COVER_ZOOM <= (max ?? Infinity);
  return extent !== null && extent[0] <= COVER_TILE_DEGREES && extent[1] <= COVER_TILE_DEGREES;
}

/** Describes more than the ground here, so it makes no surface or forest. */
export function isRegionalFeature(type: SourceType, feature: SourceFeature, bounds: GeoBounds): boolean {
  if (type === 'land_cover') return !isDetailedCover(feature.props, geometryExtentDegrees(feature.geometry));
  return isRegional(feature.geometry, bounds);
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function positive(value: unknown): number | null {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}
