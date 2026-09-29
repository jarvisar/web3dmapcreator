// Closed triangle meshes from prism solids.
//
// A prism is a polygon (with holes) extruded between a bottom and a top
// height that may vary across it. The cap is triangulated once and used for
// both the top and (reversed) the bottom, and vertical walls run along every
// boundary edge, so each shell is closed and consistently wound by
// construction. Where a surface follows the terrain the cap gets interior
// sample points on a lattice, triangulated with a constrained Delaunay
// triangulation so the outline is kept exactly.

import Constrainautor from '@kninnug/constrainautor';
import Delaunator from 'delaunator';
import earcut from 'earcut';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { capIsClosed, meshCap } from './cap';
import {
  boxesOverlap,
  cleanRing,
  densifyRing,
  intersection,
  multiBounds,
  offsetPolygons,
  PINCH_MM,
  pointInMulti,
  polygonArea,
  ringArea,
  ringBounds,
  SCALE,
  segmentDistance,
  type Box,
} from './polygon';
import { rowCrossings } from './scanline';
import type { HeightFn, PrismSolid, Solid } from './solid';

/** Thinnest wall a prism may have anywhere; thinner spots are lifted to this. */
export const MIN_THICKNESS = 0.01;

export class MeshBuilder {
  positions = new Float32Array(3 * 4096);
  indices = new Uint32Array(3 * 8192);
  vertexCount = 0;
  indexCount = 0;

  vertex(x: number, y: number, z: number): number {
    if (this.vertexCount * 3 + 3 > this.positions.length) {
      const grown = new Float32Array(this.positions.length * 2);
      grown.set(this.positions);
      this.positions = grown;
    }
    const i = this.vertexCount * 3;
    this.positions[i] = x;
    this.positions[i + 1] = y;
    this.positions[i + 2] = z;
    return this.vertexCount++;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.indices.length) {
      const grown = new Uint32Array(this.indices.length * 2);
      grown.set(this.indices);
      this.indices = grown;
    }
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  /** Append raw geometry, e.g. a precomputed tree. */
  append(positions: ArrayLike<number>, indices: ArrayLike<number>, dx = 0, dy = 0, dz = 0): void {
    const base = this.vertexCount;
    for (let i = 0; i < positions.length; i += 3) this.vertex(positions[i] + dx, positions[i + 1] + dy, positions[i + 2] + dz);
    for (let i = 0; i < indices.length; i += 3) this.triangle(base + indices[i], base + indices[i + 1], base + indices[i + 2]);
  }

  get triangleCount(): number {
    return this.indexCount / 3;
  }

  finish(): { positions: Float32Array; indices: Uint32Array } {
    return {
      positions: this.positions.slice(0, this.vertexCount * 3),
      indices: this.indices.slice(0, this.indexCount),
    };
  }
}

export interface MeshStats {
  solids: number;
  failed: number;
  fallbacks: number;
}

export function newMeshStats(): MeshStats {
  return { solids: 0, failed: 0, fallbacks: 0 };
}

/** A clip region with its bounds, so solids clearly inside or outside skip the boolean. */
export interface ClipRegion {
  polygons: MultiPolygon;
  box: Box;
  /** True when the region is exactly its bounding box. */
  rectangular: boolean;
}

export function clipRegion(polygons: MultiPolygon): ClipRegion {
  const box = multiBounds(polygons);
  const rectangular =
    polygons.length === 1 &&
    polygons[0].length === 1 &&
    Math.abs(polygonArea(polygons[0]) - (box[2] - box[0]) * (box[3] - box[1])) < 1e-9 * Math.max(1, polygonArea(polygons[0]));
  return { polygons, box, rectangular };
}

/** Mesh one solid into `out`, optionally keeping only what lies inside `clip`. */
export function meshSolid(solid: Solid, out: MeshBuilder, clip?: MultiPolygon | ClipRegion, stats?: MeshStats): void {
  const region = clip && !Array.isArray(clip) ? clip : clip ? clipRegion(clip) : undefined;
  if (solid.kind === 'cap') {
    const result = meshCap(solid, out, region);
    if (stats && result === 'ok') stats.solids++;
    if (stats && result === 'failed') stats.failed++;
    return;
  }
  if (solid.kind === 'mesh') {
    // A tree can't be cut, so one crossing a section edge is left out of both
    // sections rather than overhanging the next one. Trees are kept inside
    // the model outline, so only the section's box needs checking.
    if (region && (!pointInMulti(solid.anchor[0], solid.anchor[1], region.polygons) || !withinBox(solid.positions, region.box))) return;
    out.append(solid.positions, solid.indices);
    if (stats) stats.solids++;
    return;
  }
  let polygons: MultiPolygon = [solid.polygon];
  if (region) {
    const box = ringBounds(solid.polygon[0]);
    if (!boxesOverlap(box, region.box)) return;
    const inside =
      region.rectangular && box[0] >= region.box[0] && box[1] >= region.box[1] && box[2] <= region.box[2] && box[3] <= region.box[3];
    if (!inside) polygons = intersection([solid.polygon], region.polygons);
  }
  for (const polygon of polygons) {
    let result = meshPrism(polygon, solid, out, false, true);
    // Rings touching at a vertex (a pinch), or a hole's corner lying on
    // another ring's edge, which defeats both triangulators. A draped cap
    // whose constrained triangulation failed would fall back to a flat film,
    // and the same nudge usually lets it through. Shrinking parts the rings
    // and moves every vertex a little, and nothing was written by the refused
    // attempt.
    if (result === 'pinched' || result === 'failed' || result === 'fallback') {
      result = 'ok';
      for (const piece of shrink(polygon)) {
        const r = meshPrism(piece, solid, out, true);
        if (r === 'failed') result = 'failed';
        else if (r === 'fallback' && result === 'ok') result = 'fallback';
      }
    }
    if (stats) {
      if (result === 'failed') stats.failed++;
      else {
        stats.solids++;
        if (result === 'fallback') stats.fallbacks++;
      }
    }
  }
}

type Cap = { points: Vec2[]; boundaryCount: number; rings: number[][]; triangles: number[] };

/**
 * Mesh a single polygon as a prism. Returns 'ok', 'fallback' when the
 * constrained triangulation failed and ear clipping was used instead (with
 * `strict`, nothing is written then), 'pinched' (nothing written) when rings
 * touch at a vertex, or 'failed' when nothing usable could be built.
 */
export function meshPrism(
  polygon: Polygon,
  solid: Pick<PrismSolid, 'top' | 'bottom' | 'drape' | 'lattice'>,
  out: MeshBuilder,
  allowPinch = false,
  strict = false,
): 'ok' | 'fallback' | 'pinched' | 'failed' {
  const rings = prepareRings(polygon, solid.drape);
  if (!rings) return 'failed';
  // Checked after densifying, which can put a vertex right on a touching corner.
  if (!allowPinch && isPinched(rings)) return 'pinched';
  const expected = polygonArea(rings);
  if (expected <= 1e-8) return 'failed';

  let cap: Cap | null = null;
  let result: 'ok' | 'fallback' = 'ok';
  if (solid.drape > 0) {
    cap = constrainedCap(rings, solid.drape, solid.lattice, expected);
    if (!cap && strict) return 'fallback';
    if (!cap) result = 'fallback';
  }
  if (!cap) cap = earcutCap(rings, expected);
  // Ear clipping can go wrong around many holes close together (a harbour
  // full of piers). The constrained triangulation of the outline alone copes.
  if (!cap && solid.drape <= 0) cap = constrainedCap(rings, 0, undefined, expected);
  if (!cap) return 'failed';

  const top = solid.top;
  const bottom = solid.bottom;
  const n = cap.points.length;
  const topZ = new Float64Array(n);
  const bottomZ = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y] = cap.points[i];
    const b = evaluate(bottom, x, y);
    const t = evaluate(top, x, y);
    bottomZ[i] = b;
    topZ[i] = t < b + MIN_THICKNESS ? b + MIN_THICKNESS : t;
  }

  const topIndex = new Uint32Array(n);
  for (let i = 0; i < n; i++) topIndex[i] = out.vertex(cap.points[i][0], cap.points[i][1], topZ[i]);
  const tris = cap.triangles;
  for (let t = 0; t < tris.length; t += 3) out.triangle(topIndex[tris[t]], topIndex[tris[t + 1]], topIndex[tris[t + 2]]);

  // A flat bottom needs only the outline: ear clip it on its own instead of
  // repeating every interior lattice point of the top.
  const flatBottom = typeof bottom === 'number' && cap.boundaryCount < n;
  let bottomTris: number[] = tris;
  let bottomCount = n;
  if (flatBottom) {
    const outline = earcutIndices(cap.points, cap.rings);
    if (
      outline &&
      Math.abs(trianglesArea(cap.points, outline) - expected) <= 1e-5 + expected * 1e-4 &&
      capIsClosed(outline, cap.rings, cap.points.length)
    ) {
      bottomTris = outline;
      bottomCount = cap.boundaryCount;
    }
  }
  const bottomIndex = new Uint32Array(bottomCount);
  for (let i = 0; i < bottomCount; i++) bottomIndex[i] = out.vertex(cap.points[i][0], cap.points[i][1], bottomZ[i]);
  for (let t = 0; t < bottomTris.length; t += 3) {
    out.triangle(bottomIndex[bottomTris[t]], bottomIndex[bottomTris[t + 2]], bottomIndex[bottomTris[t + 1]]);
  }

  // Rings run counter-clockwise (outer) or clockwise (holes), so the solid is
  // on the left of every edge and the wall faces right.
  for (const ring of cap.rings) {
    for (let k = 0; k < ring.length; k++) {
      const i = ring[k];
      const j = ring[(k + 1) % ring.length];
      out.triangle(bottomIndex[i], bottomIndex[j], topIndex[j]);
      out.triangle(bottomIndex[i], topIndex[j], topIndex[i]);
    }
  }
  return result;
}

function withinBox(positions: ArrayLike<number>, box: Box): boolean {
  // Positions are float32, so allow for their rounding.
  const slack = 1e-4;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    if (x < box[0] - slack || x > box[2] + slack || y < box[1] - slack || y > box[3] + slack) return false;
  }
  return true;
}

function evaluate(height: HeightFn | number, x: number, y: number): number {
  return typeof height === 'number' ? height : height(x, y);
}

/** Clean, orient and (for draped solids) densify the rings. Null when the outer ring is degenerate. */
function prepareRings(polygon: Polygon, drape: number): Polygon | null {
  const out: Polygon = [];
  for (let r = 0; r < polygon.length; r++) {
    let ring = cleanRing(polygon[r]);
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 1e-9) {
      if (r === 0) return null;
      continue;
    }
    const ccw = ringArea(ring) > 0;
    if (ccw !== (r === 0)) ring = ring.slice().reverse();
    if (drape > 0) ring = densifyRing(ring, drape);
    out.push(ring);
  }
  return out.length ? out : null;
}

/**
 * Boolean results can touch themselves at a vertex: a hole meeting its outer
 * ring, or a ring meeting itself. Meshed as is, four wall faces would share
 * one vertical edge. Shrinking such a polygon by a tenth of a micron parts
 * the rings (and splits it where it only touched), without welding anything.
 */
function isPinched(polygon: Polygon): boolean {
  const seen = new Set<number>();
  for (const ring of polygon) {
    for (const p of cleanRing(ring)) {
      const key = pointKey(p[0], p[1]);
      if (seen.has(key)) return true;
      seen.add(key);
    }
  }
  return false;
}

function shrink(polygon: Polygon): Polygon[] {
  return offsetPolygons([polygon], -PINCH_MM, 'miter');
}

function trianglesArea(points: Vec2[], tris: number[]): number {
  let area = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = points[tris[t]];
    const b = points[tris[t + 1]];
    const c = points[tris[t + 2]];
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  return area;
}

/** Deduplicated boundary points and each ring as indices into them. */
function boundary(rings: Polygon): { points: Vec2[]; rings: number[][] } {
  const points: Vec2[] = [];
  const index = new Map<number, number>();
  const ringIndices: number[][] = [];
  for (const ring of rings) {
    const ids: number[] = [];
    for (const p of ring) {
      const key = pointKey(p[0], p[1]);
      let id = index.get(key);
      if (id === undefined) {
        id = points.length;
        points.push(p);
        index.set(key, id);
      }
      if (ids[ids.length - 1] !== id) ids.push(id);
    }
    while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
    if (ids.length >= 3) ringIndices.push(ids);
  }
  return { points, rings: ringIndices };
}

function pointKey(x: number, y: number): number {
  const qx = Math.round(x * SCALE) + 16777216;
  const qy = Math.round(y * SCALE) + 16777216;
  return qx * 33554432 + qy;
}

function earcutIndices(points: Vec2[], rings: number[][]): number[] | null {
  const coords: number[] = [];
  const holes: number[] = [];
  const map: number[] = [];
  rings.forEach((ring, r) => {
    if (r > 0) holes.push(map.length);
    for (const id of ring) {
      coords.push(points[id][0], points[id][1]);
      map.push(id);
    }
  });
  const local = earcut(coords, holes.length ? holes : undefined, 2);
  if (!local.length) return null;
  const out = new Array<number>(local.length);
  for (let i = 0; i < local.length; i += 3) {
    // earcut does not promise an orientation: make every triangle CCW.
    const a = map[local[i]];
    const b = map[local[i + 1]];
    const c = map[local[i + 2]];
    const pa = points[a];
    const pb = points[b];
    const pc = points[c];
    const cross = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
    out[i] = a;
    if (cross >= 0) {
      out[i + 1] = b;
      out[i + 2] = c;
    } else {
      out[i + 1] = c;
      out[i + 2] = b;
    }
  }
  return out;
}

function earcutCap(rings: Polygon, expected: number): Cap | null {
  const { points, rings: ids } = boundary(rings);
  if (!ids.length) return null;
  const triangles = earcutIndices(points, ids);
  if (!triangles) return null;
  // Ear clipping can silently drop a sliver on awkward input, and a cap that
  // does not add up to the polygon would leave a hole in the shell.
  if (Math.abs(trianglesArea(points, triangles) - expected) > 1e-5 + expected * 1e-4) return null;
  if (!capIsClosed(triangles, ids, points.length)) return null;
  return { points, boundaryCount: points.length, rings: ids, triangles };
}

function nextEdge(e: number): number {
  return e % 3 === 2 ? e - 2 : e + 1;
}

function constrainedCap(
  rings: Polygon,
  spacing: number,
  lattice: PrismSolid['lattice'],
  expected: number,
): Cap | null {
  const { points, rings: ids } = boundary(rings);
  if (!ids.length) return null;
  const boundaryCount = points.length;
  const step = lattice?.step ?? spacing;
  const x0 = lattice?.x0 ?? 0;
  const y0 = lattice?.y0 ?? 0;
  if (step > 0) addLattice(points, ids, x0, y0, step);
  // A lone triangle with nothing inside it is its own cap.
  if (points.length === boundaryCount && boundaryCount < 4) return earcutCap(rings, expected);

  const coords = new Float64Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    coords[2 * i] = points[i][0];
    coords[2 * i + 1] = points[i][1];
  }
  let triangles: Uint32Array;
  let halfedges: Int32Array;
  const directed = new Set<number>();
  const count = points.length;
  try {
    const del = new Delaunator(coords);
    const con = new Constrainautor(del);
    for (const ring of ids) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        con.constrainOne(a, b);
        directed.add(a * count + b);
      }
    }
    triangles = del.triangles;
    halfedges = del.halfedges;
  } catch {
    return null;
  }

  // Label triangles from the boundary edges they touch, then flood across
  // unconstrained edges. The solid lies left of every directed ring edge.
  const triCount = triangles.length / 3;
  const label = new Int8Array(triCount); // 1 inside, -1 outside, 0 unknown
  const orient = triangleOrientation(coords, triangles);
  const queue: number[] = [];
  for (let e = 0; e < triangles.length; e++) {
    const a = triangles[e];
    const b = triangles[nextEdge(e)];
    const t = (e / 3) | 0;
    let side = 0;
    if (directed.has(a * count + b)) side = 1;
    else if (directed.has(b * count + a)) side = -1;
    if (side === 0) continue;
    side *= orient;
    if (label[t] === 0) {
      label[t] = side;
      queue.push(t);
    } else if (label[t] !== side) {
      label[t] = 2; // conflicting: decided by its centroid below
    }
  }
  while (queue.length) {
    const t = queue.pop()!;
    const value = label[t];
    if (value === 2) continue;
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k;
      const opposite = halfedges[e];
      if (opposite < 0) continue;
      const a = triangles[e];
      const b = triangles[nextEdge(e)];
      if (directed.has(a * count + b) || directed.has(b * count + a)) continue;
      const u = (opposite / 3) | 0;
      if (label[u] === 0) {
        label[u] = value;
        queue.push(u);
      }
    }
  }

  const kept: number[] = [];
  for (let t = 0; t < triCount; t++) {
    let inside = label[t] === 1;
    if (label[t] === 2 || label[t] === 0) {
      const a = triangles[3 * t];
      const b = triangles[3 * t + 1];
      const c = triangles[3 * t + 2];
      const cx = (coords[2 * a] + coords[2 * b] + coords[2 * c]) / 3;
      const cy = (coords[2 * a + 1] + coords[2 * b + 1] + coords[2 * c + 1]) / 3;
      inside = windingInside(cx, cy, points, ids);
    }
    if (!inside) continue;
    const a = triangles[3 * t];
    const b = triangles[3 * t + 1];
    const c = triangles[3 * t + 2];
    if (orient > 0) kept.push(a, b, c);
    else kept.push(a, c, b);
  }
  if (!kept.length) return null;
  if (Math.abs(trianglesArea(points, kept) - expected) > 1e-5 + expected * 1e-4) return null;
  if (!capIsClosed(kept, ids, count)) return null;
  return { points, boundaryCount, rings: ids, triangles: kept };
}


/** +1 when Delaunator's triangles are counter-clockwise in this coordinate system. */
function triangleOrientation(coords: Float64Array, triangles: Uint32Array): number {
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t];
    const b = triangles[t + 1];
    const c = triangles[t + 2];
    const cross =
      (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) -
      (coords[2 * c] - coords[2 * a]) * (coords[2 * b + 1] - coords[2 * a + 1]);
    if (cross !== 0) return cross > 0 ? 1 : -1;
  }
  return 1;
}

function windingInside(x: number, y: number, points: Vec2[], rings: number[][]): boolean {
  let winding = 0;
  for (const ring of rings) {
    for (let k = 0, n = ring.length; k < n; k++) {
      const [x1, y1] = points[ring[k]];
      const [x2, y2] = points[ring[(k + 1) % n]];
      if (y1 <= y) {
        if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) winding++;
      } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) {
        winding--;
      }
    }
  }
  return winding !== 0;
}

/**
 * Lattice points strictly inside the rings and at least a third of a step
 * from every edge, so no sliver triangle forms against the outline and no
 * point can sit on a constrained edge.
 */
function addLattice(points: Vec2[], rings: number[][], x0: number, y0: number, step: number): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of rings[0]) {
    const [x, y] = points[id];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const firstCol = Math.ceil((minX - x0) / step);
  const lastCol = Math.floor((maxX - x0) / step);
  const firstRow = Math.ceil((minY - y0) / step);
  const lastRow = Math.floor((maxY - y0) / step);
  if (lastCol < firstCol || lastRow < firstRow) return;

  // Edges bucketed by lattice cell for the clearance test.
  const margin = step / 3;
  const cols = lastCol - firstCol + 3;
  const buckets = new Map<number, number[]>();
  const edges: number[] = [];
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      const e = edges.length;
      edges.push(a, b);
      const [ax, ay] = points[a];
      const [bx, by] = points[b];
      const c0 = Math.floor((Math.min(ax, bx) - margin - x0) / step) - firstCol + 1;
      const c1 = Math.floor((Math.max(ax, bx) + margin - x0) / step) - firstCol + 1;
      const r0 = Math.floor((Math.min(ay, by) - margin - y0) / step) - firstRow + 1;
      const r1 = Math.floor((Math.max(ay, by) + margin - y0) / step) - firstRow + 1;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = r * cols + c;
          let list = buckets.get(key);
          if (!list) buckets.set(key, (list = []));
          list.push(e);
        }
      }
    }
  }

  const ringPoints: Vec2[][] = rings.map((ring) => ring.map((id) => points[id]));
  const rowXs = rowCrossings(ringPoints, y0, step, firstRow, lastRow - firstRow + 1);
  for (let row = firstRow; row <= lastRow; row++) {
    const y = y0 + row * step;
    const xs = rowXs[row - firstRow];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(firstCol, Math.ceil((xs[k] - x0) / step));
      const c1 = Math.min(lastCol, Math.floor((xs[k + 1] - x0) / step));
      for (let col = c0; col <= c1; col++) {
        const x = x0 + col * step;
        if (x - xs[k] < margin || xs[k + 1] - x < margin) continue;
        const bucketPoints = [
          Math.floor((x - x0) / step) - firstCol + 1,
          Math.floor((y - y0) / step) - firstRow + 1,
        ];
        let clear = true;
        for (let dr = -1; dr <= 1 && clear; dr++) {
          for (let dc = -1; dc <= 1 && clear; dc++) {
            const list = buckets.get((bucketPoints[1] + dr) * cols + bucketPoints[0] + dc);
            if (!list) continue;
            for (const e of list) {
              const [ax, ay] = points[edges[e]];
              const [bx, by] = points[edges[e + 1]];
              if (segmentDistance(x, y, ax, ay, bx, by) < margin) {
                clear = false;
                break;
              }
            }
          }
        }
        if (clear) points.push([x, y]);
      }
    }
  }
}
