// How far a measured height may overrule the mapped one, from the add-on's
// lidar_source.py. A mapped podium height constrains that podium, never the
// tower above another part. Explicit heights of unknown provenance stay
// trusted; derived estimates and missing values can yield to a
// well-supported measurement.

import { difference, intersection, multiArea, union } from '../geometry/polygon';
import type { MultiPolygon } from '../types';
import { roofHeights, type LidarRecord } from './records';
import { convexArea } from './shapes';
import { heightConflict, topHeight } from './selection';

export type Props = Record<string, unknown>;

function positive(value: unknown): number {
  if (typeof value === 'boolean') return 0;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Every source property the measurement reads, here and in features.ts,
// selection.ts and prepare.ts. Prepared results and batch checkpoints are
// keyed by these, so one read anywhere new belongs here too, or a changed
// value reuses an answer made without it: a parent going from 10 m to 100 m
// kept the old decision.
const MEASURED = [
  'height',
  'num_floors',
  'building:levels',
  'min_height',
  'min_floor',
  'is_underground',
  'has_parts',
  'roof_shape',
  'building_id',
  // Which heights are estimates (Microsoft ML, earlier LiDAR).
  'sources',
  'start_date',
  'building:start_date',
  'construction_date',
  'year_built',
  'lidar_surface_kind',
  'source_land_ids',
  'covered_buildings',
] as const;

/** The measurement's inputs from a feature's properties, for cache keys. */
export function measuredProps(props: Props): unknown[] {
  return MEASURED.map((key) => props[key] ?? null);
}

export function heightMetres(props: Props): number {
  const value = props.height;
  if (typeof value === 'string') {
    let match = /^\s*(\d+(?:\.\d+)?)\s*(m|metres|meters|ft|feet)\s*$/.exec(value);
    if (match) return Number(match[1]) * (match[2] === 'ft' || match[2] === 'feet' ? 0.3048 : 1);
    match = /^\s*(\d+)'\s*(\d+(?:\.\d+)?)?"?\s*$/.exec(value);
    if (match) return Number(match[1]) * 0.3048 + Number(match[2] ?? 0) * 0.0254;
  }
  return positive(value);
}

export function floorCount(props: Props): number {
  return positive(props.num_floors ?? props['building:levels']);
}

export function sourceTopHint(props: Props): number {
  return heightMetres(props) || floorCount(props) * 3;
}

/** A height Overture filled from machine-learned or earlier LiDAR estimates. */
export function estimatedHeight(props: Props): boolean {
  const sources = Array.isArray(props.sources) ? props.sources : [];
  const relevant = sources.filter(
    (s): s is Record<string, unknown> => typeof s === 'object' && s !== null && (s as Record<string, unknown>).property === '/properties/height',
  );
  return relevant.length > 0 && relevant.every((s) => s.dataset === 'Microsoft ML Buildings' || s.dataset === 'USGS Lidar');
}

export function strongMeasurement(record: Partial<LidarRecord>): boolean {
  return (
    (record.coverage ?? 0) >= 0.9 &&
    (record.explainedFraction ?? 0) >= 0.8 &&
    (record.roofSupportDensityM2 ?? 0) >= 1 &&
    ['flat_regions', 'roof_planes', 'supported_roof_height', 'faceted_roof', 'height_only'].includes(record.method ?? '')
  );
}

/**
 * A rejection reason, or permission to use the measured height. Large
 * disagreements with credible explicit heights or floor counts keep the
 * source in either direction, which protects a new short building from
 * stale tall LiDAR even when no construction date is mapped.
 */
export function heightDecision(props: Props, observed: number, strong: boolean, corroborated = false): string {
  const height = heightMetres(props);
  const floors = floorCount(props);
  const derived = estimatedHeight(props);
  const conflict = height > 0 && heightConflict(height, observed);
  if (height && !derived && !conflict) return 'measured_height';
  // Floor counts are a broad sanity range, not a second height estimate.
  const floorConflict = floors > 0 && (observed < floors * 2 - 10 || observed > floors * 5 + 15);
  if (floorConflict) return 'source_height_conflict';
  if (conflict) {
    const internallyWrong = floors > 0 && (height < floors * 2 - 10 || height > floors * 5 + 15);
    if (!(derived || internallyWrong)) return 'source_height_conflict';
    const supported = strong || (derived && (corroborated || internallyWrong));
    return supported ? 'corrected_estimated_height' : 'weak_height_correction';
  }
  return 'measured_height';
}

/** A robust top within a mapped part: narrow spill from a neighbouring roof cannot veto a podium. */
export function regionalTop(record: LidarRecord, geometry: MultiPolygon, footprint: MultiPolygon): number | null {
  let remaining = intersection(geometry, footprint);
  const size = multiArea(remaining);
  if (size <= 0) return null;
  const parts: [number, number][] = [];
  for (const tier of [...record.tiers].reverse()) {
    const overlap = intersection(remaining, tier.geometry);
    if (!overlap.length) continue;
    parts.push([tier.topM, multiArea(overlap)]);
    remaining = difference(remaining, overlap);
  }
  for (const surface of record.roofSurfaces ?? []) {
    const shape: MultiPolygon = [surface.rings.map((ring) => ring.map(([x, y]) => [x, y] as [number, number]))];
    const overlap = intersection(remaining, shape);
    if (!overlap.length) continue;
    parts.push([Math.max(...surface.rings.flat().map((v) => v[2])), multiArea(overlap)]);
    remaining = difference(remaining, overlap);
  }
  let left = multiArea(remaining);
  if (record.cap) {
    // The envelope's faces are disjoint, so each one's share of the part is
    // a convex clip, not a subtraction per face (seconds on a large building).
    const v = record.cap.vertices;
    const f = record.cap.triangles;
    for (let t = 0; t < f.length; t += 3) {
      const [a, b, c] = [3 * f[t], 3 * f[t + 1], 3 * f[t + 2]];
      const share = convexArea(remaining, [
        [v[a], v[a + 1]],
        [v[b], v[b + 1]],
        [v[c], v[c + 1]],
      ]);
      if (share <= 0) continue;
      parts.push([Math.max(v[a + 2], v[b + 2], v[c + 2]), share]);
      left -= share;
    }
  }
  parts.push([record.heightM, Math.max(0, left)]);
  let covered = 0;
  for (const [height, a] of parts.sort((p, q) => p[0] - q[0] || p[1] - q[1])) {
    covered += a;
    if (covered >= size * 0.9) return height;
  }
  return topHeight(record);
}

export interface SourcePart {
  id: string;
  props: Props;
  geometry: MultiPolygon;
}

/** Validate a complete measured envelope against the mapped parts' heights. */
export function checkSource(featureProps: Props, parts: SourcePart[], record: LidarRecord, footprint: MultiPolygon): string {
  const observedTop = topHeight(record);
  let corroborated = false;
  const mapped = parts.map((part) => ({ part, top: sourceTopHint(part.props) }));
  for (const { part, top } of mapped) {
    // A low podium can extend underneath mapped upper floors: only its exposed roof counts.
    const upper = mapped.filter((m) => m.part !== part && (!m.top || m.top > top + 2)).map((m) => m.part.geometry);
    const exposed = upper.length ? difference(part.geometry, union(...upper)) : part.geometry;
    const observed = regionalTop(record, exposed, footprint);
    if (observed === null) continue;
    const check = heightDecision(part.props, observed, strongMeasurement(record));
    if (check === 'source_height_conflict' || check === 'weak_height_correction') return check;
    const explicit = heightMetres(part.props);
    if (
      explicit &&
      !estimatedHeight(part.props) &&
      Math.abs(explicit - observedTop) <= Math.max(10, observedTop * 0.1) &&
      multiArea(intersection(exposed, footprint)) >= multiArea(footprint) * 0.03
    ) {
      corroborated = true;
    }
  }
  return heightDecision(featureProps, observedTop, strongMeasurement(record), corroborated);
}

export { roofHeights };
