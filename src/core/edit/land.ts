// Ground a removed road or building leaves, given back to the land cover it
// was cleared from: a path taken out of a park is grass again, not a strip
// of bare terrain. The fill meets the slab it came out of along the old
// edge, so the part gets a second shell there, which prints like one.

import { ClipSet, clipToBox, difference, dropSmall, intersection, multiBounds, offsetPolygons } from '../geometry/polygon';
import { SLIVER_MM } from '../pipeline/land';
import type { SurfaceCategory } from '../settings';
import type { MultiPolygon } from '../types';
import type { TileGrid } from './roads';

export interface LandFill {
  category: SurfaceCategory;
  polygons: MultiPolygon;
}

type Regions = Partial<Record<SurfaceCategory, MultiPolygon>>;

// Smaller than this isn't worth a solid.
const MINIMUM_MM2 = 0.1;

/**
 * Land cover for ground left bare, before thin strips are opened away.
 * `regions` is each category's ground before anything was cleared from it,
 * `blockers` what still stands there now: water, roads and buildings.
 */
export function bareLand(regions: Regions, order: readonly SurfaceCategory[], vacated: MultiPolygon, blockers: MultiPolygon): LandFill[] {
  if (!vacated.length) return [];
  const box = multiBounds(vacated);
  const free = blockers.length ? difference(vacated, clipToBox(blockers, box, 1)) : vacated;
  if (!free.length) return [];
  const out: LandFill[] = [];
  for (const category of order) {
    const region = regions[category];
    if (!region?.length) continue;
    const polygons = intersection(clipToBox(region, box, 1), free);
    if (polygons.length) out.push({ category, polygons });
  }
  return out;
}

/** Strips too thin to print in a colour of their own go, as the land stage has them. */
export function openFill(polygons: MultiPolygon): MultiPolygon {
  return dropSmall(offsetPolygons(offsetPolygons(polygons, -SLIVER_MM, 'round'), SLIVER_MM, 'round'), MINIMUM_MM2);
}

export function landFill(regions: Regions, order: readonly SurfaceCategory[], vacated: MultiPolygon, blockers: MultiPolygon): LandFill[] {
  const out: LandFill[] = [];
  for (const fill of bareLand(regions, order, vacated, blockers)) {
    const polygons = openFill(fill.polygons);
    if (polygons.length) out.push({ category: fill.category, polygons });
  }
  return out;
}

/** Land cover and water cut to tiles, as fills ask for them. */
export class LandTiles {
  private readonly regions: [SurfaceCategory, ClipSet][] = [];
  private readonly water: ClipSet;
  private readonly cache = new Map<number, { regions: Regions; water: MultiPolygon }>();

  constructor(
    land: { regions: Regions; water: MultiPolygon },
    private readonly grid: TileGrid,
  ) {
    for (const [category, polygons] of Object.entries(land.regions)) {
      if (polygons?.length) this.regions.push([category as SurfaceCategory, new ClipSet([polygons])]);
    }
    this.water = new ClipSet([land.water]);
  }

  tile(tile: number): { regions: Regions; water: MultiPolygon } {
    let out = this.cache.get(tile);
    if (!out) {
      const rect = this.grid.units(tile);
      const regions: Regions = {};
      for (const [category, set] of this.regions) {
        const polygons = set.polygonsWithinRect(rect);
        if (polygons.length) regions[category] = polygons;
      }
      out = { regions, water: this.water.polygonsWithinRect(rect) };
      this.cache.set(tile, out);
    }
    return out;
  }
}
