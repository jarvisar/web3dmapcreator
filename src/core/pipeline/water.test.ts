import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { intersection, multiArea, polygonArea, ringBounds } from '../geometry/polygon';
import { cloneSettings } from '../settings';
import { HeightField } from '../terrain/heightfield';
import type { Ring } from '../types';
import { Progress, type Context } from './context';
import type { SourceFeature } from './source';
import { CUT_WATER_DROP_MM, solveWater } from './water';

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
    expect(sea[0].top).toBeCloseTo(0.35 - CUT_WATER_DROP_MM, 9);
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

  it('cuts a large lake that only has a corner in the model', async () => {
    const ctx = context(() => 1);
    // A 1.5 km square lake with 3 x 3 mm (about 1800 m2) in the model.
    const result = await solveWater([water(ctx, 'lake', 47, 32, 152, 137, LAKE)], ctx);
    expect(result.bodies.map((b) => b.kind)).toEqual(['cut']);
  });
});
