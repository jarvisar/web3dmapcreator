// Where road pieces lie along their Overture segment, as a fraction of its
// length, for edits to a block of a road (edit/blocks.ts). The tidy cuts,
// moves and joins lines after they're split from their segment, so pieces
// are measured once at the end by projecting their points onto the
// segment's own line, rather than carrying positions through every step.
//
// Blocks end at junctions: inner vertices of the segment that another kept
// segment shares. Overture puts a connector wherever segments meet, on a
// vertex of both, and this found the same junctions as the connectors on all
// 536 of the Loop's segments with any, without reading them (25% more
// segment data). Only kept segments count: most connectors are where
// sidewalks and crossings meet a street, which aren't printed, and a block
// ending at one nobody can see read as a bug. Junctions closer than
// BLOCK_MIN_MM printed are taken as one (two carriageways of a divided cross
// street).

import { roundAt } from '../edit/blocks';
import type { Vec2 } from '../types';
import type { DeckPiece } from './bridges';
import type { RoadPiece } from './roads';

/** Junctions closer than this along a segment, in printed mm, are one. */
export const BLOCK_MIN_MM = 0.5;
// Vertices of two segments within this are the same point, in model mm.
const SAME_MM = 1e-3;

export interface SegmentLine {
  points: Vec2[];
  /** Fraction of the length at each point, 0 to 1. */
  at: Float64Array;
  lengthMm: number;
}

/** A segment's line with its points' positions, or null when it has no length. */
export function segmentLine(points: Vec2[]): SegmentLine | null {
  if (points.length < 2) return null;
  const at = new Float64Array(points.length);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    at[i] = total;
  }
  if (!(total > 0)) return null;
  for (let i = 0; i < at.length; i++) at[i] /= total;
  return { points, at, lengthMm: total };
}

/** The position along the segment of each point of a piece of it. */
export function measurePoints(points: readonly Vec2[], line: SegmentLine): number[] {
  const out = new Array<number>(points.length);
  const nearest = (x: number, y: number, near: number | null): number => {
    let best = Infinity;
    let at = 0;
    const p = line.points;
    for (let i = 1; i < p.length; i++) {
      const [ax, ay] = p[i - 1];
      const ex = p[i][0] - ax;
      const ey = p[i][1] - ay;
      const length2 = ex * ex + ey * ey;
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / length2)) : 0;
      const d = Math.hypot(ax + ex * t - x, ay + ey * t - y);
      const value = line.at[i - 1] + (line.at[i] - line.at[i - 1]) * t;
      // Ties, as where a loop's ends meet, go to the place nearer the point before.
      if (d < best - SAME_MM || (d <= best + SAME_MM && near !== null && Math.abs(value - near) < Math.abs(at - near))) {
        best = Math.min(best, d);
        at = value;
      }
    }
    return at;
  };
  if (!points.length) return out;
  // The second point first, so the first can settle a tie by it.
  const second = points.length > 1 ? nearest(points[1][0], points[1][1], null) : null;
  out[0] = nearest(points[0][0], points[0][1], second);
  for (let i = 1; i < points.length; i++) out[i] = nearest(points[i][0], points[i][1], out[i - 1]);
  return out;
}

/**
 * The junctions of each kept segment: inner vertices another kept segment
 * has a vertex at too, closer ones taken as one, rounded as edit keys have
 * them. Only segments with any are listed.
 */
export function segmentJunctions(lines: ReadonlyMap<string, SegmentLine>): Map<string, number[]> {
  // Every vertex of every segment, by a grid of SAME_MM cells.
  const cell = (x: number, y: number) => `${Math.round(x / SAME_MM)},${Math.round(y / SAME_MM)}`;
  const owners = new Map<string, Set<string>>();
  for (const [id, line] of lines) {
    for (const [x, y] of line.points) {
      const key = cell(x, y);
      let set = owners.get(key);
      if (!set) owners.set(key, (set = new Set()));
      set.add(id);
    }
  }
  const shared = (id: string, [x, y]: Vec2) => {
    const cx = Math.round(x / SAME_MM);
    const cy = Math.round(y / SAME_MM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const set = owners.get(`${cx + dx},${cy + dy}`);
        if (set && (set.size > 1 || !set.has(id))) return true;
      }
    }
    return false;
  };
  const out = new Map<string, number[]>();
  for (const [id, line] of lines) {
    const inner: number[] = [];
    for (let i = 1; i < line.points.length - 1; i++) if (shared(id, line.points[i])) inner.push(line.at[i]);
    if (!inner.length) continue;
    // Runs closer than BLOCK_MIN_MM become their middle, and one near an end goes into it.
    const gap = BLOCK_MIN_MM / line.lengthMm;
    const kept: number[] = [];
    let run: number[] = [];
    const flush = () => {
      if (!run.length) return;
      const middle = run.reduce((sum, v) => sum + v, 0) / run.length;
      if (middle > gap && middle < 1 - gap) kept.push(roundAt(middle));
      run = [];
    };
    for (const at of inner) {
      if (run.length && at - run[run.length - 1] >= gap) flush();
      run.push(at);
    }
    flush();
    const unique = kept.filter((v, i) => v > 0 && v < 1 && (i === 0 || v > kept[i - 1]));
    if (unique.length) out.set(id, unique);
  }
  return out;
}

/**
 * Measures the ground pieces and decks along their segments (in place), and
 * returns the junctions of the segments they're from, by road key.
 */
export function measureRoads(lines: ReadonlyMap<string, SegmentLine>, pieces: RoadPiece[], decks: DeckPiece[]): Map<string, number[]> {
  const kept = new Map<string, SegmentLine>();
  for (const piece of pieces) {
    const line = lines.get(piece.sourceId);
    if (!line) continue;
    kept.set(piece.sourceId, line);
    piece.measure = measurePoints(piece.points, line);
  }
  for (const deck of decks) {
    const id = deck.key.slice(3);
    const line = lines.get(id);
    if (!line || !deck.points.length) continue;
    kept.set(id, line);
    let low = Infinity;
    let high = -Infinity;
    for (const at of measurePoints(deck.points, line)) {
      low = Math.min(low, at);
      high = Math.max(high, at);
    }
    deck.at = (low + high) / 2;
  }
  const out = new Map<string, number[]>();
  for (const [id, junctions] of segmentJunctions(kept)) out.set(`r:${id}`, junctions);
  return out;
}
