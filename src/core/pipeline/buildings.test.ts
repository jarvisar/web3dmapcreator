import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { MeshBuilder, meshSolid, newMeshStats } from '../geometry/mesher';
import { multiArea, polygonArea, rectangle, ringBounds } from '../geometry/polygon';
import type { HeightFn, PrismSolid } from '../geometry/solid';
import { edgeReport, signedVolume } from '../geometry/validate';
import { cloneSettings, type ModelSettings } from '../settings';
import { HeightField } from '../terrain/heightfield';
import type { MultiPolygon, Ring, Vec2 } from '../types';
import { buildBuildings } from './buildings';
import { Progress, type Context } from './context';
import type { SourceFeature } from './source';

// Printed mm per real metre, vertically, at the default scale and height boost.
const V = 0.07 * 1.1;
const local = new Projection([0, 0], 0, 1);

interface Setup {
  terrain?: (x: number, y: number) => number;
  crop?: Ring;
  patch?: (settings: ModelSettings) => void;
}

function context(setup: Setup = {}): Context {
  const settings = cloneSettings();
  setup.patch?.(settings);
  const crop: Ring = setup.crop ?? [[-40, -40], [40, -40], [40, 40], [-40, 40]];
  const cropBox = ringBounds(crop);
  const grid: [number, number, number, number] = [cropBox[0] - 2, cropBox[1] - 2, cropBox[2] + 2, cropBox[3] + 2];
  return {
    settings,
    projection: new Projection([0, 0], 0, settings.scale.mmPerMetre),
    crop: [crop],
    cropSet: [[crop]],
    cropBox,
    bounds: { west: -0.01, south: -0.01, east: 0.01, north: 0.01 },
    heightfield: HeightField.build(grid, 84, setup.terrain ?? (() => 0)),
    stats: {},
    warnings: [],
    progress: new Progress(),
  };
}

/** A rectangle given in real metres east and north of the area centre. */
function feature(id: string, x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown> = {}): SourceFeature {
  const corners: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  return { id, props, geometry: { type: 'Polygon', coordinates: [corners.map(([x, y]) => local.localToGeo(x, y))] } };
}

async function build(buildings: SourceFeature[], parts: SourceFeature[] = [], setup: Setup = {}, clipAway: MultiPolygon = []) {
  const ctx = context(setup);
  const result = await buildBuildings(buildings, parts, ctx, { clipAway });
  return { ctx, ...result };
}

function mesh(solids: PrismSolid[]) {
  const out = new MeshBuilder();
  const stats = newMeshStats();
  for (const solid of solids) meshSolid(solid, out, undefined, stats);
  const { positions, indices } = out.finish();
  let top = -Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    top = Math.max(top, positions[i + 2]);
    maxX = Math.max(maxX, positions[i]);
  }
  return { stats, report: edgeReport(indices, positions.length / 3), volume: signedVolume(positions, indices), top, maxX };
}

function expectClosed(solids: PrismSolid[]) {
  const m = mesh(solids);
  expect(m.stats.failed).toBe(0);
  expect(m.report.open).toBe(0);
  expect(m.report.repeated).toBe(0);
  expect(m.volume).toBeGreaterThan(0);
  return m;
}

const at = (height: HeightFn | number, x: number, y: number) => (typeof height === 'number' ? height : height(x, y));
const expectTops = (solids: PrismSolid[], expected: number[]) => {
  expect(solids).toHaveLength(expected.length);
  solids.forEach((solid, i) => expect(solid.top).toBeCloseTo(expected[i], 9));
};
const area = (solids: PrismSolid[]) => solids.reduce((sum, s) => sum + polygonArea(s.polygon), 0);
const tops = (solids: PrismSolid[]) => solids.flatMap((s) => s.polygon[0].map(([x, y]) => at(s.top, x, y)));

describe('buildBuildings', () => {
  it('stands a flat box on the ground at its scaled height', async () => {
    const { solids, footprint, ctx } = await build([feature('a', -10, -10, 10, 10, { height: 20 })]);
    expect(solids).toHaveLength(1);
    const [solid] = solids;
    expect(solid.role).toBe('building');
    expect(solid.top).toBeCloseTo(20 * V, 9);
    expect(at(solid.bottom, 0, 0)).toBeCloseTo(-0.15, 9);
    const m = expectClosed(solids);
    expect(m.volume).toBeCloseTo(1.4 * 1.4 * (20 * V + 0.15), 3);
    expect(multiArea(footprint)).toBeCloseTo(1.96, 6);
    expect(ctx.stats.buildings).toBe(1);
    expect(ctx.stats.building_height_scale).toBe(1.1);
  });

  it('uses floors, then class defaults, then the default height', async () => {
    const { solids } = await build(
      [
        feature('floors', -300, 0, -280, 20, { num_floors: 8 }),
        feature('stadium', -200, 0, -100, 100, { class: 'stadium' }),
        feature('plain', 100, 0, 120, 20, {}),
      ],
      [],
      { patch: (s) => (s.buildings.minHeightMm = 0) },
    );
    expectTops(solids, [24 * V, 30 * V, 10 * V]);
  });

  it('founds every part on the lowest ground under the whole building', async () => {
    const slope = { terrain: (x: number) => 0.05 * x };
    const parent = feature('parent', -20, -10, 20, 10, { has_parts: true, height: 30 });
    const parts = [
      feature('west', -20, -10, 0, 10, { building_id: 'parent', height: 30 }),
      feature('east', 0, -10, 20, 10, { building_id: 'parent', height: 30 }),
    ];
    const { solids, ctx } = await build([parent], parts, slope);
    expect(solids).toHaveLength(2);
    const base = 0.05 * -20 * 0.07;
    for (const solid of solids) {
      expect(solid.top).toBeCloseTo(base + 30 * V, 9);
      // The underside follows the slope just below the surface.
      expect(at(solid.bottom, 1, 0.5)).toBeCloseTo(0.05 - 0.15, 9);
      expect(solid.drape).toBeGreaterThan(0);
    }
    expect(ctx.stats.suppressed_parents).toBe(1);
    expect(ctx.stats.building_parts).toBe(2);
    expect(ctx.stats.parts_founded_on_parent_base).toBe(2);
    expectClosed(solids);
  });

  it('shares the base between a kept parent and its upper part', async () => {
    const slope = { terrain: (x: number, y: number) => 0.03 * x + 0.02 * y };
    const parent = feature('parent', -30, -30, 30, 30, { has_parts: true, height: 100 });
    const crown = feature('crown', -10, -10, 10, 10, { building_id: 'parent', height: 110 });
    const { solids } = await build([parent], [crown], slope);
    expect(solids).toHaveLength(2);
    expect((solids[1].top as number) - (solids[0].top as number)).toBeCloseTo(10 * V, 9);
    expect(solids[0].top).toBeCloseTo((0.03 + 0.02) * -30 * 0.07 + 100 * V, 9);
  });

  it('keeps an elevated part\'s underside flat and leaves it out of the ground footprint', async () => {
    const { solids, footprint } = await build([], [feature('bridge', -10, -5, 10, 5, { building_id: 'elsewhere', min_height: 10, height: 20 })]);
    expect(solids).toHaveLength(1);
    expect(solids[0].bottom).toBeCloseTo(10 * V, 9);
    expect(solids[0].top).toBeCloseTo(20 * V, 9);
    expect(solids[0].drape).toBe(0);
    expect(footprint).toEqual([]);
    expectClosed(solids);
  });

  it('stretches a low building to the minimum above its highest ground', async () => {
    const slope = { terrain: (x: number) => 0.05 * x };
    const { solids, ctx } = await build(
      [
        feature('warehouse', -10, -10, 10, 10, { height: 3 }),
        // Too small to stretch: a shed stays at its real height.
        feature('shed', 200, 0, 205, 5, { height: 3 }),
        // Area enough, but a ribbon: a wall fragment would become a fin.
        feature('wall', -300, 0, -240, 2, { height: 3 }),
      ],
      [],
      slope,
    );
    const [warehouse, shed, wall] = solids;
    expect(warehouse.top).toBeCloseTo(0.05 * 0.7 + 0.8, 9);
    expect(shed.top).toBeCloseTo(0.05 * 200 * 0.07 + 3 * V, 9);
    expect(wall.top).toBeCloseTo(0.05 * -300 * 0.07 + 3 * V, 9);
    expect(ctx.stats.buildings_raised_to_minimum).toBe(1);
    expect(ctx.stats.minimum_building_height_mm).toBe(0.8);
    // Off switches the floor entirely.
    const off = await build([feature('warehouse', -10, -10, 10, 10, { height: 3 })], [], { ...slope, patch: (s) => (s.buildings.minHeightMm = 0) });
    expect(off.solids[0].top).toBeCloseTo(-0.05 * 0.7 + 3 * V, 9);
  });

  it('keeps a shaped roof\'s pitch when it is stretched', async () => {
    const house = feature('house', -10, -6, 10, 6, { num_floors: 1, roof_shape: 'gabled', roof_height: 3 });
    const { solids, ctx } = await build([house]);
    expect(solids).toHaveLength(2);
    const heights = tops(solids);
    expect(Math.max(...heights)).toBeCloseTo(0.8, 9);
    expect(Math.max(...heights) - Math.min(...heights)).toBeCloseTo(3 * V, 9);
    expect(ctx.stats.roofs_built_gabled).toBe(1);
    expect(ctx.stats.roofs_shaped).toBe(1);
    expect(ctx.stats.buildings_raised_to_minimum).toBe(1);
    expectClosed(solids);
  });

  it('builds every roof kind as closed planar pieces on a slope', async () => {
    const shapes = ['skillion', 'gabled', 'hipped', 'pyramidal', 'dome', 'onion', 'mansard'];
    const buildings = shapes.map((shape, i) => feature(shape, -350 + i * 100, -20, -310 + i * 100, 25, { height: 40, roof_shape: shape, roof_height: 10 }));
    const slope = await build(buildings, [], { terrain: (x: number, y: number) => 0.04 * x - 0.03 * y + 0.2 * Math.sin(x / 3) });
    for (const kind of ['skillion', 'gabled', 'pyramid']) expect(slope.ctx.stats[`roofs_built_${kind}`]).toBe(1);
    expect(slope.ctx.stats.roofs_built_hipped).toBe(2);
    expect(slope.ctx.stats.roofs_built_dome).toBe(2);
    expect(slope.ctx.stats.roofs_shaped).toBe(7);
    expect(slope.ctx.stats.roofs_fallback_flat).toBe(0);
    expect(area(slope.solids)).toBeCloseTo(7 * 40 * 45 * 0.07 * 0.07, 6);
    expect(slope.solids.some((s) => s.drape > 0)).toBe(true);
    expectClosed(slope.solids);
    // On flat ground every roof runs from its wall top to its explicit height.
    const flat = await build(buildings);
    const heights = tops(flat.solids);
    expect(Math.max(...heights)).toBeCloseTo(40 * V, 9);
    expect(Math.min(...heights)).toBeCloseTo(30 * V, 9);
  });

  it('leaves low, holed and unknown roofs flat', async () => {
    const holed: SourceFeature = feature('holed', 100, 0, 160, 60, { height: 20, roof_shape: 'hipped', roof_height: 6 });
    (holed.geometry.coordinates as number[][][]).push(
      ([[120, 20], [120, 40], [140, 40], [140, 20], [120, 20]] as Vec2[]).map(([x, y]) => local.localToGeo(x, y)),
    );
    const { solids, ctx } = await build([
      feature('low', -100, 0, -80, 20, { height: 20, roof_shape: 'gabled', roof_height: 1 }),
      holed,
      feature('odd', 0, 0, 20, 20, { height: 20, roof_shape: 'hyperbolic-paraboloid' }),
      // An L whose centroid lies in its own notch cannot carry a pyramid.
      { id: 'ell', props: { height: 20, roof_shape: 'pyramidal' }, geometry: {
        type: 'Polygon',
        coordinates: [([[-300, 0], [-240, 0], [-240, 20], [-280, 20], [-280, 60], [-300, 60], [-300, 0]] as Vec2[]).map(([x, y]) => local.localToGeo(x, y))],
      } },
    ]);
    expect(solids).toHaveLength(4);
    expect(solids.every((s) => typeof s.top === 'number')).toBe(true);
    expect(ctx.stats.roofs_below_minimum).toBe(1);
    expect(ctx.stats.roofs_unsupported_shape).toBe(1);
    expect(ctx.stats.roofs_fallback_flat).toBe(2);
    expect(solids[1].polygon).toHaveLength(2);
    expectClosed(solids);
  });

  it('splits a concave gable into clean pieces', async () => {
    // Both arms of the U lie across the ridge line, so the half-plane clip
    // joins them with a zero-width bridge along it.
    const u: Vec2[] = [[0, 0], [30, 0], [30, 20], [20, 20], [20, 8], [10, 8], [10, 20], [0, 20], [0, 0]];
    const house: SourceFeature = {
      id: 'u',
      props: { height: 12, roof_shape: 'gabled', roof_height: 4 },
      geometry: { type: 'Polygon', coordinates: [u.map(([x, y]) => local.localToGeo(x, y))] },
    };
    const { solids, ctx } = await build([house], [], { terrain: (x) => 0.02 * x });
    expect(ctx.stats.roofs_built_gabled).toBe(1);
    expect(area(solids)).toBeCloseTo((30 * 20 - 10 * 12) * 0.07 * 0.07, 6);
    expectClosed(solids);
  });

  it('crowns a tower with its corroborated dome', async () => {
    // Great American Tower: the crown part is 140 to 162.7 m with a 40 m dome
    // that the parent's 202.7 m total corroborates.
    const parent = feature('tower', -15, -15, 15, 15, { has_parts: true, height: 202.7 });
    const shaft = feature('shaft', -15, -15, 15, 15, { building_id: 'tower', height: 140 });
    const crown = feature('crown', -10, -10, 10, 10, { building_id: 'tower', min_height: 140, height: 162.7, roof_shape: 'dome', roof_height: 40 });
    const { solids, ctx } = await build([parent], [shaft, crown]);
    expect(ctx.stats.buildings).toBe(0);
    expect(ctx.stats.building_parts).toBe(2);
    expect(solids[0].top).toBeCloseTo(140 * V, 9);
    const dome = solids.slice(1);
    for (const piece of dome) expect(piece.bottom).toBeCloseTo(140 * V, 9);
    const heights = tops(dome);
    expect(Math.max(...heights)).toBeCloseTo(202.7 * V, 9);
    expect(Math.min(...heights)).toBeCloseTo(162.7 * V, 9);
    expect(ctx.stats.roofs_built_dome).toBe(1);
    expectClosed(solids);
  });

  it('can switch roof shapes off', async () => {
    const { solids } = await build([feature('house', -10, -6, 10, 6, { height: 20, roof_shape: 'gabled', roof_height: 6 })], [], {
      patch: (s) => (s.buildings.roofShapes = false),
    });
    expect(solids).toHaveLength(1);
    expect(solids[0].top).toBeCloseTo(20 * V, 9);
  });

  it('builds a published-twice building once', async () => {
    // The Scripps Center: a named 143 m box standing exactly over the parts
    // of an unnamed outline.
    const outline = feature('outline', 0, 0, 100, 100, { has_parts: true });
    const named = feature('named', 0, 0, 100, 100, { height: 143, names: { primary: 'Scripps' } });
    const parts = [
      feature('p1', 0, 0, 50, 50, { building_id: 'outline', height: 100 }),
      feature('p2', 50, 0, 100, 50, { building_id: 'outline', height: 120 }),
      feature('p3', 0, 50, 100, 100, { building_id: 'outline', height: 143 }),
    ];
    const { solids, ctx } = await build([outline, named], parts);
    expectTops(solids, [100 * V, 120 * V, 143 * V]);
    expect(ctx.stats.duplicate_outlines_suppressed).toBe(1);
    expect(ctx.stats.suppressed_parents).toBe(1);
    expect(ctx.stats.buildings).toBe(0);
    expect(ctx.stats.building_parts).toBe(3);
  });

  it('restores a suppressed parent when none of its parts can be built', async () => {
    const parent = feature('parent', -20, -20, 20, 20, { has_parts: true, height: 30 });
    const fins = [
      feature('west', -20, -20, -19, 20, { building_id: 'parent', height: 20 }),
      feature('east', 19, -20, 20, 20, { building_id: 'parent', height: 20 }),
    ];
    const patch = (s: ModelSettings) => {
      s.buildings.minWidthMm = 0.08;
      s.buildings.restoreMainBodies = false;
    };
    const { solids, ctx } = await build([parent], fins, { patch });
    expect(solids).toHaveLength(1);
    expect(solids[0].top).toBeCloseTo(30 * V, 9);
    expect(ctx.stats.rejected_too_narrow).toBe(2);
    expect(ctx.stats.building_parents_restored).toBe(1);
    expect(ctx.stats.suppressed_parents).toBe(0);
    // One part that prints keeps the assembly.
    const kept = await build([parent], [...fins, feature('core', -5, -5, 5, 5, { building_id: 'parent', height: 20 })], { patch });
    expect(kept.solids).toHaveLength(1);
    expect(kept.ctx.stats.building_parts).toBe(1);
    expect(kept.ctx.stats.building_parents_restored).toBe(0);
  });

  it('drops needles and fragments when the filters are on', async () => {
    const patch = (s: ModelSettings) => {
      s.buildings.minWidthMm = 0.08;
      s.buildings.maxSlenderness = 30;
    };
    const { solids, ctx } = await build(
      [
        feature('chimney', 0, 0, 1, 1, { height: 20 }),
        feature('spire', 100, 0, 106, 6, { height: 100 }),
        // Wider than a nozzle line: prints whatever its height.
        feature('tower', 200, 0, 220, 20, { height: 300 }),
      ],
      [],
      { patch },
    );
    expect(solids).toHaveLength(1);
    expect(solids[0].top).toBeCloseTo(300 * V, 9);
    expect(ctx.stats.rejected_too_narrow).toBe(1);
    expect(ctx.stats.rejected_too_slender).toBe(1);
  });

  it('keeps thin parts that adjoin into a printable mass', async () => {
    const parent = feature('parent', 0, 0, 20, 20, { has_parts: true });
    const strips = Array.from({ length: 20 }, (_, i) => feature(`s${i}`, i, 0, i + 1, 20, { building_id: 'parent', height: 10 }));
    const { solids, ctx } = await build([parent], strips, { patch: (s) => (s.buildings.minWidthMm = 0.08) });
    expect(solids).toHaveLength(20);
    expect(ctx.stats.building_parts_kept_by_adjacency).toBe(20);
    expect(ctx.stats.rejected_too_narrow).toBe(0);
  });

  it('skips invalid intervals and underground buildings', async () => {
    const { solids, ctx } = await build([
      feature('broken', 0, 0, 20, 20, { height: 5, min_height: 9 }),
      feature('garage', 100, 0, 120, 20, { height: 5, is_underground: true }),
    ]);
    expect(solids).toEqual([]);
    expect(ctx.stats.buildings_invalid_vertical_interval).toBe(1);
    expect(ctx.stats.buildings).toBe(0);
  });

  it('sections a building on the edge of the area instead of reroofing what is left', async () => {
    // 550 to 600 m east is 38.5 to 42 mm, and the area ends at 40 mm.
    const { solids, footprint, ctx } = await build([feature('edge', 550, -10, 600, 10, { height: 40, roof_shape: 'hipped', roof_height: 10 })]);
    const m = expectClosed(solids);
    expect(m.maxX).toBeLessThanOrEqual(40 + 1e-4);
    expect(area(solids)).toBeCloseTo(1.5 * 1.4, 6);
    expect(multiArea(footprint)).toBeCloseTo(1.5 * 1.4, 6);
    // The whole footprint's ridge runs through the cut, so the section shows its full height.
    const cut = solids.flatMap((s) => s.polygon[0].filter(([x]) => Math.abs(x - 40) < 1e-6).map(([x, y]) => at(s.top, x, y)));
    expect(Math.max(...cut)).toBeCloseTo(40 * V, 9);
    expect(ctx.stats.buildings).toBe(1);
  });

  it('clips to a round area', async () => {
    const circle: Ring = Array.from({ length: 96 }, (_, i): Vec2 => [40 * Math.cos((Math.PI * 2 * i) / 96), 40 * Math.sin((Math.PI * 2 * i) / 96)]);
    const { solids } = await build(
      [
        feature('inside', -10, -10, 10, 10, { height: 30, roof_shape: 'dome', roof_height: 10 }),
        feature('edge', 380, 380, 420, 420, { height: 30, roof_shape: 'pyramidal', roof_height: 10 }),
        feature('outside', 600, 600, 620, 620, { height: 30 }),
      ],
      [],
      { crop: circle, terrain: (x, y) => 0.02 * (x + y) },
    );
    expectClosed(solids);
    for (const solid of solids) for (const [x, y] of solid.polygon[0]) expect(Math.hypot(x, y)).toBeLessThan(40 + 1e-3);
  });

  it('clips footprints away from water with no ground kept', async () => {
    const water = rectangle(0, -50, 50, 50);
    const { solids, footprint } = await build([feature('a', -10, -10, 10, 10, { height: 20 })], [], {}, water);
    expect(area(solids)).toBeCloseTo(0.7 * 1.4, 6);
    expect(multiArea(footprint)).toBeCloseTo(0.7 * 1.4, 6);
    expectClosed(solids);
  });

  it('ignores buildings outside the area without counting them', async () => {
    const { solids, ctx } = await build([feature('far', 1000, 0, 1020, 20, { height: 5, min_height: 9 })]);
    expect(solids).toEqual([]);
    expect(ctx.stats.buildings_invalid_vertical_interval).toBe(0);
    expect(ctx.stats.buildings_rejected_geometry).toBe(0);
  });

  it('returns the union of the ground-founded footprints', async () => {
    const { footprint } = await build([feature('a', -10, -10, 10, 10, { height: 20 }), feature('b', 0, 0, 20, 20, { height: 10 })]);
    expect(footprint).toHaveLength(1);
    expect(multiArea(footprint)).toBeCloseTo(0.07 * 0.07 * (400 + 400 - 100), 6);
  });

  it('never lets a draped underside reach through its own top', async () => {
    // A hill rising steeply under a low building: the underside is capped
    // below the top instead of turning the solid inside out.
    const steep = { terrain: (x: number) => 0.5 * x, patch: (s: ModelSettings) => (s.buildings.minHeightMm = 0) };
    const { solids } = await build([feature('a', -20, -10, 20, 10, { height: 2 })], [], steep);
    const [solid] = solids;
    for (const [x, y] of solid.polygon[0]) expect(at(solid.bottom, x, y)).toBeLessThanOrEqual((solid.top as number) - 0.05 + 1e-12);
    expectClosed(solids);
  });
});
