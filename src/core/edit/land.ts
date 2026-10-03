// Ground a removed road, building or body of water left, given back to the
// land cover it was cleared from: a path taken out of a park is grass again,
// not a strip of bare terrain.
//
// The cover is laid again around what was vacated the way the land stage
// lays it (pipeline/land.ts), from each category's ground before anything was
// cleared and what clears it now, and the fill is what that has and the
// generated slab lacks. So the fill meets the slab along the slab's own
// edges, and the part gets a second shell there, which prints like one.
// Laying the vacated footprint and opening it on its own left holes where
// its edges and the slab's didn't meet.
//
// It goes the other way too. Land cover gives way to a shape standing on the
// ground, the way the land stage cuts it around buildings and roads
// (LandSlabs). Left in, a slab under a drawn road only printed right where
// the slicer gave the overlap to the road, and an STL has no order.

import type { Rect64 } from 'clipper2-ts';
import { boxesOverlap, ClipSet, clipToUnits, difference, differenceSet, dropSmall, intersection, multiBounds, offsetPolygons, openSharp, SCALE, splitToTiles, type Box } from '../geometry/polygon';
import { SLIVER_MM } from '../pipeline/land';
import type { SurfaceCategory } from '../settings';
import type { MultiPolygon } from '../types';
import type { TileGrid } from './roads';

export interface LandFill {
  category: SurfaceCategory;
  polygons: MultiPolygon;
}

type Regions = Partial<Record<SurfaceCategory, MultiPolygon>>;

/**
 * How far the land stage's opening carries a change: in by SLIVER_MM, and out
 * again by up to three times that where a corner is mitred.
 */
export const FILL_REACH_MM = 4 * SLIVER_MM + 0.05;
// Cover is laid this far past where it's kept, as the land stage's tiles look past theirs.
const MARGIN_MM = 1;
// Two runs of the same booleans can differ by rounding, up to about 0.15 µm.
const DRIFT_MM = 0.0005;
// Rounding dust, as in the land stage.
const SPECK_MM2 = 1e-6;

/** Pieces wider than rounding. */
function real(polygons: MultiPolygon): MultiPolygon {
  return polygons.filter((p) => offsetPolygons([p], -DRIFT_MM).length > 0);
}

export class LandCover {
  private readonly regions: [SurfaceCategory, ClipSet][] = [];
  private readonly slabs = new Map<SurfaceCategory, ClipSet>();
  /** The generated water, which keeps land cover off until some of it is left out. */
  readonly water: ClipSet;

  /** `slabs` is each category's land cover as generated. */
  constructor(land: { regions: Regions; water: MultiPolygon }, slabs: Regions, order: readonly SurfaceCategory[]) {
    for (const category of order) {
      const region = land.regions[category];
      if (!region?.length) continue;
      this.regions.push([category, new ClipSet([region])]);
      this.slabs.set(category, new ClipSet([slabs[category] ?? []]));
    }
    this.water = new ClipSet([land.water]);
  }

  /** Where land cover can come back around ground vacated, rounding left out. */
  static reach(vacated: MultiPolygon): MultiPolygon {
    return vacated.length ? offsetPolygons(offsetPolygons(vacated, -DRIFT_MM), FILL_REACH_MM + DRIFT_MM, 'round') : [];
  }

  /**
   * Cover the slabs lack in one tile, `rect`, within `reach`. `blockers`
   * gives what clears land cover now near a box: water, roads and buildings.
   */
  tile(rect: Rect64, reach: MultiPolygon, blockers: (box: Box) => MultiPolygon): LandFill[] {
    if (!reach.length || !this.regions.length) return [];
    const r = multiBounds(reach);
    const box: Box = [Math.max(r[0], rect.left / SCALE), Math.max(r[1], rect.top / SCALE), Math.min(r[2], rect.right / SCALE), Math.min(r[3], rect.bottom / SCALE)];
    if (box[0] > box[2] || box[1] > box[3]) return [];
    const near: Box = [box[0] - MARGIN_MM, box[1] - MARGIN_MM, box[2] + MARGIN_MM, box[3] + MARGIN_MM];
    // Only a band around what was vacated is laid again. Laying the whole box
    // took 430 ms for Mission Creek in San Francisco.
    const zone = intersection(offsetPolygons(reach, MARGIN_MM), [[[[near[0], near[1]], [near[2], near[1]], [near[2], near[3]], [near[0], near[3]]]]]);
    let clear: MultiPolygon | null = null;
    const out: LandFill[] = [];
    for (const [category, set] of this.regions) {
      const region = set.polygonsWithin(near);
      if (!region.length || !boxesOverlap(multiBounds(region), box)) continue;
      const local = intersection(region, zone);
      if (!local.length) continue;
      clear ??= intersection(blockers(near), zone);
      const kept = clear.length ? difference(local, clear) : local;
      const laid = clipToUnits(openSharp(kept, SLIVER_MM), rect);
      const slab = this.slabs.get(category)!.polygonsWithin(near);
      const polygons = real(slab.length ? difference(laid, slab) : laid);
      if (polygons.length) out.push({ category, polygons });
    }
    return out;
  }

  /** One category's fill joined across tiles: only what reaches vacated ground. */
  static settle(polygons: MultiPolygon, reach: ClipSet): MultiPolygon {
    return polygons.filter((p) => {
      const near = reach.polygonsWithin(multiBounds([p]));
      return near.length > 0 && intersection([p], near).length > 0;
    });
  }
}

/** Land cover with `cut` taken out, opened like the land stage opens it. */
export function cutCover(polygons: MultiPolygon, cut: ClipSet): MultiPolygon {
  const kept = differenceSet(polygons, cut);
  return kept.length ? dropSmall(openSharp(kept, SLIVER_MM), SPECK_MM2) : [];
}

/**
 * The generated land cover split into the editor's tiles, for the view, which
 * meshes it a tile at a time so a shape moved only meshes the tiles it was
 * and is in. Exports cut the whole slabs instead (cutCover).
 */
export class LandSlabs {
  private readonly sets = new Map<SurfaceCategory, ClipSet>();
  private readonly split = new Map<SurfaceCategory, Map<number, MultiPolygon>>();

  constructor(
    private readonly grid: TileGrid,
    private readonly slabs: Regions,
  ) {}

  /** The category's tiles with anything in them. */
  tiles(category: SurfaceCategory): Map<number, MultiPolygon> {
    let tiles = this.split.get(category);
    if (!tiles) {
      const g = this.grid;
      this.split.set(category, (tiles = splitToTiles(this.slabs[category] ?? [], g.left, g.top, g.step, g.cols, g.rows)));
    }
    return tiles;
  }

  /**
   * One tile with `cut` taken out. Cut a millimetre past the tile and cut to
   * it after, as the land stage's tiles are, so the opening doesn't eat into
   * the tile's edges.
   */
  cut(category: SurfaceCategory, tile: number, cut: ClipSet): MultiPolygon {
    if (!this.tiles(category).has(tile)) return [];
    let set = this.sets.get(category);
    if (!set) this.sets.set(category, (set = new ClipSet([this.slabs[category] ?? []])));
    const rect = this.grid.units(tile);
    const margin = Math.round(MARGIN_MM * SCALE);
    const local = set.polygonsWithinRect({ left: rect.left - margin, top: rect.top - margin, right: rect.right + margin, bottom: rect.bottom + margin });
    return dropSmall(clipToUnits(cutCover(local, cut), rect), SPECK_MM2);
  }
}
