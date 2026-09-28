// Water: which bodies are cut through the base, which are recessed basins and
// which are surface sheets, and the level each one sits at.
//
// A lake or river is level, and elevation data reports open water as a noisy
// plateau at its surface, so the median of samples inside a body is its
// level. Some elevation data carries bathymetry instead (San Francisco Bay's
// median is its seabed), so cut water is never solved below the low tenth of
// its connected shoreline. The terrain under water is then flattened to the
// level and the shore around cut water is kept at or above it, so the bank
// always shows above the water.

import { densifyRing, clipToBox, intersection, multiArea, polygonArea, union } from '../geometry/polygon';
import { interiorPoints, type HeightField } from '../terrain/heightfield';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { isPrintableWater, isUntypedWater, recessedWaterKind } from './classify';
import { count, type Context } from './context';
import { projectPolygons, type SourceFeature } from './source';

/** Cut water sits this far below the bank it is flattened to: one layer of bank shows. */
export const CUT_WATER_DROP_MM = 0.25;
/** Uncut water sits this far above its flattened bed, so it shows over the terrain. */
export const SHEET_OFFSET_MM = 0.18;
export const SHEET_THICKNESS_MM = 1.2;
const SHORE_LEVEL_PERCENTILE = 0.1;
const MINIMUM_AREA_MM2 = 0.25;
const UNTYPED_BASIN_MAX_M2 = 5000;

export type WaterKind = 'cut' | 'sheet' | 'basin';

export interface WaterBody {
  polygon: Polygon;
  kind: WaterKind;
  /** Level the terrain under the body is flattened to (the floor, for a basin). */
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

function sourceAreaM2(feature: SourceFeature, ctx: Context): number {
  // The whole uncropped feature: a small crop must not turn a large river into a pond.
  const polygons = projectPolygons(feature.geometry, ctx.projection);
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

export async function solveWater(features: SourceFeature[], ctx: Context): Promise<WaterResult> {
  const { settings, heightfield: hf } = ctx;
  const water = settings.water;
  const bodies: WaterBody[] = [];
  const classifyBasins = water.recessPonds || water.skipPonds;
  const areaScale = ctx.projection.mmPerMetre ** 2;
  const seenBasins = new Set<string>();

  for (let index = 0; index < features.length; index++) {
    const feature = features[index];
    let basinKind = classifyBasins ? recessedWaterKind(feature) : null;
    if (classifyBasins && !basinKind && isUntypedWater(feature) && sourceAreaM2(feature, ctx) < UNTYPED_BASIN_MAX_M2) {
      basinKind = 'untyped_water';
    }
    if (basinKind && water.skipPonds) {
      count(ctx, 'water_basins_skipped');
      continue;
    }
    if (!basinKind && !isPrintableWater(feature)) continue;

    const clipped = intersection(clipToBox(projectPolygons(feature.geometry, ctx.projection), ctx.cropBox), ctx.cropSet);
    for (const polygon of clipped) {
      const area = polygonArea(polygon);
      if (area < MINIMUM_AREA_MM2) continue;
      if (basinKind) {
        const key = ringKey(polygon);
        if (seenBasins.has(key)) continue;
        seenBasins.add(key);
        const bank = hf.minOver(densifyRing(polygon[0], 1.5));
        const bed = bank - water.pondDepthMm;
        bodies.push({ polygon, kind: 'basin', bed, top: bed + Math.min(water.pondWaterMm, water.pondDepthMm), areaM2: area / areaScale });
        continue;
      }
      const interior = interiorPoints(polygon, 1.0);
      const samples: Vec2[] = interior.length >= 8 ? interior : densifyRing(polygon[0], 1.5);
      const bed = hf.percentileOver(samples, 0.5);
      const areaM2 = area / areaScale;
      const cut = areaM2 >= water.cutMinAreaM2;
      bodies.push({
        polygon,
        kind: cut ? 'cut' : 'sheet',
        bed,
        top: cut ? bed - CUT_WATER_DROP_MM : bed + SHEET_OFFSET_MM,
        areaM2,
      });
    }
    if (index % 16 === 0) await ctx.progress.checkpoint(index / features.length);
  }

  raiseCutWaterToShore(hf, bodies);
  flattenUnderWater(hf, bodies);

  const cut = union(bodies.filter((b) => b.kind === 'cut').map((b) => b.polygon));
  const basins = union(bodies.filter((b) => b.kind === 'basin').map((b) => b.polygon));
  const sheets = union(bodies.filter((b) => b.kind === 'sheet').map((b) => b.polygon));
  ctx.stats.water_bodies = bodies.length;
  ctx.stats.water_cut_bodies = bodies.filter((b) => b.kind === 'cut').length;
  ctx.stats.water_basins = bodies.filter((b) => b.kind === 'basin').length;
  ctx.stats.water_cut_area_mm2 = Math.round(multiArea(cut));
  return { bodies, cut, basins, sheets, all: union(cut, basins, sheets) };
}

/**
 * Cut water can't stand below the land holding it in: raise each cut body to
 * the low tenth of the dry nodes bordering its connected water. The frame is
 * not a shore, since water cropped by it has seabed at its edge nodes.
 */
function raiseCutWaterToShore(hf: HeightField, bodies: WaterBody[]): void {
  const ordinary = bodies.filter((b) => b.kind !== 'basin');
  if (!ordinary.some((b) => b.kind === 'cut')) return;
  const { cols, rows } = hf;
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
            if (nr > 0 && nr < rows - 1 && nc > 0 && nc < cols - 1) shore.add(n);
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
    const heights: number[] = [];
    for (const label of labels) if (label >= 0) heights.push(...shores[label]);
    if (!heights.length) return;
    heights.sort((a, b) => a - b);
    const level = heights[Math.floor(SHORE_LEVEL_PERCENTILE * (heights.length - 1))];
    if (level > body.bed) {
      body.bed = level;
      body.top = level - CUT_WATER_DROP_MM;
    }
  });
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
