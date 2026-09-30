// Mapped tree points plus a jittered-grid scatter through forest polygons.
// The scatter is seeded from feature ids and grid cells, so the same
// selection always grows the same trees.

import { EdgeIndex } from '../geometry/edgeindex';
import { boxesOverlap, clipToBox, densifyRing, intersection, ringBounds, type Box } from '../geometry/polygon';
import type { MeshSolid } from '../geometry/solid';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { classifySurface, isTreePoint } from './classify';
import { count, type Context } from './context';
import { isRegionalFeature, projectPoints, projectPolygons, type SourceData, type SourceType } from './source';

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
  /** Ground roads. Crowns stay clear of them when avoidRoads is on. */
  roads: MultiPolygon;
  /** Building footprints and bridge decks. Crowns always stay clear of them. */
  structures: MultiPolygon;
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
  const blockers = t.avoidRoads ? [...options.roads, ...options.structures] : options.structures;
  const avoid = blockers.length ? new EdgeIndex(blockers, Math.max(radius * 4, 1)) : null;
  const water = new EdgeIndex(options.noGround, 1);
  // Long crop edges fill every bucket of their bounds, so this one is coarse.
  const crop = new EdgeIndex(ctx.cropSet, Math.max(radius * maxFactor * 4, 2));
  const placements: [number, number, number][] = [];
  let skipped = 0;

  const place = (x: number, y: number, size: number) => {
    if (placements.length >= t.maxTrees) return;
    const r = radius * scaleFor(size);
    // The whole crown, not only the trunk, has to be on the model.
    if (!crop.contains(x, y) || crop.distance(x, y, r) < r || water.contains(x, y)) return;
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
    const sources: [SourceType, typeof land][] = [
      ['land', land],
      ['land_use', data.features.land_use ?? []],
    ];
    if (t.landCoverScatter) sources.push(['land_cover', data.features.land_cover ?? []]);
    const regions: MultiPolygon[] = [];
    for (const [type, features] of sources) {
      for (const feature of features) {
        if (classifySurface(type, feature) !== 'forest') continue;
        if (isRegionalFeature(type, feature, ctx.bounds)) continue;
        const polygons = projectPolygons(feature.geometry, ctx.projection).filter((p) => boxesOverlap(ringBounds(p[0]), ctx.cropBox));
        if (polygons.length) regions.push(intersection(clipToBox(polygons, ctx.cropBox), ctx.cropSet));
      }
    }
    const full = () => placements.length >= t.maxTrees;
    // A forest is often mapped in land and land_use both. Each grid cell is
    // tried once whichever region reaches it, or it would get two trees.
    const tried = new Set<string>();
    for (let i = 0; i < regions.length && !full(); i++) {
      const progress = (f: number) => ctx.progress.checkpoint((i + f) / regions.length);
      for (const polygon of regions[i]) await scatter(polygon, spacing, tried, place, full, progress);
      await progress(1);
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
    // The base is flat, so on a slope its downhill side would lift off the
    // ground. It goes down to the lowest ground under it instead.
    const ring: Vec2[] = [];
    for (let i = 0; i < SIDES; i++) ring.push([positions[i * 3], positions[i * 3 + 1]]);
    let low = hf.minOver(densifyRing(ring, hf.step / 2));
    for (const node of hf.nodesInside([ring])) low = Math.min(low, hf.values[node]);
    for (let i = 0; i < SIDES; i++) positions[i * 3 + 2] = Math.min(positions[i * 3 + 2], low - embed);
    return { kind: 'mesh', role: 'tree', positions, indices: shape.indices, anchor: [x, y] as Vec2 };
  });
  count(ctx, 'trees', solids.length);
  count(ctx, 'trees_mapped', mapped);
  count(ctx, 'trees_skipped_roads', skipped);
  if (placements.length >= t.maxTrees) ctx.warnings.push(`Tree limit reached (${t.maxTrees.toLocaleString()} trees).`);
  return solids;
}

async function scatter(
  polygon: Polygon,
  spacing: number,
  tried: Set<string>,
  place: (x: number, y: number, size: number) => void,
  full: () => boolean,
  progress: (fraction: number) => Promise<void>,
) {
  const box: Box = ringBounds(polygon[0]);
  // Cells are counted from the model origin rather than the polygon and every
  // forest shares one jitter, so a tree stays put when the crop cuts its
  // forest differently, and overlapping forests agree on where trees go.
  const c0 = Math.floor(box[0] / spacing);
  const r0 = Math.floor(box[1] / spacing);
  const c1 = Math.floor(box[2] / spacing);
  const r1 = Math.floor(box[3] / spacing);
  // Strips one row of cells tall: a candidate only tests the outline edges
  // in its own row, which matters on a coastline-like forest edge.
  const outline = new EdgeIndex([polygon], spacing);
  for (let r = r0; r <= r1 && !full(); r++) {
    for (let c = c0; c <= c1; c++) {
      const [jx, jy, size] = jitter(seed('forest', r, c));
      const x = (c + 0.5 + (jx - 0.5) * JITTER * 2) * spacing;
      const y = (r + 0.5 + (jy - 0.5) * JITTER * 2) * spacing;
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
      const key = `${r},${c}`;
      if (tried.has(key) || !outline.contains(x, y)) continue;
      tried.add(key);
      place(x, y, size);
    }
    if ((r - r0) % 16 === 15) await progress((r - r0) / (r1 - r0 + 1));
  }
}
