// What a measurement produces for one building. During measurement the
// geometry is in the local metric frame; `publish` turns it into lon/lat,
// which is what the cache keeps and generation reads, so a record does not
// depend on the area's centre or rotation.

import type { Tin } from '../geometry/tinclip';
import type { MultiPolygon } from '../types';

// Bump when a change to measurement would give different records, so cached
// ones are measured again. The add-on's records were algorithm 29.
export const ALGORITHM_VERSION = 6;

export type Method = 'faceted_roof' | 'roof_planes' | 'flat_regions' | 'height_only' | 'roof_p90' | 'supported_roof_height' | 'source_parts';

export interface Tier {
  bottomM: number;
  topM: number;
  geometry: MultiPolygon;
}

/** A planar roof polygon: rings of [x, y, z]. */
export interface RoofSurface {
  rings: [number, number, number][][];
  bottomM: number;
}

export interface LidarRecord {
  method: Method;
  /** Height above ground of the base the roof stands on (the lowest cap height for an envelope). */
  heightM: number;
  tiers: Tier[];
  groundM?: number;
  roofPoints?: number;
  coverage?: number;
  cellM?: number;
  classifiedFraction?: number;
  roofSupportDensityM2?: number;
  explainedFraction?: number;
  coverageBasis?: 'footprint_area';
  coverageGridOffset?: [number, number];
  facetedFallback?: string;
  partBoundariesUsed?: number;
  measuredTierBoundaries?: number;
  supportedBaseM?: number;
  /** Planar roof polygons (roof planes). */
  roofSurfaces?: RoofSurface[];
  /** The roof envelope: one TIN tiling the footprint, z above ground. */
  cap?: Tin;
  surfaceReconstruction?: 'roof_envelope';
  roofFitP95M?: number;
  roofFitP90M?: number;
  surfaceDiagnostics?: Record<string, number | string>;
  /** Height-only mode: corrected top per source identity. */
  sourceHeights?: Record<string, number>;
  /** Source-parts mode: corrected part heights. */
  partHeights?: Record<string, number>;
  infillGeometry?: MultiPolygon;
  partsSkipped?: Record<string, string>;
  heightDecision?: string;
  sourceHeightDecision?: string;
  /** Where the ground was measured when no plane fitted: x, y and height above it. */
  groundAnchor?: [number, number, number];
  groundReference?: 'surrounding_ground_anchor';
  surfaceKind?: 'rock';
  surfaceGeometry?: MultiPolygon;
  sourceLandIds?: string[];
  coveredBuildings?: string[];
  captureYear?: number | null;
  dateBasis?: string;
  sourceDateConflict?: boolean;
  // Survey the record came from.
  source?: string;
  sourceUrl?: string;
  sourceFormat?: string;
  classifiedRoofFraction?: number;
  projectYearHint?: number | null;
  selection?: Record<string, unknown>;
}

/** Everything measured with roof geometry of its own. */
export function hasRoofSurface(record: LidarRecord): boolean {
  return Boolean(record.roofSurfaces?.length || record.cap);
}

/** Heights of every roof corner, whichever geometry the record carries. */
export function roofHeights(record: LidarRecord): number[] {
  const out: number[] = [];
  if (record.cap) for (let k = 2; k < record.cap.vertices.length; k += 3) out.push(record.cap.vertices[k]);
  for (const surface of record.roofSurfaces ?? []) for (const ring of surface.rings) for (const v of ring) out.push(v[2]);
  return out;
}
