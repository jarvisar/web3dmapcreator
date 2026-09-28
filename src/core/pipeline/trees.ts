// Mapped tree points plus a jittered-grid scatter through forest polygons.
// The scatter is seeded from feature ids and grid cells, so the same
// selection always grows the same trees.

import { EdgeIndex } from '../geometry/edgeindex';
import { boxesOverlap, clipToBox, intersection, pointInMulti, ringBounds, type Box } from '../geometry/polygon';
import type { MeshSolid } from '../geometry/solid';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { classifySurface, isTreePoint } from './classify';
import { count, type Context } from './context';
import { isRegional, projectPoints, projectPolygons, type SourceData, type SourceType } from './source';

const CANOPY_DIAMETER_M = 7;
const TREE_HEIGHT_M = 11;
const SIDES = 6;
const JITTER = 0.3;
const CANOPY_CLEARANCE_MM = 0.2;
const ROAD_CLEARANCE_MM = 0.005;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** zlib.crc32(data, value), so seeds are stable across runs and platforms. */
export function crc32(text: string, value = 0): number {
  const bytes = new TextEncoder().encode(text);
  let crc = ~value >>> 0;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function seed(...parts: (string | number)[]): number {
  return crc32(parts.join('|'));
}

function jitter(s: number): [number, number, number] {
  return [crc32('x', s) / 4294967296, crc32('y', s) / 4294967296, crc32('s', s) / 4294967296];
}

/**
 * One closed three-tier crown with a broad base. Each outward flare rises at
 * least as far as it reaches out, so no tier has a flat underside to print.
 */
export function treeGeometry(radius: number, height: number, embed = 0): { positions: number[]; indices: number[] } {
  const profile: [number, number][] = [
    [radius, 0],
    [0.58 * radius, 0.36 * height],
    [0.78 * radius, 0.45 * height],
    [0.33 * radius, 0.69 * height],
    [0.49 * radius, 0.77 * height],
  ];
  for (let i = profile.length - 2; i >= 0; i--) {
    const lower = profile[i];
    const upper = profile[i + 1];
    lower[0] = Math.max(lower[0], upper[0] - (upper[1] - lower[1]));
  }
  if (embed > 0) profile.unshift([radius, -embed]);
  const positions: number[] = [];
  for (const [r, z] of profile) {
    for (let i = 0; i < SIDES; i++) {
      const a = (2 * Math.PI * i) / SIDES;
      positions.push(Math.cos(a) * r, Math.sin(a) * r, z);
    }
  }
  const indices: number[] = [];
  // Bottom cap, facing down.
  for (let i = 1; i < SIDES - 1; i++) indices.push(0, i + 1, i);
  for (let ring = 0; ring < profile.length - 1; ring++) {
    const bottom = ring * SIDES;
    const top = (ring + 1) * SIDES;
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      indices.push(bottom + i, bottom + j, top + j, bottom + i, top + j, top + i);
    }
  }
  const apex = positions.length / 3;
  positions.push(0, 0, height);
  const top = (profile.length - 1) * SIDES;
  for (let i = 0; i < SIDES; i++) indices.push(top + i, top + ((i + 1) % SIDES), apex);
  return { positions, indices };
}

/** Accepts a tree only when its crown keeps a gap to every accepted crown. */
class Clearance {
  private cells = new Map<string, [number, number, number][]>();
  private readonly cell: number;
  constructor(maxRadius: number, private readonly gap: number) {
    this.cell = Math.max(2 * maxRadius + gap, 1e-6);
  }
  accept(x: number, y: number, r: number): boolean {
    const c = Math.floor(x / this.cell);
    const w = Math.floor(y / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const [px, py, pr] of this.cells.get(`${c + dx},${w + dy}`) ?? []) {
          if ((x - px) ** 2 + (y - py) ** 2 < (r + pr + this.gap) ** 2) return false;
        }
      }
    }
    const key = `${c},${w}`;
    const list = this.cells.get(key);
    if (list) list.push([x, y, r]);
    else this.cells.set(key, [[x, y, r]]);
    return true;
  }
}

export interface TreeOptions {
  /** Forest floor slabs, used when land cover is off too. */
  forest: MultiPolygon;
  /** Ground roads and buildings; crowns must stay clear of them. */
  avoid: MultiPolygon;
  /** Water and basins: never planted. */
  noGround: MultiPolygon;
}

export async function buildTrees(data: SourceData, ctx: Context, options: TreeOptions): Promise<MeshSolid[]> {
  const t = ctx.settings.trees;
  const hf = ctx.heightfield;
  const mm = ctx.projection.mmPerMetre;
  const embed = ctx.settings.land.embedMm;
  const flat = Math.cos(Math.PI / SIDES);
  // Floors apply to the finished tree independently, so a wider printable
  // crown does not also stretch the tree above the buildings around it.
  const trueHeight = TREE_HEIGHT_M * mm;
  const trueDiameter = CANOPY_DIAMETER_M * mm;
  const height = trueHeight * Math.max(1, t.minHeightMm / Math.max(trueHeight, 1e-9));
  const radius = (trueDiameter * Math.max(1, t.minWidthMm / Math.max(trueDiameter * flat, 1e-9))) / 2;
  const scaleFor = (size: number) =>
    Math.max(t.minHeightMm / height, t.minWidthMm / (2 * radius * flat), 1 + (size - 0.5) * 2 * t.variation);
  const maxFactor = Math.max(scaleFor(0), scaleFor(1));
  const clearance = new Clearance(radius * maxFactor, CANOPY_CLEARANCE_MM);
  const avoid = t.avoidRoads && options.avoid.length ? new EdgeIndex(options.avoid, Math.max(radius * 4, 1)) : null;
  const water = new EdgeIndex(options.noGround, 1);
  const placements: [number, number, number][] = [];
  let skipped = 0;

  const place = (x: number, y: number, size: number) => {
    if (placements.length >= t.maxTrees) return;
    if (!pointInMulti(x, y, ctx.cropSet) || water.contains(x, y)) return;
    const r = radius * scaleFor(size);
    if (avoid && avoid.touches(x, y, r + ROAD_CLEARANCE_MM)) {
      skipped++;
      return;
    }
    if (!clearance.accept(x, y, r)) return;
    placements.push([x, y, size]);
  };

  const land = data.features.land ?? [];
  if (t.mapped) {
    for (const feature of land) {
      if (!isTreePoint(feature)) continue;
      for (const [x, y] of projectPoints(feature.geometry, ctx.projection)) place(x, y, jitter(seed(feature.id))[2]);
    }
  }
  const mapped = placements.length;

  if (t.forestScatter) {
    const spacing = Math.max(t.spacingM * mm, 2 * radius + CANOPY_CLEARANCE_MM);
    const sources: [SourceType, typeof land][] = [['land', land]];
    if (t.landCoverScatter) sources.push(['land_cover', data.features.land_cover ?? []]);
    const regions: { key: string; polygons: MultiPolygon }[] = [];
    for (const [type, features] of sources) {
      for (const feature of features) {
        if (classifySurface(type, feature) !== 'forest') continue;
        if (isRegional(feature.geometry, ctx.bounds)) continue;
        const polygons = projectPolygons(feature.geometry, ctx.projection).filter((p) => boxesOverlap(ringBounds(p[0]), ctx.cropBox));
        if (polygons.length) regions.push({ key: `${type}|${feature.id}`, polygons: intersection(clipToBox(polygons, ctx.cropBox), ctx.cropSet) });
      }
    }
    if (!regions.length && options.forest.length) regions.push({ key: 'forest', polygons: options.forest });
    for (let i = 0; i < regions.length && placements.length < t.maxTrees; i++) {
      for (const polygon of regions[i].polygons) scatter(polygon, spacing, seed(regions[i].key), place);
      await ctx.progress.checkpoint(i / regions.length);
    }
  }

  const shape = treeGeometry(radius, height, embed);
  const solids: MeshSolid[] = placements.map(([x, y, size]) => {
    const factor = scaleFor(size);
    const angle = size * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const base = hf.heightAt(x, y);
    const positions = new Float32Array(shape.positions.length);
    for (let i = 0; i < shape.positions.length; i += 3) {
      const vx = shape.positions[i];
      const vy = shape.positions[i + 1];
      positions[i] = x + (vx * cos - vy * sin) * factor;
      positions[i + 1] = y + (vx * sin + vy * cos) * factor;
      positions[i + 2] = base + shape.positions[i + 2] * factor;
    }
    return { kind: 'mesh', role: 'tree', positions, indices: shape.indices, anchor: [x, y] as Vec2 };
  });
  count(ctx, 'trees', solids.length);
  count(ctx, 'trees_mapped', mapped);
  count(ctx, 'trees_skipped_roads', skipped);
  if (placements.length >= t.maxTrees) ctx.warnings.push(`Tree limit reached (${t.maxTrees.toLocaleString()} trees).`);
  return solids;
}

function scatter(polygon: Polygon, spacing: number, s: number, place: (x: number, y: number, size: number) => void) {
  const box: Box = ringBounds(polygon[0]);
  const columns = Math.floor((box[2] - box[0]) / spacing) + 1;
  const rows = Math.floor((box[3] - box[1]) / spacing) + 1;
  // Global grid cells, so neighbouring forests share one pattern.
  const c0 = Math.floor(box[0] / spacing);
  const r0 = Math.floor(box[1] / spacing);
  for (let r = r0; r <= r0 + rows; r++) {
    for (let c = c0; c <= c0 + columns; c++) {
      const [jx, jy, size] = jitter(seed(s, r, c));
      const x = (c + 0.5 + (jx - 0.5) * JITTER * 2) * spacing;
      const y = (r + 0.5 + (jy - 0.5) * JITTER * 2) * spacing;
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
      if (pointInMulti(x, y, [polygon])) place(x, y, size);
    }
  }
}
