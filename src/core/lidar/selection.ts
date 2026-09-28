// Choosing one complete survey measurement per building, from the add-on's
// lidar_selection.py. Dates describe observations, never map edit
// timestamps, and nothing is averaged between surveys.

import { difference, intersection, multiArea } from '../geometry/polygon';
import type { MultiPolygon } from '../types';
import { hasRoofSurface, roofHeights, type LidarRecord } from './records';

export const CONTRADICTIONS = new Set([
  'source_height_conflict',
  'footprint_roof_mismatch',
  'roof_extends_outside_footprint',
  'observed_ground_in_footprint',
  'predates_building',
  'mixed_capture_epochs',
]);

/** A year in a survey's name: a hint, never a capture date. */
export function projectYear(name: string | undefined): number | null {
  const match = /(?<!\d)((?:19|20)\d{2})(?!\d)/.exec(name ?? '');
  return match ? Number(match[1]) : null;
}

/** Only explicit construction dates, not source update times. */
export function constructionYear(props: Record<string, unknown>): number | null {
  for (const key of ['start_date', 'building:start_date', 'construction_date', 'year_built']) {
    const value = props[key];
    if (value === null || value === undefined || typeof value === 'boolean') continue;
    const match = /^((?:19|20)\d{2})(?:-\d{2}(?:-\d{2})?)?$/.exec(String(value).trim());
    if (match) return Number(match[1]);
  }
  return null;
}

export function topHeight(record: LidarRecord): number {
  let top = record.heightM;
  for (const tier of record.tiers) top = Math.max(top, tier.topM);
  for (const h of Object.values(record.partHeights ?? {})) top = Math.max(top, h);
  for (const h of roofHeights(record)) top = Math.max(top, h);
  return top;
}

export function heightConflict(a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo > 0 && hi - lo > 20 && lo < hi * 0.65;
}

function regions(record: LidarRecord, footprint: MultiPolygon): [MultiPolygon, number][] {
  const shapes = [footprint, ...record.tiers.map((t) => intersection(t.geometry, footprint))];
  const heights = [record.heightM, ...record.tiers.map((t) => t.topM)];
  return shapes.map((p, i) => [i + 1 < shapes.length ? difference(p, shapes[i + 1]) : p, heights[i]]);
}

export function profilesConflict(a: LidarRecord, b: LidarRecord, footprint?: MultiPolygon): boolean {
  if (heightConflict(topHeight(a), topHeight(b))) return true;
  if (a.method === 'source_parts' || b.method === 'source_parts') {
    // Different reconstruction modes cannot show the same complete building.
    if (a.method !== b.method) return true;
    for (const key of Object.keys(a.partHeights ?? {})) {
      const other = b.partHeights?.[key];
      if (other !== undefined && heightConflict(a.partHeights![key], other)) return true;
    }
  }
  if (!footprint || hasRoofSurface(a) || hasRoofSurface(b)) return false;
  const threshold = Math.max(5, Math.max(topHeight(a), topHeight(b)) * 0.15);
  let disagreement = 0;
  for (const [p, h] of regions(a, footprint)) {
    for (const [q, k] of regions(b, footprint)) if (Math.abs(h - k) > threshold) disagreement += multiArea(intersection(p, q));
  }
  return disagreement > multiArea(footprint) * 0.2;
}

/** Python string order: by code point, not locale. */
function codePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function quality(record: LidarRecord): number {
  const coverage = Math.max(0, Math.min(1, record.coverage ?? 0));
  const explained = Math.max(0, Math.min(1, record.explainedFraction ?? coverage));
  const density = Math.max(0, record.roofSupportDensityM2 ?? 0);
  // Saturating density keeps facade-heavy scans from dominating.
  const support = Math.min(1, Math.log2(1 + density) / Math.log2(5));
  return 0.6 * coverage + 0.25 * explained + 0.15 * support;
}

export interface Observation {
  reason: string;
  source?: string;
  captureYear?: number | null;
}

export interface SelectionAudit {
  reason: string;
  candidates: number;
  source?: string;
  sourceUrl?: string;
  captureYear?: number | null;
  quality?: number;
  score?: number;
  ignoredConflicts?: Record<string, unknown>[];
}

/** One usable survey for a building, or the conflict that rules them out. */
export function chooseMeasurement(
  candidates: LidarRecord[],
  observations: Observation[] = [],
  footprint?: MultiPolygon,
  preferLidar = false,
): { record: LidarRecord | null; audit: SelectionAudit } {
  if (!candidates.length) return { record: null, audit: { reason: 'no_compatible_measurement', candidates: 0 } };
  const known = candidates.map((r) => r.captureYear).filter((y): y is number => !!y);
  const newest = known.length ? Math.max(...known) : 0;
  const score = (record: LidarRecord) => {
    const year = record.captureYear;
    const age = year && newest ? Math.min(8, newest - year) : 0;
    // Quality first; among comparable observations prefer recent capture.
    const recency = year ? 0.12 - age * 0.015 : 0;
    return quality(record) + recency;
  };
  const ordered = [...candidates].sort(
    (a, b) =>
      score(b) - score(a) ||
      quality(b) - quality(a) ||
      (b.classifiedRoofFraction ?? 0) - (a.classifiedRoofFraction ?? 0) ||
      codePoints(a.source ?? '', b.source ?? '') ||
      codePoints(a.sourceUrl ?? '', b.sourceUrl ?? ''),
  );
  const selected = ordered[0];
  const year = selected.captureYear;
  const conflicts: Record<string, unknown>[] = [];
  for (const observation of observations) {
    const newer = observation.captureYear;
    if (CONTRADICTIONS.has(observation.reason) && (!newer || !year || newer >= year)) {
      const conflict = { reason: 'newer_or_same_age_conflict', source: observation.source ?? '', captureYear: newer, conflict: observation.reason };
      if (!preferLidar) return { record: null, audit: { ...conflict, candidates: candidates.length } };
      conflicts.push(conflict);
    }
  }
  // Two materially different buildings with no clear chronology: pick neither.
  for (const other of ordered.slice(1)) {
    if (!profilesConflict(selected, other, footprint)) continue;
    const otherYear = other.captureYear;
    const reason =
      !year || !otherYear || year === otherYear ? 'conflicting_surveys_unknown_order' : otherYear > year ? 'newer_survey_building_changed' : null;
    if (!reason) continue;
    const conflict = { reason, source: other.source ?? '' };
    if (!preferLidar) return { record: null, audit: { ...conflict, candidates: candidates.length } };
    conflicts.push(conflict);
  }
  return {
    record: selected,
    audit: {
      reason: preferLidar ? 'best_usable_survey' : 'best_compatible_survey',
      candidates: candidates.length,
      source: selected.source ?? '',
      sourceUrl: selected.sourceUrl ?? '',
      captureYear: year,
      quality: Math.round(quality(selected) * 1e4) / 1e4,
      score: Math.round(score(selected) * 1e4) / 1e4,
      ignoredConflicts: conflicts,
    },
  };
}

/**
 * Capture years from GPS time. Adjusted standard GPS time (encoding bit set)
 * gives an absolute date; GPS week time does not. The USGS EPT mirror drops
 * the encoding bit, so there values outside one week that decode to plausible
 * dates are taken as inferred. Year precision only.
 */
export function gpsCaptureYears(values: ArrayLike<number>, adjusted: boolean, knownEpt = false, now = new Date()): { years: Uint16Array; basis: string } {
  const years = new Uint16Array(values.length);
  let basis = 'unknown';
  if (adjusted) basis = 'gps_declared';
  else if (knownEpt) basis = 'gps_inferred_ept';
  else return { years, basis };
  const thisYear = now.getUTCFullYear();
  const gpsEpoch = Date.UTC(1980, 0, 6);
  let any = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || v === 0) continue;
    if (!adjusted && !(v < 0 || v > 604800)) continue;
    const seconds = v + 1e9;
    if (seconds < 315964800 || seconds >= (thisYear - 1979) * 366 * 86400) continue;
    const year = new Date(gpsEpoch + Math.floor(seconds) * 1000).getUTCFullYear();
    if (year >= 1990 && year <= thisYear) {
      years[i] = year;
      any = true;
    }
  }
  return { years, basis: any ? basis : 'unknown' };
}
