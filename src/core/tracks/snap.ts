// Moves a recorded track onto the roads it followed. GPS wanders 5 to 10 m
// either side of a street, 20 to 30 m between towers, and printed at the
// default scale that's half a road's width or more, so an imported run
// zigzagged across the streets beside the ones it took.
//
// It's map matching with a hidden Markov model (Newson and Krumm, 2009): the
// track is sampled every 10 m, each sample can be on any road within reach,
// and the most likely sequence is the one whose distance along the roads
// best agrees with the distance between the samples. A sample can also be
// off the roads, at the cost of switching there and back, so a trail across
// a park that isn't mapped, or a beach run, stays as recorded. Between two
// samples on roads the result follows the road's own line.
//
// Works in any flat units: model mm, an SVG map's canvas mm, or metres.

import type { Vec2 } from '../types';
import { NONE, RoadGraph } from './network';

export interface SnapOptions {
  /** Flat units per real metre. */
  unitsPerMetre: number;
}

export interface SnapResult {
  lines: Vec2[][];
  /**
   * Per line, which network line each segment was matched along (segment i
   * runs from point i to i + 1), or -1 where it's off the roads.
   */
  via: Int32Array[];
  /** Share of the track's samples matched to a road, 0 to 1. */
  snapped: number;
}

// Samples along the track, and what a sample's distance from the road costs.
const STEP_M = 10;
const SIGMA_M = 8;
// Roads within this of a sample are candidates. A sample further from every
// road than OFF_M costs more on the road than off it.
const RADIUS_M = 40;
const OFF_M = 3 * SIGMA_M;
// Leaving the roads or coming back costs this much, in log probability.
const SWITCH = 4;
// How far the distance along the roads may differ from the straight one.
const BETA_M = 8;
// Vertices this close are one junction.
const JOIN_M = 0.5;

interface Sample {
  x: number;
  y: number;
  /** Distance along its line from the start. */
  s: number;
}

function cumulative(line: readonly Vec2[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  return out;
}

function samplesOf(line: readonly Vec2[], along: number[], step: number): Sample[] {
  const total = along[along.length - 1];
  const count = Math.max(1, Math.ceil(total / step));
  const out: Sample[] = [];
  let i = 1;
  for (let k = 0; k <= count; k++) {
    const s = (total * k) / count;
    while (i < line.length - 1 && along[i] < s) i++;
    const span = along[i] - along[i - 1];
    const t = span > 0 ? (s - along[i - 1]) / span : 0;
    out.push({ x: line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, y: line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t, s });
  }
  return out;
}

/** The recorded points strictly between two distances along the line. */
function rawBetween(line: readonly Vec2[], along: number[], from: number, to: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < line.length; i++) if (along[i] > from && along[i] < to) out.push(line[i]);
  return out;
}

function pushPoint(out: Vec2[], x: number, y: number): boolean {
  const last = out[out.length - 1];
  if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) return false;
  out.push([x, y]);
  return true;
}

/** The network lines near the track, so the graph only holds what a match could use, and which line each came from. */
function nearTrack(network: readonly Vec2[][], track: readonly Vec2[][], reach: number): { lines: Vec2[][]; sources: number[] } {
  const cell = reach;
  const key = (cx: number, cy: number) => (cx + 2 ** 25) * 2 ** 26 + (cy + 2 ** 25);
  const near = new Set<number>();
  for (const line of track) {
    const along = cumulative(line);
    for (const p of samplesOf(line, along, reach / 2)) {
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor(p.y / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) near.add(key(cx + dx, cy + dy));
    }
  }
  const isNear = (x: number, y: number) => near.has(key(Math.floor(x / cell), Math.floor(y / cell)));
  // A segment counts when any point along it, every half cell, is near.
  const segmentNear = (a: Vec2, b: Vec2) => {
    const steps = Math.min(1000, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (cell / 2)));
    for (let k = 0; k <= steps; k++) if (isNear(a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps)) return true;
    return false;
  };
  const lines: Vec2[][] = [];
  const sources: number[] = [];
  network.forEach((line, source) => {
    let piece: Vec2[] = [];
    for (let i = 1; i < line.length; i++) {
      if (segmentNear(line[i - 1], line[i])) {
        if (!piece.length) piece.push(line[i - 1]);
        piece.push(line[i]);
      } else if (piece.length) {
        lines.push(piece);
        sources.push(source);
        piece = [];
      }
    }
    if (piece.length >= 2) {
      lines.push(piece);
      sources.push(source);
    }
  });
  return { lines, sources };
}

function unmatched(track: readonly Vec2[][]): SnapResult {
  return { lines: track.map((line) => [...line]), via: track.map((line) => new Int32Array(Math.max(0, line.length - 1)).fill(NONE)), snapped: 0 };
}

/** The track moved onto the network where it follows it. Lines are matched one at a time. */
export function snapToNetwork(track: readonly Vec2[][], network: readonly Vec2[][], options: SnapOptions): SnapResult {
  const u = options.unitsPerMetre;
  if (!network.length || !track.length || !(u > 0)) return unmatched(track);
  const radius = RADIUS_M * u;
  const near = nearTrack(network, track, radius + 150 * u);
  return snapOnGraph(track, RoadGraph.build(near.lines, near.sources, JOIN_M * u, radius), options);
}

/**
 * The same on a graph already built, like the route editor's of every road
 * around the area. Its vertices within half a metre should be one node, as here.
 */
export function snapOnGraph(track: readonly Vec2[][], graph: RoadGraph, options: SnapOptions): SnapResult {
  const u = options.unitsPerMetre;
  if (!graph.nodes || !track.length || !(u > 0)) return unmatched(track);
  const radius = RADIUS_M * u;
  const sigma = SIGMA_M * u;
  const beta = BETA_M * u;
  const offCost = 0.5 * (OFF_M / SIGMA_M) ** 2;
  let total = 0;
  let matched = 0;
  const lines: Vec2[][] = [];
  const via: Int32Array[] = [];

  for (const line of track) {
    if (line.length < 2) continue;
    const along = cumulative(line);
    const samples = samplesOf(line, along, STEP_M * u);
    const candidates = samples.map((p) => graph.candidates(p.x, p.y, radius, JOIN_M * u * 2));
    // Viterbi. State j < candidates[k].length is that road candidate, the last is off the roads.
    const score: Float64Array[] = [];
    const back: Int32Array[] = [];
    const emit = (k: number, j: number) => (j < candidates[k].length ? -0.5 * (candidates[k][j].distance / sigma) ** 2 : -offCost);
    const first = new Float64Array(candidates[0].length + 1);
    for (let j = 0; j < first.length; j++) first[j] = emit(0, j);
    score.push(first);
    back.push(new Int32Array(first.length).fill(NONE));
    for (let k = 1; k < samples.length; k++) {
      const before = candidates[k - 1];
      const now = candidates[k];
      const straight = Math.hypot(samples[k].x - samples[k - 1].x, samples[k].y - samples[k - 1].y);
      const limit = straight * 3 + 2 * radius + 30 * u;
      const routed = before.map((c) => (now.length ? graph.distances(c, now, limit) : []));
      const prev = score[k - 1];
      const current = new Float64Array(now.length + 1).fill(-Infinity);
      const from = new Int32Array(now.length + 1).fill(NONE);
      const offBefore = before.length;
      for (let j = 0; j <= now.length; j++) {
        const offNow = j === now.length;
        for (let i = 0; i <= before.length; i++) {
          if (!(prev[i] > -Infinity)) continue;
          let move: number;
          if (i === offBefore && offNow) move = 0;
          else if (i === offBefore || offNow) move = -SWITCH;
          else {
            const d = routed[i][j];
            if (!Number.isFinite(d)) continue;
            move = -Math.abs(d - straight) / beta;
          }
          const value = prev[i] + move;
          if (value > current[j]) {
            current[j] = value;
            from[j] = i;
          }
        }
        if (current[j] > -Infinity) current[j] += emit(k, j);
      }
      score.push(current);
      back.push(from);
    }
    const states = new Int32Array(samples.length);
    const last = score[samples.length - 1];
    let best = 0;
    for (let j = 1; j < last.length; j++) if (last[j] > last[best]) best = j;
    for (let k = samples.length - 1; k >= 0; k--) {
      states[k] = best;
      best = back[k][best];
    }

    const out: Vec2[] = [];
    // The network line of the segment ending at each point.
    const ways: number[] = [];
    const push = (x: number, y: number, way: number) => {
      if (pushPoint(out, x, y)) ways.push(way);
    };
    for (let k = 0; k < samples.length; k++) {
      const state = states[k];
      const offNow = state === candidates[k].length;
      total++;
      if (offNow) {
        if (k > 0) for (const p of rawBetween(line, along, samples[k - 1].s, samples[k].s)) push(p[0], p[1], NONE);
        push(samples[k].x, samples[k].y, NONE);
        continue;
      }
      matched++;
      const c = candidates[k][state];
      const prevState = k > 0 ? states[k - 1] : NONE;
      if (k > 0 && prevState < candidates[k - 1].length) {
        const p = candidates[k - 1][prevState];
        const straight = Math.hypot(samples[k].x - samples[k - 1].x, samples[k].y - samples[k - 1].y);
        const nodes: number[] = [];
        const edges: number[] = [];
        graph.distances(p, [c], straight * 3 + 2 * radius + 30 * u, nodes, edges);
        nodes.forEach((n, i) => push(graph.x[n], graph.y[n], graph.line[edges[i]]));
        push(c.x, c.y, graph.line[c.edge]);
      } else {
        push(c.x, c.y, NONE);
      }
    }
    if (out.length >= 2) {
      lines.push(out);
      via.push(Int32Array.from(ways.slice(1)));
    }
  }
  return { lines, via, snapped: total ? matched / total : 0 };
}
