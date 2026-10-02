// Which survey is read first, of those under an area. The add-on's order is
// newest first (metadata_order). Here an older survey can go ahead of a newer
// one when the newer one can't fill the model's grid cells and the older one
// fills clearly finer ones, which depends on the cell: at the default 0.71 m
// almost every modern survey is fine, at 0.25 m few are.
//
// How finely a survey fills the cells is worked out from its returns per m²
// near the area (read/density.ts), and measured on a block near the middle
// when the choice depends on it. Density alone misses holes: NOAA's 2025
// Bay-Delta survey has 18 returns per m² in San Francisco's Financial
// District and still left 7% of 0.71 m cells empty between the towers, where
// USGS's 2023 survey left 0.5%.

import type { Projection } from '../geo/projection';
import { MIN_CELL_M } from '../dsm/grid';
import { union } from '../geometry/polygon';
import type { SurveyPreference } from '../settings';
import type { GeoBounds, MultiPolygon, Polygon, Ring } from '../types';
import { staged, surveyYear } from './offers';
import { eptPresence, localDensity } from './read/density';
import type { Fetcher } from './read/fetcher';
import { shortHash } from './rock';
import { projectYear } from './selection';
import { bounds, contains, keepStart } from './shapes';
import type { Candidate } from './sources';
import type { SurveyRules } from './query';

export type { SurveyPreference, SurveyRules };

/** How finely a survey filled the grid on one block (occupiedCell). */
export interface SurveyProbe {
  /** The cell asked for, metres. */
  requested: number;
  /** The smallest cell from there it filled: `requested` when it filled that. */
  cell: number;
  /** Returns per m² on land there. */
  density: number;
}

export interface Ranked {
  candidate: Candidate;
  /** Where its outline reaches in the area, metres in the area's frame. */
  coverage: MultiPolygon;
  catalogCoverage: number;
  /** Share of the area its index has points in (eptPresence), where that was measured. */
  measuredCoverage?: number;
  /** Returns per m² near the area, from its index (localDensity). */
  localDensity?: number;
  probe?: SurveyProbe;
}

/** A stable short hash of any JSON-able value. */
export function digest(value: unknown): string {
  return shortHash(JSON.stringify(value));
}

/** Lon/lat polygons in a metric frame, unioned. */
export function toMetric(polygons: Polygon[], frame: Projection): MultiPolygon {
  const projected = polygons.map((polygon) => polygon.filter((ring) => ring.length >= 3).map((ring) => ring.map(([lon, lat]) => frame.toLocal(lon, lat))));
  const valid = projected.filter((p) => p.length);
  return keepStart(union(valid), valid);
}

/** Sutherland-Hodgman of lon/lat rings against a lon/lat box, before projecting huge catalog outlines. */
export function clipRingToBox(ring: Ring, [w, s, e, n]: [number, number, number, number]): Ring {
  let points = ring;
  const sides: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= w, (a, b) => [w, a[1] + ((w - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]],
    [(p) => p[0] <= e, (a, b) => [e, a[1] + ((e - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]],
    [(p) => p[1] >= s, (a, b) => [a[0] + ((s - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), s]],
    [(p) => p[1] <= n, (a, b) => [a[0] + ((n - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), n]],
  ];
  for (const [inside, cross] of sides) {
    const out: Ring = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length];
      const b = points[i];
      if (inside(a) !== inside(b)) out.push(cross(a, b));
      if (inside(b)) out.push(b);
    }
    points = out;
    if (!points.length) break;
  }
  return points;
}

const DAY_MS = 24 * 3600 * 1000;

export function acquisitionOrdinal(c: Candidate): number {
  const date = c.acquisitionStart ?? c.acquisitionEnd;
  if (date) return Date.parse(date) / DAY_MS;
  const hint = c.projectYearHint ?? projectYear(c.name);
  return hint ? Date.UTC(hint, 0, 1) / DAY_MS : 0;
}

/** Returns per m² near the area where its index told, else the catalog's average over the whole outline. */
export function surveyDensity(r: Ranked): number | null {
  return r.localDensity ?? r.candidate.densityM2 ?? null;
}

/** Share of the area a survey has points in, as far as its outline and index tell. Shown in the survey list. */
export function coverageShare(r: Ranked): number {
  return Math.min(r.catalogCoverage, r.measuredCoverage ?? 1);
}

// LiDAR only models read the surveys whose outlines cover the most of the
// area first, so blocks don't mix years: those within COVER_SLACK of the one
// that covers the most. Held to the whole area, downtown Miami's 2021 county
// survey (97%, its outline stops short of a corner of the bay) went behind
// every older one. Not by where their points are: an index can't tell water
// from land, and San Francisco's 2023 survey has none over the far side of
// the bay by the Ferry Building (85%), so a 2010 survey that does went first.
const COVER_SLACK = 0.05;

/** 0 for the surveys whose outlines cover about as much of the area as any does, else 1. */
export function coverTier(list: Ranked[]): (r: Ranked) => number {
  const best = Math.max(0, ...list.map((r) => r.catalogCoverage));
  return (r) => (r.catalogCoverage >= best - COVER_SLACK ? 0 : 1);
}

// The add-on's metadata_order: newest acquisition first, then coverage,
// resolution and classification, EPT before COPC before plain LAZ (read
// whole) on ties, the original publisher before a mirror.
export function rankOrder(a: Ranked, b: Ranked): number {
  const key = (r: Ranked) => {
    const density = surveyDensity(r);
    return [
      -acquisitionOrdinal(r.candidate),
      r.catalogCoverage < 0.98 ? 1 : 0,
      -(density ? density / (1 + density) : 0),
      -(r.candidate.classificationQuality ?? 0),
      -r.catalogCoverage,
      r.candidate.format === 'EPT' ? 0 : r.candidate.format === 'COPC' || r.candidate.format === 'I3S' ? 1 : 2,
      r.candidate.authoritative ? 0 : 1,
    ];
  };
  const [p, q] = [key(a), key(b)];
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] - q[i];
  return a.candidate.url < b.candidate.url ? -1 : a.candidate.url > b.candidate.url ? 1 : 0;
}

// Returns per cell for few empty cells. Probes found 3 to 5 for 3% empty
// (occupiedCell's limit), more for surveys flown in widely spaced lines.
const FILLED = 4;
// An older survey has to fill cells at least this much finer to go first,
// within `years`. Hierarchy densities are about 30% off, so less is noise:
// King County's 2016-17 survey (14 per m² downtown) against 2021's (11).
const DETAIL_GAIN = 1.25;
// Up to twice `years` older for cells half the size, a quarter of the
// detail. LiDAR only models used to take any survey that filled the cells
// over one that didn't, whatever its age. Without USGS's 2023 survey that
// would put a 2010 one (14 per m²) over NOAA's 2025 one in the Financial
// District, older than Salesforce Tower.
const FAR_GAIN = 2;
// The newest survey is only measured when one this much denser could take its place.
const RIVAL_DENSITY = 1.5;
const RIVALS_MEASURED = 2;

/**
 * The cell a survey fills from `cell` up, metres: measured where it was
 * probed, else from its density. Null when neither is known.
 */
export function effectiveCell(r: Ranked, cell: number): number | null {
  const probe = r.probe;
  if (probe) {
    if (probe.cell > probe.requested * 1.001) return Math.max(cell, probe.cell);
    if (cell >= probe.requested) return cell;
  }
  const density = probe?.density || surveyDensity(r);
  if (!density) return probe ? probe.requested : null;
  const estimate = Math.max(cell, Math.sqrt(FILLED / density));
  return probe ? Math.min(estimate, probe.requested) : estimate;
}

/** The cell compared for a preference: the model's, or the finest there is for the most detail. */
function comparedCell(rules: SurveyRules): number {
  return rules.preference === 'detail' ? MIN_CELL_M : rules.cellM;
}

// Two days' slack, so 2015 to 2022 (leap days and all) counts as seven years.
const within = (days: number, years: number) => days <= years * 365.25 + 2;

/** Whether `older` goes ahead of `newer`. Undated surveys never move. */
export function beats(older: Ranked, newer: Ranked, rules: SurveyRules): boolean {
  if (rules.preference === 'newest') return false;
  const [o, n] = [acquisitionOrdinal(older.candidate), acquisitionOrdinal(newer.candidate)];
  if (!o || !n || o >= n) return false;
  const cell = comparedCell(rules);
  const [eo, en] = [effectiveCell(older, cell), effectiveCell(newer, cell)];
  if (eo === null || en === null) return false;
  const gain = en / eo;
  if (rules.preference === 'detail') return gain >= DETAIL_GAIN;
  return (gain >= DETAIL_GAIN && within(n - o, rules.years)) || (gain >= FAR_GAIN && within(n - o, 2 * rules.years));
}

/**
 * Surveys best first: by `compare`, then each one moved up past the newer
 * surveys it beats, within `group`. `beats` isn't transitive (three surveys
 * can beat each other in a circle), so it's a pass that stops at the first
 * survey one doesn't beat, not a sort comparator.
 */
export function rankSurveys(list: Ranked[], rules: SurveyRules, compare: (a: Ranked, b: Ranked) => number = rankOrder, group: (a: Ranked, b: Ranked) => boolean = () => true): Ranked[] {
  const out = [...list].sort(compare);
  for (let i = 1; i < out.length; i++) {
    for (let j = i; j > 0 && group(out[j - 1], out[j]) && beats(out[j], out[j - 1], rules); j--) {
      [out[j - 1], out[j]] = [out[j], out[j - 1]];
    }
  }
  return out;
}

export interface OrderOptions {
  compare?: (a: Ranked, b: Ranked) => number;
  group?: (a: Ranked, b: Ranked) => boolean;
  /** Measures how finely a survey fills the grid near the middle of the area, or null where it can't. */
  probe?: (r: Ranked) => Promise<SurveyProbe | null>;
}

/**
 * rankSurveys, after measuring what the choice at the front depends on.
 * Only for balanced: the newest survey is measured when a clearly denser one
 * that could take its place exists, and if it doesn't fill the cells, the
 * densest of those are measured too. Probes are saved, so this costs reads
 * once per area and cell.
 */
export async function orderSurveys(list: Ranked[], rules: SurveyRules, options: OrderOptions = {}): Promise<Ranked[]> {
  const { compare = rankOrder, group = () => true, probe } = options;
  const order = () => rankSurveys(list, rules, compare, group);
  if (!probe || rules.preference !== 'balanced') return order();
  const head = [...list].sort(compare)[0];
  if (!head) return [];
  const rivals = rivalsOf(head, list, rules, group);
  if (!rivals.some((r) => clearlyDenser(r, head, rules))) return order();
  head.probe = (await probe(head)) ?? undefined;
  // Can't be told, or it fills them: nothing older can do better.
  if (!head.probe || head.probe.cell <= head.probe.requested * 1.001) return order();
  // Only those that would go first if their density is right about them.
  const densest = rivals
    .filter((r) => beats(r, head, rules))
    .sort((a, b) => surveyDensity(b)! - surveyDensity(a)!)
    .slice(0, RIVALS_MEASURED);
  for (const r of densest) r.probe = (await probe(r)) ?? undefined;
  return order();
}

/**
 * For a list made without reading points: when the newest survey goes first
 * but would be measured against a denser one, which one that is and a note
 * saying so. Null when nothing is left to measure.
 */
export function checkNote(order: Ranked[], rules: SurveyRules, compare: (a: Ranked, b: Ranked) => number = rankOrder, group: (a: Ranked, b: Ranked) => boolean = () => true): string | null {
  if (rules.preference !== 'balanced') return null;
  const head = [...order].sort(compare)[0];
  // A whole-file survey is only measured once its tiles are downloaded.
  if (!head || head !== order[0] || head.probe || staged(head.candidate)) return null;
  const rival = rivalsOf(head, order, rules, group)
    .filter((r) => clearlyDenser(r, head, rules))
    .sort((a, b) => surveyDensity(b)! - surveyDensity(a)!)[0];
  return rival ? `Whether this newest survey fills the ${metres(rules.cellM)} cells is measured when the model is made. Where it leaves gaps, ${named(rival)} goes first.` : null;
}

/** 1.5 times as dense, or where the newest's density is unknown, dense enough to fill the cells. */
function clearlyDenser(r: Ranked, head: Ranked, rules: SurveyRules): boolean {
  const density = surveyDensity(head);
  if (density !== null) return surveyDensity(r)! >= RIVAL_DENSITY * density;
  return effectiveCell(r, rules.cellM)! <= rules.cellM * 1.001;
}

/** Older dated surveys with a density, in the same group and within reach of going first. */
function rivalsOf(head: Ranked, list: Ranked[], rules: SurveyRules, group: (a: Ranked, b: Ranked) => boolean): Ranked[] {
  const newest = acquisitionOrdinal(head.candidate);
  if (!newest) return [];
  return list.filter((r) => {
    if (r === head || !group(head, r) || surveyDensity(r) === null) return false;
    const days = newest - acquisitionOrdinal(r.candidate);
    return acquisitionOrdinal(r.candidate) > 0 && days > 0 && within(days, 2 * rules.years);
  });
}

// Local densities are worked out over at most this much of the area, around
// the middle of where the survey reaches.
const DENSITY_SPAN_M = 512;
const DENSITIES_AT_ONCE = 4;
// A host that doesn't answer (ICGC's from US addresses) mustn't hold up the
// order. Its request carries on into the cache.
const DENSITY_DEADLINE_MS = 20_000;

/** The lon/lat box around a rectangle of `frame`. */
function geoBox(frame: Projection, x0: number, y0: number, x1: number, y1: number): GeoBounds {
  const corners = [frame.localToGeo(x0, y0), frame.localToGeo(x1, y0), frame.localToGeo(x1, y1), frame.localToGeo(x0, y1)];
  return { west: Math.min(...corners.map((c) => c[0])), south: Math.min(...corners.map((c) => c[1])), east: Math.max(...corners.map((c) => c[0])), north: Math.max(...corners.map((c) => c[1])) };
}

/** The answer, or null once DENSITY_DEADLINE_MS has gone by. */
async function inTime<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), DENSITY_DEADLINE_MS)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fills in each survey's localDensity, where its index can tell, and with
 * `area` (a rectangle of `frame`) its measuredCoverage. A failure leaves the
 * catalog's figures.
 */
export async function measureDensities(fetcher: Fetcher, ranked: Ranked[], frame: Projection, signal?: AbortSignal, area?: [number, number, number, number]): Promise<void> {
  const queue = [...ranked];
  const lane = async () => {
    while (queue.length) {
      const r = queue.shift()!;
      if (!r.coverage.length) continue;
      const [x0, y0, x1, y1] = bounds(r.coverage);
      const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
      const half = [Math.min(x1 - x0, DENSITY_SPAN_M) / 2, Math.min(y1 - y0, DENSITY_SPAN_M) / 2];
      const box = geoBox(frame, cx - half[0], cy - half[1], cx + half[0], cy + half[1]);
      const inside = (lon: number, lat: number) => {
        const [x, y] = frame.toLocal(lon, lat);
        return contains(r.coverage, x, y);
      };
      try {
        const density = await inTime(localDensity(fetcher, r.candidate, box, inside));
        if (density) r.localDensity = density;
        if (area && r.candidate.format === 'EPT') {
          const inArea = (lon: number, lat: number) => {
            const [x, y] = frame.toLocal(lon, lat);
            return x >= area[0] && x <= area[2] && y >= area[1] && y <= area[3];
          };
          const share = await inTime(eptPresence(fetcher, r.candidate.url, geoBox(frame, ...area), inArea));
          if (share !== null) r.measuredCoverage = share;
        }
      } catch (error) {
        if ((error as Error)?.name === 'AbortError' || signal?.aborted) throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DENSITIES_AT_ONCE, queue.length) }, lane));
}

const metres = (value: number) => `${Number(value.toFixed(2))} m`;
const named = (r: Ranked) => {
  const year = surveyYear(r.candidate);
  return year ? `${r.candidate.name} (${year})` : r.candidate.name;
};

/**
 * Why the first survey of `order` goes first, when that isn't plain: it beat
 * a newer one, or a denser one was passed over because this one fills the
 * cells. Null when it's simply the newest.
 */
export function pickNote(order: Ranked[], rules: SurveyRules, compare: (a: Ranked, b: Ranked) => number = rankOrder): string | null {
  const first = order[0];
  if (!first || rules.preference === 'newest') return null;
  const newest = [...order].sort(compare)[0];
  const cell = comparedCell(rules);
  if (newest !== first) {
    const [en, ef] = [effectiveCell(newest, cell), effectiveCell(first, cell)];
    if (rules.preference === 'detail') {
      const [dn, df] = [surveyDensity(newest), surveyDensity(first)];
      return dn && df ? `Read for its detail: about ${Math.round(df)} returns per m² here, against ${Math.round(dn)} for the newer ${named(newest)}.` : null;
    }
    if (en === null || ef === null) return null;
    const how = newest.probe ? 'only filled' : 'would only fill';
    const tail = ef <= rules.cellM * 1.001 ? `where this one fills the ${metres(rules.cellM)} asked for` : `against ${metres(ef)} for this one`;
    return `The newer ${named(newest)} ${how} ${metres(en)} cells near the middle of the area, ${tail}.`;
  }
  if (rules.preference === 'balanced' && first.probe && first.probe.cell <= first.probe.requested * 1.001) {
    const denser = order.find((r) => r !== first && (surveyDensity(r) ?? 0) >= RIVAL_DENSITY * (surveyDensity(first) ?? Infinity));
    if (denser) return `${named(denser)} is denser, but this newer one fills the ${metres(rules.cellM)} cells near the middle of the area.`;
  }
  return null;
}
