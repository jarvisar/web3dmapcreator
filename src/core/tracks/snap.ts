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
const MAX_CANDIDATES = 8;
// Vertices this close are one junction.
const JOIN_M = 0.5;

const NONE = -1;

interface Candidate {
  edge: number;
  /** Along the edge from its first node, 0 to 1. */
  t: number;
  x: number;
  y: number;
  distance: number;
}

class Graph {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly from: Int32Array;
  readonly to: Int32Array;
  readonly length: Float64Array;
  /** The network line each edge came from. */
  readonly line: Int32Array;
  /** Node to its edges, CSR. */
  private readonly start: Int32Array;
  private readonly links: Int32Array;
  private readonly cells = new Map<number, number[]>();
  private readonly cell: number;
  // Reused between searches: distances are only valid where stamp matches.
  private readonly dist: Float64Array;
  private readonly prev: Int32Array;
  private readonly prevEdge: Int32Array;
  private readonly stamp: Int32Array;
  private round = 0;

  constructor(lines: readonly Vec2[][], sources: readonly number[], join: number, cell: number) {
    const xs: number[] = [];
    const ys: number[] = [];
    const grid = new Map<number, number[]>();
    const key = (cx: number, cy: number) => (cx + 2 ** 25) * 2 ** 26 + (cy + 2 ** 25);
    const node = (x: number, y: number): number => {
      const cx = Math.floor(x / join);
      const cy = Math.floor(y / join);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const n of grid.get(key(cx + dx, cy + dy)) ?? []) if (Math.hypot(xs[n] - x, ys[n] - y) <= join) return n;
        }
      }
      const n = xs.length;
      xs.push(x);
      ys.push(y);
      const list = grid.get(key(cx, cy));
      if (list) list.push(n);
      else grid.set(key(cx, cy), [n]);
      return n;
    };

    // A line ending part way along another (a T junction the data didn't
    // split) is joined to it there.
    const ends: Vec2[] = [];
    for (const line of lines) if (line.length >= 2) ends.push(line[0], line[line.length - 1]);
    const endGrid = new Map<number, number[]>();
    const endCell = Math.max(join * 4, cell / 8);
    ends.forEach(([x, y], i) => {
      const k = key(Math.floor(x / endCell), Math.floor(y / endCell));
      const list = endGrid.get(k);
      if (list) list.push(i);
      else endGrid.set(k, [i]);
    });
    const splitsOf = (a: Vec2, b: Vec2): number[] => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length2 = dx * dx + dy * dy;
      if (length2 === 0) return [];
      const out: number[] = [];
      const x0 = Math.floor((Math.min(a[0], b[0]) - join) / endCell);
      const x1 = Math.floor((Math.max(a[0], b[0]) + join) / endCell);
      const y0 = Math.floor((Math.min(a[1], b[1]) - join) / endCell);
      const y1 = Math.floor((Math.max(a[1], b[1]) + join) / endCell);
      // A long straight segment crossing a large area isn't worth splitting this way.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return out;
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          for (const i of endGrid.get(key(cx, cy)) ?? []) {
            const [px, py] = ends[i];
            const t = ((px - a[0]) * dx + (py - a[1]) * dy) / length2;
            if (t <= 0 || t >= 1) continue;
            const d = Math.hypot(a[0] + dx * t - px, a[1] + dy * t - py);
            const along = Math.sqrt(length2);
            if (d <= join && t * along > join && (1 - t) * along > join) out.push(t);
          }
        }
      }
      return out.sort((p, q) => p - q);
    };

    const from: number[] = [];
    const to: number[] = [];
    const lengths: number[] = [];
    const edgeLines: number[] = [];
    let source = NONE;
    const edge = (u: number, v: number) => {
      if (u === v) return;
      from.push(u);
      to.push(v);
      lengths.push(Math.hypot(xs[v] - xs[u], ys[v] - ys[u]));
      edgeLines.push(source);
    };
    for (let l = 0; l < lines.length; l++) {
      const line = lines[l];
      if (line.length < 2) continue;
      source = sources[l];
      let previous = node(line[0][0], line[0][1]);
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1];
        const b = line[i];
        for (const t of splitsOf(a, b)) {
          const n = node(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
          edge(previous, n);
          previous = n;
        }
        const n = node(b[0], b[1]);
        edge(previous, n);
        previous = n;
      }
    }
    this.x = Float64Array.from(xs);
    this.y = Float64Array.from(ys);
    this.from = Int32Array.from(from);
    this.to = Int32Array.from(to);
    this.length = Float64Array.from(lengths);
    this.line = Int32Array.from(edgeLines);
    const degree = new Int32Array(xs.length + 1);
    for (let e = 0; e < from.length; e++) {
      degree[from[e] + 1]++;
      degree[to[e] + 1]++;
    }
    for (let n = 0; n < xs.length; n++) degree[n + 1] += degree[n];
    this.start = degree;
    this.links = new Int32Array(degree[xs.length]);
    const fill = degree.slice(0, xs.length);
    for (let e = 0; e < from.length; e++) {
      this.links[fill[from[e]]++] = e;
      this.links[fill[to[e]]++] = e;
    }
    this.cell = cell;
    for (let e = 0; e < from.length; e++) {
      const ax = xs[from[e]];
      const ay = ys[from[e]];
      const bx = xs[to[e]];
      const by = ys[to[e]];
      const x0 = Math.floor(Math.min(ax, bx) / cell);
      const x1 = Math.floor(Math.max(ax, bx) / cell);
      const y0 = Math.floor(Math.min(ay, by) / cell);
      const y1 = Math.floor(Math.max(ay, by) / cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const k = key(cx, cy);
          const list = this.cells.get(k);
          if (list) list.push(e);
          else this.cells.set(k, [e]);
        }
      }
    }
    this.dist = new Float64Array(xs.length);
    this.prev = new Int32Array(xs.length);
    this.prevEdge = new Int32Array(xs.length);
    this.stamp = new Int32Array(xs.length);
  }

  get nodes(): number {
    return this.x.length;
  }

  /** The nearest point of each edge within `radius`, nearest first, without near repeats. */
  candidates(px: number, py: number, radius: number, distinct: number): Candidate[] {
    const key = (cx: number, cy: number) => (cx + 2 ** 25) * 2 ** 26 + (cy + 2 ** 25);
    const seen = new Set<number>();
    const found: Candidate[] = [];
    const reach = Math.ceil(radius / this.cell);
    const cx0 = Math.floor(px / this.cell);
    const cy0 = Math.floor(py / this.cell);
    for (let cx = cx0 - reach; cx <= cx0 + reach; cx++) {
      for (let cy = cy0 - reach; cy <= cy0 + reach; cy++) {
        for (const e of this.cells.get(key(cx, cy)) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const ax = this.x[this.from[e]];
          const ay = this.y[this.from[e]];
          const dx = this.x[this.to[e]] - ax;
          const dy = this.y[this.to[e]] - ay;
          const length2 = dx * dx + dy * dy;
          const t = length2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
          const x = ax + dx * t;
          const y = ay + dy * t;
          const distance = Math.hypot(x - px, y - py);
          if (distance <= radius) found.push({ edge: e, t, x, y, distance });
        }
      }
    }
    found.sort((a, b) => a.distance - b.distance);
    const out: Candidate[] = [];
    for (const c of found) {
      // A corner's two edges give the same point.
      if (out.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < distinct)) continue;
      out.push(c);
      if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
  }

  /**
   * Distances along the roads from a candidate to each target, up to
   * `limit`, Infinity past it. With `path`, also the nodes between the
   * candidate and the first target, and with `edges` the edge into each.
   */
  distances(source: Candidate, targets: readonly Candidate[], limit: number, path?: number[], edges?: number[]): number[] {
    const round = ++this.round;
    const heap = new MinHeap();
    const visit = (n: number, d: number, from: number, edge: number) => {
      if (d > limit) return;
      if (this.stamp[n] === round && this.dist[n] <= d) return;
      this.stamp[n] = round;
      this.dist[n] = d;
      this.prev[n] = from;
      this.prevEdge[n] = edge;
      heap.push(n, d);
    };
    const e0 = source.edge;
    visit(this.from[e0], source.t * this.length[e0], NONE, e0);
    visit(this.to[e0], (1 - source.t) * this.length[e0], NONE, e0);
    const wanted = new Set<number>();
    for (const target of targets) {
      wanted.add(this.from[target.edge]);
      wanted.add(this.to[target.edge]);
    }
    while (heap.size) {
      const [n, d] = heap.pop();
      if (this.stamp[n] !== round || d > this.dist[n]) continue;
      wanted.delete(n);
      if (!wanted.size) break;
      for (let k = this.start[n]; k < this.start[n + 1]; k++) {
        const e = this.links[k];
        const m = this.from[e] === n ? this.to[e] : this.from[e];
        visit(m, d + this.length[e], n, e);
      }
    }
    const at =(n: number) => (this.stamp[n] === round ? this.dist[n] : Infinity);
    const out: number[] = [];
    let best = Infinity;
    let bestEnd = NONE;
    targets.forEach((target, i) => {
      const e = target.edge;
      const viaFrom = at(this.from[e]) + target.t * this.length[e];
      const viaTo = at(this.to[e]) + (1 - target.t) * this.length[e];
      let d = Math.min(viaFrom, viaTo);
      let end = viaFrom <= viaTo ? this.from[e] : this.to[e];
      // Along the same edge, either way.
      if (e === e0) {
        const direct = Math.abs(target.t - source.t) * this.length[e];
        if (direct <= d) {
          d = direct;
          end = NONE;
        }
      }
      out.push(d <= limit ? d : Infinity);
      if (i === 0) {
        best = d;
        bestEnd = end;
      }
    });
    if (path && Number.isFinite(best) && bestEnd !== NONE) {
      const nodes: number[] = [];
      for (let n = bestEnd; n !== NONE; n = this.prev[n]) nodes.push(n);
      nodes.reverse();
      path.push(...nodes);
      edges?.push(...nodes.map((n) => this.prevEdge[n]));
    }
    return out;
  }
}

class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    let i = this.ids.length;
    this.ids.push(id);
    this.keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.ids[i] = this.ids[parent];
      this.keys[i] = this.keys[parent];
      i = parent;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }

  pop(): [number, number] {
    const id = this.ids[0];
    const key = this.keys[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length) {
      let i = 0;
      const n = this.ids.length;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= n) break;
        const right = left + 1;
        const child = right < n && this.keys[right] < this.keys[left] ? right : left;
        if (this.keys[child] >= lastKey) break;
        this.ids[i] = this.ids[child];
        this.keys[i] = this.keys[child];
        i = child;
      }
      this.ids[i] = lastId;
      this.keys[i] = lastKey;
    }
    return [id, key];
  }
}

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
  const graph = new Graph(near.lines, near.sources, JOIN_M * u, radius);
  if (!graph.nodes) return unmatched(track);
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
