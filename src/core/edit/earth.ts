// Terrain and water once edits change what stands in the water. Water left
// out is given back as ground at the level of its banks, or keeps its recess
// as a hollow. The water is cut around whatever stands in it, and with
// supports on the ground kept under a structure goes with it and new road
// area or a drawn shape gets ground of its own, the way the pipeline keeps it
// (generate.ts). Only ground that was kept in the water ever goes: land is
// never touched. Both parts are rebuilt whole: the terrain meshes in about
// 100 ms even for San Francisco.
//
// Once anything really changed, the water and floors are cut from what
// stands in the water now, not from the generated regions patched with what
// went. The patch was an opened copy of the removed footprint, whose edges
// and arcs never quite met the old ones, and hairlines of the old outline
// stayed in the water as ground.

import { ClipSet, difference, differenceSet, dropSmall, intersection, multiBounds, offsetPolygons, ringBounds, union, type Box } from '../geometry/polygon';
import type { PrismSolid } from '../geometry/solid';
import { GROUND_SPECK_MM2, type EditContext, type EditWater } from '../pipeline/generate';
import type { ModelSettings } from '../settings';
import type { MultiPolygon, Polygon } from '../types';

// A hollow in water running down to the base keeps at least this much floor.
const MIN_FLOOR_MM = 0.6;
// Threads of water given back smaller than this stay water.
const NOISE_MM2 = 0.01;
// Half the width of a change that's more than rounding.
const DRIFT_MM = 0.0005;
// Water given back narrower than a nozzle stays ground, or a removed road
// beside a building leaves a thread of water.
const MIN_WATER_MM = 0.4;

export interface EarthInput {
  /** Ground kept in the water now, or null while it's as generated. */
  kept: MultiPolygon | null;
  /** Everything standing in the water now, which it's cut around, or null while as generated. */
  standing: MultiPolygon | null;
  /** Bodies left out and filled with ground, by index. */
  filled: ReadonlySet<number>;
  /** Bodies left out that keep their recess. */
  hollow: ReadonlySet<number>;
}

/** A body where there's no ground now, and how a shape stands in it. */
export interface WetBody {
  index: number;
  polygons: Polygon[];
  box: Box;
  /** The surface a shape's top counts from: its water, or its floor once the water's left out. */
  level: number;
  /** What a shape standing in it is built down to. */
  footing: number;
}

export interface Earth {
  /** Terrain solids, or null while the generated ones stand. */
  terrain: PrismSolid[] | null;
  /** Every body's water, or null while the generated water stands. */
  water: PrismSolid[] | null;
  wet: WetBody[];
  /** Ground kept in the water that the edits took away. */
  dropped: MultiPolygon;
}

/** Cut water and basins have a recess to fill or keep. Sheets lie on the ground. */
export function isRecessed(body: EditWater): boolean {
  return body.kind !== 'sheet';
}

export class EarthModel {
  /** Everything standing in the water as generated. */
  readonly standing: MultiPolygon;
  /** Ground kept in it as generated: under all of that with supports on, mapped piers and the like either way. */
  readonly kept: MultiPolygon;
  private cached: { signature: string; earth: Earth } | null = null;

  constructor(
    private readonly ctx: EditContext,
    private readonly settings: ModelSettings,
    private readonly baseZ: number,
    private readonly crop: MultiPolygon,
    /** The model has a water part, so bodies show their water. */
    private readonly waterShown: boolean,
  ) {
    const kept = ctx.kept;
    this.standing = union(kept.roads, kept.piers, kept.decks, kept.buildings, ...kept.tracks.map((track) => track.pieces));
    this.kept = settings.supports ? this.standing : kept.decks;
  }

  /** What a hollow left where water was stands on. */
  hollowFloor(body: EditWater): number {
    return body.floor ?? Math.max(body.top - this.settings.water.thicknessMm, this.baseZ + MIN_FLOOR_MM);
  }

  /** The floor under a body now, or null where it runs down to the base. */
  private floorOf(body: EditWater, hollow: boolean): number | null {
    return hollow ? this.hollowFloor(body) : body.floor;
  }

  earth(input: EarthInput, removed: ReadonlySet<number>, signature: string): Earth {
    if (this.cached?.signature === signature) return this.cached.earth;
    const earth = this.build(input, removed);
    this.cached = { signature, earth };
    return earth;
  }

  private build(input: EarthInput, removed: ReadonlySet<number>): Earth {
    const ctx = this.ctx;
    const bodies = ctx.bodies;
    const embed = this.settings.land.embedMm;

    // What the water is cut around, and the ground kept in it (only what was
    // kept can go), each as generated until it really changed.
    const standingChange = input.standing ? changes(this.standing, input.standing) : null;
    const keptChange = input.kept ? changes(this.kept, input.kept) : null;
    const standingSet = standingChange ? new ClipSet([input.standing!]) : null;
    const through = [...input.hollow].some((i) => bodies[i].floor === null);

    const water = bodies.map((body): Polygon[] => {
      if (!isRecessed(body) || !standingSet || !overlaps(body.polygon, standingChange!.box)) return body.water;
      return differenceSet([body.polygon], standingSet);
    });
    // Water given back narrower than a nozzle stays ground.
    const thin: Polygon[] = [];
    const gone = standingChange?.gone ?? [];
    if (gone.length) {
      const goneSet = new ClipSet([gone]);
      const goneBox = multiBounds(gone);
      bodies.forEach((body, i) => {
        if (water[i] === body.water || !overlaps(body.polygon, goneBox)) return;
        const given = dropSmall(intersection(water[i], goneSet.polygonsWithin(ringBounds(body.polygon[0]))), NOISE_MM2);
        const narrow = given.length ? thinParts(water[i], given) : [];
        if (!narrow.length) return;
        water[i] = difference(water[i], narrow);
        thin.push(...narrow);
      });
    }

    const kept = keptChange ? input.kept! : this.kept;
    let keptBox = keptChange?.box ?? null;
    if (thin.length) {
      const b = multiBounds(thin);
      keptBox = keptBox ? [Math.min(keptBox[0], b[0]), Math.min(keptBox[1], b[1]), Math.max(keptBox[2], b[2]), Math.max(keptBox[3], b[3])] : b;
    }
    const keptSet = keptBox ? new ClipSet([kept, thin]) : null;
    const floors = bodies.map((body): Polygon[] => {
      if (!isRecessed(body) || !keptSet || !overlaps(body.polygon, keptBox!)) return body.floors;
      return differenceSet([body.polygon], keptSet);
    });
    const dropped = keptChange?.gone.length ? (thin.length ? difference(keptChange.gone, thin) : keptChange.gone) : [];

    const wet: WetBody[] = [];
    bodies.forEach((body, i) => {
      if (!isRecessed(body) || input.filled.has(i) || !floors[i].length) return;
      const hollow = input.hollow.has(i);
      const floor = this.floorOf(body, hollow);
      const shown = this.waterShown && !removed.has(i);
      const level = shown ? body.top : (floor ?? this.baseZ);
      wet.push({ index: i, polygons: floors[i], box: multiBounds(floors[i]), level, footing: floor !== null ? floor - embed : this.baseZ });
    });

    const terrainChanged = keptBox !== null || input.filled.size > 0 || through;
    let terrain: PrismSolid[] | null = null;
    if (terrainChanged && ctx.terrain && ctx.heightfield) {
      const hf = ctx.heightfield;
      let ground = ctx.terrain.ground;
      if (keptBox !== null || input.filled.size > 0) {
        const open = wet.flatMap((body) => body.polygons);
        ground = dropSmall(open.length ? difference(this.crop, union(open)) : this.crop, GROUND_SPECK_MM2);
      }
      const drape = hf.flat ? 0 : hf.step;
      const lattice = hf.flat ? undefined : hf.lattice;
      const top = (x: number, y: number) => hf.heightAt(x, y);
      terrain = ground.map((polygon): PrismSolid => ({ kind: 'prism', role: 'terrain', polygon, top, bottom: this.baseZ, drape, lattice }));
      for (const body of wet) {
        const floor = this.floorOf(bodies[body.index], input.hollow.has(body.index));
        if (floor === null) continue;
        for (const polygon of body.polygons) terrain.push({ kind: 'prism', role: 'terrain', polygon, top: floor, bottom: this.baseZ, drape: 0 });
      }
    }

    let fills: PrismSolid[] | null = null;
    if (standingChange && this.waterShown) {
      fills = [];
      bodies.forEach((body, i) => {
        for (const polygon of water[i]) fills!.push({ kind: 'prism', role: 'water', polygon, top: body.top, bottom: body.bottom, drape: 0, key: body.key });
      });
    }
    return { terrain, water: fills, wet, dropped };
  }
}

/**
 * What went from a region, and a box around everything that changed, or null
 * while it only differs by rounding: road tiles rebuilt for an edit nearby
 * come out up to about 0.15 µm off the generated ones. That's judged by
 * width, not area. A road running along a pier left a 0.006 mm² sliver of
 * water, which an area threshold took for rounding, and the sliver stayed
 * ground.
 */
function changes(before: MultiPolygon, after: MultiPolygon): { gone: MultiPolygon; box: Box } | null {
  const gone = difference(before, after);
  const added = difference(after, before);
  const real = (mp: MultiPolygon) => mp.length > 0 && offsetPolygons(mp, -DRIFT_MM).length > 0;
  if (!real(gone) && !real(added)) return null;
  return { gone, box: multiBounds([...gone, ...added]) };
}

/**
 * Water given back that's narrower than a nozzle and more than a nozzle's
 * width from any wider water: threads between a building and the bank, not
 * the corners of open water. It's judged in the water as it is now. Opening
 * the given back footprint on its own left crescents where another road's end
 * cut into it and tabs where it met the bank, and filling every narrow corner
 * left a triangle of ground where a road had met the bank at an angle.
 */
function thinParts(water: MultiPolygon, given: MultiPolygon): MultiPolygon {
  const r = MIN_WATER_MM / 2;
  // The opening reaches 2r and the wide water MIN_WATER_MM past that, so the
  // water around what was given back is cut well clear of both.
  const local = intersection(water, offsetPolygons(given, 3 * MIN_WATER_MM));
  let near = offsetPolygons(offsetPolygons(local, -r, 'round'), r, 'round');
  // Grown in steps through the water, not across a pier between a sliver and the harbour.
  for (let i = 0; i < 4; i++) near = intersection(offsetPolygons(near, MIN_WATER_MM / 4, 'round'), local);
  return dropSmall(difference(given, near), NOISE_MM2);
}

function overlaps(polygon: Polygon, box: Box): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon[0]) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return minX <= box[2] && maxX >= box[0] && minY <= box[3] && maxY >= box[1];
}
