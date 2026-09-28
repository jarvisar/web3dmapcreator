// Measured LiDAR buildings as solids, ported from the add-on's
// lidar_buildings.measured_builder. A building with a roof envelope becomes
// a foundation prism draped into the terrain up to its measured base, and the
// roof cap standing on it (overlapping a little, as the add-on's did). Tiers
// and roof planes, from the terrace fallback, are flat or planar prisms.
// Anything that cannot be built cleanly returns null, and the building keeps
// its mapped shape.

import { capBoundary } from '../geometry/cap';
import { densifyRing, intersection, multiArea, normalize, ringPerimeter } from '../geometry/polygon';
import type { CapSolid, HeightFn, PrismSolid, Solid } from '../geometry/solid';
import { clipTin, tinArea, type Tin } from '../geometry/tinclip';
import type { PublishedRecord } from '../lidar/publish';
import type { MultiPolygon, Polygon } from '../types';
import { ringWidth } from './buildings/planar';
import { footprintAdmitsMinimumHeight } from './buildings/printability';
import type { Context } from './context';

export interface MeasuredOptions {
  /** The whole footprint, in model mm. */
  footprint: MultiPolygon;
  /** What of it lies in the model area and is not clipped away. */
  pieces: MultiPolygon;
  whole: boolean;
  /** Lowest and highest terrain under the building. */
  ground: [number, number];
  vertical: (metres: number) => number;
  minimumWidth: number;
  maximumSlenderness: number;
  exemptWidth: number;
  minimumHeight: number;
  minimumFootprint: number;
  role?: 'building' | 'rock';
}

export interface MeasuredResult {
  solids: Solid[];
  lift: number;
  terrain: number;
  /** Top of the whole measured building above the terrain it stands on, mm. */
  heightMm: number;
}

function projectShape(shape: MultiPolygon, ctx: Context): MultiPolygon {
  return normalize(shape.map((polygon) => polygon.map((ring) => ring.map(([lon, lat]) => ctx.projection.toModel(lon, lat)))));
}

/** A planar surface's height, fitted in the model frame through its widest corners. */
function planeOf(rings: [number, number, number][][]): ((x: number, y: number) => number) | null {
  const v = rings.flatMap((r) => r.slice(0, -1));
  if (v.length < 3) return null;
  const p = v[0];
  let q = v[1];
  for (const w of v) if ((w[0] - p[0]) ** 2 + (w[1] - p[1]) ** 2 > (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2) q = w;
  let r = v[2];
  let best = -1;
  for (const w of v) {
    const cross = Math.abs((q[0] - p[0]) * (w[1] - p[1]) - (q[1] - p[1]) * (w[0] - p[0]));
    if (cross > best) {
      best = cross;
      r = w;
    }
  }
  const [dx, dy, dz] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const [ex, ey, ez] = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  const det = dx * ey - dy * ex;
  if (Math.abs(det) <= 1e-12 * Math.max(dx * dx + dy * dy, ex * ex + ey * ey)) return null;
  const a = (dz * ey - dy * ez) / det;
  const b = (dx * ez - dz * ex) / det;
  return (x, y) => p[2] + a * (x - p[0]) + b * (y - p[1]);
}

/**
 * Solids for one measured building, or null to keep the mapped building.
 * Heights in the record are metres above the survey's ground; they stand on
 * the lowest terrain under the building, or, where the record carries a
 * ground anchor, on the terrain at that measured spot.
 */
export function measuredSolids(record: PublishedRecord, options: MeasuredOptions, ctx: Context): MeasuredResult | null {
  const hf = ctx.heightfield;
  const { vertical, pieces } = options;
  const role = options.role ?? 'building';
  let [terrain, terrainTop] = options.ground;
  if (record.groundAnchor) {
    const [x, y] = ctx.projection.toModel(record.groundAnchor[0], record.groundAnchor[1]);
    terrain = hf.heightAt(x, y) - vertical(record.groundAnchor[2]);
  }
  const base = record.heightM;
  let cap: Tin | null = null;
  if (record.cap) {
    const n = record.cap.vertices.length / 3;
    const vertices = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [x, y] = ctx.projection.toModel(record.cap.vertices[3 * i], record.cap.vertices[3 * i + 1]);
      vertices[3 * i] = x;
      vertices[3 * i + 1] = y;
      vertices[3 * i + 2] = record.cap.vertices[3 * i + 2];
    }
    cap = { vertices, triangles: Uint32Array.from(record.cap.triangles) };
    if (!options.whole) {
      cap = clipTin(cap, pieces);
      if (!cap || !cap.triangles.length) return null;
    }
    // The cap outline went through the metric frame and back; it may miss the
    // footprint by a micron or so along the edge, never more.
    const expected = multiArea(pieces);
    const perimeter = pieces.reduce((s, p) => s + p.reduce((t, ring) => t + ringPerimeter(ring), 0), 0);
    if (Math.abs(tinArea(cap) - expected) > Math.max(1e-3, perimeter * 1e-3) || !capBoundary(cap)) return null;
  }
  const surfaces = (record.roofSurfaces ?? []).map((surface) => {
    const rings = surface.rings.map((ring) => ring.map(([lon, lat, z]) => [...ctx.projection.toModel(lon, lat), z] as [number, number, number]));
    return { surface, rings, height: planeOf(rings) };
  });
  if (surfaces.some((s) => !s.height)) return null;
  // Only what is inside the model area counts towards the apex that the minimum height is measured to.
  let finished = base;
  if (cap) for (let k = 2; k < cap.vertices.length; k += 3) finished = Math.max(finished, cap.vertices[k]);
  for (const s of surfaces) for (const ring of s.rings) for (const [, , z] of ring) finished = Math.max(finished, z);
  let total = finished;
  for (const tier of record.tiers) total = Math.max(total, tier.topM);
  const outlines = pieces;
  let lift = 0;
  if (options.minimumHeight > 0 && outlines.some((p) => footprintAdmitsMinimumHeight(p[0], options.minimumFootprint))) {
    lift = Math.max(0, options.minimumHeight - (terrain + vertical(finished) - terrainTop));
  }
  const top = terrain + vertical(base) + lift;
  // Tiers, planes and the cap start this far below their base, inside the solid beneath.
  const overlap = Math.min(0.02, vertical(base) * 0.1);
  const embed = ctx.settings.land.embedMm;
  const floor: HeightFn = (x, y) => Math.min(hf.heightAt(x, y) - embed, top - 0.05);
  const lattice = { x0: hf.minX, y0: hf.minY, step: hf.step };
  const solids: Solid[] = [];
  for (const polygon of outlines) {
    const width = ringWidth(polygon[0]);
    if (width < options.minimumWidth) return null;
    if (options.maximumSlenderness > 0 && width < options.exemptWidth && vertical(total) > width * options.maximumSlenderness) return null;
    const box = polygon[0].reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
    const big = Math.max(box[2] - box[0], box[3] - box[1]) > hf.step;
    solids.push({ kind: 'prism', role, polygon, top, bottom: floor, drape: big ? hf.step : 0, lattice: big ? lattice : undefined } satisfies PrismSolid);
  }
  for (const tier of record.tiers) {
    const shape = intersection(projectShape(tier.geometry, ctx), outlines);
    const bottom = terrain + vertical(tier.bottomM) + lift - overlap;
    const tierTop = terrain + vertical(tier.topM) + lift;
    for (const polygon of shape) solids.push({ kind: 'prism', role, polygon, top: tierTop, bottom, drape: 0 });
  }
  if (cap) {
    const z = new Float64Array(cap.vertices);
    for (let k = 2; k < z.length; k += 3) z[k] = terrain + vertical(z[k]) + lift;
    solids.push({ kind: 'cap', role, vertices: z, triangles: cap.triangles, bottom: top - overlap } satisfies CapSolid);
  }
  let roofArea = 0;
  for (const { surface, rings, height } of surfaces) {
    const polygon: Polygon = rings.map((ring) => ring.slice(0, -1).map(([x, y]) => [x, y] as [number, number]));
    const bottom = terrain + vertical(surface.bottomM) + lift - overlap;
    for (const piece of intersection([polygon], outlines)) {
      const at: HeightFn = (x, y) => terrain + vertical(height!(x, y)) + lift;
      if (piece.some((ring) => ring.some(([x, y]) => at(x, y) <= bottom))) return null;
      solids.push({ kind: 'prism', role, polygon: piece, top: at, bottom, drape: 0 });
      roofArea += multiArea([piece]);
    }
  }
  if (surfaces.length) {
    const footprintArea = multiArea(outlines);
    if (Math.abs(roofArea - footprintArea) > Math.max(0.001, footprintArea * 0.01)) return null;
  }
  return { solids, lift, terrain, heightMm: vertical(total) + lift };
}

/** Terrain samples along a shape's outline and inside it: lowest and highest. */
export function terrainRange(shape: MultiPolygon, ctx: Context): [number, number] | null {
  const hf = ctx.heightfield;
  let low = Infinity;
  let high = -Infinity;
  for (const polygon of shape) {
    for (const ring of polygon) {
      for (const [x, y] of densifyRing(ring, hf.step)) {
        const z = hf.heightAt(x, y);
        low = Math.min(low, z);
        high = Math.max(high, z);
      }
    }
    for (const node of hf.nodesInside(polygon)) {
      low = Math.min(low, hf.values[node]);
      high = Math.max(high, hf.values[node]);
    }
  }
  return Number.isFinite(low) ? [low, high] : null;
}

export { projectShape };
