// 2D polygon operations in model millimetres, on top of Clipper2's integer
// engine. Coordinates are scaled to a 0.1 micron grid, which keeps booleans
// exact and robust while losing nothing a printer could show.

import {
  ClipType,
  Clipper64,
  ClipperOffset,
  EndType,
  FillRule,
  JoinType,
  PolyTree64,
  simplifyPaths,
  type Path64,
  type Paths64,
  type PolyPath64,
  type Rect64,
} from 'clipper2-ts';
import earcut from 'earcut';
import type { MultiPolygon, Polygon, Ring, Vec2 } from '../types';
import { clipToRect, pathBounds } from './clipRect';

export const SCALE = 10000;
/** Model-space distance below which two points are the same, in mm. */
export const EPSILON = 1e-4;
// Largest gap between a round cap or join and its chords: far below what a
// printer resolves, and every vertex saved speeds up the booleans after it.
const ARC_TOLERANCE = 0.005;

export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

export function polygonArea(polygon: Polygon): number {
  if (!polygon.length) return 0;
  let area = Math.abs(ringArea(polygon[0]));
  for (let i = 1; i < polygon.length; i++) area -= Math.abs(ringArea(polygon[i]));
  return Math.max(0, area);
}

export function multiArea(mp: MultiPolygon): number {
  let area = 0;
  for (const polygon of mp) area += polygonArea(polygon);
  return area;
}

export function ringPerimeter(ring: Ring): number {
  let sum = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    sum += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  }
  return sum;
}

export type Box = [number, number, number, number];

export function ringBounds(ring: Ring): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function multiBounds(mp: MultiPolygon): Box {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of mp) {
    if (!polygon.length) continue;
    const b = ringBounds(polygon[0]);
    if (b[0] < box[0]) box[0] = b[0];
    if (b[1] < box[1]) box[1] = b[1];
    if (b[2] > box[2]) box[2] = b[2];
    if (b[3] > box[3]) box[3] = b[3];
  }
  return box;
}

export function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return a[0] <= b[2] + margin && b[0] <= a[2] + margin && a[1] <= b[3] + margin && b[1] <= a[3] + margin;
}

/** Winding-number test against every ring: inside the outer ring and outside all holes. */
export function pointInPolygon(x: number, y: number, polygon: Polygon): boolean {
  let winding = 0;
  for (const ring of polygon) {
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      if (y1 <= y) {
        if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) winding++;
      } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) {
        winding--;
      }
    }
  }
  return winding !== 0;
}

export function pointInMulti(x: number, y: number, mp: MultiPolygon): boolean {
  for (const polygon of mp) if (pointInPolygon(x, y, polygon)) return true;
  return false;
}

/** Remove repeated points and the closing duplicate. */
export function cleanRing(ring: Ring, tolerance = EPSILON): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(p[0] - last[0]) > tolerance || Math.abs(p[1] - last[1]) > tolerance) out.push(p);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) > tolerance || Math.abs(a[1] - b[1]) > tolerance) break;
    out.pop();
  }
  return out;
}

/** Insert points so no edge is longer than `spacing`. */
export function densifyRing(ring: Ring, spacing: number): Ring {
  if (!(spacing > 0)) return ring;
  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push(a);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.ceil(length / spacing);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export function densifyLine(line: Vec2[], spacing: number): Vec2[] {
  if (!(spacing > 0) || line.length < 2) return line;
  const out: Vec2[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// ------------------------------------------------------------ conversion

function toPath(ring: Ring, wantPositive: boolean): Path64 {
  const path: Path64 = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) {
    path[i] = { x: Math.round(ring[i][0] * SCALE), y: Math.round(ring[i][1] * SCALE) };
  }
  // Clipper's positive orientation is counter-clockwise with Y up.
  if (pathArea(path) > 0 !== wantPositive) path.reverse();
  return path;
}

function pathArea(path: Path64): number {
  let sum = 0;
  for (let i = 0, n = path.length, j = n - 1; i < n; j = i++) {
    sum += (path[j].x + path[i].x) * (path[j].y - path[i].y);
  }
  return -sum / 2;
}

function fromPath(path: Path64): Ring {
  const ring: Ring = new Array(path.length);
  for (let i = 0; i < path.length; i++) ring[i] = [path[i].x / SCALE, path[i].y / SCALE];
  return ring;
}

/** Outer rings counter-clockwise and holes clockwise, as NonZero filling expects. */
export function toPaths(mp: MultiPolygon | Polygon[]): Paths64 {
  const paths: Paths64 = [];
  for (const polygon of mp) {
    polygon.forEach((ring, index) => {
      if (ring.length >= 3) paths.push(toPath(ring, index === 0));
    });
  }
  return paths;
}

function fromTree(tree: PolyTree64): MultiPolygon {
  const out: MultiPolygon = [];
  const strays: Ring[] = [];
  collect(tree, out, strays);
  if (strays.length) placeStrays(out, strays);
  return out;
}

function collect(node: PolyPath64, out: MultiPolygon, strays: Ring[]) {
  for (let i = 0; i < node.count; i++) addOuter(node.child(i), out, strays);
}

// Rings are sorted by orientation rather than by their depth in the tree:
// see placeStrays.
function addOuter(node: PolyPath64, out: MultiPolygon, strays: Ring[]) {
  if (!node.polygon || node.polygon.length < 3) return;
  const ring = fromPath(node.polygon);
  if (ringArea(ring) < 0) {
    strays.push(ring);
    collect(node, out, strays);
    return;
  }
  const polygon: Polygon = [ring];
  for (let j = 0; j < node.count; j++) {
    const hole = node.child(j);
    if (!hole.polygon || hole.polygon.length < 3) continue;
    const holeRing = fromPath(hole.polygon);
    if (ringArea(holeRing) > 0) {
      addOuter(hole, out, strays);
      continue;
    }
    polygon.push(holeRing);
    // Islands inside holes are outer polygons of their own.
    collect(hole, out, strays);
  }
  out.push(polygon);
}

// Where edges of the two inputs nearly coincide, a hole can cross its outer
// ring by less than a unit. Its bounds then poke out of the outer's, the
// engine won't nest it, and it comes back as a reversed outer: kept as one,
// a hole would print as a solid. Each goes back into the smallest polygon
// holding its interior, and a polygon it leaves thinner than a micron is
// dropped. Real models see a few specks of this.
function placeStrays(out: MultiPolygon, strays: Ring[]) {
  const emptied = new Set<Polygon>();
  for (const hole of strays) {
    const inside = interiorPoint(hole);
    if (!inside) continue;
    let owner: Polygon | null = null;
    let ownerArea = Infinity;
    for (const polygon of out) {
      const area = ringArea(polygon[0]);
      if (area >= ownerArea || !pointInPolygon(inside[0], inside[1], polygon)) continue;
      owner = polygon;
      ownerArea = area;
    }
    if (!owner) continue;
    owner.push(hole);
    if (polygonArea(owner) < ringPerimeter(owner[0]) * 1e-3) emptied.add(owner);
  }
  if (!emptied.size) return;
  let kept = 0;
  for (const polygon of out) if (!emptied.has(polygon)) out[kept++] = polygon;
  out.length = kept;
}

/** Centroid of the largest triangle of a ring, which is inside it. */
function interiorPoint(ring: Ring): Vec2 | null {
  const flat = ring.flat();
  const triangles = earcut(flat);
  let best: Vec2 | null = null;
  let bestArea = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [ring[triangles[t]], ring[triangles[t + 1]], ring[triangles[t + 2]]];
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    if (area <= bestArea) continue;
    bestArea = area;
    best = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
  }
  return best;
}

function run(clipType: ClipType, subject: Paths64, clip: Paths64 | null, fillRule = FillRule.NonZero): MultiPolygon {
  const clipper = new Clipper64();
  clipper.preserveCollinear = false;
  clipper.addSubject(subject);
  if (clip && clip.length) clipper.addClip(clip);
  const tree = new PolyTree64();
  clipper.execute(clipType, fillRule, tree);
  return fromTree(tree);
}

// ------------------------------------------------------------ booleans

/** Union of any number of polygons, overlapping or not. */
export function union(...sets: (MultiPolygon | Polygon[])[]): MultiPolygon {
  const paths: Paths64 = [];
  for (const set of sets) for (const p of toPaths(set)) paths.push(p);
  if (!paths.length) return [];
  return run(ClipType.Union, paths, null);
}

export function difference(subject: MultiPolygon, clip: MultiPolygon): MultiPolygon {
  if (!subject.length) return [];
  if (!clip.length) return run(ClipType.Union, toPaths(subject), null);
  return run(ClipType.Difference, toPaths(subject), toPaths(clip));
}

/** A box in mm grown by `margin`, as Clipper units rounded outwards. */
function rectFor(box: Box, margin: number): Rect64 {
  return {
    left: Math.floor((box[0] - margin) * SCALE),
    top: Math.floor((box[1] - margin) * SCALE),
    right: Math.ceil((box[2] + margin) * SCALE),
    bottom: Math.ceil((box[3] + margin) * SCALE),
  };
}

/**
 * Clip rings for a later boolean, cut to a box. Overlapping sets need no
 * union first: with NonZero filling, overlapping clip rings just add up.
 */
export class ClipSet {
  private readonly paths: Paths64;
  // Bounds of each path in Clipper units, so a query skips distant rings
  // without scanning them.
  private readonly boxes: Float64Array;
  constructor(sets: (MultiPolygon | Polygon[])[]) {
    this.paths = [];
    for (const set of sets) for (const p of toPaths(set)) this.paths.push(p);
    this.boxes = new Float64Array(this.paths.length * 4);
    this.paths.forEach((path, i) => this.boxes.set(pathBounds(path), i * 4));
  }
  get empty(): boolean {
    return this.paths.length === 0;
  }
  /** The rings cut to a box, much cheaper than clipping against all of them. */
  within(box: Box, margin = 0): Paths64 {
    const rect = rectFor(box, margin);
    const near: Paths64 = [];
    for (let i = 0; i < this.paths.length; i++) {
      const b = i * 4;
      if (this.boxes[b] > rect.right || this.boxes[b + 2] < rect.left || this.boxes[b + 1] > rect.bottom || this.boxes[b + 3] < rect.top) {
        continue;
      }
      near.push(this.paths[i]);
    }
    return near.length ? clipToRect(rect, near) : [];
  }
}

/**
 * Runs `fn` tile by tile over a large subject, so the booleans inside it only
 * see what's near each tile. A tile gets the subject `margin` past its edges
 * and keeps only its own square of the result, so an `fn` that looks no
 * further than `margin` (a difference, an opening) matches a single pass.
 * Pieces are cut at tile edges, and any later boolean joins them again.
 */
export function tiled(
  subject: MultiPolygon,
  tile: number,
  margin: number,
  fn: (local: MultiPolygon) => MultiPolygon,
): MultiPolygon {
  if (!subject.length) return [];
  const box = multiBounds(subject);
  if (box[2] - box[0] <= tile && box[3] - box[1] <= tile) return fn(subject);
  const out: MultiPolygon = [];
  const subjectSet = new ClipSet([subject]);
  // Tile edges fall on whole Clipper units, so neighbours share them exactly.
  const step = Math.round(tile * SCALE);
  const left = Math.floor(box[0] * SCALE);
  const top = Math.floor(box[1] * SCALE);
  const right = Math.ceil(box[2] * SCALE);
  const bottom = Math.ceil(box[3] * SCALE);
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const rect = { left: x, top: y, right: Math.min(x + step, right), bottom: Math.min(y + step, bottom) };
      const cell: Box = [rect.left / SCALE, rect.top / SCALE, rect.right / SCALE, rect.bottom / SCALE];
      const local = subjectSet.within(cell, margin);
      if (!local.length) continue;
      const result = toPaths(fn(run(ClipType.Union, local, null)));
      if (!result.length) continue;
      const kept = clipToRect(rect, result);
      if (kept.length) for (const piece of run(ClipType.Union, kept, null)) out.push(piece);
    }
  }
  return out;
}

/** Subtract a ClipSet: only the clip rings near the subject take part. */
export function differenceSet(subject: MultiPolygon, clip: ClipSet): MultiPolygon {
  if (!subject.length) return [];
  if (clip.empty) return subject;
  const local = clip.within(multiBounds(subject), 0.01);
  if (!local.length) return subject;
  return run(ClipType.Difference, toPaths(subject), local);
}

export function intersection(subject: MultiPolygon, clip: MultiPolygon): MultiPolygon {
  if (!subject.length || !clip.length) return [];
  return run(ClipType.Intersection, toPaths(subject), toPaths(clip));
}

/** Clean self-intersections and orientation of arbitrary source polygons. */
export function normalize(mp: MultiPolygon | Polygon[]): MultiPolygon {
  const paths = toPaths(mp);
  if (!paths.length) return [];
  return run(ClipType.Union, paths, null);
}

/**
 * Source polygons cut to a box, then cleaned like `normalize`. A sea or
 * forest polygon can carry hundreds of thousands of vertices of coastline far
 * outside the model. The rectangle clip is linear and drops them before the
 * much more expensive union.
 */
export function clipToBox(mp: MultiPolygon | Polygon[], box: Box, margin = 1): MultiPolygon {
  const paths = toPaths(mp);
  if (!paths.length) return [];
  const clipped = clipToRect(rectFor(box, margin), paths);
  if (!clipped.length) return [];
  return run(ClipType.Union, clipped, null);
}

// ------------------------------------------------------------ lines

/** Parts of open polylines inside (or outside, with `outside`) a polygon set. */
export function clipLines(lines: Vec2[][], clip: MultiPolygon, outside = false): Vec2[][] {
  if (!lines.length) return [];
  if (!clip.length) return outside ? lines : [];
  const clipper = new Clipper64();
  clipper.addOpenSubject(
    lines.filter((l) => l.length >= 2).map((l) => l.map(([x, y]) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) }))),
  );
  clipper.addClip(toPaths(clip));
  const closed: Paths64 = [];
  const open: Paths64 = [];
  clipper.execute(outside ? ClipType.Difference : ClipType.Intersection, FillRule.NonZero, closed, open);
  return open.filter((p) => p.length >= 2).map(fromPath);
}

export type LineCap = 'round' | 'butt' | 'square';

/**
 * Buffer centerlines into ribbons of the given full width. Joins are round so
 * tight turns and junctions stay solid. The result is one unioned set, with
 * any `extra` polygons in the same union.
 */
export function bufferLines(lines: { points: Vec2[]; width: number }[], cap: LineCap = 'round', extra: Polygon[] = []): MultiPolygon {
  if (!lines.length && !extra.length) return [];
  const endType = cap === 'round' ? EndType.Round : cap === 'square' ? EndType.Square : EndType.Butt;
  // Group by width: ClipperOffset applies one delta per execute.
  const byWidth = new Map<number, Paths64>();
  for (const line of lines) {
    if (line.points.length < 2 || !(line.width > 0)) continue;
    const key = Math.round(line.width * SCALE);
    let paths = byWidth.get(key);
    if (!paths) byWidth.set(key, (paths = []));
    paths.push(line.points.map(([x, y]) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) })));
  }
  const all: Paths64 = [];
  for (const [width, paths] of byWidth) {
    const offset = new ClipperOffset(2, ARC_TOLERANCE * SCALE);
    offset.addPaths(paths, JoinType.Round, endType);
    const solution: Paths64 = [];
    offset.execute(width / 2, solution);
    for (const p of solution) all.push(p);
  }
  if (extra.length) for (const p of toPaths(extra)) all.push(p);
  if (!all.length) return [];
  return run(ClipType.Union, all, null);
}

/** Grow (positive) or shrink (negative) polygons. */
export function offsetPolygons(mp: MultiPolygon, delta: number, join: 'round' | 'miter' = 'miter'): MultiPolygon {
  if (!mp.length) return [];
  if (delta === 0) return mp;
  const offset = new ClipperOffset(join === 'miter' ? 3 : 2, ARC_TOLERANCE * SCALE);
  offset.addPaths(toPaths(mp), join === 'miter' ? JoinType.Miter : JoinType.Round, EndType.Polygon);
  const tree = new PolyTree64();
  offset.execute(delta * SCALE, tree);
  return fromTree(tree);
}

/**
 * Vertices closer than `epsilon` to the line through their neighbours
 * dropped, then tidied by a union: an outline traced along a grid loses its
 * one-cell stairs and keeps its long edges and real corners.
 */
export function simplifyPolygons(mp: MultiPolygon, epsilon: number): MultiPolygon {
  if (!mp.length) return [];
  return run(ClipType.Union, simplifyPaths(toPaths(mp), epsilon * SCALE, true), null);
}

/**
 * Polygons of one set that share a vertex, shrunk by a hair so their prisms
 * don't share a wall edge. A union leaves polygons touching at a single
 * point apart, and two solids meeting along an edge don't slice as closed.
 */
export function separateTouching(mp: MultiPolygon): MultiPolygon {
  const owner = new Map<number, number>();
  const touching = new Set<number>();
  mp.forEach((polygon, i) => {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        const key = (Math.round(x * SCALE) + 2 ** 25) * 2 ** 26 + Math.round(y * SCALE) + 2 ** 25;
        const other = owner.get(key);
        if (other === undefined) owner.set(key, i);
        else if (other !== i) touching.add(other).add(i);
      }
    }
  });
  if (!touching.size) return mp;
  return mp.flatMap((polygon, i) => (touching.has(i) ? offsetPolygons([polygon], -2 / SCALE) : [polygon]));
}

/** Drop polygons (and holes) smaller than `minArea` mm². */
export function dropSmall(mp: MultiPolygon, minArea: number): MultiPolygon {
  const out: MultiPolygon = [];
  for (const polygon of mp) {
    if (!polygon.length || Math.abs(ringArea(polygon[0])) < minArea) continue;
    const kept: Polygon = [polygon[0]];
    for (let i = 1; i < polygon.length; i++) if (Math.abs(ringArea(polygon[i])) >= minArea * 0.25) kept.push(polygon[i]);
    out.push(kept);
  }
  return out;
}

/** A rectangle as a polygon set. */
export function rectangle(minX: number, minY: number, maxX: number, maxY: number): MultiPolygon {
  return [[[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]]];
}

/** Distance from a point to a segment. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / length2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
