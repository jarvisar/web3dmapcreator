// Water: which bodies are cut from the terrain, which are recessed basins and
// which are surface sheets, and the level each one sits at. Cut water and
// basins are a layer of water on a terrain floor, or with `water.mode`
// 'through' cut water runs down to the base instead.
//
// A lake or river is level, and elevation data reports open water as a noisy
// plateau at its surface, so the median of samples inside a body is its
// level. Some elevation data carries bathymetry instead (San Francisco Bay's
// median is its seabed), so cut water is never solved below the low tenth of
// its connected shoreline. The terrain under water is then flattened to the
// level and the shore around cut water is kept at or above it, so the bank
// always shows above the water.

import {
  boxesOverlap,
  ClipSet,
  clipToBox,
  densifyRing,
  differenceSet,
  intersection,
  multiArea,
  polygonArea,
  ringBounds,
  union,
} from '../geometry/polygon';
import { interiorPoints, type HeightField } from '../terrain/heightfield';
import type { ModelSettings } from '../settings';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { isPrintableWater, isUntypedWater, recessedWaterKind } from './classify';
import { count, type Context } from './context';
import { projectPolygons, type SourceFeature } from './source';

/** Cut water and basins sit this far below their bank: one layer of bank shows. */
export const WATER_DROP_MM = 0.25;
/** Sheets sit this far above their flattened bed, so they show over the terrain. */
export const SHEET_OFFSET_MM = 0.18;
const SHORE_LEVEL_PERCENTILE = 0.1;
const MINIMUM_AREA_MM2 = 0.25;
const UNTYPED_BASIN_MAX_M2 = 5000;
// Level samples are 1 mm apart until a body would need more than this many.
const MAXIMUM_SAMPLES = 2 ** 18;
// Cut bodies overlapping by less than this only share an edge.
const OVERLAP_MM2 = 0.01;

export type WaterKind = 'cut' | 'sheet' | 'basin';

export interface WaterBody {
  polygon: Polygon;
  kind: WaterKind;
  /** Level the terrain under the body is flattened to (the lowest bank, for a basin). */
  bed: number;
  /** Water surface. */
  top: number;
  areaM2: number;
}

export interface WaterResult {
  bodies: WaterBody[];
  cut: MultiPolygon;
  basins: MultiPolygon;
  sheets: MultiPolygon;
  /** Every water footprint, for clearing land cover. */
  all: MultiPolygon;
}

function sourceAreaM2(polygons: Polygon[], ctx: Context): number {
  const scale = ctx.projection.mmPerMetre;
  let area = 0;
  for (const polygon of polygons) area += polygonArea(polygon);
  return area > 0 ? area / (scale * scale) : Infinity;
}

function ringKey(polygon: Polygon): string {
  return polygon
    .map((ring) => {
      let start = 0;
      for (let i = 1; i < ring.length; i++) {
        if (ring[i][0] < ring[start][0] || (ring[i][0] === ring[start][0] && ring[i][1] < ring[start][1])) start = i;
      }
      return ring
        .slice(start)
        .concat(ring.slice(0, start))
        .map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`)
        .join(';');
    })
    .join('|');
}

function medianLevel(hf: HeightField, polygon: Polygon): number {
  const spacing = Math.max(1, Math.sqrt(polygonArea(polygon) / MAXIMUM_SAMPLES));
  const interior = interiorPoints(polygon, spacing);
  const samples: Vec2[] = interior.length >= 8 ? interior : densifyRing(polygon[0], 1.5);
  return hf.percentileOver(samples, 0.5);
}

export async function solveWater(features: SourceFeature[], ctx: Context): Promise<WaterResult> {
  const { settings, heightfield: hf } = ctx;
  const water = settings.water;
  const cutBodies: WaterBody[] = [];
  const sheetPolygons: Polygon[] = [];
  const basinPolygons: Polygon[] = [];
  const areaScale = ctx.projection.mmPerMetre ** 2;
  const seenBasins = new Set<string>();

  for (let index = 0; index < features.length; index++) {
    if (index % 16 === 0) await ctx.progress.checkpoint(index / features.length);
    const feature = features[index];
    let projected: Polygon[] | null = null;
    const source = () => (projected ??= projectPolygons(feature.geometry, ctx.projection));
    let basinKind = recessedWaterKind(feature);
    if (!basinKind && isUntypedWater(feature) && sourceAreaM2(source(), ctx) < UNTYPED_BASIN_MAX_M2) {
      basinKind = 'untyped_water';
    }
    if (basinKind && water.skipPonds) {
      count(ctx, 'water_basins_skipped');
      continue;
    }
    if (!basinKind && !isPrintableWater(feature)) continue;

    const clipped = intersection(clipToBox(source(), ctx.cropBox), ctx.cropSet);
    // Decided on the whole feature, like basins: a lake with only a corner in
    // the model, or a river a round crop splits, is still cut water.
    const cut = !basinKind && sourceAreaM2(source(), ctx) >= water.cutMinAreaM2;
    for (const polygon of clipped) {
      const area = polygonArea(polygon);
      if (area < MINIMUM_AREA_MM2) continue;
      if (basinKind) {
        const key = ringKey(polygon);
        if (seenBasins.has(key)) continue;
        seenBasins.add(key);
        basinPolygons.push(polygon);
      } else if (cut) {
        const bed = medianLevel(hf, polygon);
        cutBodies.push({ polygon, kind: 'cut', bed, top: bed - WATER_DROP_MM, areaM2: area / areaScale });
      } else {
        sheetPolygons.push(polygon);
      }
    }
  }

  // A pond mapped inside a river would stack a recessed floor, or a sheet,
  // on top of the river's fill, so only what lies outside cut water is kept.
  const cutSet = new ClipSet([cutBodies.map((b) => b.polygon)]);
  const outsideCut = (polygon: Polygon): Polygon[] => {
    const kept = differenceSet([polygon], cutSet).filter((piece) => polygonArea(piece) >= MINIMUM_AREA_MM2);
    if (multiArea(kept) < polygonArea(polygon) - 1e-6) count(ctx, 'water_trimmed_to_cut');
    return kept;
  };
  const bodies: WaterBody[] = [...cutBodies];
  for (const polygon of sheetPolygons) {
    for (const piece of outsideCut(polygon)) {
      const bed = medianLevel(hf, piece);
      bodies.push({ polygon: piece, kind: 'sheet', bed, top: bed + SHEET_OFFSET_MM, areaM2: polygonArea(piece) / areaScale });
    }
  }
  // Ponds are too small for the elevation data to show, so they sit below
  // their lowest bank rather than at the median inside.
  for (const polygon of basinPolygons) {
    for (const piece of outsideCut(polygon)) {
      const bank = hf.minOver(densifyRing(piece[0], 1.5));
      bodies.push({ polygon: piece, kind: 'basin', bed: bank, top: bank - WATER_DROP_MM, areaM2: polygonArea(piece) / areaScale });
    }
  }
  await ctx.progress.checkpoint(0.9);

  raiseCutWaterToShore(hf, bodies, ctx.crop);
  const levelled = mergeConnectedCut(bodies, areaScale);
  flattenUnderWater(hf, levelled);

  const cut = union(levelled.filter((b) => b.kind === 'cut').map((b) => b.polygon));
  const basins = union(levelled.filter((b) => b.kind === 'basin').map((b) => b.polygon));
  const sheets = union(levelled.filter((b) => b.kind === 'sheet').map((b) => b.polygon));
  ctx.stats.water_bodies = levelled.length;
  ctx.stats.water_cut_bodies = levelled.filter((b) => b.kind === 'cut').length;
  ctx.stats.water_basins = levelled.filter((b) => b.kind === 'basin').length;
  ctx.stats.water_cut_area_mm2 = Math.round(multiArea(cut));
  return { bodies: levelled, cut, basins, sheets, all: union(cut, basins, sheets) };
}

/**
 * Underside of a body's water part, or null when it runs down to the base.
 * Cut water and basins sit on a terrain floor at this height. A sheet lies
 * on the terrain and reaches into it at least as far as roads and land do.
 */
export function waterBottom(body: WaterBody, settings: ModelSettings): number | null {
  const { mode, thicknessMm } = settings.water;
  if (body.kind === 'cut' && mode === 'through') return null;
  if (body.kind === 'sheet') return Math.min(body.top - thicknessMm, body.bed - settings.land.embedMm);
  return body.top - thicknessMm;
}

/**
 * Cut water can't stand below the land holding it in: raise each cut body to
 * the low tenth of the dry nodes bordering its connected water. Only nodes in
 * the model count. The grid runs on past the crop, and water the crop cut off
 * has seabed there.
 */
function raiseCutWaterToShore(hf: HeightField, bodies: WaterBody[], crop: Polygon): void {
  const ordinary = bodies.filter((b) => b.kind !== 'basin');
  if (!ordinary.some((b) => b.kind === 'cut')) return;
  const { cols, rows } = hf;
  const inModel = new Uint8Array(cols * rows);
  for (const n of hf.nodesInside(crop)) inModel[n] = 1;
  const inside = ordinary.map((b) => hf.nodesInside(b.polygon));
  const wet = new Uint8Array(cols * rows);
  for (const nodes of inside) for (const n of nodes) wet[n] = 1;
  const component = new Int32Array(cols * rows).fill(-1);
  const shores: number[][] = [];
  for (const nodes of inside) {
    for (const start of nodes) {
      if (component[start] >= 0) continue;
      const label = shores.length;
      const shore = new Set<number>();
      const stack = [start];
      component[start] = label;
      while (stack.length) {
        const node = stack.pop()!;
        const r = Math.floor(node / cols);
        const c = node - r * cols;
        const neighbours = [
          [r - 1, c],
          [r + 1, c],
          [r, c - 1],
          [r, c + 1],
        ];
        for (const [nr, nc] of neighbours) {
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const n = nr * cols + nc;
          if (!wet[n]) {
            if (inModel[n]) shore.add(n);
          } else if (component[n] < 0) {
            component[n] = label;
            stack.push(n);
          }
        }
      }
      shores.push([...shore].map((n) => hf.values[n]));
    }
  }
  ordinary.forEach((body, i) => {
    if (body.kind !== 'cut') return;
    const labels = new Set(inside[i].map((n) => component[n]));
    // A loop, not push(...shore): a lake with many islands has more shore
    // nodes than a call can take as arguments.
    const heights: number[] = [];
    for (const label of labels) if (label >= 0) for (const h of shores[label]) heights.push(h);
    if (!heights.length) return;
    heights.sort((a, b) => a - b);
    const level = heights[Math.floor(SHORE_LEVEL_PERCENTILE * (heights.length - 1))];
    if (level > body.bed) {
      body.bed = level;
      body.top = level - WATER_DROP_MM;
    }
  });
}

/**
 * Overlapping cut bodies are one stretch of water mapped twice (a harbour
 * mapped over the rivers running into it). Each group becomes one body at
 * the area-weighted median of their levels, which the largest body usually
 * decides. Separate levels would print as steps in open water. Bodies that
 * only touch keep their own levels, so a river mapped in pieces can still
 * step down a slope.
 */
function mergeConnectedCut(bodies: WaterBody[], areaScale: number): WaterBody[] {
  const cut = bodies.filter((b) => b.kind === 'cut');
  if (cut.length < 2) return bodies;
  const boxes = cut.map((b) => ringBounds(b.polygon[0]));
  const parent = cut.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < cut.length; i++) {
    for (let j = i + 1; j < cut.length; j++) {
      if (find(i) === find(j) || !boxesOverlap(boxes[i], boxes[j])) continue;
      // Both sides cut to the shared box first: a whole coastline against
      // hundreds of small lakes is otherwise very slow.
      const [a, b] = [boxes[i], boxes[j]];
      const shared: [number, number, number, number] = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
      const overlap = intersection(clipToBox([cut[i].polygon], shared, 0), clipToBox([cut[j].polygon], shared, 0));
      if (multiArea(overlap) > OVERLAP_MM2) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, WaterBody[]>();
  cut.forEach((body, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(body);
    else groups.set(root, [body]);
  });
  if (groups.size === cut.length) return bodies;

  const out = bodies.filter((b) => b.kind !== 'cut');
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => a.bed - b.bed);
    const total = sorted.reduce((sum, b) => sum + b.areaM2, 0);
    let level = sorted[sorted.length - 1].bed;
    let covered = 0;
    for (const body of sorted) {
      covered += body.areaM2;
      if (covered >= total / 2) {
        level = body.bed;
        break;
      }
    }
    for (const polygon of union(group.map((b) => b.polygon))) {
      out.push({ polygon, kind: 'cut', bed: level, top: level - WATER_DROP_MM, areaM2: polygonArea(polygon) / areaScale });
    }
  }
  return out;
}

/**
 * Cut water is flattened both ways (its nodes only shape the shoreline and
 * the ground kept under structures) and the ground around it is raised to at
 * least its level. Other water is carved down only, so a slab over it cannot
 * be pierced.
 */
function flattenUnderWater(hf: HeightField, bodies: WaterBody[]): void {
  const cut = bodies.filter((b) => b.kind === 'cut').sort((a, b) => b.bed - a.bed);
  for (const body of cut) hf.flattenInside(body.polygon, body.bed, true);
  if (cut.length) raiseCutShores(hf, cut, bodies.filter((b) => b.kind !== 'cut'));
  for (const body of bodies) if (body.kind === 'sheet') hf.flattenInside(body.polygon, body.bed);
}

function raiseCutShores(hf: HeightField, cut: WaterBody[], others: WaterBody[]): void {
  const { cols, rows } = hf;
  const wet = new Uint8Array(cols * rows);
  const inside = cut.map((b) => hf.nodesInside(b.polygon));
  for (const nodes of inside) for (const n of nodes) wet[n] = 1;
  for (const other of others) for (const n of hf.nodesInside(other.polygon)) wet[n] = 1;
  const raised = new Map<number, number>();
  cut.forEach((body, i) => {
    const near = new Set<number>();
    for (const node of inside[i]) {
      const r = Math.floor(node / cols);
      const c = node - r * cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) near.add(nr * cols + nc);
        }
      }
    }
    // A channel narrower than a cell holds no node, but its outline still
    // reaches every corner of the cells it runs through.
    for (const ring of body.polygon) {
      for (const [x, y] of densifyRing(ring, hf.step * 0.5)) {
        const c = Math.min(Math.max(Math.floor((x - hf.minX) / hf.step), 0), cols - 2);
        const r = Math.min(Math.max(Math.floor((y - hf.minY) / hf.step), 0), rows - 2);
        const base = r * cols + c;
        near.add(base);
        near.add(base + 1);
        near.add(base + cols);
        near.add(base + cols + 1);
      }
    }
    for (const node of near) {
      if (wet[node]) continue;
      if (hf.values[node] < body.bed && (raised.get(node) ?? -Infinity) < body.bed) raised.set(node, body.bed);
    }
  });
  for (const [node, level] of raised) hf.values[node] = level;
}
