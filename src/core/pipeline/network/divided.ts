// Merging the two carriageways of a divided road into one line down its
// middle.
//
// Overture maps a divided road as two one-way lines, one each way. When the
// ground between them is too thin to print, the two ribbons print as one wide
// road with a hairline down it. They're replaced by the line halfway between
// them: the longer carriageway moves onto the middle and the other goes. Only
// clear pairs merge: one-way lines of the same class and subclass travelling
// opposite ways side by side, nothing as important between them, each the
// other's only partner. A tram or footway in the median doesn't count: it
// runs inside the merged road afterwards and cull.ts drops it. Anything less
// clear (three carriageways, a two-way street beside a one-way one, a car
// park's aisles) keeps its lines, and the gap fill prints them as one wide
// road.
//
// Junctions move with the road. A street meeting or crossing the pair slides
// along its own line onto the middle, so straight streets stay straight and
// the stub of a cross street across the median shrinks away. Carriageways
// that part again bend in to the end of the merged line like a fork. The
// first version kept junctions where they were and bent the moved line back
// to each of them, which zigzagged divided streets at every cross street.

import type { Vec2 } from '../../types';
import { dedupe, polylineLength } from '../linework';
import { cumulative, intervals, pointAt, SegmentIndex, simplifyIndices, slice } from './lines';
import { Nodes, type Candidate, type EndOrigin, type Part } from './routes';

const STREET_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']);
const PAIR_SUBCLASSES = new Set(['', 'link']);
const PARALLEL_DEG = 25;
const STEP_MM = 0.1;
// Shorter doubled stretches are left to the gap fill: the gore of a fork, a
// splitter island at a crossing.
const MIN_PAIR_MM = 1.2;
// A pair starts where the ground between the carriageways is thinner than
// the gap, and carries on until it's this many times wider. Medians hovering
// around the limit otherwise merged for a block and forked again.
const HYSTERESIS = 1.5;
// Breaks in a pair this short are bridged, like the samples at a junction.
const BRIDGE_MM = 0.5;
// Stretch ends this close to a junction move to it, so the merged line
// reaches the cross street instead of bending in just short of it.
const SNAP_MM = 0.6;
// Where the two carriageways meet again within this, as at the fork where a
// divided stretch leaves a two-way road, the merged line runs on to that
// node instead of bending in on each arm of the fork.
const FORK_MM = 4;
// Lines meeting the pair at least this steeply slide along themselves onto
// the middle. Shallower ones, like carriageways parting at a fork, bend in.
const SLIDE_DEG = 35;
// A bend-in runs over this many times the distance the end moves.
const BEND_RATIO = 3;
const MIDLINE_TOLERANCE_MM = 0.01;
// Crossing divided roads merge one per round.
const ROUNDS = 4;
const EPSILON = 1e-7;

interface Member {
  part: number;
  /** The part's points run against the direction of travel. */
  reversed: boolean;
  from: number;
  to: number;
}

interface Chain {
  members: Member[];
  points: Vec2[];
  cum: number[];
  length: number;
  kind: string;
}

interface Stretch {
  x: number;
  y: number;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

export interface MergeResult {
  pairs: number;
  droppedMm: number;
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function closest(points: Vec2[], p: Vec2): { point: Vec2; distance: number; segment: number; t: number } {
  let best = { point: points[0], distance: dist(points[0], p), segment: 0, t: 0 };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const q: Vec2 = [a[0] + dx * t, a[1] + dy * t];
    const d = dist(q, p);
    if (d < best.distance) best = { point: q, distance: d, segment: i - 1, t };
  }
  return best;
}

// Nearest points on one line through a grid of its segments. Answers are
// exact within `reach`, and further out found the slow way.
class Lookup {
  private readonly index: SegmentIndex;
  private readonly cum: number[];

  constructor(
    private readonly points: Vec2[],
    reach: number,
  ) {
    this.index = new SegmentIndex(Math.max(reach, 0.05));
    this.index.add(points, 0);
    this.cum = cumulative(points);
  }

  nearest(p: Vec2): { point: Vec2; distance: number; arc: number } {
    const index = this.index;
    let best: { point: Vec2; distance: number; arc: number } | null = null;
    index.near(p[0], p[1], (s) => {
      const t = Math.max(0, Math.min(1, index.along(s, p[0], p[1])));
      const d = index.distance(s, p[0], p[1], t);
      if (!best || d < best.distance) best = { point: index.closest(s, p[0], p[1]), distance: d, arc: index.from[s] + t * index.length[s] };
    });
    if (best && (best as { distance: number }).distance <= index.cell) return best;
    const c = closest(this.points, p);
    return { point: c.point, distance: c.distance, arc: this.cum[c.segment] + c.t * (this.cum[c.segment + 1] - this.cum[c.segment]) };
  }
}

// Unit direction from a line's end into the line, looking a little way in so
// a short last segment doesn't decide it.
function inward(points: Vec2[], atStart: boolean): Vec2 | null {
  const n = points.length;
  const e = atStart ? points[0] : points[n - 1];
  for (let k = 1; k < n; k++) {
    const v = atStart ? points[k] : points[n - 1 - k];
    const d = dist(v, e);
    if (d >= 0.15 || k === n - 1) return d > 1e-9 ? [(v[0] - e[0]) / d, (v[1] - e[1]) / d] : null;
  }
  return null;
}

// Move a line's end to `target`, easing the move out over a stretch of the
// line, so the rest keeps its place and a curved ramp keeps its curve. A
// line shorter than the stretch eases out over its whole length.
function bendIn(points: Vec2[], atStart: boolean, target: Vec2): Vec2[] {
  const pts = atStart ? points : [...points].reverse();
  const dx = target[0] - pts[0][0];
  const dy = target[1] - pts[0][1];
  const offset = Math.hypot(dx, dy);
  if (offset <= EPSILON) return points;
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  const reach = Math.min(Math.max(BEND_RATIO * offset, 0.25), total);
  const out: Vec2[] = [];
  for (let k = 0; k < pts.length; k++) {
    if (cum[k] >= reach) {
      if (cum[k] > reach + EPSILON) out.push(pointAt(pts, cum, reach));
      out.push(...pts.slice(k));
      break;
    }
    const f = 1 - cum[k] / reach;
    out.push([pts[k][0] + dx * f, pts[k][1] + dy * f]);
  }
  const line = dedupe(out, 1e-6);
  return atStart ? line : line.reverse();
}

// Trim or extend a line's end along itself to where it meets the line
// through `p` along `u`, then put the end exactly on `target`.
function slideEnd(points: Vec2[], atStart: boolean, p: Vec2, u: Vec2, target: Vec2): Vec2[] | null {
  const pts = atStart ? points : [...points].reverse();
  const side = (q: Vec2) => cross(u, sub(q, p));
  const s0 = side(pts[0]);
  let out: Vec2[] | null = null;
  const direction = inward(pts, true);
  if (!direction) return null;
  // Whether the line through p lies ahead, into the line, or behind its end.
  const denominator = cross(direction, u);
  if (Math.abs(denominator) < 1e-9) return null;
  const t = cross(sub(p, pts[0]), u) / denominator;
  if (t <= 0) {
    out = [target, ...pts];
  } else {
    for (let k = 0; k < pts.length - 1; k++) {
      const sa = k === 0 ? s0 : side(pts[k]);
      const sb = side(pts[k + 1]);
      if (sa === 0 || sa * sb > 0) continue;
      const f = sa / (sa - sb);
      const hit: Vec2 = [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f];
      if (dist(hit, target) > 0.05) return null;
      out = [target, ...pts.slice(k + 1)];
      break;
    }
  }
  if (!out) return null;
  out = dedupe(out, 1e-6);
  if (out.length < 2) return null;
  // Extended straight on, the old end is just a point along the way.
  if (out.length >= 3 && Math.abs(cross(sub(out[1], out[0]), sub(out[2], out[0]))) <= 1e-6 * dist(out[0], out[2])) out.splice(1, 1);
  return atStart ? out : out.reverse();
}

// A closed ring as an open line running the same way as `line`, starting at
// the point of the ring closest to the start of `line`.
function unroll(ring: Vec2[], line: Vec2[]): Vec2[] {
  const open = ring.slice(0, -1);
  const c = closest(ring, line[0]);
  const next = line[Math.min(1, line.length - 1)];
  const a = ring[c.segment];
  const b = ring[c.segment + 1];
  const same = (b[0] - a[0]) * (next[0] - line[0][0]) + (b[1] - a[1]) * (next[1] - line[0][1]) >= 0;
  const k = c.segment + 1;
  const rotated = [c.point, ...open.slice(k % open.length), ...open.slice(0, k % open.length), c.point];
  return dedupe(same ? rotated : rotated.reverse(), 1e-9);
}

// Halfway from each point to its closest point on a line, the closest points
// kept in order along the line.
function halfway(points: Vec2[], line: Vec2[], lineCum: number[], reach: number): Vec2[] {
  const lookup = new Lookup(line, reach);
  const along = points.map((p) => lookup.nearest(p).arc);
  const falling = along[along.length - 1] < along[0];
  for (let k = 1; k < along.length; k++) along[k] = falling ? Math.min(along[k], along[k - 1]) : Math.max(along[k], along[k - 1]);
  return points.map((p, k): Vec2 => {
    const q = pointAt(line, lineCum, along[k]);
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  });
}

export function mergeDivided(parts: Part[], candidates: Candidate[], gap: number, tolerance: number): MergeResult {
  let pairs = 0;
  let droppedMm = 0;
  // After the first round only chains near what changed are looked at again.
  let dirty: Set<Part> | null = null;
  for (let round = 0; round < ROUNDS; round++) {
    const merged = mergeRound(parts, candidates, gap, tolerance, dirty);
    // Parts removed this round are left empty until here, so indices stay put.
    const alive = parts.filter((p) => p.points.length >= 2);
    parts.splice(0, parts.length, ...alive);
    if (!merged.pairs) break;
    pairs += merged.pairs;
    droppedMm += merged.droppedMm;
    dirty = merged.dirty;
  }
  return { pairs, droppedMm };
}

function mergeRound(parts: Part[], candidates: Candidate[], gap: number, tolerance: number, dirty: Set<Part> | null): MergeResult & { dirty: Set<Part> } {
  const eligible = parts.map((p) => {
    const c = candidates[p.source];
    return (
      !p.merged && p.points.length >= 2 && !c.deck && !c.minor && c.oneway !== 0 && STREET_CLASSES.has(c.piece.roadClass) && PAIR_SUBCLASSES.has(c.piece.subclass)
    );
  });
  const next = new Set<Part>();
  if (!eligible.some(Boolean)) return { pairs: 0, droppedMm: 0, dirty: next };
  const { chains, chainOf, memberOf } = buildChains(parts, candidates, eligible, tolerance);
  const wanted = chains.map((chain) => dirty === null || chain.members.some((m) => dirty.has(parts[m.part])));
  const stretches = findStretches(parts, candidates, chains, chainOf, memberOf, gap, wanted);
  if (!stretches.length) return { pairs: 0, droppedMm: 0, dirty: next };

  // Every part's ends, to find what meets a pair.
  const cell = 0.5;
  const ends = new Map<number, { part: number; atStart: boolean }[]>();
  const key = (cx: number, cy: number) => (cx + 1048576) * 2097152 + (cy + 1048576);
  parts.forEach((p, i) => {
    if (p.points.length < 2) return;
    for (const atStart of [true, false]) {
      const [x, y] = atStart ? p.points[0] : p.points[p.points.length - 1];
      const k = key(Math.floor(x / cell), Math.floor(y / cell));
      const list = ends.get(k);
      if (list) list.push({ part: i, atStart });
      else ends.set(k, [{ part: i, atStart }]);
    }
  });
  const endsNear = (box: [number, number, number, number]) => {
    const out: { part: number; atStart: boolean }[] = [];
    for (let cx = Math.floor(box[0] / cell); cx <= Math.floor(box[2] / cell); cx++) {
      for (let cy = Math.floor(box[1] / cell); cy <= Math.floor(box[3] / cell); cy++) out.push(...(ends.get(key(cx, cy)) ?? []));
    }
    return out;
  };

  const corridor = gap + 2 * candidates.reduce((m, c) => Math.max(m, c.halfWidth), 0);
  const touched = new Set<number>();
  let pairs = 0;
  let droppedMm = 0;
  const count = parts.length;
  for (const stretch of stretches) {
    const dropped = applyStretch(stretch, parts, chains, endsNear, touched, tolerance, corridor);
    if (dropped === null) continue;
    if (dropped === 'conflict') {
      // Deferred to the next round.
      for (const m of [...chains[stretch.x].members, ...chains[stretch.y].members]) next.add(parts[m.part]);
      continue;
    }
    pairs++;
    droppedMm += dropped;
  }
  for (const i of touched) next.add(parts[i]);
  for (let i = count; i < parts.length; i++) next.add(parts[i]);
  return { pairs, droppedMm, dirty: next };
}

function buildChains(parts: Part[], candidates: Candidate[], eligible: boolean[], tolerance: number) {
  const nodes = new Nodes(tolerance);
  const travel = (i: number) => (candidates[parts[i].source].oneway > 0 ? parts[i].points : [...parts[i].points].reverse());
  const startNode: number[] = [];
  const endNode: number[] = [];
  const leaving = new Map<number, number[]>();
  const arriving = new Map<number, number[]>();
  const push = (map: Map<number, number[]>, node: number, i: number) => {
    const list = map.get(node);
    if (list) list.push(i);
    else map.set(node, [i]);
  };
  parts.forEach((_p, i) => {
    if (!eligible[i]) return;
    const pts = travel(i);
    startNode[i] = nodes.id(pts[0]);
    endNode[i] = nodes.id(pts[pts.length - 1]);
    push(leaving, startNode[i], i);
    push(arriving, endNode[i], i);
  });
  const direction = (pts: Vec2[], atEnd: boolean): Vec2 | null => {
    const n = pts.length;
    const [a, b] = atEnd ? [pts[n - 2], pts[n - 1]] : [pts[0], pts[1]];
    const d = dist(a, b);
    return d > 1e-12 ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : null;
  };
  // The one option carrying on within 60 degrees, or within 30 when there
  // are several.
  const pick = (heading: Vec2 | null, options: number[], headingOf: (i: number) => Vec2 | null) => {
    if (!heading || !options.length) return -1;
    const scored = options.map((i) => {
      const h = headingOf(i);
      return { i, cos: h ? heading[0] * h[0] + heading[1] * h[1] : -1 };
    });
    scored.sort((a, b) => b.cos - a.cos);
    if (scored.length === 1) return scored[0].cos >= 0.5 ? scored[0].i : -1;
    return scored[0].cos >= 0.866 && scored[1].cos < 0.866 ? scored[0].i : -1;
  };

  const kind = (i: number) => candidates[parts[i].source].kind;
  const used = new Set<number>();
  const chains: Chain[] = [];
  const chainOf = new Int32Array(parts.length).fill(-1);
  const memberOf = new Int32Array(parts.length).fill(-1);
  const order = parts.map((_p, i) => i).filter((i) => eligible[i]);
  const lengths = parts.map((p) => polylineLength(p.points));
  order.sort((a, b) => lengths[b] - lengths[a] || a - b);
  for (const start of order) {
    if (used.has(start)) continue;
    used.add(start);
    const chain = [start];
    for (;;) {
      const last = chain[chain.length - 1];
      const options = (leaving.get(endNode[last]) ?? []).filter((i) => !used.has(i) && kind(i) === kind(start));
      const next = pick(direction(travel(last), true), options, (i) => direction(travel(i), false));
      if (next < 0) break;
      used.add(next);
      chain.push(next);
    }
    for (;;) {
      const first = chain[0];
      const options = (arriving.get(startNode[first]) ?? []).filter((i) => !used.has(i) && kind(i) === kind(start));
      const back = direction(travel(first), false);
      const previous = pick(back && [-back[0], -back[1]], options, (i) => {
        const d = direction(travel(i), true);
        return d && [-d[0], -d[1]];
      });
      if (previous < 0) break;
      used.add(previous);
      chain.unshift(previous);
    }
    const points: Vec2[] = [];
    const bounds: number[] = [];
    for (const i of chain) {
      const pts = travel(i);
      for (let k = points.length ? 1 : 0; k < pts.length; k++) points.push(pts[k]);
      bounds.push(points.length - 1);
    }
    const cum = cumulative(points);
    let vertex = 0;
    const members = chain.map((i, n): Member => {
      const member = { part: i, reversed: candidates[parts[i].source].oneway < 0, from: cum[vertex], to: cum[bounds[n]] };
      vertex = bounds[n];
      return member;
    });
    const id = chains.length;
    chain.forEach((i, n) => {
      chainOf[i] = id;
      memberOf[i] = n;
    });
    chains.push({ members, points, cum, length: cum[cum.length - 1], kind: kind(start) });
  }
  return { chains, chainOf, memberOf };
}

function findStretches(
  parts: Part[],
  candidates: Candidate[],
  chains: Chain[],
  chainOf: Int32Array,
  memberOf: Int32Array,
  gap: number,
  wanted: boolean[],
): Stretch[] {
  const maxHalfWidth = parts.reduce((m, p) => Math.max(m, candidates[p.source].halfWidth), 0);
  const index = new SegmentIndex(Math.max(HYSTERESIS * gap + 2 * maxHalfWidth, 0.1));
  parts.forEach((p, i) => {
    if (p.points.length >= 2 && !candidates[p.source].deck) index.add(p.points, i);
  });
  const cosParallel = Math.cos((PARALLEL_DEG * Math.PI) / 180);

  // Where a spot on one of a part's segments lies along its chain.
  const arcOnChain = (part: number, segment: number, t: number) => {
    const member = chains[chainOf[part]].members[memberOf[part]];
    const local = index.from[segment] + t * index.length[segment];
    return member.reversed ? member.to - local : member.from + local;
  };

  const steps = chains.map((c) => Math.max(1, Math.ceil(c.length / STEP_MM)));
  const partner: Int32Array[] = [];
  const partnerArc: Float64Array[] = [];
  // Closer than the gap, not just within the hysteresis.
  const strict: Uint8Array[] = [];
  const sample = (c: number) => {
    if (partner[c]) return;
    const chain = chains[c];
    const count = steps[c];
    partner[c] = new Int32Array(count).fill(-1);
    partnerArc[c] = new Float64Array(count);
    strict[c] = new Uint8Array(count);
    const samples = intervals(chain.points, chain.cum, count);
    let m = 0;
    for (let k = 0; k < count; k++) {
      const s = ((k + 0.5) * chain.length) / count;
      while (m < chain.members.length - 1 && chain.members[m].to < s) m++;
      const own = candidates[parts[chain.members[m].part].source];
      const halfWidth = own.halfWidth;
      const { x, y, ux, uy } = samples[k];
      const nearest = [Infinity, Infinity];
      const mate = [
        { lateral: Infinity, chain: -1, arc: 0, strict: false },
        { lateral: Infinity, chain: -1, arc: 0, strict: false },
      ];
      index.near(x, y, (seg) => {
        const o = index.owner[seg];
        if (chainOf[o] === c) return;
        const t = index.along(seg, x, y);
        if ((t <= 0 && index.first[seg]) || (t >= 1 && index.last[seg])) return;
        const cos = ux * index.ux[seg] + uy * index.uy[seg];
        if (Math.abs(cos) < cosParallel) return;
        if (!index.beside(seg, x, y, ux, uy)) return;
        const f = Math.max(0, Math.min(1, t));
        const qx = index.ax[seg] + (index.bx[seg] - index.ax[seg]) * f;
        const qy = index.ay[seg] + (index.by[seg] - index.ay[seg]) * f;
        const lateral = (qx - x) * -uy + (qy - y) * ux;
        const other = candidates[parts[o].source];
        const edgeGap = Math.hypot(qx - x, qy - y) - halfWidth - other.halfWidth;
        if (edgeGap >= HYSTERESIS * gap) return;
        const side = lateral >= 0 ? 0 : 1;
        const away = Math.abs(lateral);
        if (other.rank <= own.rank) nearest[side] = Math.min(nearest[side], away);
        const oc = chainOf[o];
        if (oc < 0 || chains[oc].kind !== chain.kind) return;
        // Travelling the other way.
        if (cos * other.oneway > -cosParallel) return;
        if (away < mate[side].lateral) mate[side] = { lateral: away, chain: oc, arc: arcOnChain(o, seg, f), strict: edgeGap < gap };
      });
      // The nearest line on its side, and no rival on the other.
      const open = [0, 1].filter((side) => mate[side].chain >= 0 && mate[side].lateral <= nearest[side] + 1e-9);
      if (open.length !== 1) continue;
      partner[c][k] = mate[open[0]].chain;
      partnerArc[c][k] = mate[open[0]].arc;
      strict[c][k] = mate[open[0]].strict ? 1 : 0;
    }
  };
  const sampled: number[] = [];
  chains.forEach((_chain, c) => {
    if (!wanted[c]) return;
    sample(c);
    sampled.push(c);
  });
  // And whatever they found beside them, to check it's mutual.
  for (const c of [...sampled]) {
    for (const d of new Set(partner[c])) {
      if (d < 0 || partner[d]) continue;
      sample(d);
      sampled.push(d);
    }
  }

  // Each the other's partner.
  const mutual: number[][] = [];
  for (const c of sampled) {
    mutual[c] = Array.from(partner[c], (d, k) => {
      if (d < 0 || !partner[d]) return -1;
      const kd = Math.floor((partnerArc[c][k] / chains[d].length) * steps[d]);
      for (let j = Math.max(0, kd - 1); j <= Math.min(steps[d] - 1, kd + 1); j++) if (partner[d][j] === c) return d;
      return -1;
    });
  }

  const nodesOf = (chain: Chain) => [0, ...chain.members.map((m) => m.to)];
  const snap = (value: number, chain: Chain) => {
    let best = value;
    let bestDistance = SNAP_MM;
    for (const node of nodesOf(chain)) {
      const d = Math.abs(node - value);
      if (d <= bestDistance) {
        best = node;
        bestDistance = d;
      }
    }
    return best;
  };

  // Parts ending at a point, for telling a cross street's stub across the
  // median.
  const endKey = (p: Vec2) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  const endsAt = new Map<string, number[]>();
  parts.forEach((part, i) => {
    if (part.points.length < 2) return;
    for (const p of [part.points[0], part.points[part.points.length - 1]]) {
      const k = endKey(p);
      const list = endsAt.get(k);
      if (list) list.push(i);
      else endsAt.set(k, [i]);
    }
  });
  const partsAt = (p: Vec2) => {
    const out = new Set<number>();
    const [x, y] = [Math.round(p[0] * 100), Math.round(p[1] * 100)];
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (const i of endsAt.get(`${x + dx},${y + dy}`) ?? []) out.add(i);
    return out;
  };
  const reach = HYSTERESIS * gap + 2 * maxHalfWidth;
  // Two nodes one short piece apart, the stub of a street crossing the median.
  const joined = (p: Vec2, q: Vec2) => {
    if (dist(p, q) > reach) return false;
    const atQ = partsAt(q);
    for (const i of partsAt(p)) if (atQ.has(i) && chainOf[i] < 0) return true;
    return false;
  };

  // Run each end of a stretch on to a node both carriageways share, or to
  // the street crossing both, when it's close by beyond it. Carriageways
  // often splay or close in over the last stretch before a junction, and
  // stopping there left a fork.
  const toFork = (stretch: Stretch, X: Chain, Y: Chain) => {
    const xNodes = nodesOf(X).map((a) => ({ a, p: pointAt(X.points, X.cum, a) }));
    const yNodes = nodesOf(Y).map((a) => ({ a, p: pointAt(Y.points, Y.cum, a) }));
    for (const end of [0, 1]) {
      const from = end ? stretch.a1 : stretch.a0;
      let best: { a: number; b: number } | null = null;
      for (const x of xNodes) {
        const beyond = end ? x.a - from : from - x.a;
        if (beyond <= EPSILON || beyond > FORK_MM) continue;
        for (const y of yNodes) {
          if (dist(x.p, y.p) > 0.03 && !joined(x.p, y.p)) continue;
          if (!best || Math.abs(x.a - from) < Math.abs(best.a - from)) best = { a: x.a, b: y.a };
        }
      }
      if (!best) continue;
      if (end) stretch.a1 = best.a;
      else stretch.a0 = best.a;
      stretch.b0 = Math.min(stretch.b0, best.b);
      stretch.b1 = Math.max(stretch.b1, best.b);
    }
  };

  const stretches: Stretch[] = [];
  for (const c of sampled) {
    const chain = chains[c];
    const count = steps[c];
    const h = chain.length / count;
    const bridge = Math.ceil(BRIDGE_MM / h);
    let k = 0;
    while (k < count) {
      const d = mutual[c][k];
      if (d < 0) {
        k++;
        continue;
      }
      let last = k;
      let j = k + 1;
      while (j < count && j - last <= bridge) {
        if (mutual[c][j] === d) last = j;
        else if (mutual[c][j] >= 0) break;
        j++;
      }
      const first = k;
      k = last + 1;
      if ((last - first + 1) * h < MIN_PAIR_MM) continue;
      let close = 0;
      for (let n = first; n <= last; n++) if (mutual[c][n] === d && strict[c][n]) close++;
      if (close * h < MIN_PAIR_MM / 2) continue;
      // The longer chain stays. Both see the pair, so only it records it.
      const other = chains[d];
      if (other.length > chain.length || (other.length === chain.length && d < c)) continue;
      let b0 = Infinity;
      let b1 = -Infinity;
      for (let n = first; n <= last; n++) {
        if (mutual[c][n] !== d) continue;
        b0 = Math.min(b0, partnerArc[c][n]);
        b1 = Math.max(b1, partnerArc[c][n]);
      }
      const hd = other.length / steps[d];
      // Snapped, but never onto one node.
      const span = (lo: number, hi: number, of: Chain): [number, number] => {
        const [s0, s1] = [snap(lo, of), snap(hi, of)];
        return s1 - s0 > MIN_PAIR_MM / 4 ? [s0, s1] : [lo, hi];
      };
      const [a0, a1] = span(first * h, (last + 1) * h, chain);
      const [sb0, sb1] = span(Math.max(0, b0 - hd / 2), Math.min(other.length, b1 + hd / 2), other);
      const stretch = { x: c, y: d, a0, a1, b0: sb0, b1: sb1 };
      toFork(stretch, chain, other);
      stretches.push(stretch);
    }
  }
  stretches.sort((p, q) => q.a1 - q.a0 - (p.a1 - p.a0));
  return stretches;
}

function applyStretch(
  stretch: Stretch,
  parts: Part[],
  chains: Chain[],
  endsNear: (box: [number, number, number, number]) => { part: number; atStart: boolean }[],
  touched: Set<number>,
  tolerance: number,
  corridor: number,
): number | 'conflict' | null {
  const X = chains[stretch.x];
  const Y = chains[stretch.y];
  const { a0, a1, b0, b1 } = stretch;
  // Side by side, the two carriageways run about as far as each other.
  if (a1 - a0 < MIN_PAIR_MM / 2 || b1 - b0 < 0.5 * (a1 - a0)) return null;
  const inside = (chain: Chain, lo: number, hi: number) => chain.members.filter((m) => Math.min(hi, m.to) - Math.max(lo, m.from) > EPSILON);
  const xInside = inside(X, a0, a1);
  const yInside = inside(Y, b0, b1);
  const own = new Set([...xInside, ...yInside].map((m) => m.part));
  for (const i of own) if (touched.has(i)) return 'conflict';

  // The midline: halfway from points along X to their closest points on Y,
  // kept in order along Y so a bend can't bunch it up, then simplified so a
  // straight pair gives a straight line.
  let ySpan = slice(Y.points, Y.cum, Math.max(0, b0 - 0.05), Math.min(Y.length, b1 + 0.05));
  const xSpan = slice(X.points, X.cum, a0, a1);
  if (ySpan.length < 2 || xSpan.length < 2) return null;
  // A one-way ring beside another, the other way round: taken from where it
  // starts, the closest points wrap round and can't be kept in order. Run it
  // the same way as X, from beside X's start.
  if (dist(Y.points[0], Y.points[Y.points.length - 1]) <= tolerance && b1 - b0 >= Y.length - 0.1) ySpan = unroll(Y.points, xSpan);
  const yCum = cumulative(ySpan);
  const arcs = new Set<number>([a0, a1]);
  for (let a = a0 + STEP_MM; a < a1; a += STEP_MM) arcs.add(a);
  for (let k = 0; k < X.cum.length; k++) if (X.cum[k] > a0 && X.cum[k] < a1) arcs.add(X.cum[k]);
  const nodeArcs = new Set(X.members.map((m) => m.to).filter((a) => a > a0 && a < a1));
  const sorted = [...arcs].sort((p, q) => p - q);
  const onX = sorted.map((a) => pointAt(X.points, X.cum, a));
  const xCum = cumulative(xSpan);
  const ySamples: Vec2[] = [];
  for (let a = 0; a < yCum[yCum.length - 1]; a += STEP_MM) ySamples.push(pointAt(ySpan, yCum, a));
  ySamples.push(ySpan[ySpan.length - 1]);
  // From X across to Y, and from Y back across to X. Where the carriageways
  // aren't parallel (the arms of a fork) the closest point across isn't
  // straight across, and each half leans its own way. Averaged, they don't.
  const forward = halfway(onX, ySpan, yCum, corridor);
  const backward = halfway(ySamples, xSpan, xCum, corridor);
  const between = new Lookup(backward, 0.5);
  const raw = forward.map((m): Vec2 => {
    const q = between.nearest(m).point;
    return [(m[0] + q[0]) / 2, (m[1] + q[1]) / 2];
  });
  // Halfway to the other carriageway is never far. A midline that is has
  // matched the wrong stretch of it, and the pair is left alone.
  if (raw.some((m, k) => dist(m, onX[k]) > corridor * (HYSTERESIS / 2 + 0.25))) return null;
  const keep = new Set<number>();
  sorted.forEach((a, k) => {
    if (nodeArcs.has(a)) keep.add(k);
  });
  const kept = simplifyIndices(raw, MIDLINE_TOLERANCE_MM, keep);
  const mArcs = kept.map((k) => sorted[k]);
  const mPts = kept.map((k) => raw[k]);
  const midAt = (a: number): Vec2 => {
    if (a <= mArcs[0]) return mPts[0];
    if (a >= mArcs[mArcs.length - 1]) return mPts[mPts.length - 1];
    let k = 0;
    while (k < mArcs.length - 2 && mArcs[k + 1] < a) k++;
    const f = (a - mArcs[k]) / (mArcs[k + 1] - mArcs[k] || 1);
    return [mPts[k][0] + (mPts[k + 1][0] - mPts[k][0]) * f, mPts[k][1] + (mPts[k + 1][1] - mPts[k][1]) * f];
  };
  const midBetween = (lo: number, hi: number): Vec2[] => {
    const out: Vec2[] = [midAt(lo)];
    for (let k = 0; k < mArcs.length; k++) if (mArcs[k] > lo + EPSILON && mArcs[k] < hi - EPSILON) out.push(mPts[k]);
    out.push(midAt(hi));
    return out;
  };
  // The midline's local line near a point, extended past its ends.
  const midLine = (p: Vec2): { point: Vec2; u: Vec2; distance: number } => {
    const c = closest(mPts, p);
    const a = mPts[c.segment];
    const b = mPts[Math.min(c.segment + 1, mPts.length - 1)];
    const d = dist(a, b) || 1;
    const u: Vec2 = [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
    // Past an end, the nearest point on the extended line.
    const t = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
    const point: Vec2 = [a[0] + u[0] * t, a[1] + u[1] * t];
    return { point, u, distance: dist(point, p) };
  };

  // Everything meeting the pair within the stretch: its junctions, and the
  // ends of streets that stop on it.
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of [...xSpan, ...ySpan]) {
    box[0] = Math.min(box[0], x - 0.1);
    box[1] = Math.min(box[1], y - 0.1);
    box[2] = Math.max(box[2], x + 0.1);
    box[3] = Math.max(box[3], y + 0.1);
  }
  const touching: { part: number; atStart: boolean; point: Vec2 }[] = [];
  const onXSpan = new Lookup(xSpan, 0.25);
  const onYSpan = new Lookup(ySpan, 0.25);
  for (const end of endsNear(box)) {
    const p = parts[end.part];
    if (p.points.length < 2) continue;
    const point = end.atStart ? p.points[0] : p.points[p.points.length - 1];
    if (onXSpan.nearest(point).distance <= tolerance || onYSpan.nearest(point).distance <= tolerance) touching.push({ ...end, point });
  }
  const anchors = new Nodes(tolerance);
  const groups = new Map<number, { point: Vec2; ends: { part: number; atStart: boolean }[] }>();
  for (const t of touching) {
    const id = anchors.id(t.point);
    const group = groups.get(id) ?? { point: t.point, ends: [] };
    group.ends.push({ part: t.part, atStart: t.atStart });
    groups.set(id, group);
  }
  for (const group of groups.values()) for (const e of group.ends) if (!own.has(e.part) && touched.has(e.part)) return 'conflict';

  const sine = Math.sin((SLIDE_DEG * Math.PI) / 180);
  const moves: { part: number; atStart: boolean; target: Vec2; line: { point: Vec2; u: Vec2 }; slide: boolean }[] = [];
  const targets: { point: Vec2; target: Vec2 }[] = [];
  for (const group of groups.values()) {
    const e = group.point;
    const line = midLine(e);
    let target = line.point;
    const externals = group.ends.filter((end) => !own.has(end.part));
    let slider = -1;
    let best = sine;
    externals.forEach((end, n) => {
      const x = inward(parts[end.part].points, end.atStart);
      if (!x) return;
      const s = Math.abs(cross(x, line.u));
      if (s < best) return;
      const t = cross(sub(line.point, e), line.u) / cross(x, line.u);
      if (Math.abs(t) > 3 * line.distance + 0.05) return;
      best = s;
      slider = n;
      target = [e[0] + x[0] * t, e[1] + x[1] * t];
    });
    targets.push({ point: e, target });
    externals.forEach((end, n) => moves.push({ ...end, target, line, slide: n === slider }));
  }
  const targetAt = (p: Vec2): Vec2 | null => {
    for (const t of targets) if (dist(t.point, p) <= tolerance) return t.target;
    return null;
  };

  const removed = new Set<number>();
  const added: Part[] = [];
  const orient = (points: Vec2[], ends: [EndOrigin, EndOrigin], reversed: boolean): { points: Vec2[]; ends: [EndOrigin, EndOrigin] } =>
    reversed ? { points: [...points].reverse(), ends: [ends[1], ends[0]] } : { points, ends };
  const travelEnds = (m: Member): [EndOrigin, EndOrigin] => {
    const ends = parts[m.part].ends;
    return m.reversed ? [ends[1], ends[0]] : ends;
  };
  const nearerEnd = (p: Vec2) => (dist(p, mPts[0]) <= dist(p, mPts[mPts.length - 1]) ? mPts[0] : mPts[mPts.length - 1]);

  // X: the stretch moves onto the middle, whatever lies outside stays and
  // bends in to it where it was cut.
  for (const m of xInside) {
    const lo = Math.max(a0, m.from);
    const hi = Math.min(a1, m.to);
    const [head, tail] = travelEnds(m);
    const source = parts[m.part].source;
    removed.add(m.part);
    if (lo - m.from > EPSILON) {
      const before = bendIn(slice(X.points, X.cum, m.from, lo), false, midAt(lo));
      added.push({ source, ...orient(before, [head, 'met'], m.reversed) });
    }
    const mid = midBetween(lo, hi);
    const start = lo - m.from <= EPSILON ? targetAt(pointAt(X.points, X.cum, m.from)) : null;
    if (start) mid[0] = start;
    const end = m.to - hi <= EPSILON ? targetAt(pointAt(X.points, X.cum, m.to)) : null;
    if (end) mid[mid.length - 1] = end;
    const line = dedupe(mid, 1e-6);
    if (line.length >= 2) {
      added.push({ source, ...orient(line, [lo - m.from <= EPSILON ? head : 'met', m.to - hi <= EPSILON ? tail : 'met'], m.reversed), merged: true });
    }
    if (m.to - hi > EPSILON) {
      const after = bendIn(slice(X.points, X.cum, hi, m.to), true, midAt(hi));
      added.push({ source, ...orient(after, ['met', tail], m.reversed) });
    }
  }
  // Y: the stretch goes, what lies outside bends in to the nearer end of the
  // merged line.
  let dropped = 0;
  for (const m of yInside) {
    const lo = Math.max(b0, m.from);
    const hi = Math.min(b1, m.to);
    const [head, tail] = travelEnds(m);
    const source = parts[m.part].source;
    removed.add(m.part);
    dropped += hi - lo;
    if (lo - m.from > EPSILON) {
      const before = slice(Y.points, Y.cum, m.from, lo);
      added.push({ source, ...orient(bendIn(before, false, nearerEnd(before[before.length - 1])), [head, 'met'], m.reversed) });
    }
    if (m.to - hi > EPSILON) {
      const after = slice(Y.points, Y.cum, hi, m.to);
      added.push({ source, ...orient(bendIn(after, true, nearerEnd(after[0])), ['met', tail], m.reversed) });
    }
  }

  // What meets the pair moves onto the middle: along itself where it meets
  // it steeply, bending in where it runs alongside.
  const movedEnds = new Map<number, number>();
  for (const move of moves) {
    const part = parts[move.part];
    if (removed.has(move.part) || part.points.length < 2) continue;
    const e = move.atStart ? part.points[0] : part.points[part.points.length - 1];
    if (dist(e, move.target) <= EPSILON) continue;
    let points: Vec2[] | null = null;
    const x = inward(part.points, move.atStart);
    if (x && Math.abs(cross(x, move.line.u)) >= sine) points = slideEnd(part.points, move.atStart, move.line.point, move.line.u, move.target);
    part.points = points ?? bendIn(part.points, move.atStart, move.target);
    movedEnds.set(move.part, (movedEnds.get(move.part) ?? 0) + 1);
  }
  // A cross street's stub across the median, a U-turn or crossover between
  // the carriageways: both ends moved onto the middle, nothing left of it.
  for (const [i, count] of movedEnds) {
    if (count < 2) continue;
    if (polylineLength(parts[i].points) <= corridor) removed.add(i);
  }

  for (const i of removed) parts[i].points = [];
  for (const i of [...own, ...movedEnds.keys()]) touched.add(i);
  const start = parts.length;
  parts.push(...added.filter((p) => p.points.length >= 2 && polylineLength(p.points) > EPSILON));
  for (let i = start; i < parts.length; i++) touched.add(i);
  return dropped;
}
