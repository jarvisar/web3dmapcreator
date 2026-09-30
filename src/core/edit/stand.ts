// What an added shape stands on. It's built down to the top of whatever is
// under it and no further: a roof or bridge deck it was raised onto, or the
// ground. In water it goes down through the water to the floor under it (or
// the base), with the water cut around it, unless ground is kept for it
// there. Shapes used to be solid down to the base, which cut a column
// through whatever was under them, and a column through a building changes
// filament on every layer of it.

import type { Paths64 } from 'clipper2-ts';
import { boxesOverlap, ClipSet, difference, intersection, multiArea, multiBounds, ringBounds, SCALE, splitToTiles, union, type Box } from '../geometry/polygon';
import type { CapSolid, HeightFn, PrismSolid, Solid } from '../geometry/solid';
import { interiorPoints } from '../terrain/heightfield';
import type { MultiPolygon, Polygon } from '../types';
import type { WetBody } from './earth';

/** Something a raised shape can stand on. */
export interface Holder {
  /** What it is, for a note: 'building', 'bridge' or 'shape'. */
  kind: string;
  polygon: Polygon;
  box: Box;
  /** Top at a point inside it, NaN where it has none. */
  topAt(x: number, y: number): number;
  /** Its top when that's flat. */
  flat?: number;
  /** Lowest point of its underside. */
  bottom: number;
  /** A deck's underside, which something sunk into the deck stays above. */
  underside?: HeightFn;
}

export interface StandPiece {
  polygons: MultiPolygon;
  /** A flat underside, or null to stand on the ground. */
  bottom: number | null;
  /** The surface under it when that's water or a hollow, which a shape following the ground is flat on. */
  level?: number;
  /** Sunk into something taller than the shape. */
  buried?: string;
  /** Held up by a building, bridge or shape, not the ground or the water. */
  held?: boolean;
}

// Overlaps smaller than this don't hold anything up.
const MIN_OVERLAP_MM2 = 1e-3;
// Tops that aren't flat are sampled about this far apart, up to a limit.
const SAMPLE_MM = 0.5;
const MAX_SAMPLES = 400;
// A deck whose underside rises or falls more than this is looked at in
// squares. Whole, a span high over a shape held it up because its ramp came
// down to the ground somewhere else, and the shape hung under it. A square
// is quartered again while its top rises more than a third of the deck's
// thickness across it: a piece set on its lowest point stuck out under a
// steep ramp at the other side.
const DECK_RISE_MM = 0.2;
const DECK_SQUARE_MM = 2;
const DECK_MIN_SQUARE_MM = 0.25;

/** Holders from a building, bridge or shape solid. Trees hold nothing up. */
export function holdersOf(solid: Solid, kind: string): Holder[] {
  if (solid.kind === 'mesh') return [];
  if (solid.kind === 'cap') return capHolders(solid, kind);
  if (kind === 'bridge') {
    const bottom = solid.bottom;
    const underside = typeof bottom === 'number' ? () => bottom : bottom;
    const squares = typeof bottom === 'number' ? null : deckSquares(solid, bottom);
    return (squares ?? [solid.polygon]).map((polygon) => ({ ...prismHolder(solid, polygon, kind), underside }));
  }
  return [prismHolder(solid, solid.polygon, kind)];
}

function prismHolder(solid: PrismSolid, polygon: Polygon, kind: string): Holder {
  const top = solid.top;
  return {
    kind,
    polygon,
    box: ringBounds(polygon[0]),
    topAt: typeof top === 'number' ? () => top : top,
    flat: typeof top === 'number' ? top : undefined,
    bottom: typeof solid.bottom === 'number' ? solid.bottom : lowestOver(polygon, solid.bottom),
  };
}

const deckCuts = new WeakMap<PrismSolid, Polygon[] | null>();

/** A sloping deck cut into squares on a fixed grid, or null for one that's about level. */
function deckSquares(solid: PrismSolid, bottom: HeightFn): Polygon[] | null {
  const cached = deckCuts.get(solid);
  if (cached !== undefined) return cached;
  // Inside as well as the outline: an arched deck is low at both ends, where all its corners are.
  let low = Infinity;
  let high = -Infinity;
  for (const [x, y] of samples([solid.polygon])) {
    const z = bottom(x, y);
    if (z < low) low = z;
    if (z > high) high = z;
  }
  let squares: Polygon[] | null = null;
  if (high - low > DECK_RISE_MM) {
    const deckTop = solid.top;
    const topAt = typeof deckTop === 'number' ? () => deckTop : deckTop;
    const out: Polygon[] = [];
    // Squares are on whole Clipper units, left and top their corner.
    const refine = (pieces: MultiPolygon, left: number, top: number, size: number) => {
      let lowTop = Infinity;
      let highTop = -Infinity;
      let thickness = Infinity;
      for (const [x, y] of samples(pieces)) {
        const z = topAt(x, y);
        if (z < lowTop) lowTop = z;
        if (z > highTop) highTop = z;
        thickness = Math.min(thickness, z - bottom(x, y));
      }
      const half = size / 2;
      if (highTop - lowTop <= thickness / 3 || half < DECK_MIN_SQUARE_MM * SCALE) {
        out.push(...pieces);
        return;
      }
      for (const [index, part] of splitToTiles(pieces, left, top, half, 2, 2)) refine(part, left + (index % 2) * half, top + Math.floor(index / 2) * half, half);
    };
    const step = DECK_SQUARE_MM * SCALE;
    const [minX, minY, maxX, maxY] = ringBounds(solid.polygon[0]);
    const left = Math.floor((minX * SCALE) / step) * step;
    const top = Math.floor((minY * SCALE) / step) * step;
    const cols = Math.max(1, Math.ceil((maxX * SCALE - left) / step));
    const rows = Math.max(1, Math.ceil((maxY * SCALE - top) / step));
    for (const [index, pieces] of splitToTiles([solid.polygon], left, top, step, cols, rows)) {
      refine(pieces, left + (index % cols) * step, top + Math.floor(index / cols) * step, step);
    }
    squares = out;
  }
  deckCuts.set(solid, squares);
  return squares;
}

// By triangles: a building made taller keeps its outline and its triangle list.
const capOutlines = new WeakMap<Uint32Array, MultiPolygon>();

function capHolders(cap: CapSolid, kind: string): Holder[] {
  let outline = capOutlines.get(cap.triangles);
  if (!outline) {
    const triangles: Polygon[] = [];
    const v = cap.vertices;
    const t = cap.triangles;
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3;
      const b = t[i + 1] * 3;
      const c = t[i + 2] * 3;
      triangles.push([
        [
          [v[a], v[a + 1]],
          [v[b], v[b + 1]],
          [v[c], v[c + 1]],
        ],
      ]);
    }
    outline = union(triangles);
    capOutlines.set(cap.triangles, outline);
  }
  const topAt = (x: number, y: number) => tinHeight(cap, x, y);
  return outline.map((polygon) => ({ kind, polygon, box: ringBounds(polygon[0]), topAt, bottom: cap.bottom }));
}

/** Height of a cap's surface at a point, or NaN off it. */
function tinHeight(cap: CapSolid, x: number, y: number): number {
  const v = cap.vertices;
  const t = cap.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    const ax = v[a];
    const ay = v[a + 1];
    const bx = v[b];
    const by = v[b + 1];
    const cx = v[c];
    const cy = v[c + 1];
    if (x < Math.min(ax, bx, cx) - 1e-6 || x > Math.max(ax, bx, cx) + 1e-6 || y < Math.min(ay, by, cy) - 1e-6 || y > Math.max(ay, by, cy) + 1e-6) continue;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    return l1 * v[a + 2] + l2 * v[b + 2] + l3 * v[c + 2];
  }
  return NaN;
}

function lowestOver(polygon: Polygon, fn: (x: number, y: number) => number): number {
  let low = Infinity;
  for (const ring of polygon) for (const [x, y] of ring) low = Math.min(low, fn(x, y));
  return low;
}

/** Points to sample a region's surface at: its corners and a grid inside. */
function samples(region: MultiPolygon): [number, number][] {
  const out: [number, number][] = [];
  for (const polygon of region) for (const ring of polygon) for (const point of ring) out.push(point);
  const spacing = Math.max(SAMPLE_MM, Math.sqrt(multiArea(region) / MAX_SAMPLES));
  for (const polygon of region) out.push(...interiorPoints(polygon, spacing, MAX_SAMPLES));
  return out;
}

function highestOver(fn: HeightFn, region: MultiPolygon): number {
  let high = -Infinity;
  for (const [x, y] of samples(region)) high = Math.max(high, fn(x, y));
  return high;
}

/** The lowest a holder's top gets over a region, or NaN when it has no top there. */
export function levelOver(holder: Holder, region: MultiPolygon): number {
  if (holder.flat !== undefined) return holder.flat;
  let low = Infinity;
  for (const [x, y] of samples(region)) {
    const z = holder.topAt(x, y);
    if (Number.isFinite(z) && z < low) low = z;
  }
  return Number.isFinite(low) ? low : NaN;
}

/**
 * The pieces of a footprint by what they stand on. `base` is where a flat
 * shape's underside would be if it floated, and `top` its top: holders it
 * clears hold it up, and one reaching past the base holds it where it's
 * sunk in. A shape that follows the ground (`base` null) only stands on
 * water and ground.
 */
export function standPieces(footprint: MultiPolygon, base: number | null, top: number | null, holders: readonly Holder[], wet: readonly WetBody[], embed: number): StandPiece[] {
  if (!footprint.length) return [];
  if (base === null || top === null) return restPieces(footprint, wet);
  const held = heldPieces(footprint, base, holders, embed);
  return [...heldAt(held, top), ...restPieces(held.remaining, wet)];
}

/**
 * What holders hold up of a flat shape's footprint, and what's left for the
 * water and the ground. It doesn't depend on the water or the shape's own
 * height, so it's kept while only those change: a box over downtown San
 * Francisco stands on some 9,000 roofs.
 */
export interface Held {
  /** `top` is the holder's own top over the piece, to tell a shape sunk into it. */
  pieces: { polygons: MultiPolygon; bottom: number; top: number; kind: string }[];
  remaining: MultiPolygon;
}

export function heldPieces(footprint: MultiPolygon, base: number, holders: readonly Holder[], embed: number): Held {
  if (!footprint.length || !holders.length) return { pieces: [], remaining: footprint };
  const box = multiBounds(footprint);
  // Only the footprint near each holder is clipped against it: a title
  // across a city passes thousands.
  const near = new ClipSet([footprint]);
  const found: { region: MultiPolygon; box: Box; level: number; top: number; kind: string }[] = [];
  for (const holder of holders) {
    if (holder.bottom >= base || !boxesOverlap(holder.box, box)) continue;
    const local = near.polygonsWithin(holder.box);
    if (!local.length) continue;
    const region = intersection(local, [holder.polygon]);
    if (multiArea(region) < MIN_OVERLAP_MM2) continue;
    const level = levelOver(holder, region);
    if (!Number.isFinite(level)) continue;
    // Sunk into a deck, it stays above the deck's underside rather than sticking out below it.
    const floor = holder.underside ? highestOver(holder.underside, region) + embed : -Infinity;
    found.push({ region, box: multiBounds(region), level: Math.min(level, Math.max(base, floor)), top: level, kind: holder.kind });
  }
  found.sort((a, b) => b.level - a.level);
  // Each region less the higher ones already taken. Only those overlapping
  // it can take anything, and taking every region from what was left one
  // at a time cost 9 s for a 30 mm title over San Francisco.
  const pieces: Held['pieces'] = [];
  const taken = new BoxGrid(box, found.length);
  for (const item of found) {
    const over = taken.overlapping(item.box);
    const piece = over.length ? difference(item.region, over.length === 1 ? over[0] : union(...over)) : item.region;
    if (multiArea(piece) < MIN_OVERLAP_MM2) continue;
    taken.add(item.box, item.region);
    pieces.push({ polygons: piece, bottom: item.level - embed, top: item.top, kind: item.kind });
  }
  const regions = taken.values;
  const remaining = regions.length ? difference(footprint, regions.length === 1 ? regions[0] : union(...regions)) : footprint;
  return { pieces, remaining };
}

/** Held pieces under a shape with this top. */
export function heldAt(held: Held, top: number): StandPiece[] {
  return held.pieces.map((p) => ({ polygons: p.polygons, bottom: p.bottom, buried: p.top >= top - 1e-6 ? p.kind : undefined, held: true }));
}

/** The rest of a footprint: over each body of water, then the ground. */
export function restPieces(footprint: MultiPolygon, wet: readonly WetBody[]): StandPiece[] {
  const pieces: StandPiece[] = [];
  if (!footprint.length) return pieces;
  const box = multiBounds(footprint);
  let remaining = footprint;
  for (const body of wet) {
    if (!remaining.length) break;
    if (!boxesOverlap(body.box, box)) continue;
    // The body cut to the box first: a bay's outline runs the length of the model.
    const local = wetSet(body.polygons).polygonsWithin(box, 0.01);
    if (!local.length) continue;
    const piece = intersection(remaining, local);
    if (multiArea(piece) < MIN_OVERLAP_MM2) continue;
    remaining = difference(remaining, local);
    pieces.push({ polygons: piece, bottom: body.footing, level: body.level });
  }
  if (remaining.length && multiArea(remaining) >= MIN_OVERLAP_MM2) pieces.push({ polygons: remaining, bottom: null });
  return pieces;
}

/** Regions by their boxes, in a grid, so the ones overlapping a box are found without looking at all of them. */
class BoxGrid {
  readonly values: MultiPolygon[] = [];
  private readonly boxes: Box[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly size: number;
  private readonly cols: number;

  constructor(
    private readonly bounds: Box,
    count: number,
  ) {
    const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
    const across = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(count))));
    this.size = Math.max(span / across, 1e-3);
    this.cols = Math.ceil((bounds[2] - bounds[0]) / this.size) + 1;
  }

  private visit(box: Box, fn: (cell: number) => void): void {
    const c0 = Math.max(0, Math.floor((box[0] - this.bounds[0]) / this.size));
    const c1 = Math.max(0, Math.floor((box[2] - this.bounds[0]) / this.size));
    const r0 = Math.max(0, Math.floor((box[1] - this.bounds[1]) / this.size));
    const r1 = Math.max(0, Math.floor((box[3] - this.bounds[1]) / this.size));
    for (let r = r0; r <= r1; r++) for (let c = Math.min(c0, this.cols - 1); c <= Math.min(c1, this.cols - 1); c++) fn(r * this.cols + c);
  }

  add(box: Box, value: MultiPolygon): void {
    const index = this.values.length;
    this.values.push(value);
    this.boxes.push(box);
    this.visit(box, (cell) => {
      const list = this.cells.get(cell);
      if (list) list.push(index);
      else this.cells.set(cell, [index]);
    });
  }

  overlapping(box: Box): MultiPolygon[] {
    const seen = new Set<number>();
    const out: MultiPolygon[] = [];
    this.visit(box, (cell) => {
      for (const index of this.cells.get(cell) ?? []) {
        if (seen.has(index)) continue;
        seen.add(index);
        if (boxesOverlap(this.boxes[index], box)) out.push(this.values[index]);
      }
    });
    return out;
  }
}

/**
 * What a shape is hidden inside, when at least `share` of its footprint is
 * under something whose top clears the shape's own `top`.
 */
export function buriedIn(footprint: MultiPolygon, holders: readonly Holder[], top: number, share: number): string | null {
  if (!footprint.length) return null;
  const box = multiBounds(footprint);
  const near = new ClipSet([footprint]);
  const regions: MultiPolygon[] = [];
  let kind: string | null = null;
  for (const holder of holders) {
    if (holder.bottom >= top || !boxesOverlap(holder.box, box)) continue;
    const local = near.polygonsWithin(holder.box);
    if (!local.length) continue;
    const region = intersection(local, [holder.polygon]);
    if (multiArea(region) < MIN_OVERLAP_MM2) continue;
    if (!(levelOver(holder, region) >= top - 1e-6)) continue;
    regions.push(region);
    kind = holder.kind;
  }
  if (!regions.length) return null;
  return multiArea(union(...regions)) >= multiArea(footprint) * share ? kind : null;
}

/** About `count` points spread evenly along a footprint's outlines. */
export function outlinePoints(footprint: MultiPolygon, count: number): [number, number][] {
  let length = 0;
  for (const polygon of footprint) length += ringLength(polygon[0]);
  if (!(length > 0)) return [];
  const step = length / count;
  const out: [number, number][] = [];
  let next = step / 2;
  let walked = 0;
  for (const polygon of footprint) {
    const ring = polygon[0];
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      const edge = Math.hypot(bx - ax, by - ay);
      while (next < walked + edge && out.length < count) {
        const t = (next - walked) / edge;
        out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
        next += step;
      }
      walked += edge;
    }
  }
  return out;
}

function ringLength(ring: readonly (readonly number[])[]): number {
  let length = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    length += Math.hypot(bx - ax, by - ay);
  }
  return length;
}

const wetSets = new WeakMap<Polygon[], ClipSet>();

/** A body's floor for cutting to boxes, kept while the floor is the same one. */
function wetSet(polygons: Polygon[]): ClipSet {
  let set = wetSets.get(polygons);
  if (!set) wetSets.set(polygons, (set = new ClipSet([polygons])));
  return set;
}

/**
 * The wet floors a box reaches, as a key: all a shape standing in that box
 * takes from the earth. With the earth's own key in every shape's signature,
 * one shape moved in water that spans the model built all of them again.
 */
export function wetKey(wet: readonly WetBody[], box: Box): string {
  let key = '';
  for (const body of wet) {
    if (!boxesOverlap(body.box, box)) continue;
    key += `${body.index}:${body.level}:${body.footing}:${edgesKey(wetSet(body.polygons).within(box, 0.01))};`;
  }
  return key;
}

/** A hash of the edges of some paths, whichever vertex a ring starts at and whatever order they come in. */
function edgesKey(paths: Paths64): string {
  let sum = 0;
  let mix = 0;
  let count = 0;
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      let h = Math.imul(a.x ^ Math.imul(a.y, 0x27d4eb2d), 0x85ebca6b);
      h = Math.imul(h ^ b.x ^ Math.imul(b.y, 0x165667b1), 0xc2b2ae35);
      h ^= h >>> 15;
      sum = (sum + h) | 0;
      mix ^= Math.imul(h, 0x9e3779b1);
      count++;
    }
  }
  return `${count}.${(sum >>> 0).toString(36)}.${(mix >>> 0).toString(36)}`;
}

/** Where a footprint is wet: the pieces over each body, for a shape's top. */
export function wetUnder(footprint: MultiPolygon, wet: readonly WetBody[]): { dry: MultiPolygon; levels: number[] } {
  if (!footprint.length) return { dry: [], levels: [] };
  const box = multiBounds(footprint);
  let dry = footprint;
  const levels: number[] = [];
  for (const body of wet) {
    if (!dry.length) break;
    if (!boxesOverlap(body.box, box)) continue;
    const piece = intersection(dry, body.polygons);
    if (multiArea(piece) < MIN_OVERLAP_MM2) continue;
    dry = difference(dry, body.polygons);
    levels.push(body.level);
  }
  return { dry: multiArea(dry) >= MIN_OVERLAP_MM2 ? dry : [], levels };
}

/** A prism for one piece, draped on the ground where it stands on it. */
export function pieceSolids(
  piece: StandPiece,
  top: number | ((x: number, y: number) => number),
  ground: { heightAt: (x: number, y: number) => number; drape: number; lattice?: PrismSolid['lattice'] },
  embed: number,
  key: string,
): PrismSolid[] {
  const flatTop = typeof top === 'number' ? top : null;
  if (piece.bottom !== null) {
    const bottom = flatTop !== null ? Math.min(piece.bottom, flatTop - 0.05) : piece.bottom;
    return piece.polygons.map((polygon) => ({ kind: 'prism', role: 'building', polygon, top, bottom, drape: typeof top === 'number' ? 0 : ground.drape, lattice: typeof top === 'number' ? undefined : ground.lattice, key }));
  }
  const bottom =
    flatTop !== null
      ? (x: number, y: number) => Math.min(ground.heightAt(x, y) - embed, flatTop - 0.05)
      : (x: number, y: number) => ground.heightAt(x, y) - embed;
  return piece.polygons.map((polygon) => ({ kind: 'prism', role: 'building', polygon, top, bottom, drape: ground.drape, lattice: ground.lattice, key }));
}
