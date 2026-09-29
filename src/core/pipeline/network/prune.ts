// Removing what leads nowhere, on a graph of the lines as they'll print:
// nodes where an end lands inside another ribbon or two centerlines cross,
// edges between them. Judging spurs from their loose end to the first
// junction catches the kerb stub of a dropped crossing and the tail a path
// leaves past a street as well as whole fragments.
//
// - A spur whose loose end met something that's gone goes when less than a
//   stub of it shows past the junction.
// - A spur ending in a real dead end stays, unless less of it shows than its
//   own width: a bump, not a street.
// - Whatever touches nothing and is shorter than an island in total goes.
//
// Removing a spur can leave the line it hung from loose, so the queue
// revisits that junction. Ends on the model's edge are never loose.

import { cumulative, SegmentIndex, slice } from './lines';
import type { Candidate, EndOrigin, Part } from './routes';

export interface PruneOptions {
  stub: number;
  island: number;
  tolerance: number;
}

export interface PruneResult {
  parts: Part[];
  stubs: number;
  nubs: number;
  islands: number;
}

interface Edge {
  part: number;
  from: number;
  to: number;
  a: number;
  b: number;
  length: number;
  live: boolean;
}

export function prune(input: Part[], candidates: Candidate[], options: PruneOptions): PruneResult {
  const { stub, island, tolerance } = options;
  const parts = input.filter((p) => p.points.length >= 2);
  const cums = parts.map((p) => cumulative(p.points));
  const lengths = cums.map((c) => c[c.length - 1]);
  const halfWidth = (part: number) => candidates[parts[part].source].halfWidth;
  const deck = (part: number) => candidates[parts[part].source].deck;
  const maxHalfWidth = parts.reduce((m, _p, i) => Math.max(m, halfWidth(i)), 0);
  const index = new SegmentIndex(Math.max(maxHalfWidth, tolerance, 0.1));
  parts.forEach((p, i) => index.add(p.points, i));

  const parent: number[] = [];
  const node = () => parent.push(parent.length) - 1;
  const find = (n: number): number => {
    while (parent[n] !== n) n = parent[n] = parent[parent[n]];
    return n;
  };
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const stops: { s: number; node: number }[][] = parts.map(() => []);
  const endNode = parts.map((_p, i): [number, number] => {
    const ends: [number, number] = [node(), node()];
    stops[i].push({ s: 0, node: ends[0] }, { s: lengths[i], node: ends[1] });
    return ends;
  });

  // Ends landing inside another ribbon. A deck only meets the ground where
  // their lines meet: a road passing under it doesn't.
  parts.forEach((p, i) => {
    for (const end of [0, 1] as const) {
      const [x, y] = end ? p.points[p.points.length - 1] : p.points[0];
      const best = new Map<number, { d: number; s: number }>();
      index.near(x, y, (s) => {
        const j = index.owner[s];
        if (j === i) return;
        const reach = deck(i) === deck(j) ? Math.max(halfWidth(j), tolerance) : tolerance;
        const t = Math.min(1, Math.max(0, index.along(s, x, y)));
        const d = index.distance(s, x, y, t);
        if (d > reach) return;
        const found = best.get(j);
        if (!found || d < found.d) best.set(j, { d, s: index.from[s] + t * index.length[s] });
      });
      for (const [j, { s }] of best) {
        const n = node();
        stops[j].push({ s, node: n });
        join(n, endNode[i][end]);
      }
    }
  });

  // Centerlines crossing or touching mid-span, as at an Overture connector
  // two segments both carry on through.
  for (let s = 0; s < index.size; s++) {
    const i = index.owner[s];
    const count = Math.max(1, Math.ceil(index.length[s] / (index.cell / 2)));
    const tested = new Set<number>();
    for (let k = 0; k <= count; k++) {
      const x = index.ax[s] + ((index.bx[s] - index.ax[s]) * k) / count;
      const y = index.ay[s] + ((index.by[s] - index.ay[s]) * k) / count;
      index.near(x, y, (r) => {
        const j = index.owner[r];
        if (j <= i || deck(i) !== deck(j) || tested.has(r)) return;
        tested.add(r);
        const hit = touch(index, s, r, tolerance);
        if (!hit) return;
        const n = node();
        const m = node();
        stops[i].push({ s: index.from[s] + hit[0] * index.length[s], node: n });
        stops[j].push({ s: index.from[r] + hit[1] * index.length[r], node: m });
        join(n, m);
      });
    }
  }

  // Edges between consecutive stops along each part.
  const edges: Edge[] = [];
  const byPart: number[][] = parts.map(() => []);
  parts.forEach((_p, i) => {
    const list = stops[i].sort((a, b) => a.s - b.s);
    let current = list[0];
    for (let k = 1; k < list.length; k++) {
      const next = list[k];
      if (next.s - current.s <= tolerance) {
        join(next.node, current.node);
        continue;
      }
      byPart[i].push(edges.length);
      edges.push({ part: i, from: current.s, to: next.s, a: current.node, b: next.node, length: next.s - current.s, live: true });
      current = next;
    }
  });
  const degree = new Map<number, number>();
  const at = new Map<number, number[]>();
  edges.forEach((e, k) => {
    e.a = find(e.a);
    e.b = find(e.b);
    for (const n of [e.a, e.b]) {
      degree.set(n, (degree.get(n) ?? 0) + 1);
      const list = at.get(n);
      if (list) list.push(k);
      else at.set(n, [k]);
    }
  });

  // What a loose end met in the source. Anything that was a junction, or
  // has lost an edge, met something that's gone.
  const anchored = new Set<number>();
  const origin = new Map<number, EndOrigin>();
  parts.forEach((p, i) => {
    for (const end of [0, 1] as const) {
      const n = find(endNode[i][end]);
      if (p.ends[end] === 'edge') anchored.add(n);
      origin.set(n, degree.get(n) === 1 ? p.ends[end] : 'met');
    }
  });
  const remove = (e: Edge) => {
    e.live = false;
    for (const n of [e.a, e.b]) {
      degree.set(n, degree.get(n)! - 1);
      origin.set(n, 'met');
    }
  };

  let stubs = 0;
  let nubs = 0;
  const queue = [...degree.keys()].filter((n) => degree.get(n) === 1);
  while (queue.length) {
    const start = queue.pop()!;
    if (degree.get(start) !== 1 || anchored.has(start)) continue;
    // From the loose end through plain joints to the first junction.
    const spur = new Set<number>();
    let n = start;
    let length = 0;
    for (;;) {
      const k = at.get(n)!.find((k) => edges[k].live && !spur.has(k));
      if (k === undefined) break;
      spur.add(k);
      length += edges[k].length;
      n = edges[k].a === n ? edges[k].b : edges[k].a;
      if (n === start || anchored.has(n) || degree.get(n) !== 2) break;
    }
    if (!spur.size) continue;
    const junction = degree.get(n)! >= 3;
    let shown = length;
    if (junction) {
      let widest = 0;
      for (const k of at.get(n)!) if (edges[k].live && !spur.has(k)) widest = Math.max(widest, halfWidth(edges[k].part));
      shown -= widest;
    }
    const kind = origin.get(start) ?? 'met';
    const first = edges[spur.values().next().value!];
    const isStub = (kind === 'met' || kind === 'portal') && shown < stub;
    const isNub = kind === 'dead' && junction && shown < 2 * halfWidth(first.part);
    if (!isStub && !isNub) continue;
    if (isStub) stubs++;
    else nubs++;
    for (const k of spur) remove(edges[k]);
    if (degree.get(n) === 1) queue.push(n);
  }

  // Islands: whatever touches nothing on the model's edge and is too short
  // in total to read as a line.
  const group = Int32Array.from(parent, (_p, i) => i);
  const top = (n: number): number => {
    while (group[n] !== n) n = group[n] = group[group[n]];
    return n;
  };
  for (const e of edges) {
    if (!e.live) continue;
    const ra = top(e.a);
    const rb = top(e.b);
    if (ra !== rb) group[ra] = rb;
  }
  const total = new Map<number, number>();
  for (const e of edges) if (e.live) total.set(top(e.a), (total.get(top(e.a)) ?? 0) + e.length);
  const held = new Set<number>();
  for (const n of anchored) held.add(top(n));
  const small = new Set<number>();
  for (const [r, length] of total) if (!held.has(r) && length < island) small.add(r);
  for (const e of edges) if (e.live && small.has(top(e.a))) e.live = false;

  // What's left of each part, as runs of live edges.
  const out: Part[] = [];
  parts.forEach((p, i) => {
    const live = byPart[i].map((k) => edges[k]).filter((e) => e.live);
    let k = 0;
    while (k < live.length) {
      const from = live[k].from;
      let to = live[k].to;
      while (k + 1 < live.length && live[k + 1].from - to <= tolerance) to = live[++k].to;
      k++;
      const startsAtEnd = from <= tolerance;
      const reachesEnd = to >= lengths[i] - tolerance;
      const points = startsAtEnd && reachesEnd ? p.points : slice(p.points, cums[i], from, to);
      if (points.length < 2) continue;
      out.push({ source: p.source, points, ends: [startsAtEnd ? p.ends[0] : 'met', reachesEnd ? p.ends[1] : 'met'] });
    }
  });
  return { parts: out, stubs, nubs, islands: small.size };
}

/** Where segments s and r cross or pass within `tolerance`, as positions along each. */
function touch(index: SegmentIndex, s: number, r: number, tolerance: number): [number, number] | null {
  const ax = index.ax[s];
  const ay = index.ay[s];
  const dx = index.bx[s] - ax;
  const dy = index.by[s] - ay;
  const cx = index.ax[r];
  const cy = index.ay[r];
  const ex = index.bx[r] - cx;
  const ey = index.by[r] - cy;
  const denominator = dx * ey - dy * ex;
  if (Math.abs(denominator) > 1e-12) {
    const t = ((cx - ax) * ey - (cy - ay) * ex) / denominator;
    const u = ((cx - ax) * dy - (cy - ay) * dx) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return [t, u];
  }
  // Not crossing: the closest approach is at one of the four ends.
  const options: [number, number, number][] = [];
  const project = (onto: number, x: number, y: number) => {
    const t = Math.min(1, Math.max(0, index.along(onto, x, y)));
    return [t, index.distance(onto, x, y, t)];
  };
  for (const [fixed, x, y] of [[0, ax, ay], [1, index.bx[s], index.by[s]]]) {
    const [t, d] = project(r, x, y);
    options.push([fixed, t, d]);
  }
  for (const [fixed, x, y] of [[0, cx, cy], [1, index.bx[r], index.by[r]]]) {
    const [t, d] = project(s, x, y);
    options.push([t, fixed, d]);
  }
  let best: [number, number, number] | null = null;
  for (const option of options) if (option[2] <= tolerance && (!best || option[2] < best[2])) best = option;
  return best ? [best[0], best[1]] : null;
}
