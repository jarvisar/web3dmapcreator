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
    let worst = -1;
    let worstSq = toleranceSq;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistanceSq(path[i], path[a], path[b]);
      if (d > worstSq) {
        worstSq = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
  return keep;
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

/** Simplified to `tolerance` metres, or coarser until there are at most `maxPoints`. */
export function simplifyTrack(lines: readonly LonLat[][], tolerance = TOLERANCE_M, maxPoints = MAX_TRACK_POINTS): LonLat[][] {
  const metres = toMetres(lines);
  for (;;) {
    const out = metres.map((path, i) => {
      const keep = keptPoints(path, tolerance);
      return lines[i].filter((_, j) => keep[j]);
    });
    const total = out.reduce((sum, line) => sum + line.length, 0);
    if (total <= maxPoints || tolerance > 1e5) return out;
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
    let points = 0;
    for (const line of lines) points += decodePolyline(line).length;
    if (points > MAX_TRACK_POINTS) continue;
    ids.add(id);
    out.push({ id, name: tidyTrackName(typeof item.name === 'string' ? item.name : '') || 'Route', visible: item.visible !== false, lines });
  }
  return out;
}

/**
 * Tracks from a share link or an options file added to these. One that's
 * already here (the same link opened twice) isn't added again, and theirs
 * never replace ours. `left` counts what the limit left out.
 */
export function mergeTracks(base: Track[], extra: Track[]): { tracks: Track[]; added: number; left: number } {
  const same = (a: Track, b: Track) => a.lines.length === b.lines.length && a.lines.every((line, i) => line === b.lines[i]);
  const out = [...base];
  let added = 0;
  let left = 0;
  for (const track of extra) {
    if (out.some((other) => same(other, track))) continue;
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
