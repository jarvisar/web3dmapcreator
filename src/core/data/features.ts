// Types for the downloaded map data. Geometries are GeoJSON in WGS84, the way
// Overture publishes them.

import type { GeoBounds } from '../types';

export type OvertureType =
  | 'building'
  | 'building_part'
  | 'segment'
  | 'water'
  | 'land'
  | 'land_use'
  | 'land_cover'
  | 'infrastructure';

export const OVERTURE_TYPES: readonly OvertureType[] = [
  'building',
  'building_part',
  'segment',
  'water',
  'land',
  'land_use',
  'land_cover',
  'infrastructure',
];

/** Plural names for progress messages, e.g. "Downloading building parts". */
export const OVERTURE_LABEL: Record<OvertureType, string> = {
  building: 'buildings',
  building_part: 'building parts',
  segment: 'roads and paths',
  water: 'water',
  land: 'land',
  land_use: 'land use',
  land_cover: 'land cover',
  infrastructure: 'infrastructure',
};

/** [lon, lat]. Overture data is 2D and the WKB reader drops any Z or M. */
export type Position = [number, number];

export interface Point {
  type: 'Point';
  coordinates: Position;
}

export interface MultiPoint {
  type: 'MultiPoint';
  coordinates: Position[];
}

export interface LineString {
  type: 'LineString';
  coordinates: Position[];
}

export interface MultiLineString {
  type: 'MultiLineString';
  coordinates: Position[][];
}

/** Outer ring first, then holes. Rings are closed as in the source (last point repeats the first). */
export interface Polygon {
  type: 'Polygon';
  coordinates: Position[][];
}

export interface MultiPolygon {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}

export interface GeometryCollection {
  type: 'GeometryCollection';
  geometries: Geometry[];
}

export type Geometry =
  | Point
  | MultiPoint
  | LineString
  | MultiLineString
  | Polygon
  | MultiPolygon
  | GeometryCollection;

export interface OvertureFeature {
  id: string;
  type: OvertureType;
  /** Unclipped: a feature is kept when its bbox meets the area. */
  geometry: Geometry;
  /** west, south, east, north, from Overture's bbox column. */
  bbox: [number, number, number, number];
  /**
   * The other selected columns under their Overture names, e.g. `height`,
   * `class`, `road_flags`. Null values are left out, INT64 values are
   * numbers and MAP columns such as `source_tags` are plain objects.
   * Buildings, segments and water carry `names` as `{ primary }` only.
   */
  props: Record<string, unknown>;
}

export interface OvertureTypeStats {
  /** Files whose index bbox meets the area. */
  files: number;
  /** Row groups read after pruning by their bbox statistics. */
  rowGroups: number;
  /** Rows read in the first pass (every column but geometry). */
  rowsRead: number;
  /** Rows whose bbox meets the area and that the caller's filter accepted. */
  rowsKept: number;
  /** Kept rows with a readable geometry, less repeated ids. */
  features: number;
  /** Rows dropped because their id or geometry could not be read. */
  skipped: number;
  /** Bytes read for this type including file footers, from the network or the cache. */
  bytes: number;
  /** The part of `bytes` that came from the cache. */
  cachedBytes: number;
  /** Seconds from the start of the fetch until this type finished. */
  seconds: number;
}

export interface OvertureData {
  release: string;
  bounds: GeoBounds;
  /** Every type is present, empty when it was not requested. */
  features: Record<OvertureType, OvertureFeature[]>;
  /** Bytes read, from the network or the cache. */
  bytes: number;
  stats: Record<OvertureType, OvertureTypeStats>;
  /** Things the user should know about, e.g. a type the release did not have. Can be shown as they are. */
  warnings: string[];
}
