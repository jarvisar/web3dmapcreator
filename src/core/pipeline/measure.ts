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
export function segmentJunctions(lines: ReadonlyMap<string, SegmentLine>, reaches?: (id: string, at: number) => boolean): Map<string, number[]> {
  // Every vertex of every segment, by a grid of SAME_MM cells.
  const cell = (x: number, y: number) => `${Math.round(x / SAME_MM)},${Math.round(y / SAME_MM)}`;
  const owners = new Map<string, { id: string; at: number }[]>();
  for (const [id, line] of lines) {
    line.points.forEach(([x, y], i) => {
      const key = cell(x, y);
      let list = owners.get(key);
      if (!list) owners.set(key, (list = []));
      list.push({ id, at: line.at[i] });
    });
  }
  const shared = (id: string, [x, y]: Vec2) => {
    const cx = Math.round(x / SAME_MM);
    const cy = Math.round(y / SAME_MM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of owners.get(`${cx + dx},${cy + dy}`) ?? []) if (other.id !== id && (!reaches || reaches(other.id, other.at))) return true;
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
  // In place, so the caller's list has the merged lines cut where their partner changes.
  pieces.splice(0, pieces.length, ...pieces.flatMap((piece) => (piece.partners?.length ? byPartner(piece, lines) : [piece])));
  for (const piece of pieces) {
    const line = lines.get(piece.sourceId);
    if (!line) continue;
    kept.set(piece.sourceId, line);
    piece.measure = settleOffLine(piece.points, measurePoints(piece.points, line), line);
    if (piece.partner) piece.partnerMeasure = measurePoints(piece.points, lines.get(piece.partner)!);
  }
  // What of each segment is printed, as ranges along it, so a junction is only
  // where another road really meets: a path kept elsewhere but pruned or
  // culled here left blocks ending where nothing printed met.
  const printed = new Map<string, [number, number][]>();
  const addPrinted = (id: string, measure: readonly number[]) => {
    let low = Infinity;
    let high = -Infinity;
    for (const v of measure) {
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
    if (!(low <= high)) return;
    let list = printed.get(id);
    if (!list) printed.set(id, (list = []));
    list.push([low, high]);
  };
  for (const piece of pieces) {
    if (piece.measure) addPrinted(piece.sourceId, piece.measure);
    if (piece.partner && piece.partnerMeasure) addPrinted(piece.partner, piece.partnerMeasure);
  }
  for (const deck of decks) {
    const id = deck.key.slice(3);
    const line = lines.get(id);
    if (!line || !deck.points.length) continue;
    kept.set(id, line);
    const measure = measurePoints(deck.points, line);
    addPrinted(id, measure);
    deck.at = (Math.min(...measure) + Math.max(...measure)) / 2;
  }
  const reaches = (id: string, at: number) => {
    const line = lines.get(id);
    const slack = line ? REACH_MM / line.lengthMm : 0;
    return (printed.get(id) ?? []).some(([low, high]) => at >= low - slack && at <= high + slack);
  };
  const out = new Map<string, number[]>();
  for (const [id, junctions] of segmentJunctions(kept, reaches)) out.set(`r:${id}`, junctions);
  return out;
}

// How far short of a vertex, in printed mm, another segment's printed line
// may end and still meet there: a cross street slid onto a divided road's
// midline ends up to half the median (0.6 mm) short of its old vertex.
const REACH_MM = 1;

/**
 * Measures of points the tidy moved off the segment (a slid or eased end, a
 * join's added point), from the points still on it and the distance along
 * the piece. Projected, a moved end on a zigzag footway landed on another
 * zig, and a turning loop's join point next to its start, so the piece ran
 * back along its segment. A piece with no point on the line (a merged
 * divided road) keeps its projection.
 */
export function settleOffLine(points: readonly Vec2[], measure: number[], line: SegmentLine): number[] {
  const n = points.length;
  const on: number[] = [];
  for (let i = 0; i < n; i++) if (distanceTo(points[i], line) <= SAME_MM) on.push(i);
  if (on.length < 2 || on.length === n) return measure;
  const along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const out = [...measure];
  const first = on[0];
  const last = on[on.length - 1];
  const direction = Math.sign(measure[last] - measure[first]);
  for (let i = 0; i < n; i++) {
    if (i < first) out[i] = Math.max(0, Math.min(1, measure[first] - (direction * (along[first] - along[i])) / line.lengthMm));
    else if (i > last) out[i] = Math.max(0, Math.min(1, measure[last] + (direction * (along[i] - along[last])) / line.lengthMm));
    else if (!on.includes(i)) {
      const k = on.findIndex((j) => j > i);
      const a = on[k - 1];
      const b = on[k];
      // Across a loop's seam the measures jump, so nothing between them can be told.
      if (Math.abs(measure[b] - measure[a]) > 0.5) continue;
      const t = (along[i] - along[a]) / (along[b] - along[a] || 1);
      out[i] = measure[a] + (measure[b] - measure[a]) * t;
    }
  }
  return out;
}

/**
 * A merged divided road cut where the other carriageway beside it changes
 * segment, each stretch with the one it lies along (`partner`). Most merged
 * lines run beside several: taking the one nearest the middle for all of it
 * carried a few metres of one segment's edit over a whole block, and left
 * edits to the segment really beside it doing nothing. Cut at a vertex or
 * along a span, the ribbons either side meet in round caps, so the road
 * tiles buffer the same outline.
 */
export function byPartner(piece: RoadPiece, lines: ReadonlyMap<string, SegmentLine>): RoadPiece[] {
  const ids = [...new Set(piece.partners)].filter((id) => lines.has(id));
  if (ids.length <= 1) return [{ ...piece, partner: ids[0] }];
  const points = piece.points;
  const along = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const length = along[along.length - 1];
  if (!(length > 0)) return [{ ...piece, partner: ids[0] }];
  const pointAt = (s: number): Vec2 => {
    let i = 1;
    while (i < along.length - 1 && along[i] < s) i++;
    const span = along[i] - along[i - 1];
    const t = span > 0 ? Math.max(0, Math.min(1, (s - along[i - 1]) / span)) : 0;
    return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
  };
  const nearest = (p: Vec2): number => {
    let best = 0;
    let bestD = Infinity;
    ids.forEach((id, k) => {
      const d = distanceTo(p, lines.get(id)!);
      if (d < bestD) [best, bestD] = [k, d];
    });
    return best;
  };
  // Samples at every vertex and every PARTNER_STEP_MM between.
  const samples = new Set(along);
  for (let s = PARTNER_STEP_MM; s < length; s += PARTNER_STEP_MM) samples.add(s);
  const at = [...samples].sort((a, b) => a - b);
  const runs: { from: number; to: number; partner: number }[] = [];
  let previous = nearest(pointAt(at[0]));
  runs.push({ from: 0, to: length, partner: previous });
  for (let k = 1; k < at.length; k++) {
    const current = nearest(pointAt(at[k]));
    if (current === previous) continue;
    // Where the two are equally near, between the samples.
    const a = lines.get(ids[previous])!;
    const b = lines.get(ids[current])!;
    let lo = at[k - 1];
    let hi = at[k];
    for (let step = 0; step < 30; step++) {
      const mid = (lo + hi) / 2;
      const p = pointAt(mid);
      if (distanceTo(p, a) <= distanceTo(p, b)) lo = mid;
      else hi = mid;
    }
    const cut = (lo + hi) / 2;
    runs[runs.length - 1].to = cut;
    runs.push({ from: cut, to: length, partner: current });
    previous = current;
  }
  // A stretch too short to matter goes with its neighbour.
  for (let k = 0; k < runs.length && runs.length > 1; ) {
    if (runs[k].to - runs[k].from >= PARTNER_MIN_MM) {
      k++;
      continue;
    }
    if (k > 0) runs[k - 1].to = runs[k].to;
    else runs[1].from = runs[0].from;
    runs.splice(k, 1);
  }
  for (let k = runs.length - 1; k > 0; k--) {
    if (runs[k].partner !== runs[k - 1].partner) continue;
    runs[k - 1].to = runs[k].to;
    runs.splice(k, 1);
  }
  if (runs.length === 1) return [{ ...piece, partner: ids[runs[0].partner] }];
  return runs.map((run) => {
    const slice: Vec2[] = [pointAt(run.from)];
    for (let i = 1; i < points.length - 1; i++) if (along[i] > run.from && along[i] < run.to) slice.push(points[i]);
    slice.push(pointAt(run.to));
    return { ...piece, points: slice, partner: ids[run.partner] };
  });
}

// Printed mm between the samples finding which carriageway a merged line lies along.
const PARTNER_STEP_MM = 0.25;
// Stretches beside another carriageway shorter than this go with their neighbour.
const PARTNER_MIN_MM = 0.2;

function distanceTo([x, y]: Vec2, line: SegmentLine): number {
  let best = Infinity;
  const p = line.points;
  for (let i = 1; i < p.length; i++) {
    const [ax, ay] = p[i - 1];
    const ex = p[i][0] - ax;
    const ey = p[i][1] - ay;
    const length2 = ex * ex + ey * ey;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / length2)) : 0;
    best = Math.min(best, Math.hypot(ax + ex * t - x, ay + ey * t - y));
  }
  return best;
}
