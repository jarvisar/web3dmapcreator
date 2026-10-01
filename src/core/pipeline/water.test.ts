import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { intersection, multiArea, polygonArea, ringBounds } from '../geometry/polygon';
import { cloneSettings } from '../settings';
import { HeightField } from '../terrain/heightfield';
import type { Ring } from '../types';
import { Progress, type Context } from './context';
import type { SourceFeature } from './source';
import { WATER_DROP_MM, solveWater, waterBottom, type WaterBody } from './water';

const CROP: Ring = [[-50, -35], [50, -35], [50, 35], [-50, 35]];

// Laid out like generateModel's: the grid runs 1.5 cells past the crop.
function context(terrain: (x: number, y: number) => number): Context {
  const settings = cloneSettings();
  const cropBox = ringBounds(CROP);
  const pad = (100 / 96) * 1.5;
  const grid: [number, number, number, number] = [cropBox[0] - pad, cropBox[1] - pad, cropBox[2] + pad, cropBox[3] + pad];
  return {
    settings,
    projection: new Projection([0.01, 45], 0, settings.scale.mmPerMetre),
    crop: [CROP],
    cropSet: [[CROP]],
    cropBox,
    bounds: { west: 0, south: 44.99, east: 0.02, north: 45.01 },
    heightfield: HeightField.build(grid, 96, terrain),
    stats: {},
    warnings: [],
    progress: new Progress(),
  };
}

/** A rectangle given in model mm. */
function water(ctx: Context, id: string, x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): SourceFeature {
  const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => ctx.projection.modelToGeo(x, y));
  return { id, props, geometry: { type: 'Polygon', coordinates: [ring] } };
}

const LAKE = { subtype: 'lake', class: 'lake' };

describe('solveWater', () => {
  it('raises sea cut off by the model edge to the shore inside the model', async () => {
    // Bathymetry under the sea, land at 0.35 mm. The grid nodes past the
    // crop are seabed too, and must not pull the level down.
    const ctx = context((_, y) => (y < 0 ? -1.4 : 0.35));
    const result = await solveWater([water(ctx, 'sea', -200, -200, 200, 0, { subtype: 'ocean', class: 'ocean' })], ctx);
    const sea = result.bodies.filter((b) => b.kind === 'cut');
    expect(sea).toHaveLength(1);
    expect(sea[0].bed).toBeCloseTo(0.35, 9);
    expect(sea[0].top).toBeCloseTo(0.35 - WATER_DROP_MM, 9);
  });

  it('gives overlapping cut water one level and one body', async () => {
    // The water slopes (a noisy survey) and the land around it is lower, so
    // the shore doesn't level the two on its own.
    const ctx = context((x, y) => (Math.abs(y) < 20 && Math.abs(x) < 40 ? 1 + x / 40 : 0));
    const result = await solveWater(
      [water(ctx, 'west', -40, -20, 5, 20, LAKE), water(ctx, 'east', -5, -20, 40, 20, LAKE)],
      ctx,
    );
    const cut = result.bodies.filter((b) => b.kind === 'cut');
    expect(cut).toHaveLength(1);
    expect(polygonArea(cut[0].polygon)).toBeCloseTo(80 * 40, 3);
    expect(ctx.stats.water_cut_bodies).toBe(1);
  });

  it('keeps its own level for cut water that only touches', async () => {
    // A river mapped in two pieces end to end, stepping down a slope.
    const ctx = context((x, y) => (Math.abs(y) < 20 && Math.abs(x) < 40 ? 1 + x / 40 : 0));
    const result = await solveWater(
      [water(ctx, 'west', -40, -20, 0, 20, LAKE), water(ctx, 'east', 0, -20, 40, 20, LAKE)],
      ctx,
    );
    const cut = result.bodies.filter((b) => b.kind === 'cut');
    expect(cut).toHaveLength(2);
    expect(cut[0].bed).not.toBeCloseTo(cut[1].bed, 2);
  });

  it('keeps ponds out of cut water', async () => {
    const ctx = context(() => 1);
    const result = await solveWater(
      [water(ctx, 'lake', -40, -20, 0, 20, LAKE), water(ctx, 'pond', -5, -5, 5, 5, { subtype: 'water', class: 'pond' })],
      ctx,
    );
    const basins = result.bodies.filter((b) => b.kind === 'basin');
    expect(basins).toHaveLength(1);
    expect(polygonArea(basins[0].polygon)).toBeCloseTo(50, 3);
    expect(multiArea(intersection(result.cut, result.basins))).toBeLessThan(1e-6);
  });

  it('sinks a pond below its lowest bank', async () => {
    const ctx = context((x) => 1 + x / 100);
    const result = await solveWater([water(ctx, 'pond', -5, -5, 5, 5, { subtype: 'water', class: 'pond' })], ctx);
    const [pond] = result.bodies;
    expect(pond.kind).toBe('basin');
    expect(pond.bed).toBeCloseTo(0.95, 2);
    expect(pond.top).toBeCloseTo(pond.bed - WATER_DROP_MM, 9);
    expect(waterBottom(pond, ctx.settings)).toBeCloseTo(pond.top - ctx.settings.water.thicknessMm, 9);
  });

  it('runs cut water down to the base only when cut through', async () => {
    const ctx = context(() => 1);
    const result = await solveWater([water(ctx, 'lake', -40, -20, 0, 20, LAKE)], ctx);
    const [lake] = result.bodies;
    ctx.settings.water.thicknessMm = 0.6;
    expect(waterBottom(lake, ctx.settings)).toBeCloseTo(lake.top - 0.6, 9);
    ctx.settings.water.mode = 'through';
    expect(waterBottom(lake, ctx.settings)).toBeNull();
  });

  it('keeps a thin sheet reaching into the terrain', async () => {
    // About 43 m square, under the size cut water starts at.
    const ctx = context(() => 1);
    const result = await solveWater([water(ctx, 'stream', -1.5, -1.5, 1.5, 1.5, { subtype: 'river', class: 'river' })], ctx);
    const [sheet] = result.bodies;
    expect(sheet.kind).toBe('sheet');
    ctx.settings.water.thicknessMm = 0.1;
    expect(waterBottom(sheet, ctx.settings)).toBeCloseTo(sheet.bed - ctx.settings.land.embedMm, 9);
  });

  it('cuts a large lake that only has a corner in the model', async () => {
    const ctx = context(() => 1);
    // A 1.5 km square lake with 3 x 3 mm (about 1800 m2) in the model.
    const result = await solveWater([water(ctx, 'lake', 47, 32, 152, 137, LAKE)], ctx);
    expect(result.bodies.map((b) => b.kind)).toEqual(['cut']);
  });
});

describe('joining small water to cut water', () => {
  const DOCK = { subtype: 'water', class: 'dock' };
  const CANAL = { subtype: 'canal', class: 'canal' };
  const byId = (bodies: WaterBody[], id: string) => bodies.find((b) => b.source === id)!;

  it('sinks a lock with the water beside it, not on its dam', async () => {
    // The elevation data reads the lock as its dam, 0.2 mm over the water.
    const ctx = context((x, y) => (x > 0 && x < 3 && Math.abs(y) < 1.5 ? 1.2 : 1));
    const features = [water(ctx, 'river', -40, -20, 0, 20, LAKE), water(ctx, 'lock', 0, -1.5, 3, 1.5, DOCK)];
    const result = await solveWater(features, ctx);
    const lock = byId(result.bodies, 'lock');
    expect(lock.kind).toBe('cut');
    expect(lock.top).toBeCloseTo(byId(result.bodies, 'river').top, 9);
    expect(ctx.stats.water_joined_to_cut).toBe(1);
    expect(multiArea(result.cut)).toBeCloseTo(40 * 40 + 9, 3);

    const off = context((x, y) => (x > 0 && x < 3 && Math.abs(y) < 1.5 ? 1.2 : 1));
    off.settings.water.joinSmallWater = false;
    const sheet = byId((await solveWater(features, off)).bodies, 'lock');
    expect(sheet.kind).toBe('sheet');
    expect(sheet.top).toBeGreaterThan(byId(result.bodies, 'river').top + 0.4);
  });

  it('carries on through canal pieces that only touch each other', async () => {
    const ctx = context(() => 1);
    const result = await solveWater(
      [water(ctx, 'river', -40, -20, 0, 20, LAKE), water(ctx, 'a', 0, -1, 4, 1, CANAL), water(ctx, 'b', 4, -1, 8, 1, CANAL), water(ctx, 'c', 8, -1, 12, 1, CANAL)],
      ctx,
    );
    const top = byId(result.bodies, 'river').top;
    for (const id of ['a', 'b', 'c']) {
      expect(byId(result.bodies, id).kind).toBe('cut');
      expect(byId(result.bodies, id).top).toBeCloseTo(top, 9);
    }
  });

  it('takes the lower level between two bodies of water', async () => {
    // A lock between a river and a harbour 0.3 mm higher.
    const ctx = context((x) => (x < 0 ? 1 : x > 3 ? 1.3 : 1.2));
    const result = await solveWater(
      [water(ctx, 'river', -40, -20, 0, 20, LAKE), water(ctx, 'lock', 0, -1.5, 3, 1.5, DOCK), water(ctx, 'harbour', 3, -20, 40, 20, LAKE)],
      ctx,
    );
    const [river, lock, harbour] = ['river', 'lock', 'harbour'].map((id) => byId(result.bodies, id));
    expect(harbour.bed).toBeGreaterThan(river.bed + 0.2);
    expect(lock.bed).toBeCloseTo(river.bed, 9);
  });

  it('leaves a stream climbing away from the water on the ground', async () => {
    const ctx = context((x) => (x > 0 ? 1 + x / 3 : 1));
    const result = await solveWater([water(ctx, 'lake', -40, -20, 0, 20, LAKE), water(ctx, 'stream', 0, -1, 9, 1, CANAL)], ctx);
    expect(byId(result.bodies, 'stream').kind).toBe('sheet');
  });

  it('joins untyped small water but not a tagged pond', async () => {
    const ctx = context(() => 1);
    const result = await solveWater(
      [
        water(ctx, 'lake', -40, -20, 0, 20, LAKE),
        water(ctx, 'pond', 0, 5, 3, 8, { subtype: 'water', class: 'pond' }),
        water(ctx, 'untyped', 0, -8, 3, -5, { subtype: 'water', class: 'water' }),
      ],
      ctx,
    );
    expect(byId(result.bodies, 'pond').kind).toBe('basin');
    expect(byId(result.bodies, 'untyped').kind).toBe('cut');
  });

  it("leaves small water that doesn't touch", async () => {
    const ctx = context(() => 1);
    const result = await solveWater([water(ctx, 'lake', -40, -20, 0, 20, LAKE), water(ctx, 'lock', 0.5, -1.5, 3.5, 1.5, DOCK)], ctx);
    expect(byId(result.bodies, 'lock').kind).toBe('sheet');
  });
});
