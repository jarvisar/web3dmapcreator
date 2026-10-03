// The roads and paths as a graph, for matching a recorded track to them
// (snap.ts) and for routing along them in the route editor. Junctions are
// where lines share a vertex, which is how Overture's segments meet, or
// where a line ends part way along another. Bridges and tunnels only meet
// what they share a vertex with, so nothing drops off a deck onto the road
// under it.
//
// Works in any flat units.

import type { Vec2 } from '../types';

// Up to this many candidates on different edges near a point.
const MAX_CANDIDATES = 8;

export const NONE = -1;

export interface Candidate {
  edge: number;
  /** Along the edge from its first node, 0 to 1. */
  t: number;
  x: number;
  y: number;
  distance: number;
}

const cellKey = (cx: number, cy: number) => (cx + 2 ** 25) * 2 ** 26 + (cy + 2 ** 25);

/** A graph as plain arrays, to build it in a worker and post it. */
export interface GraphParts {
  x: Float64Array;
  y: Float64Array;
  from: Int32Array;
  to: Int32Array;
  length: Float64Array;
  line: Int32Array;
  start: Int32Array;
  links: Int32Array;
  /** Grid cells with edges in them, and each one's edges, CSR. */
  cellKeys: Float64Array;
  cellStart: Int32Array;
  cellEdges: Int32Array;
  cell: number;
}

export class RoadGraph {
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
  private readonly cellKeys: Float64Array;
  private readonly cellStart: Int32Array;
  private readonly cellEdges: Int32Array;
  private readonly cellSlot = new Map<number, number>();
  private readonly cell: number;
  // Reused between searches: distances are only valid where stamp matches.
  private readonly dist: Float64Array;
  private readonly prev: Int32Array;
  private readonly prevEdge: Int32Array;
  private readonly stamp: Int32Array;
  private round = 0;

  constructor(parts: GraphParts) {
    this.x = parts.x;
    this.y = parts.y;
    this.from = parts.from;
    this.to = parts.to;
    this.length = parts.length;
    this.line = parts.line;
    this.start = parts.start;
    this.links = parts.links;
    this.cellKeys = parts.cellKeys;
    this.cellStart = parts.cellStart;
    this.cellEdges = parts.cellEdges;
    this.cell = parts.cell;
    for (let i = 0; i < parts.cellKeys.length; i++) this.cellSlot.set(parts.cellKeys[i], i);
    const nodes = parts.x.length;
    this.dist = new Float64Array(nodes);
    this.prev = new Int32Array(nodes);
    this.prevEdge = new Int32Array(nodes);
    this.stamp = new Int32Array(nodes);
  }

  /** Copies of the arrays, for posting the graph elsewhere. */
  parts(): GraphParts {
    return {
      x: this.x.slice(),
      y: this.y.slice(),
      from: this.from.slice(),
      to: this.to.slice(),
      length: this.length.slice(),
      line: this.line.slice(),
      start: this.start.slice(),
      links: this.links.slice(),
      cellKeys: this.cellKeys.slice(),
      cellStart: this.cellStart.slice(),
      cellEdges: this.cellEdges.slice(),
      cell: this.cell,
    };
  }

  /**
   * The graph of these lines. Vertices within `join` are one node, `sources`
   * gives each line's source for `line`, and edges are found near a point
   * through a grid of `cell`.
   */
  static build(lines: readonly Vec2[][], sources: readonly number[], join: number, cell: number): RoadGraph {
    const xs: number[] = [];
    const ys: number[] = [];
    const grid = new Map<number, number[]>();
    const key = cellKey;
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
    const degree = new Int32Array(xs.length + 1);
    for (let e = 0; e < from.length; e++) {
      degree[from[e] + 1]++;
      degree[to[e] + 1]++;
    }
    for (let n = 0; n < xs.length; n++) degree[n + 1] += degree[n];
    const links = new Int32Array(degree[xs.length]);
    const fill = degree.slice(0, xs.length);
    for (let e = 0; e < from.length; e++) {
      links[fill[from[e]]++] = e;
      links[fill[to[e]]++] = e;
    }
    const cells = new Map<number, number[]>();
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
          const list = cells.get(k);
          if (list) list.push(e);
          else cells.set(k, [e]);
        }
      }
    }
    const cellKeys = new Float64Array(cells.size);
    const cellStart = new Int32Array(cells.size + 1);
    let total = 0;
    for (const list of cells.values()) total += list.length;
    const cellEdges = new Int32Array(total);
    let slot = 0;
    let at = 0;
    for (const [k, list] of cells) {
      cellKeys[slot] = k;
      cellStart[slot] = at;
      cellEdges.set(list, at);
      at += list.length;
      slot++;
    }
    cellStart[slot] = at;
    return new RoadGraph({
      x: Float64Array.from(xs),
      y: Float64Array.from(ys),
      from: Int32Array.from(from),
      to: Int32Array.from(to),
      length: Float64Array.from(lengths),
      line: Int32Array.from(edgeLines),
      start: degree,
      links,
      cellKeys,
      cellStart,
      cellEdges,
      cell,
    });
  }

  get nodes(): number {
    return this.x.length;
  }

  /** The nearest point of each edge within `radius`, nearest first, without near repeats. */
  candidates(px: number, py: number, radius: number, distinct: number): Candidate[] {
    const seen = new Set<number>();
    const found: Candidate[] = [];
    const reach = Math.ceil(radius / this.cell);
    const cx0 = Math.floor(px / this.cell);
    const cy0 = Math.floor(py / this.cell);
    for (let cx = cx0 - reach; cx <= cx0 + reach; cx++) {
      for (let cy = cy0 - reach; cy <= cy0 + reach; cy++) {
        const slot = this.cellSlot.get(cellKey(cx, cy));
        if (slot === undefined) continue;
        for (let k = this.cellStart[slot]; k < this.cellStart[slot + 1]; k++) {
          const e = this.cellEdges[k];
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

/** The nearest spot on the roads within `reach` of a point, or null. */
export function nearestRoad(graph: RoadGraph, x: number, y: number, reach: number): Candidate | null {
  return graph.candidates(x, y, reach, 0)[0] ?? null;
}

/**
 * The shortest way along the roads from one spot to another, as a line from
 * a's point to b's. Null when they aren't joined within `limit`.
 */
export function routeBetween(graph: RoadGraph, a: Candidate, b: Candidate, limit: number): Vec2[] | null {
  const nodes: number[] = [];
  const [d] = graph.distances(a, [b], limit, nodes);
  if (!Number.isFinite(d)) return null;
  const out: Vec2[] = [[a.x, a.y]];
  for (const n of nodes) out.push([graph.x[n], graph.y[n]]);
  out.push([b.x, b.y]);
  return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-9);
}
