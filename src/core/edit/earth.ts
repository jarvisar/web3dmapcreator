// Terrain and water once edits change what stands in the water. Water left
// out is given back as ground at the level of its banks, or keeps its recess
// as a hollow. The water is cut around whatever stands in it, and with
// supports on the ground kept under a structure goes with it and new road
// area or a drawn shape gets ground of its own, the way the pipeline keeps it
// (generate.ts). Only ground that was kept in the water ever goes: land is
// never touched. Both parts are rebuilt whole: the terrain meshes in about
// 100 ms even for San Francisco.

import { ClipSet, difference, differenceSet, dropSmall, multiBounds, offsetPolygons, union, type Box } from '../geometry/polygon';
import type { PrismSolid } from '../geometry/solid';
import type { EditContext, EditWater } from '../pipeline/generate';
import type { ModelSettings } from '../settings';
import type { MultiPolygon, Polygon } from '../types';

// A hollow in water running down to the base keeps at least this much floor.
const MIN_FLOOR_MM = 0.6;
// Changes smaller than this are rounding, not edits.
const NOISE_MM2 = 0.01;
// Water given back narrower than a nozzle stays as it was, or a removed road
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
    this.standing = union(kept.roads, kept.piers, kept.decks, kept.buildings);
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

    // Ground kept in the water: only what was kept can go.
    let kept = this.kept;
    let dropped: MultiPolygon = [];
    let keptBox: Box | null = null;
    if (input.kept) {
      const change = changes(this.kept, input.kept);
      dropped = change.dropped;
      if (change.box) {
        kept = change.now;
        keptBox = change.box;
      }
    }
    // What the water is cut around.
    let standing = this.standing;
    let standingBox: Box | null = null;
    if (input.standing) {
      const change = changes(this.standing, input.standing);
      if (change.box) {
        standing = change.now;
        standingBox = change.box;
      }
    }
    const keptSet = keptBox ? new ClipSet([kept]) : null;
    const standingSet = standingBox ? new ClipSet([standing]) : null;
    const through = [...input.hollow].some((i) => bodies[i].floor === null);

    const floors = bodies.map((body): Polygon[] => {
      if (!isRecessed(body) || !keptSet || !keptBox || !overlaps(body.polygon, keptBox)) return body.floors;
      return differenceSet([body.polygon], keptSet);
    });
    const water = bodies.map((body): Polygon[] => {
      if (!isRecessed(body) || !standingSet || !standingBox || !overlaps(body.polygon, standingBox)) return body.water;
      return differenceSet([body.polygon], standingSet);
    });

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
        ground = dropSmall(open.length ? difference(this.crop, union(open)) : this.crop, 0.01);
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
    if (standingBox !== null && this.waterShown) {
      fills = [];
      bodies.forEach((body, i) => {
        for (const polygon of water[i]) fills!.push({ kind: 'prism', role: 'water', polygon, top: body.top, bottom: body.bottom, drape: 0, key: body.key });
      });
    }
    return { terrain, water: fills, wet, dropped };
  }
}

/**
 * How a region differs from what it was: what went, and what it is now.
 * What went is opened, so a strip of it too thin to be water again stays.
 */
function changes(before: MultiPolygon, after: MultiPolygon): { now: MultiPolygon; dropped: MultiPolygon; box: Box | null } {
  let dropped = difference(before, after);
  if (dropped.length) dropped = dropSmall(offsetPolygons(offsetPolygons(dropped, -MIN_WATER_MM / 2, 'round'), MIN_WATER_MM / 2, 'round'), NOISE_MM2);
  const added = dropSmall(difference(after, before), NOISE_MM2);
  if (!dropped.length && !added.length) return { now: before, dropped, box: null };
  const now = union(dropped.length ? difference(before, dropped) : before, added);
  return { now, dropped, box: multiBounds([...dropped, ...added]) };
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
