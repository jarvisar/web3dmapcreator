import { describe, expect, it } from 'vitest';
import { MeshBuilder, meshPrism } from '../../geometry/mesher';
import { edgeReport, signedVolume } from '../../geometry/validate';
import type { Ring, Vec2 } from '../../types';
import { resolveVerticalProfile } from './heights';
import { signedArea } from './planar';
import {
  apexLevels,
  apexRegions,
  clipRingLinear,
  planarRoofRegions,
  resolveRoof,
  ridgeFrame,
  roofKind,
  shapedRoofRegions,
  skillionHeights,
  type RoofRegion,
} from './roofs';

const SQUARE: Ring = [[0, 0], [4, 0], [4, 4], [0, 4]];
const HOUSE: Ring = [[0, 0], [10, 0], [10, 4], [0, 4]];
const OCTAGON: Ring = Array.from({ length: 8 }, (_, i): Vec2 => [Math.cos((Math.PI * 2 * i) / 8) * 3, Math.sin((Math.PI * 2 * i) / 8) * 3]);
const L_SHAPE: Ring = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
// Concave but star-shaped about its centroid.
const CROSS: Ring = [[1, -3], [1, -1], [3, -1], [3, 1], [1, 1], [1, 3], [-1, 3], [-1, 1], [-3, 1], [-3, -1], [-1, -1], [-1, -3]];

const topAt = (region: RoofRegion, x: number, y: number) => (typeof region.top === 'number' ? region.top : region.top(x, y));
const vertices = (region: RoofRegion) => region.polygon[0].map(([x, y]) => [x, y, topAt(region, x, y)] as const);
const area = (regions: RoofRegion[]) => regions.reduce((sum, region) => sum + Math.abs(signedArea(region.polygon[0])), 0);

/** Largest deviation of a region's vertices from the plane through three of them. */
function planeError(region: RoofRegion): number {
  const points = vertices(region);
  let best: [number, number, number] | null = null;
  let largest = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      for (let k = j + 1; k < points.length; k++) {
        const [a, b, c] = [points[i], points[j], points[k]];
        const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
        if (cross > largest) {
          largest = cross;
          best = [i, j, k];
        }
      }
    }
  }
  const [a, b, c] = best!.map((i) => points[i]);
  // z = z0 + gx (x - x0) + gy (y - y0), solved from the three points.
  const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  const gx = ((b[2] - a[2]) * (c[1] - a[1]) - (c[2] - a[2]) * (b[1] - a[1])) / det;
  const gy = ((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / det;
  let error = 0;
  for (const p of points) error = Math.max(error, Math.abs(a[2] + gx * (p[0] - a[0]) + gy * (p[1] - a[1]) - p[2]));
  return error;
}

/** Mesh every region from a flat floor and report closure and volume. */
function meshRegions(regions: RoofRegion[], bottom = 0) {
  const out = new MeshBuilder();
  for (const region of regions) expect(meshPrism(region.polygon, { top: region.top, bottom, drape: 0 }, out)).not.toBe('failed');
  const { positions, indices } = out.finish();
  return { report: edgeReport(indices, positions.length / 3), volume: signedVolume(positions, indices) };
}

describe('roof semantics', () => {
  it('folds shapes onto constructions', () => {
    expect(roofKind('pyramidal')).toBe('pyramid');
    expect(roofKind('onion')).toBe('dome');
    expect(roofKind('Gabled ')).toBe('gabled');
    expect(roofKind(null)).toBe('flat');
    expect(roofKind('hyperbolic-paraboloid')).toBe('unsupported');
    expect(roofKind('toString')).toBe('unsupported');
  });

  it('sits a corroborated part roof on top of its height', () => {
    // The Great American Tower crown: 140 to 162.7 m walls, 40 m dome above.
    const props = { height: 162.7, min_height: 140, roof_shape: 'dome', roof_height: 40 };
    const roof = resolveRoof(props, resolveVerticalProfile(props, 3, 10), true, 202.7, 20);
    expect(roof.kind).toBe('dome');
    expect(roof.wallTopM).toBeCloseTo(162.7, 10);
    expect(roof.roofTopM).toBeCloseTo(202.7, 10);
    expect(roof.source).toBe('roof_height+parent_corroborated_walls');
  });

  it('keeps a part roof inside its own total', () => {
    const props = { height: 30, roof_shape: 'pyramidal', roof_height: 20 };
    const roof = resolveRoof(props, resolveVerticalProfile(props, 3, 10), true, 40, 10);
    expect(roof.roofTopM).toBeCloseTo(30, 10);
    expect(roof.source).toBe('roof_height');
  });

  it('does not count the Chicago roof height twice', () => {
    const props = { height: 177.4, roof_height: 73, roof_shape: 'skillion' };
    for (const parent of [177, 177.4, null]) {
      const roof = resolveRoof(props, resolveVerticalProfile(props, 3, 10), true, parent, 30);
      expect(roof.roofTopM).toBeCloseTo(177.4, 10);
      expect(roof.wallTopM).toBeCloseTo(104.4, 10);
    }
  });

  it('never raises an explicit part height with a default roof', () => {
    const props = { height: 184, roof_shape: 'hipped' };
    expect(resolveRoof(props, resolveVerticalProfile(props, 3, 10), true, 184, 20).roofTopM).toBe(184);
  });

  it('adds the roof once to floor-derived walls', () => {
    const props = { num_floors: 3, roof_shape: 'gabled', roof_height: 2 };
    for (const isPart of [false, true]) {
      const roof = resolveRoof(props, resolveVerticalProfile(props, 3, 10), isPart, null, 10);
      expect([roof.wallTopM, roof.roofTopM]).toEqual([9, 11]);
    }
  });

  it('gives an ambiguous crown no legacy addition', () => {
    const props = { height: 162.7, min_height: 140, roof_shape: 'dome', roof_height: 40 };
    expect(resolveRoof(props, resolveVerticalProfile(props, 3, 10), true, null, 20).roofTopM).toBeCloseTo(162.7, 10);
  });

  it('keeps a whole building\'s roof inside its height', () => {
    const props = { height: 8, roof_shape: 'gabled', roof_height: 3 };
    const roof = resolveRoof(props, resolveVerticalProfile(props, 3, 10), false, null, 8);
    expect(roof.wallTopM).toBeCloseTo(5, 10);
    expect(roof.roofTopM).toBeCloseTo(8, 10);
  });

  it('leaves some wall under an oversized roof', () => {
    const props = { height: 6, roof_shape: 'gabled', roof_height: 9 };
    const roof = resolveRoof(props, resolveVerticalProfile(props, 3, 10), false, null, 8);
    expect(roof.wallTopM).toBeGreaterThan(0);
    expect(roof.roofTopM).toBeCloseTo(6, 10);
  });

  it('records a missing roof height as a default', () => {
    const props = { height: 8, roof_shape: 'hipped' };
    const roof = resolveRoof(props, resolveVerticalProfile(props, 3, 10), false, null, 8);
    expect(roof.source).toBe('default');
    expect(roof.roofTopM - roof.wallTopM).toBeGreaterThan(0);
  });

  it('adds nothing for flat and unsupported shapes', () => {
    const profile = resolveVerticalProfile({ height: 8 }, 3, 10);
    const flat = resolveRoof({ roof_shape: 'flat', roof_height: 3 }, profile, false, null, 8);
    expect([flat.kind, flat.wallTopM, flat.roofTopM]).toEqual(['flat', 8, 8]);
    const odd = resolveRoof({ roof_shape: 'hyperbolic-paraboloid' }, profile, false, null, 8);
    expect(odd.kind).toBe('unsupported');
    expect(odd.source).toBe('unsupported:hyperbolic-paraboloid');
  });
});

describe('skillion', () => {
  it('puts the low edge towards the roof direction', () => {
    // Bearing 90 is east: the east edge is at the wall top, the west at the ridge.
    const heights = skillionHeights(SQUARE, 90, 10, 13)!;
    SQUARE.forEach(([x], i) => {
      if (x === 4) expect(heights[i]).toBeCloseTo(10, 10);
      if (x === 0) expect(heights[i]).toBeCloseTo(13, 10);
    });
  });

  it('runs the slope across the short axis without a direction', () => {
    const heights = skillionHeights(HOUSE, null, 10, 13, ridgeFrame(HOUSE))!;
    expect(Math.min(...heights)).toBeCloseTo(10, 10);
    expect(Math.max(...heights)).toBeCloseTo(13, 10);
  });
});

describe('planar roof regions', () => {
  it('clips exactly against a half-plane', () => {
    const kept = clipRingLinear(SQUARE, SQUARE.map(([x]) => x - 1));
    expect(Math.abs(signedArea(kept))).toBeCloseTo(12, 10);
    expect(kept.every(([x]) => x >= 1 - 1e-9)).toBe(true);
  });

  it('covers the house with a gable that peaks on the ridge', () => {
    const frame = ridgeFrame(HOUSE)!;
    expect(frame.halfLength).toBeCloseTo(5, 10);
    expect(frame.halfWidth).toBeCloseTo(2, 10);
    const regions = planarRoofRegions(HOUSE, 'gabled', frame, 5, 8)!;
    expect(regions).toHaveLength(2);
    expect(area(regions)).toBeCloseTo(40, 10);
    const tops = regions.flatMap((region) => vertices(region).map((v) => v[2]));
    expect(Math.min(...tops)).toBeCloseTo(5, 10);
    expect(Math.max(...tops)).toBeCloseTo(8, 10);
    // The ridge vertices lie on the long axis at y = 2.
    const ridge = regions.flatMap((region) => vertices(region).filter((v) => Math.abs(v[2] - 8) < 1e-9));
    expect(ridge.length).toBeGreaterThan(0);
    expect(ridge.every((v) => Math.abs(v[1] - 2) < 1e-9)).toBe(true);
  });

  it('tiles the house with four hip planes', () => {
    const frame = ridgeFrame(HOUSE)!;
    const regions = planarRoofRegions(HOUSE, 'hipped', frame, 5, 8)!;
    expect(regions).toHaveLength(4);
    expect(area(regions)).toBeCloseTo(40, 10);
    // Every eave corner sits at the wall top and the ridge runs 2 m in from each end.
    const all = regions.flatMap(vertices);
    const corners = all.filter((v) => HOUSE.some(([x, y]) => x === v[0] && y === v[1]));
    expect(corners.length).toBeGreaterThan(0);
    expect(corners.every((v) => Math.abs(v[2] - 5) < 1e-9)).toBe(true);
    const ridge = [...new Set(all.filter((v) => Math.abs(v[2] - 8) < 1e-9).map((v) => Math.round(v[0] * 1e6) / 1e6))].sort((a, b) => a - b);
    expect(ridge).toEqual([2, 8]);
  });

  it('makes a square hip a pyramid', () => {
    const regions = planarRoofRegions(SQUARE, 'hipped', ridgeFrame(SQUARE)!, 5, 8)!;
    expect(regions).toHaveLength(4);
    const peaks = new Set(regions.flatMap((region) => vertices(region).filter((v) => Math.abs(v[2] - 8) < 1e-9).map((v) => `${v[0].toFixed(6)},${v[1].toFixed(6)}`)));
    expect(peaks).toEqual(new Set(['2.000000,2.000000']));
  });

  it('still tiles an L shape', () => {
    const regions = planarRoofRegions(L_SHAPE, 'gabled', ridgeFrame(L_SHAPE)!, 5, 8)!;
    expect(regions).not.toBeNull();
    expect(area(regions)).toBeCloseTo(Math.abs(signedArea(L_SHAPE)), 10);
  });

  it('gives every region a planar top', () => {
    for (const ring of [HOUSE, SQUARE, L_SHAPE, OCTAGON]) {
      for (const kind of ['gabled', 'hipped'] as const) {
        const regions = planarRoofRegions(ring, kind, ridgeFrame(ring)!, 5, 8)!;
        expect(regions).not.toBeNull();
        for (const region of regions) expect(planeError(region)).toBeLessThan(1e-9);
      }
    }
  });

  it('closes into solids with the volume of the roof', () => {
    const gable = meshRegions(planarRoofRegions(HOUSE, 'gabled', ridgeFrame(HOUSE)!, 5, 8)!);
    expect(gable.report.open).toBe(0);
    expect(gable.report.repeated).toBe(0);
    expect(gable.volume).toBeCloseTo(40 * 5 + (10 * 4 * 3) / 2, 6);
    // A hip roof over L x W with height h holds W h (3L - W) / 6.
    const hip = meshRegions(planarRoofRegions(HOUSE, 'hipped', ridgeFrame(HOUSE)!, 5, 8)!);
    expect(hip.report.open).toBe(0);
    expect(hip.volume).toBeCloseTo(40 * 5 + (4 * 3 * (3 * 10 - 4)) / 6, 6);
  });
});

describe('pyramids and domes', () => {
  const octagonArea = Math.abs(signedArea(OCTAGON));

  it('builds a pyramid from one planar triangle per edge', () => {
    const { levels, apex } = apexLevels(OCTAGON, 'pyramid', 10, 14);
    expect(levels).toEqual([]);
    expect(apex[2]).toBe(14);
    const regions = apexRegions(OCTAGON, 'pyramid', 10, 14)!;
    expect(regions).toHaveLength(8);
    expect(area(regions)).toBeCloseTo(octagonArea, 10);
    for (const region of regions) expect(planeError(region)).toBeLessThan(1e-9);
    const heights = regions.flatMap((region) => vertices(region).map((v) => v[2]));
    expect(Math.max(...heights)).toBeCloseTo(14, 10);
    expect(Math.min(...heights)).toBeCloseTo(10, 10);
    const mesh = meshRegions(regions);
    expect(mesh.report.open).toBe(0);
    // Mesh positions are float32.
    expect(mesh.volume).toBeCloseTo(octagonArea * 10 + (octagonArea * 4) / 3, 3);
  });

  it('curves a dome inward through planar bands', () => {
    const { levels } = apexLevels(OCTAGON, 'dome', 10, 14);
    expect(levels).toHaveLength(3);
    const radii = levels.map((level) => Math.max(...level.ring.map(([x, y]) => Math.hypot(x, y))));
    expect(radii).toEqual([...radii].sort((a, b) => b - a));
    expect(radii[0]).toBeLessThan(3);
    const regions = apexRegions(OCTAGON, 'dome', 10, 14)!;
    expect(regions).toHaveLength(8 * 4);
    expect(area(regions)).toBeCloseTo(octagonArea, 10);
    for (const region of regions) expect(planeError(region)).toBeLessThan(1e-9);
    // Each dome ring is at its level's height.
    for (const level of levels) {
      for (const [x, y] of level.ring) {
        const region = regions.find((r) => r.polygon[0].some(([px, py]) => Math.hypot(px - x, py - y) < 1e-12))!;
        expect(topAt(region, x, y)).toBeCloseTo(level.z, 9);
      }
    }
    const mesh = meshRegions(regions);
    expect(mesh.report.open).toBe(0);
    expect(mesh.report.repeated).toBe(0);
    // Fuller than the cone, emptier than the box around it.
    expect(mesh.volume).toBeGreaterThan(octagonArea * 10 + (octagonArea * 4) / 3);
    expect(mesh.volume).toBeLessThan(octagonArea * 14);
  });

  it('builds a concave outline whose apex sees all of it', () => {
    const regions = apexRegions(CROSS, 'pyramid', 3, 5)!;
    expect(regions).toHaveLength(12);
    expect(area(regions)).toBeCloseTo(20, 10);
    expect(meshRegions(regions).report.open).toBe(0);
  });

  it('leaves a concave outline flat when its apex cannot see all of it', () => {
    // The L's centroid (2.2, 2.2) is in the notch, outside the L's kernel.
    expect(apexRegions(L_SHAPE, 'pyramid', 3, 5)).toBeNull();
    expect(apexRegions(L_SHAPE, 'dome', 3, 5)).toBeNull();
  });

  it('refuses a degenerate ring', () => {
    expect(apexRegions([[0, 0], [1, 0]], 'pyramid', 1, 2)).toBeNull();
    expect(apexRegions(SQUARE, 'pyramid', 2, 2)).toBeNull();
  });
});

describe('shaped roof regions', () => {
  const profile = (props: Record<string, unknown>) => resolveRoof(props, resolveVerticalProfile(props, 3, 10), false, null, 10);

  it('builds each kind, tiling the footprint', () => {
    for (const shape of ['skillion', 'gabled', 'hipped', 'pyramidal', 'dome']) {
      const roof = profile({ height: 8, roof_shape: shape, roof_height: 3 });
      const regions = shapedRoofRegions(HOUSE, roof, 5, 8)!;
      expect(regions).not.toBeNull();
      expect(area(regions)).toBeCloseTo(40, 9);
      const mesh = meshRegions(regions);
      expect(mesh.report.open).toBe(0);
      expect(mesh.volume).toBeGreaterThan(40 * 5);
      expect(mesh.volume).toBeLessThan(40 * 8);
    }
  });

  it('follows the roof direction and orientation', () => {
    const north = shapedRoofRegions(SQUARE, profile({ height: 8, roof_shape: 'skillion', roof_direction: 0 }), 5, 8)!;
    expect(topAt(north[0], 2, 4)).toBeCloseTo(5, 10);
    expect(topAt(north[0], 2, 0)).toBeCloseTo(8, 10);
    // Across: the ridge runs across the house, peaking along x = 5.
    const across = shapedRoofRegions(HOUSE, profile({ height: 8, roof_shape: 'gabled', roof_orientation: 'across' }), 5, 8)!;
    const ridge = across.flatMap((region) => vertices(region).filter((v) => Math.abs(v[2] - 8) < 1e-9));
    expect(ridge.length).toBeGreaterThan(0);
    expect(ridge.every((v) => Math.abs(v[0] - 5) < 1e-9)).toBe(true);
  });
});
