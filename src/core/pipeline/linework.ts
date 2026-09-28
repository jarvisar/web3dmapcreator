// Overture scopes transportation properties to parts of a segment with
// `between: [start, end]` positions. Each centerline is split at the union of
// every rule boundary before width, flags or level are read, otherwise a
// partial bridge or a partial width change is silently lost.

import type { Vec2 } from '../types';
import { num, positive, str } from './source';

// Edge-to-edge carriageway estimates in metres for classes without
// width_rules, chosen to read correctly at miniature scale.
export const DEFAULT_ROAD_WIDTH_M: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 11, secondary: 9.5, tertiary: 8, residential: 6.5,
  living_street: 5.5, unclassified: 6, service: 4.5, pedestrian: 4, footway: 2, sidewalk: 2,
  crosswalk: 2.5, steps: 1.6, path: 1.5, track: 3, cycleway: 2, bridleway: 2, driveway: 3,
  parking_aisle: 3.5, alley: 3.5, unknown: 5,
};
export const FALLBACK_ROAD_WIDTH_M = 5;
export const RAIL_CLASS = 'rail';
export const RAIL_WIDTH_M = 4;

// Roads flag bridges and tunnels in road_flags. Rail carries the same in rail_flags.
const FLAG_FIELDS = ['road_flags', 'rail_flags'];
const RULE_FIELDS = [...FLAG_FIELDS, 'width_rules', 'level_rules', 'subclass_rules'];

// The pavement beside a street and the crossings at each corner. On a
// miniature they triple the ribbons along every street.
export const SIDEPATH_SUBCLASSES = new Set(['sidewalk', 'crosswalk', 'cycle_crossing']);

export const MINOR_ROAD_CLASSES = new Set(['footway', 'sidewalk', 'crosswalk', 'steps', 'path', 'track', 'cycleway', 'bridleway']);

export interface SubSegment {
  sourceId: string;
  points: Vec2[];
  roadClass: string;
  subclass: string;
  widthM: number;
  flags: Set<string>;
  level: number;
}

type Rule = Record<string, unknown>;

function rules(value: unknown): Rule[] {
  return Array.isArray(value) ? (value.filter((r) => r && typeof r === 'object') as Rule[]) : [];
}

function between(rule: Rule): [number, number] {
  const span = rule.between;
  if (!Array.isArray(span) || span.length !== 2) return [0, 1];
  const a = num(span[0]);
  const b = num(span[1]);
  if (a === null || b === null || b <= a) return [0, 1];
  return [Math.max(0, a), Math.min(1, b)];
}

function covers(rule: Rule, t: number): boolean {
  const [a, b] = between(rule);
  return a - 1e-9 <= t && t <= b + 1e-9;
}

function activeRule(value: unknown, t: number): Rule | null {
  for (const rule of rules(value)) if (covers(rule, t)) return rule;
  return null;
}

function boundaries(props: Record<string, unknown>): number[] {
  const set = new Set<number>([0, 1]);
  for (const field of RULE_FIELDS) {
    for (const rule of rules(props[field])) {
      if (rule.between === undefined || rule.between === null) continue;
      const [a, b] = between(rule);
      set.add(a);
      set.add(b);
    }
  }
  const ordered = [...set].filter((v) => v >= 0 && v <= 1).sort((a, b) => a - b);
  const out = [ordered[0]];
  for (const v of ordered.slice(1)) if (v - out[out.length - 1] > 1e-9) out.push(v);
  return out;
}

function cumulative(points: Vec2[]): number[] {
  const d = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    d.push(total);
  }
  return total > 0 ? d.map((v) => v / total) : d.map(() => 0);
}

function interpolate(points: Vec2[], positions: number[], t: number): Vec2 {
  if (t <= positions[0]) return points[0];
  if (t >= positions[positions.length - 1]) return points[points.length - 1];
  for (let i = 0; i < positions.length - 1; i++) {
    const a = positions[i];
    const b = positions[i + 1];
    if (a <= t && t <= b) {
      const f = b > a ? (t - a) / (b - a) : 0;
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * f, points[i][1] + (points[i + 1][1] - points[i][1]) * f];
    }
  }
  return points[points.length - 1];
}

export function slicePolyline(points: Vec2[], t0: number, t1: number): Vec2[] {
  if (points.length < 2 || t1 <= t0) return [];
  const positions = cumulative(points);
  const out: Vec2[] = [interpolate(points, positions, t0)];
  for (let i = 0; i < points.length; i++) if (t0 < positions[i] && positions[i] < t1) out.push(points[i]);
  out.push(interpolate(points, positions, t1));
  return dedupe(out);
}

export function dedupe(points: Vec2[], tolerance = 1e-9): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > tolerance) out.push(p);
  }
  return out;
}

export function polylineLength(points: Vec2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return length;
}

/** Explicit width rule first, then the class default, in metres. */
function resolveWidth(props: Record<string, unknown>, t: number, roadClass: string, defaults: Record<string, number>): number {
  const rule = activeRule(props.width_rules, t);
  const explicit = rule ? positive(rule.value) : null;
  if (explicit !== null) return explicit;
  return defaults[roadClass] ?? FALLBACK_ROAD_WIDTH_M;
}

function flagValues(props: Record<string, unknown>, t: number): Set<string> {
  const active = new Set<string>();
  for (const field of FLAG_FIELDS) {
    for (const rule of rules(props[field])) {
      if (!covers(rule, t)) continue;
      const values = rule.values;
      if (typeof values === 'string') active.add(values);
      else if (Array.isArray(values)) for (const v of values) if (typeof v === 'string') active.add(v);
    }
  }
  return active;
}

function resolveLevel(props: Record<string, unknown>, t: number): number {
  const rule = activeRule(props.level_rules, t);
  const value = rule ? num(rule.value) : null;
  return value === null ? 0 : Math.trunc(value);
}

/**
 * Split one centerline (in any planar units) at every scoped-rule boundary.
 * `roadClass` overrides the feature's own class. Rail uses it to batch every
 * track class together while still splitting at its rail_flags.
 */
export function splitSegment(
  sourceId: string,
  line: Vec2[],
  props: Record<string, unknown>,
  defaults: Record<string, number> = DEFAULT_ROAD_WIDTH_M,
  roadClass?: string,
): SubSegment[] {
  const points = dedupe(line);
  if (points.length < 2 || polylineLength(points) <= 0) return [];
  const cls = roadClass ?? (str(props.class) || 'unknown');
  const cuts = boundaries(props);
  const out: SubSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const t0 = cuts[i];
    const t1 = cuts[i + 1];
    const mid = (t0 + t1) / 2;
    const piece = cuts.length === 2 ? points : slicePolyline(points, t0, t1);
    if (piece.length < 2) continue;
    const subclassRule = activeRule(props.subclass_rules, mid);
    out.push({
      sourceId,
      points: piece,
      roadClass: cls,
      subclass: str(subclassRule?.value) || str(props.subclass),
      widthM: resolveWidth(props, mid, cls, defaults),
      flags: flagValues(props, mid),
      level: resolveLevel(props, mid),
    });
  }
  return out;
}

/** Whether any stretch of a segment is flagged a bridge. */
export function hasBridgeFlag(props: Record<string, unknown>): boolean {
  for (const field of FLAG_FIELDS) {
    for (const rule of rules(props[field])) {
      const values = rule.values;
      if (Array.isArray(values) && values.includes('is_bridge')) return true;
      if (values === 'is_bridge') return true;
    }
  }
  return false;
}
