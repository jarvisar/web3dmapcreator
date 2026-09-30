import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import type { MeshSolid } from '../geometry/solid';
import { cloneSettings, type ModelSettings } from '../settings';
import { HeightField } from '../terrain/heightfield';
import type { MultiPolygon, Ring } from '../types';
import { Progress, type Context } from './context';
import type { SourceFeature, SourceType } from './source';
import { buildTrees } from './trees';

const HALF = 35;
const CROP: Ring = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]];

function context(patch?: (settings: ModelSettings) => void, terrain?: (x: number, y: number) => number): Context {
  const settings = cloneSettings();
  settings.trees.enabled = true;
  patch?.(settings);
  return {
    settings,
    projection: new Projection([0.01, 45], 0, settings.scale.mmPerMetre),
    crop: [CROP],
    cropSet: [[CROP]],
    cropBox: [-HALF, -HALF, HALF, HALF],
    bounds: { west: 0, south: 44.99, east: 0.02, north: 45.01 },
    heightfield: terrain
      ? HeightField.build([-HALF - 2, -HALF - 2, HALF + 2, HALF + 2], 64, terrain)
      : HeightField.flat([-HALF - 2, -HALF - 2, HALF + 2, HALF + 2], 64, 0),
    stats: {},
    warnings: [],
    progress: new Progress(),
  };
}

/** A forest rectangle given in model mm. */
function forest(ctx: Context, x0: number, y0: number, x1: number, y1: number): SourceFeature {
  const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => ctx.projection.modelToGeo(x, y));
  return { id: `forest ${x0} ${y0}`, props: { subtype: 'forest', class: 'forest' }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

async function plant(ctx: Context, type: SourceType, features: SourceFeature[], structures: MultiPolygon = [], roads: MultiPolygon = []) {
  return buildTrees({ release: 'test', features: { [type]: features } }, ctx, { roads, structures, noGround: [] });
}

const footprintInside = (tree: MeshSolid, x0: number, y0: number, x1: number, y1: number) => {
  for (let i = 0; i < tree.positions.length; i += 3) {
    const x = tree.positions[i];
    const y = tree.positions[i + 1];
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  }
  return true;
};

describe('buildTrees', () => {
  it('scatters trees through land use forest', async () => {
    const ctx = context();
    const trees = await plant(ctx, 'land_use', [forest(ctx, -30, -30, 0, 30)]);
    expect(trees.length).toBeGreaterThan(50);
    expect(trees.every((t) => t.anchor[0] < 0)).toBe(true);
  });

  it('sinks the base of a tree on a slope into the ground all round', async () => {
    const ctx = context(undefined, (x, y) => 0.3 * x + 0.1 * y);
    const trees = await plant(ctx, 'land_use', [forest(ctx, -20, -20, 20, 20)]);
    expect(trees.length).toBeGreaterThan(10);
    const hf = ctx.heightfield;
    for (const tree of trees) {
      // The base is the lowest ring of vertices, flat.
      let low = Infinity;
      for (let i = 2; i < tree.positions.length; i += 3) low = Math.min(low, tree.positions[i]);
      for (let i = 0; i < tree.positions.length; i += 3) {
        if (tree.positions[i + 2] > low + 1e-6) continue;
        expect(low).toBeLessThanOrEqual(hf.heightAt(tree.positions[i], tree.positions[i + 1]) - ctx.settings.land.embedMm + 1e-6);
      }
    }
  });

  it('plants a forest mapped in land and land use once', async () => {
    const ctx = context();
    const once = await plant(ctx, 'land', [forest(ctx, -30, -30, 30, 30)]);
    const both = await buildTrees(
      { release: 'test', features: { land: [forest(ctx, -30, -30, 30, 30)], land_use: [forest(ctx, -30, -30, 30, 30)] } },
      context(),
      { roads: [], structures: [], noGround: [] },
    );
    expect(once.length).toBeGreaterThan(50);
    expect(both.map((t) => t.anchor)).toEqual(once.map((t) => t.anchor));
  });

  it('keeps every crown on the model', async () => {
    const ctx = context();
    // The forest runs well past the model edge.
    const trees = await plant(ctx, 'land', [forest(ctx, -60, -60, 60, 60)]);
    expect(trees.length).toBeGreaterThan(100);
    for (const tree of trees) expect(footprintInside(tree, -HALF, -HALF, HALF, HALF)).toBe(true);
  });

  it('scatters through detailed satellite forest whatever its size', async () => {
    const ctx = context();
    const [lon, lat] = ctx.projection.center;
    // Cut to a zoom 10 tile, nearly 300 times the selection.
    const tile = (min_zoom: number, max_zoom: number): SourceFeature => ({
      id: `cover ${min_zoom}`,
      props: { subtype: 'forest', cartography: { min_zoom, max_zoom } },
      geometry: { type: 'Polygon', coordinates: [[[lon - 0.17, lat - 0.17], [lon + 0.17, lat - 0.17], [lon + 0.17, lat + 0.17], [lon - 0.17, lat + 0.17], [lon - 0.17, lat - 0.17]]] },
    });
    expect((await plant(ctx, 'land_cover', [tile(8, 15)])).length).toBeGreaterThan(100);
    expect(await plant(ctx, 'land_cover', [tile(0, 7)])).toEqual([]);
    // Satellite surfaces are a separate setting.
    expect(ctx.settings.land.satelliteCover).toBe(false);
    const off = context((s) => (s.trees.landCoverScatter = false));
    expect(await plant(off, 'land_cover', [tile(8, 15)])).toEqual([]);
  });

  it('keeps crowns off buildings with road avoidance off', async () => {
    const ctx = context((s) => (s.trees.avoidRoads = false));
    const building: MultiPolygon = [[[[-10, -10], [10, -10], [10, 10], [-10, 10]]]];
    const road: MultiPolygon = [[[[-30, 20], [30, 20], [30, 21], [-30, 21]]]];
    const trees = await plant(ctx, 'land', [forest(ctx, -30, -30, 30, 30)], building, road);
    expect(trees.length).toBeGreaterThan(50);
    for (const tree of trees) {
      const [x, y] = tree.anchor;
      expect(Math.abs(x) < 10 && Math.abs(y) < 10).toBe(false);
    }
    // Roads are left alone when asked.
    expect(trees.some((t) => t.anchor[1] > 19.5 && t.anchor[1] < 21.5)).toBe(true);
  });
});
