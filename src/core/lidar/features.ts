// Measuring whole buildings from one survey's points: source-part
// supplements, capture-epoch checks and the source-height decision. Ported
// from the add-on's lidar_measurements.py (measure_source_parts,
// _reconstruct, measure_features).

import { difference, intersection, multiArea, union } from '../geometry/polygon';
import type { MultiPolygon } from '../types';
import { observedEmptyArea, measureBuilding, type Outcome, type RoofMode } from './measure';
import { groundReference } from './ground';
import { PointIndex, take, type Points } from './points';
import type { LidarRecord } from './records';
import { measureRockSurface } from './rock';
import { constructionYear, topHeight } from './selection';
import { area, bounds, buffer, Inside } from './shapes';
import { checkSource, estimatedHeight, heightDecision, heightMetres, regionalTop, strongMeasurement, type Props, type SourcePart } from './source';
import type { Observation } from './selection';
import { BatchSurface, type SurfaceSettings } from './surface';

export interface MetricFeature {
  id: string;
  props: Props;
  /** Footprint in the measurement frame. */
  geometry: MultiPolygon;
}

/**
 * Supplement an incomplete mapped assembly and keep its architecture: only
 * existing part identities get height corrections, and the missing main
 * mass is the footprint minus the mapped parts, courtyards included. Every
 * component shares one survey ground.
 */
export function measureSourceParts(
  feature: MetricFeature,
  parts: SourcePart[],
  index: PointIndex,
  minWidthM: number,
  minStepM: number,
  roofPlanes: boolean,
  preferLidar: boolean,
): Outcome {
  const footprint = feature.geometry;
  const ground = groundReference(footprint, index);
  if (ground === null) return { record: null, reason: 'insufficient_ground' };
  const [x0, y0, x1, y1] = bounds(footprint);
  if (observedEmptyArea(footprint, take(index.points, index.queryIndices(x0, y0, x1, y1)), ground)) {
    return { record: null, reason: 'observed_ground_in_footprint' };
  }
  const remainder = difference(footprint, union(...parts.map((p) => p.geometry)));
  const needsInfill = area(remainder) >= Math.max(minWidthM ** 2, area(footprint) * 0.15);
  let infill: LidarRecord | null = null;
  const corrections: Record<string, number> = {};
  const evidence: LidarRecord[] = [];
  const skipped: Record<string, string> = {};
  if (needsInfill) {
    const measured = measureBuilding(remainder, index, minWidthM, minStepM, {
      groundM: ground,
      neighbours: [footprint],
      allowComplexHeight: true,
      roofPlanes,
    });
    if (!measured.record) return { record: null, reason: measured.reason };
    infill = measured.record;
    // A complex main roof can still give a well-supported base level; do not
    // inflate the whole missing mass to its rooftop clutter.
    if (infill.supportedBaseM !== undefined) infill.heightM = infill.supportedBaseM;
    evidence.push(infill);
  }
  for (const part of parts) {
    const props = part.props;
    if (area(part.geometry) < minWidthM ** 2 || props.min_height || props.min_floor) {
      skipped[part.id] = 'small_or_elevated_part';
      continue;
    }
    // Only this part's scalar height is used; a few metres of roof keep a
    // shaped crown from fragmenting into noisy plateaus.
    const clipped = intersection(part.geometry, footprint);
    const measured = measureBuilding(clipped, index, Math.max(minWidthM, 6), Math.max(minStepM, 2), {
      groundM: ground,
      neighbours: [footprint],
      allowComplexHeight: true,
      roofPlanes,
    });
    const record = measured.record;
    if (!record) {
      skipped[part.id] = measured.reason;
      continue;
    }
    let observed = topHeight(record);
    // One height must describe this part, not a spill from a neighbouring roof.
    const interior = buffer(clipped, -Math.max(2, record.cellM ?? 0));
    if (area(interior) >= area(part.geometry) * 0.25) observed = regionalTop(record, interior, footprint) ?? observed;
    const decision = heightDecision(props, observed, strongMeasurement(record));
    if (decision === 'source_height_conflict' && !preferLidar) return { record: null, reason: decision };
    if (decision === 'weak_height_correction' && !preferLidar) {
      skipped[part.id] = decision;
      continue;
    }
    // Good explicit tops stay; missing, floor-derived and estimated ones can improve.
    if (preferLidar || !heightMetres(props) || estimatedHeight(props) || decision === 'corrected_estimated_height') {
      corrections[part.id] = observed;
      evidence.push(record);
    }
  }
  if (!evidence.length) return { record: null, reason: 'no_source_part_improvement' };
  const base = infill ?? evidence.reduce((best, r) => (topHeight(r) > topHeight(best) ? r : best));
  const result: LidarRecord = { ...base, method: 'source_parts', partHeights: corrections, partsSkipped: skipped };
  if (infill) result.infillGeometry = remainder;
  else {
    result.heightM = Math.max(...Object.values(corrections));
    result.tiers = [];
    delete result.roofSurfaces;
    delete result.cap;
    delete result.surfaceReconstruction;
  }
  const observedTop = Math.max(topHeight(result), ...parts.map((p) => heightMetres(p.props)));
  const decision = heightDecision(feature.props, observedTop, evidence.every(strongMeasurement));
  if ((decision === 'source_height_conflict' || decision === 'weak_height_correction') && !preferLidar) return { record: null, reason: decision };
  result.heightDecision = preferLidar ? 'lidar_preferred' : decision;
  result.sourceHeightDecision = decision;
  return { record: result, reason: 'source_parts' };
}

export interface ReconstructOptions {
  minWidthM: number;
  minStepM: number;
  roofPlanes: boolean;
  roofMode: RoofMode;
  surfaceScale?: [number, number];
  preferLidar: boolean;
  /** Where measured roofs come from: the batch's surface, null when it has none. */
  surface?: BatchSurface | null;
}

const SUPPLEMENT_REASONS = new Set([
  'tiers',
  'height_only',
  'roof_planes',
  'faceted_roof',
  'complex_unclassified_roof',
  'unclassified_nonplanar_roof',
  'unresolved_upper_roof',
  'unprintable_major_tier',
]);

/** One building's measurement from its own cropped points. */
export function reconstruct(
  feature: MetricFeature,
  local: Points,
  early: string | null,
  options: ReconstructOptions,
  partFootprints: MultiPolygon[],
  neighbours: MultiPolygon[],
  sourceParts: SourcePart[],
): { record: LidarRecord | null; reason: string; decision: string | null } {
  const props = feature.props;
  const footprint = feature.geometry;
  let record: LidarRecord | null = null;
  let reason = early;
  const index = early === null ? new PointIndex(local) : null;
  if (index && props.lidar_surface_kind === 'rock') {
    ({ record, reason } = measureRockSurface(footprint, index, options.surfaceScale, options.surface));
  } else if (index) {
    ({ record, reason } = measureBuilding(footprint, index, options.minWidthM, options.minStepM, {
      roofPlanes: options.roofPlanes,
      roofMode: options.roofMode,
      surfaceScale: options.surfaceScale,
      partFootprints,
      neighbours,
      heightTargets: options.roofMode === 'HEIGHT_ONLY' ? { feature: { id: feature.id, props }, parts: sourceParts } : undefined,
      preferLidar: options.preferLidar,
      surface: options.surface,
    }));
  }
  // Source-shaped roofs stay useful when a whole-envelope fit is too
  // complex. Footprint and epoch contradictions never get here.
  if (index && options.roofMode !== 'HEIGHT_ONLY' && sourceParts.length && props.has_parts === true && SUPPLEMENT_REASONS.has(reason ?? '')) {
    const shaped = sourceParts.some((p) => ![undefined, null, '', 'flat'].includes(p.props.roof_shape as string));
    const incomplete = multiArea(intersection(union(...sourceParts.map((p) => p.geometry)), footprint)) < area(footprint) * 0.85;
    if ((incomplete || shaped) && (!options.preferLidar || !record)) {
      const supplement = measureSourceParts(feature, sourceParts, index, options.minWidthM, options.minStepM, options.roofPlanes, options.preferLidar);
      if (supplement.record || supplement.reason === 'source_height_conflict') ({ record, reason } = supplement);
    }
  }
  let decision: string | null = null;
  if (record && record.method !== 'height_only' && record.method !== 'source_parts') decision = checkSource(props, sourceParts, record, footprint);
  return { record, reason: reason ?? 'unknown', decision };
}

export interface BatchContext extends ReconstructOptions {
  /** Where this batch's points reach: a building's 25 m halo must lie inside. */
  roi: MultiPolygon;
  partsByParent: Map<string, MultiPolygon[]>;
  sourcePartsByParent: Map<string, SourcePart[]>;
  neighboursById: Map<string, MultiPolygon[]>;
  /** The cells measured roofs are cut from. Without them, each building's own returns make its surface. */
  surfaceSettings?: SurfaceSettings;
  onProgress?: (done: number, total: number, name: string) => void | Promise<void>;
}

export interface BatchResult {
  records: Map<string, LidarRecord>;
  counts: Record<string, number>;
  rejected: Map<string, string>;
  observations: Map<string, Observation & { dateBasis: string }>;
}

/**
 * One survey's points against a batch of buildings. Each building sees only
 * the returns within 25 m of it, and a building whose returns come from
 * different capture years is not reconstructed from them.
 */
export async function measureFeatures(features: MetricFeature[], points: Points, ctx: BatchContext): Promise<BatchResult> {
  const index = new PointIndex(points);
  // One surface for the batch, so overlapping halos aren't composed twice.
  const options: ReconstructOptions = { ...ctx };
  if (ctx.roofMode === 'FACETED' && ctx.surfaceSettings) options.surface = BatchSurface.build(points, bounds(ctx.roi), ctx.surfaceSettings);
  const result: BatchResult = { records: new Map(), counts: {}, rejected: new Map(), observations: new Map() };
  const count = (reason: string) => (result.counts[reason] = (result.counts[reason] ?? 0) + 1);
  for (let position = 0; position < features.length; position++) {
    const feature = features[position];
    const props = feature.props;
    const names = props.names as { primary?: string } | undefined;
    await ctx.onProgress?.(position, features.length, names?.primary ?? feature.id);
    const halo = buffer(feature.geometry, 25);
    // Lowering a whole building from a clipped corner of its roof is worse than no measurement.
    if (!coveredBy(halo, ctx.roi)) {
      count('incomplete_footprint_or_ground_halo');
      result.rejected.set(feature.id, 'incomplete_footprint_or_ground_halo');
      continue;
    }
    if (props.is_underground || props.min_height || props.min_floor) {
      count('elevated_or_underground');
      result.rejected.set(feature.id, 'elevated_or_underground');
      continue;
    }
    const [x0, y0, x1, y1] = bounds(halo);
    const inHalo = new Inside(halo);
    const keep: number[] = [];
    for (const i of index.queryIndices(x0, y0, x1, y1)) if (inHalo.has(points.x[i], points.y[i])) keep.push(i);
    let local = take(points, keep);
    let dated: { captureYear: number | null; dateBasis: string } = { captureYear: null, dateBasis: 'unknown' };
    let early: string | null = null;
    let known = 0;
    let allDeclared = true;
    let allReported = true;
    const years = new Map<number, number>();
    for (let i = 0; i < local.count; i++) {
      const year = local.year[i];
      if (!year) continue;
      known++;
      years.set(year, (years.get(year) ?? 0) + 1);
      if (local.confidence[i] !== 1) allDeclared = false;
      if (Math.abs(local.confidence[i] - 0.75) > 1e-6) allReported = false;
    }
    if (known) {
      const significant = [...years].filter(([, n]) => n >= Math.max(20, local.count * 0.1)).map(([y]) => y);
      dated = {
        captureYear: Math.max(...years.keys()),
        dateBasis: allDeclared ? 'gps_declared' : allReported ? 'reported_acquisition' : 'gps_inferred_ept',
      };
      // Never reconstruct a roof from different annual capture epochs.
      if (known < local.count * 0.9 || significant.length !== 1) early = 'mixed_capture_epochs';
      else {
        dated.captureYear = significant[0];
        const epoch: number[] = [];
        for (let i = 0; i < local.count; i++) if (local.year[i] === significant[0]) epoch.push(i);
        local = take(local, epoch);
      }
    }
    const built = constructionYear(props);
    const predates = Boolean(built && dated.captureYear && dated.captureYear < built);
    if (predates && !ctx.preferLidar) early = 'predates_building';
    const { record, reason, decision: checked } = reconstruct(
      feature,
      local,
      early,
      options,
      ctx.partsByParent.get(feature.id) ?? [],
      ctx.neighboursById.get(feature.id) ?? [],
      ctx.sourcePartsByParent.get(feature.id) ?? [],
    );
    let measured = record;
    let why = reason;
    if (measured) {
      const decision = measured.method === 'height_only' ? 'measured_height' : measured.method === 'source_parts' ? measured.heightDecision ?? null : checked;
      if ((decision === 'source_height_conflict' || decision === 'weak_height_correction') && !ctx.preferLidar) {
        measured = null;
        why = decision;
      } else {
        measured.sourceHeightDecision ??= decision ?? undefined;
        measured.heightDecision = ctx.preferLidar ? 'lidar_preferred' : decision ?? undefined;
        if (predates) measured.sourceDateConflict = true;
      }
    }
    result.observations.set(feature.id, { ...dated, reason: why });
    count(why);
    if (measured) {
      measured.captureYear = dated.captureYear;
      measured.dateBasis = dated.dateBasis;
      result.records.set(feature.id, measured);
    } else result.rejected.set(feature.id, why);
  }
  await ctx.onProgress?.(features.length, features.length, '');
  return result;
}

/** Whether `inner` lies inside `outer` (Shapely's covers), up to the booleans' 0.1 mm grid. */
function coveredBy(inner: MultiPolygon, outer: MultiPolygon): boolean {
  return multiArea(difference(inner, outer)) <= 1e-6;
}
