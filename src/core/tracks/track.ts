// Routes imported from GPX and similar files ("tracks" in the code, so they
// don't get mixed up with the roads picked into routes in SVG maps). They're
// the user's own data like the model's edits: kept for every area, saved
// under a key of their own, and shared by both outputs.
//
// Lines are simplified to within a metre when they're imported. GPS noise is
// bigger than that, and a marathon recorded every second goes from about
// 14,000 points to a few thousand.

import type { LonLat } from '../types';
import { decodePolyline, encodePolyline } from './polyline';

export interface Track {
  id: string;
  name: string;
  visible: boolean;
  /** Google encoded polylines with 6 decimals, one per unbroken stretch. */
  lines: string[];
}

/** A track as generation and rendering take it, decoded. */
export interface TrackLines {
  id: string;
  name: string;
  lines: LonLat[][];
}

export const MAX_TRACKS = 20;
// Per track, after simplifying. A noisy or very long track gets a coarser
// tolerance until it fits, so saved state and links stay a sensible size.
export const MAX_TRACK_POINTS = 10_000;
// Track lines are clipped this far past the model before snapping, in real
// metres, so a route leaving the model and coming back is matched as one.
// Nothing further out changes a model.
export const SNAP_MARGIN_M = 200;
const TOLERANCE_M = 1;
const MAX_NAME = 100;

const EARTH_RADIUS = 6371008.8;

type Point = [number, number];

function segmentDistanceSq(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + dx * t - p[0];
  const y = a[1] + dy * t - p[1];
  return x * x + y * y;
}

// Douglas-Peucker without recursion, since tracks can have a lot of points.
function keptPoints(path: readonly Point[], tolerance: number): Uint8Array {
  const n = path.length;
  const keep = new Uint8Array(n);
  if (n <= 2 || !(tolerance > 0)) return keep.fill(1);
  keep[0] = 1;
  keep[n - 1] = 1;
  const toleranceSq = tolerance * tolerance;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const [worst, worstSq] = farthest(path, a, b);
    if (worstSq > toleranceSq) {
      keep[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
  return keep;
}

/**
 * The point between `a` and `b` furthest from the line between them, and its
 * squared distance, or -1 when they're all on it. Of points equally far, the
 * one nearest the middle: every other point of a sawtooth is, and taking the
 * first split one point off at a time, which was quadratic.
 */
function farthest(path: readonly Point[], a: number, b: number): [number, number] {
  const middle = (a + b) / 2;
  let worst = -1;
  let worstSq = 0;
  for (let i = a + 1; i < b; i++) {
    const d = segmentDistanceSq(path[i], path[a], path[b]);
    if (d > worstSq || (d === worstSq && worst >= 0 && Math.abs(i - middle) < Math.abs(worst - middle))) {
      worstSq = d;
      worst = i;
    }
  }
  return [worst, worstSq];
}

/** A line's points within `tolerance` of it, in the line's own units. */
export function simplifyLine<T extends Point>(path: readonly T[], tolerance: number): T[] {
  const keep = keptPoints(path, tolerance);
  return path.filter((_, i) => keep[i]);
}

// Flat metres around the lines' middle latitude, close enough for
// simplifying anything one model or map could show.
function toMetres(lines: readonly LonLat[][]): Point[][] {
  let sum = 0;
  let count = 0;
  for (const line of lines) {
    for (const [, lat] of line) {
      sum += lat;
      count++;
    }
  }
  const lat0 = count ? sum / count : 0;
  const ky = (Math.PI / 180) * EARTH_RADIUS;
  const kx = ky * Math.cos((lat0 * Math.PI) / 180);
  return lines.map((line) => line.map(([lon, lat]) => [lon * kx, lat * ky]));
}

/** Indexes of the points left after dropping those within `radius` of the last one kept. The ends stay. */
function radialKept(path: readonly Point[], radius: number): number[] {
  const n = path.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const out = [0];
  const radiusSq = radius * radius;
  let [lx, ly] = path[0];
  for (let i = 1; i < n - 1; i++) {
    const [x, y] = path[i];
    if ((x - lx) ** 2 + (y - ly) ** 2 < radiusSq) continue;
    out.push(i);
    lx = x;
    ly = y;
  }
  out.push(n - 1);
  return out;
}

// Douglas-Peucker is quadratic when every split only takes a point off the
// end. Ties going to the middle (`farthest`) covers a sawtooth, which held
// the page for 4.5 s at 50,000 points, but a sawtooth shrinking along its
// length still does it. A line that takes more than this much work per
// point is done again in runs of RUN_POINTS, whose ends are always kept.
// Recorded routes take a few steps per point and never get there.
const WORK_PER_POINT = 64;
const RUN_POINTS = 256;

/**
 * Douglas-Peucker at every tolerance at once: the squared tolerance under
 * which each point is kept. That's its distance when it was split off,
 * capped by the points it was split off under, so the same points are kept
 * as `keptPoints` keeps.
 */
function significance(path: readonly Point[]): Float64Array {
  const n = path.length;
  const out = new Float64Array(n);
  if (!n) return out;
  out[0] = Infinity;
  if (n === 1 || splitLevels(path, out, 0, n - 1, WORK_PER_POINT * n)) return out;
  out.fill(0);
  for (let from = 0; from < n - 1; from += RUN_POINTS) splitLevels(path, out, from, Math.min(n - 1, from + RUN_POINTS), Infinity);
  return out;
}

/** `significance` between two points that are both kept. False once it's done more than `budget` steps. */
function splitLevels(path: readonly Point[], out: Float64Array, from: number, to: number, budget: number): boolean {
  out[from] = Infinity;
  out[to] = Infinity;
  let work = 0;
  const stack: number[] = [from, to, Infinity];
  while (stack.length > 0) {
    const cap = stack.pop()!;
    const b = stack.pop()!;
    const a = stack.pop()!;
    work += b - a;
    if (work > budget) return false;
    const [worst, worstSq] = farthest(path, a, b);
    if (worst >= 0) {
      const level = Math.min(worstSq, cap);
      out[worst] = level;
      stack.push(a, worst, level, worst, b, level);
    }
  }
  return true;
}

// Points closer than this to the last one kept go before Douglas-Peucker,
// far under the tolerance. A file logged several times a second can have
// millions of them.
const RADIAL_M = 0.2;

/**
 * Simplified to `tolerance` metres, or coarser until there are at most
 * `maxPoints`. Every stretch keeps its ends, so one in more than half that
 * many stretches stays over it.
 */
export function simplifyTrack(lines: readonly LonLat[][], tolerance = TOLERANCE_M, maxPoints = MAX_TRACK_POINTS): LonLat[][] {
  if (!(tolerance > 0)) return lines.map((line) => [...line]);
  const metres = toMetres(lines);
  const thinned = metres.map((path) => radialKept(path, Math.min(RADIAL_M, tolerance / 4)));
  const levels = metres.map((path, i) => significance(thinned[i].map((j) => path[j])));
  for (;;) {
    const toleranceSq = tolerance * tolerance;
    let total = 0;
    for (const level of levels) for (let j = 0; j < level.length; j++) if (level[j] > toleranceSq) total++;
    if (total <= maxPoints || tolerance > 1e5) {
      return lines.map((line, i) => {
        const out: LonLat[] = [];
        thinned[i].forEach((j, k) => {
          if (levels[i][k] > toleranceSq) out.push(line[j]);
        });
        return out;
      });
    }
    tolerance *= 1.5;
  }
}

export function encodeTrack(lines: readonly LonLat[][], tolerance = TOLERANCE_M, maxPoints = MAX_TRACK_POINTS): string[] {
  return simplifyTrack(lines, tolerance, maxPoints).map(encodePolyline);
}

/** Drops anything off the globe, which a hand-edited link could hold. */
export function decodeTrack(track: Pick<Track, 'lines'>): LonLat[][] {
  const out: LonLat[][] = [];
  for (const text of track.lines) {
    if (typeof text !== 'string') continue;
    const line = decodePolyline(text).filter(([lon, lat]) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90);
    if (line.length >= 2) out.push(line);
  }
  return out;
}

/** The visible tracks, decoded, for generation and rendering. */
export function visibleTracks(tracks: readonly Track[]): TrackLines[] {
  const out: TrackLines[] = [];
  for (const track of tracks) {
    if (!track.visible) continue;
    const lines = decodeTrack(track);
    if (lines.length) out.push({ id: track.id, name: track.name, lines });
  }
  return out;
}

export function distanceM(a: LonLat, b: LonLat): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function trackLengthM(lines: readonly LonLat[][]): number {
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) total += distanceM(line[i - 1], line[i]);
  }
  return total;
}

/** Start and finish of a track, for markers and the map. */
export function trackEnds(lines: readonly LonLat[][]): { start: LonLat; finish: LonLat } | null {
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  return { start: lines[0][0], finish: last[last.length - 1] };
}

// Polyline characters only, so nothing else can ride along in a link.
const POLYLINE = /^[?-~]*$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function tidyTrackName(name: string): string {
  return name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.(gpx|kml|kmz|tcx|fit|geojson|json)$/i, '')
    .slice(0, MAX_NAME);
}

export function trackPoints(lines: readonly string[]): number {
  let points = 0;
  for (const line of lines) points += decodePolyline(line).length;
  return points;
}

/** Tracks with anything unknown or out of range dropped, from saved state, a link or a file. */
export function sanitizeTracks(value: unknown): Track[] {
  if (!Array.isArray(value)) return [];
  const out: Track[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (out.length >= MAX_TRACKS) break;
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || !Array.isArray(item.lines)) continue;
    const id = item.id.slice(0, 64);
    if (ids.has(id)) continue;
    const lines = item.lines.filter((line): line is string => typeof line === 'string' && line.length > 0 && POLYLINE.test(line));
    if (!lines.length) continue;
    if (trackPoints(lines) > MAX_TRACK_POINTS) continue;
    if (!decodeTrack({ lines }).length) continue;
    ids.add(id);
    out.push({ id, name: tidyTrackName(typeof item.name === 'string' ? item.name : '') || 'Route', visible: item.visible !== false, lines });
  }
  return out;
}

// A link simplifies routes up to 12 m to fit, so one that came back from a
// link is within this of the route it was made from.
const SAME_ROUTE_M = 15;

/**
 * Whether every point of `part` is within `reach` metres of `lines`. Only
 * that way round: a link cuts a route to its area, so ours coming back can
 * be a piece of it, or several.
 */
function liesAlong(part: readonly LonLat[][], lines: readonly LonLat[][], reach: number): boolean {
  if (!part.length || !lines.length) return false;
  const metres = toMetres([...part, ...lines]);
  // Every segment is listed in the cells it passes through, sampled every
  // `reach`, so a cell and its neighbours hold everything within `reach`.
  const cell = 2 * reach;
  const cells = new Map<string, [number, number][]>();
  for (let l = part.length; l < metres.length; l++) {
    const line = metres[l];
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / reach));
      let lastKey = '';
      for (let k = 0; k <= steps; k++) {
        const key = `${Math.floor((ax + ((bx - ax) * k) / steps) / cell)},${Math.floor((ay + ((by - ay) * k) / steps) / cell)}`;
        if (key === lastKey) continue;
        lastKey = key;
        const list = cells.get(key);
        const last = list?.[list.length - 1];
        if (!list) cells.set(key, [[l, i]]);
        else if (last![0] !== l || last![1] !== i) list.push([l, i]);
      }
    }
  }
  const reachSq = reach * reach;
  const near = (p: Point) => {
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const [l, i] of cells.get(`${cx + dx},${cy + dy}`) ?? []) if (segmentDistanceSq(p, metres[l][i - 1], metres[l][i]) <= reachSq) return true;
      }
    }
    return false;
  };
  return metres.slice(0, part.length).every((line) => line.every(near));
}

/**
 * Tracks from a share link or an options file added to these. One that's
 * already here (the same link opened twice) isn't added again, and theirs
 * never replace ours. That includes ours coming back from a link: it has
 * the same id, or the same name if it was passed on, but the link may have
 * simplified it and cut it to its area. `left` counts what the limit left out.
 */
export function mergeTracks(base: Track[], extra: Track[]): { tracks: Track[]; added: number; left: number } {
  const same = (a: Track, b: Track) => a.lines.length === b.lines.length && a.lines.every((line, i) => line === b.lines[i]);
  const close = (ours: Track, theirs: Track) => (ours.id === theirs.id || ours.name === theirs.name) && liesAlong(decodeTrack(theirs), decodeTrack(ours), SAME_ROUTE_M);
  const out = [...base];
  let added = 0;
  let left = 0;
  for (const track of extra) {
    if (out.some((other) => same(other, track) || close(other, track))) continue;
    if (out.length >= MAX_TRACKS) {
      left++;
      continue;
    }
    const id = out.some((other) => other.id === track.id) ? newTrackId() : track.id;
    out.push({ ...track, id });
    added++;
  }
  return { tracks: added ? out : base, added, left };
}

export function newTrackId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
