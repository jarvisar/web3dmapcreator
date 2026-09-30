// What an added shape stands on. It's built down to the top of whatever is
// under it and no further: a roof or bridge deck it was raised onto, or the
// ground. In water it goes down through the water to the floor under it (or
// the base), with the water cut around it, unless ground is kept for it
// there. Shapes used to be solid down to the base, which cut a column
// through whatever was under them, and a column through a building changes
// filament on every layer of it.

import { boxesOverlap, difference, intersection, multiArea, multiBounds, ringBounds, union, type Box } from '../geometry/polygon';
import type { CapSolid, PrismSolid, Solid } from '../geometry/solid';
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
}

export interface StandPiece {
  polygons: MultiPolygon;
  /** A flat underside, or null to stand on the ground. */
  bottom: number | null;
  /** The surface under it when that's water or a hollow, which a shape following the ground is flat on. */
  level?: number;
  /** Sunk into something taller than the shape. */
  buried?: string;
}

// Overlaps smaller than this don't hold anything up.
const MIN_OVERLAP_MM2 = 1e-3;
// Tops that aren't flat are sampled about this far apart, up to a limit.
const SAMPLE_MM = 0.5;
const MAX_SAMPLES = 400;

/** Holders from a building, bridge or shape solid. Trees hold nothing up. */
export function holdersOf(solid: Solid, kind: string): Holder[] {
  if (solid.kind === 'mesh') return [];
  if (solid.kind === 'cap') return capHolders(solid, kind);
  const top = solid.top;
  const bottom = typeof solid.bottom === 'number' ? solid.bottom : lowestOver(solid.polygon, solid.bottom);
  return [
    {
      kind,
      polygon: solid.polygon,
      box: ringBounds(solid.polygon[0]),
      topAt: typeof top === 'number' ? () => top : top,
      flat: typeof top === 'number' ? top : undefined,
      bottom,
    },
  ];
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

/** The lowest a holder's top gets over a region, or NaN when it has no top there. */
function levelOver(holder: Holder, region: MultiPolygon): number {
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
  const box = multiBounds(footprint);
  let remaining = footprint;
  const pieces: StandPiece[] = [];

  if (base !== null && top !== null) {
    const found: { region: MultiPolygon; level: number; buried?: string }[] = [];
    for (const holder of holders) {
      if (holder.bottom >= base || !boxesOverlap(holder.box, box)) continue;
      const region = intersection(footprint, [holder.polygon]);
      if (multiArea(region) < MIN_OVERLAP_MM2) continue;
      const level = levelOver(holder, region);
      if (!Number.isFinite(level)) continue;
      found.push({ region, level: Math.min(level, base), buried: level >= top - 1e-6 ? holder.kind : undefined });
    }
    found.sort((a, b) => b.level - a.level);
    for (const item of found) {
      if (!remaining.length) break;
      const piece = intersection(item.region, remaining);
      if (multiArea(piece) < MIN_OVERLAP_MM2) continue;
      remaining = difference(remaining, item.region);
      pieces.push({ polygons: piece, bottom: item.level - embed, buried: item.buried });
    }
  }

  for (const body of wet) {
    if (!remaining.length) break;
    if (!boxesOverlap(body.box, box)) continue;
    const piece = intersection(remaining, body.polygons);
    if (multiArea(piece) < MIN_OVERLAP_MM2) continue;
    remaining = difference(remaining, body.polygons);
    pieces.push({ polygons: piece, bottom: body.footing, level: body.level });
  }

  if (remaining.length && multiArea(remaining) >= MIN_OVERLAP_MM2) pieces.push({ polygons: remaining, bottom: null });
  return pieces;
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
