// Schematic bridges: decks on piers.
//
// Pieces flagged as bridges, and roads crossing water cut from the terrain,
// become decks. Connected pieces are solved as one network so joints share a
// height. Every loose end touches down on the road surface (except where the
// model edge cut the bridge off), the deck rises no steeper than the maximum
// grade towards a height that clears whatever it crosses, and a network that
// never rises a printed layer above the road is built as an ordinary road,
// unless it crosses open water.

import { EdgeIndex } from '../geometry/edgeindex';
import { inOneTriangle } from '../geometry/lattice';
import { bufferLines, clipLines, densifyLine, dropSmall, intersection, segmentDistance, union } from '../geometry/polygon';
import { RasterMask } from '../geometry/raster';
import type { HeightFn, PrismSolid } from '../geometry/solid';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { count, describeObject, type Context } from './context';
import { dedupe, polylineLength } from './linework';
import type { RoadPiece } from './roads';
import { WATER_DROP_MM } from './water';

export const MINIMUM_BRIDGE_M = 12;
const END_EXCLUSION_M = 12;
const MINIMUM_PIER_HEIGHT_MM = 0.4;
const JOINT_TOLERANCE_MM = 0.05;
const PIER_OVERLAP_MM = 0.1;

export interface DeckSplit {
  ground: RoadPiece[];
  decks: RoadPiece[];
}

/** Separate deck pieces from ground pieces, recovering unflagged water crossings. */
export function splitDecks(pieces: RoadPiece[], ctx: Context, cutWater: MultiPolygon): DeckSplit {
  const minLength = MINIMUM_BRIDGE_M * ctx.projection.mmPerMetre;
  const ground: RoadPiece[] = [];
  const decks: RoadPiece[] = [];
  // Cheap wet-or-not test first. Only pieces that reach water are clipped exactly.
  const wetMask = cutWater.length ? new RasterMask(cutWater, 0.1) : null;
  const reachesWater = (points: Vec2[]) => densifyLine(points, wetMask!.cell).some(([x, y]) => wetMask!.has(x, y));
  for (const piece of pieces) {
    const length = polylineLength(piece.points);
    if (piece.flags.has('is_bridge')) {
      if (length >= minLength) decks.push(piece);
      else ground.push(piece);
      continue;
    }
    if (!wetMask || !reachesWater(piece.points)) {
      ground.push(piece);
      continue;
    }
    const wet = clipLines([piece.points], cutWater);
    const crossings = wet.filter((line) => polylineLength(line) >= minLength);
    if (!crossings.length) {
      ground.push(piece);
      continue;
    }
    // A run shorter than the minimum span is mapping slop along a bank and stays a road.
    for (const line of wet) if (polylineLength(line) < minLength) ground.push({ ...piece, points: line });
    for (const line of clipLines([piece.points], cutWater, true)) ground.push({ ...piece, points: line });
    for (const line of crossings) {
      decks.push({ ...piece, points: line, flags: new Set([...piece.flags, 'is_bridge']) });
      count(ctx, 'bridge_crossings_recovered');
    }
  }
  return { ground, decks };
}

interface Node {
  x: number;
  y: number;
  ground: number;
  required: number;
  wet: boolean;
  onRoad: boolean;
  edges: [number, number][]; // neighbour, length
  anchorTop: number | null;
  cap: number;
  reach: number; // path distance from the nearest anchor
  top: number;
}

/** A deck as it was laid out, so the editor can build it again at another width. */
export interface DeckPiece {
  key: string;
  points: Vec2[];
  widthMm: number;
  top: HeightFn;
  bottom: HeightFn;
  drape: number;
}

export interface BridgeResult {
  solids: PrismSolid[];
  /** Pier footprints standing in cut water: ground is kept under them. */
  pierGround: MultiPolygon;
  /** Networks too low to read as bridges, returned to the ground roads. */
  demoted: RoadPiece[];
  decks: DeckPiece[];
}

export async function buildBridges(
  decks: RoadPiece[],
  ctx: Context,
  input: { groundRoads: MultiPolygon; cutWater: MultiPolygon },
): Promise<BridgeResult> {
  const { settings, heightfield: hf } = ctx;
  const b = settings.bridges;
  const mm = ctx.projection.mmPerMetre;
  const thickness = settings.roads.thicknessMm;
  const embed = settings.land.embedMm;
  const station = Math.max(0.25, Math.min(hf.step / 2, 0.6));
  const cutMask = new RasterMask(input.cutWater, 0.1);
  const roadMask = new RasterMask(input.groundRoads, 0.1);
  const crop = new EdgeIndex(ctx.cropSet, 5);

  // Joints: piece ends that meet within a tolerance share one node.
  const nodes: Node[] = [];
  const joints = new Map<string, number>();
  const makeNode = (x: number, y: number): number => {
    const ground = hf.heightAt(x, y);
    const wet = cutMask.has(x, y);
    const onRoad = !wet && roadMask.has(x, y);
    const below = wet ? ground - WATER_DROP_MM : ground + (onRoad ? thickness : 0);
    nodes.push({
      x, y, ground, wet, onRoad,
      required: below + b.clearanceMm + b.deckThicknessMm,
      edges: [], anchorTop: null, cap: Infinity, reach: Infinity, top: 0,
    });
    return nodes.length - 1;
  };
  const jointAt = (p: Vec2): number => {
    const q = JOINT_TOLERANCE_MM;
    const cx = Math.round(p[0] / q);
    const cy = Math.round(p[1] / q);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const id = joints.get(`${cx + dx},${cy + dy}`);
        if (id !== undefined && Math.hypot(nodes[id].x - p[0], nodes[id].y - p[1]) <= q) return id;
      }
    }
    const id = makeNode(p[0], p[1]);
    joints.set(`${cx},${cy}`, id);
    return id;
  };
  const link = (a: number, c: number) => {
    const length = Math.hypot(nodes[a].x - nodes[c].x, nodes[a].y - nodes[c].y);
    nodes[a].edges.push([c, length]);
    nodes[c].edges.push([a, length]);
  };

  const chains: { piece: RoadPiece; ids: number[] }[] = [];
  for (const piece of decks) {
    const points = dedupe(piece.points, 1e-6);
    if (points.length < 2) continue;
    const ids: number[] = [jointAt(points[0])];
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / station));
      for (let s = 1; s <= steps; s++) {
        const last = i === points.length - 1 && s === steps;
        const t = s / steps;
        const id = last ? jointAt(points[i]) : makeNode(ax + (bx - ax) * t, ay + (by - ay) * t);
        if (id !== ids[ids.length - 1]) {
          link(ids[ids.length - 1], id);
          ids.push(id);
        }
      }
    }
    chains.push({ piece, ids });
  }

  // A ramp can end partway along another deck instead of at one of its
  // ends. Joined to the nearest station of that deck, it rises with it
  // rather than being anchored to the road and diving under it. The end has
  // to lie on the other deck's centerline, not merely near it.
  const reachJoin = station / 2 + JOINT_TOLERANCE_MM;
  const onDeck = (x: number, y: number, m: number) =>
    nodes[m].edges.some(([k]) => segmentDistance(x, y, nodes[m].x, nodes[m].y, nodes[k].x, nodes[k].y) <= JOINT_TOLERANCE_MM);
  const cells = new Map<string, number[]>();
  const cellOf = (x: number, y: number) => `${Math.floor(x / reachJoin)},${Math.floor(y / reachJoin)}`;
  nodes.forEach((node, i) => {
    const key = cellOf(node.x, node.y);
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  });
  for (const { ids } of chains) {
    let own: Set<number> | null = null;
    for (const end of [ids[0], ids[ids.length - 1]]) {
      const node = nodes[end];
      if (node.edges.length !== 1) continue;
      own ??= new Set(ids);
      const cx = Math.floor(node.x / reachJoin);
      const cy = Math.floor(node.y / reachJoin);
      let best = -1;
      let bestDistance = reachJoin;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const m of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (own.has(m)) continue;
            const d = Math.hypot(nodes[m].x - node.x, nodes[m].y - node.y);
            if (d <= bestDistance && onDeck(node.x, node.y, m)) {
              best = m;
              bestDistance = d;
            }
          }
        }
      }
      if (best < 0) continue;
      link(end, best);
      count(ctx, 'bridge_ends_joined_mid_deck');
    }
  }

  // Networks: connected components of the station graph.
  const component = new Int32Array(nodes.length).fill(-1);
  let components = 0;
  for (let start = 0; start < nodes.length; start++) {
    if (component[start] >= 0) continue;
    const stack = [start];
    component[start] = components;
    while (stack.length) {
      const n = stack.pop()!;
      for (const [m] of nodes[n].edges) {
        if (component[m] < 0) {
          component[m] = components;
          stack.push(m);
        }
      }
    }
    components++;
  }

  // Loose ends touch down on the road surface. Ends at the model edge keep their height.
  for (const node of nodes) {
    if (node.edges.length !== 1) continue;
    if (!crop.contains(node.x, node.y) || crop.distance(node.x, node.y, 0.15) < 0.15) continue;
    node.anchorTop = node.ground + thickness;
  }

  // Grade limit and distance from the nearest anchor, by path length.
  const anchors = nodes.map((node, i) => (node.anchorTop !== null ? i : -1)).filter((i) => i >= 0);
  const reach = shortestPaths(nodes, anchors, () => 0, 1);
  const cap = shortestPaths(nodes, anchors, (i) => nodes[i].anchorTop!, b.maxGrade);
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].reach = reach[i];
    nodes[i].cap = cap[i];
  }
  await ctx.progress.checkpoint(0.5);

  const target = new Float64Array(components).fill(-Infinity);
  const wetNetwork = new Uint8Array(components);
  for (let i = 0; i < nodes.length; i++) {
    const c = component[i];
    target[c] = Math.max(target[c], nodes[i].required);
    if (nodes[i].wet) wetNetwork[c] = 1;
  }
  const lift = new Float64Array(components).fill(-Infinity);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const road = node.ground + thickness;
    node.top = Math.max(road, Math.min(target[component[i]], node.cap));
    lift[component[i]] = Math.max(lift[component[i]], node.top - road);
  }

  const solids: PrismSolid[] = [];
  const pierFootprints: Polygon[] = [];
  const demoted: RoadPiece[] = [];
  const deckPieces: DeckPiece[] = [];
  const spacing = b.pierSpacingM * mm;
  const exclusion = END_EXCLUSION_M * mm;
  let deckCount = 0;
  let pierCount = 0;

  for (const { piece, ids } of chains) {
    const c = component[ids[0]];
    if (!wetNetwork[c] && lift[c] < b.minLiftMm) {
      demoted.push(piece);
      count(ctx, 'bridge_pieces_demoted');
      continue;
    }
    const profile = profileFunction(ids.map((id) => nodes[id]));
    const ribbon = dropSmall(intersection(bufferLines([{ points: piece.points, width: piece.widthMm }], 'round'), ctx.cropSet), 0.01);
    const top = profile;
    const bottom = (x: number, y: number) => profile(x, y) - b.deckThicknessMm;
    const key = `br:${piece.sourceId}`;
    for (const polygon of ribbon) {
      solids.push({ kind: 'prism', role: 'bridge', polygon, top, bottom, drape: station, key, sub: 'deck' });
      deckCount++;
    }
    if (ribbon.length) describeObject(ctx, key, { kind: 'bridge', name: piece.name, detail: piece.roadClass });
    deckPieces.push({ key, points: piece.points, widthMm: piece.widthMm, top, bottom, drape: station });

    // Piers every spacing along the deck, clear of anchored ends and roads below.
    let travelled = spacing / 2;
    for (let k = 1; k < ids.length; k++) {
      const a = nodes[ids[k - 1]];
      const n = nodes[ids[k]];
      const length = Math.hypot(n.x - a.x, n.y - a.y);
      travelled += length;
      if (travelled < spacing) continue;
      travelled = 0;
      if (n.reach < exclusion || n.onRoad) continue;
      const deckBottom = n.top - b.deckThicknessMm;
      const base = n.ground;
      if (deckBottom - base < MINIMUM_PIER_HEIGHT_MM) continue;
      if (!crop.contains(n.x, n.y)) continue;
      const ux = (n.x - a.x) / (length || 1);
      const uy = (n.y - a.y) / (length || 1);
      const along = b.pierMinSizeMm / 2;
      const across = Math.max(b.pierMinSizeMm / 2, piece.widthMm * 0.4);
      const corners: Vec2[] = [
        [n.x - ux * along + uy * across, n.y - uy * along - ux * across],
        [n.x + ux * along + uy * across, n.y + uy * along - ux * across],
        [n.x + ux * along - uy * across, n.y + uy * along + ux * across],
        [n.x - ux * along - uy * across, n.y - uy * along + ux * across],
      ];
      // Decks are cut at the model edge, and piers with them.
      const half = Math.hypot(along, across);
      const footprints: Polygon[] =
        crop.distance(n.x, n.y, half) < half ? dropSmall(intersection([[corners]], ctx.cropSet), 0.01) : [[corners]];
      if (!footprints.length) continue;
      for (const footprint of footprints) {
        // Draped like a building, or a pier across a bend in the ground stands on air.
        const drape = !hf.flat && !inOneTriangle(hf.lattice, footprint);
        solids.push({
          kind: 'prism',
          role: 'pier',
          polygon: footprint,
          top: deckBottom + PIER_OVERLAP_MM,
          bottom: (x, y) => hf.heightAt(x, y) - embed,
          drape: drape ? hf.step : 0,
          lattice: drape ? hf.lattice : undefined,
          key,
          sub: 'pier',
        });
        if (n.wet) pierFootprints.push(footprint);
      }
      pierCount++;
    }
  }
  ctx.stats.bridge_decks = deckCount;
  ctx.stats.bridge_piers = pierCount;
  ctx.stats.bridge_networks = components;
  return { solids, pierGround: union(pierFootprints), demoted, decks: deckPieces };
}

/** Multi-source Dijkstra: min over sources of start(source) + rate * path length. */
function shortestPaths(nodes: Node[], sources: number[], start: (i: number) => number, rate: number): Float64Array {
  const value = new Float64Array(nodes.length).fill(Infinity);
  // Entries keep the key they were pushed with. Stale ones are skipped on pop.
  const heap: [number, number][] = [];
  const push = (i: number) => {
    heap.push([value[i], i]);
    let k = heap.length - 1;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (heap[parent][0] <= heap[k][0]) break;
      [heap[parent], heap[k]] = [heap[k], heap[parent]];
      k = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0][1];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  for (const s of sources) {
    const v = start(s);
    if (v < value[s]) {
      value[s] = v;
      push(s);
    }
  }
  const done = new Uint8Array(nodes.length);
  while (heap.length) {
    const n = pop();
    if (done[n]) continue;
    done[n] = 1;
    for (const [m, length] of nodes[n].edges) {
      const next = value[n] + rate * length;
      if (next < value[m]) {
        value[m] = next;
        push(m);
      }
    }
  }
  return value;
}

/** Deck top at any point: the profile of the nearest stretch of centerline. */
function profileFunction(chain: Node[]): (x: number, y: number) => number {
  const cell = 1;
  const buckets = new Map<string, number[]>();
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1];
    const b = chain[i];
    const c0 = Math.floor(Math.min(a.x, b.x) / cell);
    const c1 = Math.floor(Math.max(a.x, b.x) / cell);
    const r0 = Math.floor(Math.min(a.y, b.y) / cell);
    const r1 = Math.floor(Math.max(a.y, b.y) / cell);
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = `${c},${r}`;
        const list = buckets.get(key);
        if (list) list.push(i);
        else buckets.set(key, [i]);
      }
    }
  }
  return (x: number, y: number) => {
    const c = Math.floor(x / cell);
    const r = Math.floor(y / cell);
    let best = Infinity;
    let value = chain[0].top;
    for (let reach = 1; reach <= 3 && best === Infinity; reach++) {
      for (let dc = -reach; dc <= reach; dc++) {
        for (let dr = -reach; dr <= reach; dr++) {
          for (const i of buckets.get(`${c + dc},${r + dr}`) ?? []) {
            const a = chain[i - 1];
            const b = chain[i];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const l2 = dx * dx + dy * dy;
            let t = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
            if (d < best) {
              best = d;
              value = a.top + (b.top - a.top) * t;
            }
          }
        }
      }
    }
    return value;
  };
}
