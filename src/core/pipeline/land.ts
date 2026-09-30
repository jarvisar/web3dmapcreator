// Parks, forest floor, sand, rock and paving as thin draped slabs.
//
// Categories never overlap: a higher-priority category owns the ground where
// two meet, water footprints clear every category, and ground roads cut
// through all of them so a road never prints with grass under its edges.

import {
  boxesOverlap,
  ClipSet,
  clipLines,
  difference,
  differenceSet,
  dropSmall,
  intersection,
  clipToBox,
  offsetPolygons,
  ringBounds,
  tiled,
  union,
} from '../geometry/polygon';
import type { SurfaceCategory } from '../settings';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { classifySurface, isBridgeArea } from './classify';
import { count, type Context } from './context';
import { isPolygonal, isRegionalFeature, projectPolygons, type SourceData, type SourceType } from './source';

const MINIMUM_AREA_MM2 = 0.25;
const TILED_ABOVE_MM = 250;
const TILE_MM = 50;
const TILE_MARGIN_MM = 1;
export const SLIVER_MM = 0.1;

export type LandSurfaces = Record<SurfaceCategory, MultiPolygon>;

function lineMeetsPolygon(line: Vec2[], polygon: Polygon): boolean {
  const box = ringBounds(polygon[0]);
  if (!line.some(([x, y]) => x >= box[0] - 1 && x <= box[2] + 1 && y >= box[1] - 1 && y <= box[3] + 1)) return false;
  return clipLines([line], [polygon]).length > 0;
}

export async function buildLand(
  data: SourceData,
  ctx: Context,
  exclude: { water: MultiPolygon; roads: MultiPolygon; buildings: MultiPolygon; bridgeLines: Vec2[][] },
): Promise<LandSurfaces> {
  const collected: Record<SurfaceCategory, Polygon[]> = { paved: [], sand: [], rock: [], green: [], forest: [] };
  const types: SourceType[] = ['land', 'land_use'];
  // Also read for scattered trees, so the setting decides here too.
  if (ctx.settings.land.satelliteCover) types.push('land_cover');
  const cropBox = ctx.cropBox;
  let seen = 0;
  const total = types.reduce((n, t) => n + (data.features[t]?.length ?? 0), 0) || 1;

  for (const type of types) {
    for (const feature of data.features[type] ?? []) {
      seen++;
      if (seen % 64 === 0) await ctx.progress.checkpoint((0.5 * seen) / total);
      if (!isPolygonal(feature.geometry)) continue;
      const category = classifySurface(type, feature);
      if (!category) continue;
      if (isRegionalFeature(type, feature, ctx.bounds)) {
        count(ctx, 'land_regional_skipped');
        continue;
      }
      const polygons = projectPolygons(feature.geometry, ctx.projection).filter((p) =>
        boxesOverlap(ringBounds(p[0]), cropBox),
      );
      if (!polygons.length) continue;
      // A plaza mapped as the surface of a bridge is carried by the deck.
      if (isBridgeArea(feature) && exclude.bridgeLines.some((line) => polygons.some((p) => lineMeetsPolygon(line, p)))) {
        count(ctx, 'land_bridge_areas_skipped');
        continue;
      }
      collected[category].push(...polygons);
    }
  }

  const order = ctx.settings.land.priority;
  const result = {} as LandSurfaces;
  let owned: MultiPolygon = [];
  // Roads, water and buildings own their ground. Buildings stand on the
  // terrain, so no slab is left hidden inside them.
  const cleared = new ClipSet([exclude.water, exclude.roads, exclude.buildings]);
  // Large models subtract tile by tile, so each boolean only sees what's near it.
  const size = Math.max(ctx.cropBox[2] - ctx.cropBox[0], ctx.cropBox[3] - ctx.cropBox[1]);
  const tile = size > TILED_ABOVE_MM ? TILE_MM : Infinity;
  for (let i = 0; i < order.length; i++) {
    const category = order[i];
    let region = intersection(clipToBox(collected[category], ctx.cropBox), ctx.cropSet);
    if (owned.length) region = difference(region, owned);
    owned = union(owned, region);
    region = tiled(region, tile, TILE_MARGIN_MM, (local) => {
      const kept = differenceSet(local, cleared);
      // Strips narrower than about half a nozzle line (a median between two
      // road ribbons) can't print as a colour of their own, so open them away.
      return offsetPolygons(offsetPolygons(kept, -SLIVER_MM, 'round'), SLIVER_MM, 'round');
    });
    result[category] = dropSmall(intersection(region, ctx.cropSet), MINIMUM_AREA_MM2 * 0.4);
    ctx.stats[`land_${category}_polygons`] = result[category].length;
    await ctx.progress.checkpoint(0.5 + (0.5 * (i + 1)) / order.length);
  }
  for (const category of ['paved', 'sand', 'rock', 'green', 'forest'] as SurfaceCategory[]) {
    result[category] ??= [];
  }
  return result;
}
