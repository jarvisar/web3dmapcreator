// LiDAR Only models through meshing and print sections, from a synthetic
// grid: every part stays one closed shell whatever the area shape.

import { describe, expect, it } from 'vitest';
import { areaModelRing } from '../geo/area';
import { Projection } from '../geo/projection';
import { pointInMulti, polygonArea } from '../geometry/polygon';
import { edgeReport, signedVolume } from '../geometry/validate';
import { meshLayers, partsBounds } from '../pipeline/mesh';
import { buildPlates } from '../pipeline/plates';
import type { PrismSolid } from '../geometry/solid';
import { cloneSettings, DEFAULT_PALETTE, type AreaSpec, type ModelSettings } from '../settings';
import { EditSession } from '../edit/session';
import { emptyEdits, type AddedShape } from '../edit/types';
import type { SourceFeature } from '../pipeline/source';
import type { MeshPart, Polygon } from '../types';
import { gridSpec } from './grid';
import { emptyLayers } from './layers';
import { followMap, surfaceModel } from './model';
import type { PreparedSurface } from './prepare';

const GROUND = 100;

/** 160 x 120 m at 1 m cells: a 40 m tower, a 12 m low block and a river along the south edge. */
function prepared(area: AreaSpec): PreparedSurface {
  const grid = gridSpec(area.widthM, area.heightM, 1);
  const layers = emptyLayers(grid.nx, grid.ny);
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const k = j * grid.nx + i;
      const tower = i >= 60 && i < 90 && j >= 50 && j < 80;
      const block = i >= 20 && i < 45 && j >= 30 && j < 60;
      if (j < 10) {
        layers.count[k] = layers.water[k] = 2;
        layers.top[k] = layers.solid[k] = layers.waterZ[k] = GROUND - 2;
        continue;
      }
      const z = GROUND + (tower ? 40 : block ? 12 : 0) + 0.02 * i;
      layers.top[k] = layers.solid[k] = z;
      layers.count[k] = 6;
      if (tower || block) layers.building[k] = 6;
      else layers.ground[k] = z;
    }
  }
  return { layers, checkpoints: [], grid, requestedCellM: 1, densityM2: 10, coverage: 1, points: 0, noise: 0, surveys: [], failures: [], downloadedBytes: 0, blocks: 1, reusedBlocks: 0 };
}

function lidarSettings(patch: (s: ModelSettings) => void = () => undefined): ModelSettings {
  const settings = cloneSettings();
  settings.modelSource = 'lidar';
  settings.scale.mmPerMetre = 0.5;
  patch(settings);
  return settings;
}

const area = (shape: AreaSpec['shape']): AreaSpec => ({ center: [-87.63, 41.88], widthM: 160, heightM: 120, rotationDeg: 0, shape, cornerRadius: 0.2 });

function closed(part: MeshPart) {
  const report = edgeReport(part.indices, part.positions.length / 3);
  expect([report.open, report.repeated]).toEqual([0, 0]);
  expect(signedVolume(part.positions, part.indices)).toBeGreaterThan(0);
}

describe('followMap', () => {
  const box = (x0: number, y0: number, x1: number, y1: number): Polygon => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];

  it("moves the shore onto the map's line but keeps a bridge and the survey's islands", () => {
    // A river either side of a bridge, mapped a metre off both banks and under the bridge, with a mapped piling.
    const survey = [box(0, 0, 45, 20), box(55, 0, 100, 20)];
    const map: Polygon[] = [[...box(0, -1, 100, 21), [[20, 10], [20, 11], [21, 11], [21, 10]]]];
    const water = followMap(survey, map, 3);
    const wet = (x: number, y: number) => pointInMulti(x, y, water);
    expect([wet(10, -0.5), wet(10, 20.5), wet(80, -0.5)]).toEqual([true, true, true]);
    expect(wet(50, 10)).toBe(false);
    expect(wet(20.5, 10.5)).toBe(true);
    // Past twice the width the survey decides: a map 7 off the bank leaves it alone.
    expect(pointInMulti(10, -1, followMap(survey, [box(0, -7, 100, 27)], 3))).toBe(false);
  });

  it('runs from the map back to the survey without a jog where they part', () => {
    // The map's bank drifts from 1 to 9 off the survey's along 80.
    const survey = [box(0, 0, 100, 20)];
    const map: Polygon[] = [[[[0, -1], [10, -1], [90, -9], [100, -9], [100, 21], [0, 21]]]];
    const water = followMap(survey, map, 3);
    // The bank's distance off the survey's, sampled along the river.
    const bank = (x: number) => {
      let y = 0;
      while (y < 10 && pointInMulti(x, -y - 0.05, water)) y += 0.05;
      return y;
    };
    expect(bank(12)).toBeCloseTo(1.2, 0);
    expect(bank(80)).toBeLessThan(0.1);
    let step = 0;
    for (let x = 12; x < 80; x += 0.5) step = Math.max(step, Math.abs(bank(x + 0.5) - bank(x)));
    // The map's own slope is 0.05 per 0.5, and switching at the width jumped 3.
    expect(step).toBeLessThan(1);
  });
});

describe('surfaceModel', () => {
  it('is one closed solid on its base, the size of the area', async () => {
    const spec = await surfaceModel({ area: area('rectangle'), settings: lidarSettings(), surface: prepared(area('rectangle')) });
    expect(spec.layers.map((l) => [l.id, l.role])).toEqual([['city', 'terrain']]);
    const { parts } = await meshLayers(spec.layers, { zShift: -spec.baseZ });
    expect(parts).toHaveLength(1);
    closed(parts[0]);
    const [x0, y0, z0, x1, y1, z1] = partsBounds(parts);
    expect([x1 - x0, y1 - y0]).toEqual([80, 60]);
    expect(z0).toBe(0);
    // Base, then the river 2 m and 0.6 mm below its bank, and the tower 40 m over the street.
    expect(z1).toBeGreaterThan(1.3 + 0.6 + 0.5 * 42 - 0.5);
  });

  it('builds the same model when it lets the survey layers go after compose', async () => {
    const settings = lidarSettings((s) => (s.lidarModel.waterMode = 'layer'));
    const kept = prepared(area('circle'));
    const released = prepared(area('circle'));
    const a = await meshLayers((await surfaceModel({ area: area('circle'), settings, surface: kept })).layers);
    const b = await meshLayers((await surfaceModel({ area: area('circle'), settings, surface: released, releaseLayers: true })).layers);
    expect(kept.layers.top.length).toBeGreaterThan(0);
    expect(released.layers.top.length).toBe(0);
    expect(b.parts.map((p) => p.name)).toEqual(a.parts.map((p) => p.name));
    for (let k = 0; k < a.parts.length; k++) {
      expect(Array.from(b.parts[k].positions)).toEqual(Array.from(a.parts[k].positions));
      expect(Array.from(b.parts[k].indices)).toEqual(Array.from(a.parts[k].indices));
    }
  });

  it('cuts round and six-sided areas and still closes them', async () => {
    for (const shape of ['circle', 'hexagon', 'rounded'] as const) {
      const spec = await surfaceModel({ area: area(shape), settings: lidarSettings(), surface: prepared(area(shape)) });
      const { parts, failed } = await meshLayers(spec.layers);
      expect(failed).toBe(0);
      closed(parts[0]);
      // The underside covers exactly the area's shape.
      let underside = 0;
      const p = parts[0].positions;
      const f = parts[0].indices;
      for (let t = 0; t < f.length; t += 3) {
        const [a, b, c] = [3 * f[t], 3 * f[t + 1], 3 * f[t + 2]];
        if (p[a + 2] !== 0 || p[b + 2] !== 0 || p[c + 2] !== 0) continue;
        underside -= ((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1])) / 2;
      }
      // Mesh positions are float32.
      expect(underside).toBeCloseTo(polygonArea([areaModelRing(area(shape), 0.5)]), 3);
    }
  });

  it('puts the rim over the ground, not the tower', async () => {
    const settings = lidarSettings((s) => {
      s.rim.enabled = true;
      s.rim.heightMm = 2;
    });
    const spec = await surfaceModel({ area: area('rectangle'), settings, surface: prepared(area('rectangle')) });
    expect(spec.layers.map((l) => l.id)).toEqual(['city', 'rim']);
    const { parts } = await meshLayers(spec.layers);
    const rim = parts.find((p) => p.id === 'rim')!;
    closed(rim);
    const city = partsBounds(parts.filter((p) => p.id === 'city'));
    const top = partsBounds([rim])[5];
    expect(top).toBeLessThan(city[5] - 10);
    expect(top).toBeGreaterThan(1.3 + 0.6 + 0.5 * 2);
  });

  it('splits into print sections that are each closed', async () => {
    const spec = await surfaceModel({ area: area('circle'), settings: lidarSettings(), surface: prepared(area('circle')) });
    const { plates, failed } = await buildPlates(spec, { multiPlate: true, sectionWidthMm: 35, sectionHeightMm: 35, bedWidth: 256, bedDepth: 256 });
    expect(failed).toBe(0);
    expect(plates.length).toBeGreaterThan(2);
    for (const plate of plates) for (const part of plate.parts) closed(part);
  });

  it('cuts the river away and still closes, in sections too', async () => {
    const settings = lidarSettings((s) => {
      s.lidarModel.waterMode = 'cut';
      s.water.cutMinAreaM2 = 1000;
    });
    const spec = await surfaceModel({ area: area('rectangle'), settings, surface: prepared(area('rectangle')) });
    expect(spec.stats.lidar_model_cut_water_bodies).toBe(1);
    const { parts } = await meshLayers(spec.layers);
    closed(parts[0]);
    // The river's ten rows of cells come off the south edge, and the base goes under the land.
    const [x0, y0, z0, x1, y1] = partsBounds(parts);
    expect(x1 - x0).toBe(80);
    expect(y1 - y0).toBeCloseTo(60 - 4.75, 4);
    expect(z0).toBe(0);
    const { plates, failed } = await buildPlates(spec, { multiPlate: true, sectionWidthMm: 35, sectionHeightMm: 35, bedWidth: 256, bedDepth: 256 });
    expect(failed).toBe(0);
    for (const plate of plates) for (const part of plate.parts) closed(part);
    // Under the minimum it's recessed as before.
    settings.water.cutMinAreaM2 = 5000;
    const recessed = await surfaceModel({ area: area('rectangle'), settings, surface: prepared(area('rectangle')) });
    expect(recessed.stats.lidar_model_cut_water_cells).toBe(0);
  });

  it('prints the water as a thin layer on a terrain floor, in sections too', async () => {
    const settings = lidarSettings((s) => (s.lidarModel.waterMode = 'layer'));
    const spec = await surfaceModel({ area: area('rectangle'), settings, surface: prepared(area('rectangle')) });
    expect(spec.layers.map((l) => [l.id, l.role])).toEqual([['city', 'terrain'], ['water', 'water']]);
    // The river is 1,280 m², under the size cut away, and still gets its layer.
    const water = spec.layers[1].solids as PrismSolid[];
    for (const solid of water) expect((solid.top as number) - (solid.bottom as number)).toBeCloseTo(1, 9);
    const floors = spec.layers[0].solids.filter((s): s is PrismSolid => s.kind === 'prism');
    expect(floors.length).toBe(water.length);
    // The base runs under the floor, and the city's footprint is still the whole area.
    for (const floor of floors) expect(floor.top).toBeCloseTo(1.3, 5);
    const { parts } = await meshLayers(spec.layers);
    for (const part of parts) closed(part);
    const [x0, y0, z0, x1, y1] = partsBounds(parts.filter((p) => p.id === 'city'));
    expect([x1 - x0, y1 - y0, z0]).toEqual([80, 60, 0]);
    const [, , low, , , high] = partsBounds(parts.filter((p) => p.id === 'water'));
    expect([low, high - low]).toEqual([expect.closeTo(1.3, 4), expect.closeTo(1, 4)]);
    const { plates, failed } = await buildPlates(spec, { multiPlate: true, sectionWidthMm: 35, sectionHeightMm: 35, bedWidth: 256, bedDepth: 256 });
    expect(failed).toBe(0);
    for (const plate of plates) for (const part of plate.parts) closed(part);
  });

  it('stands a shape over cut water on the bed, and over a water layer on its floor', async () => {
    for (const mode of ['cut', 'layer'] as const) {
      const settings = lidarSettings((s) => {
        s.lidarModel.waterMode = mode;
        s.water.cutMinAreaM2 = 1000;
      });
      const spec = await surfaceModel({ area: area('rectangle'), settings, surface: prepared(area('rectangle')) });
      const projection = new Projection(area('rectangle').center, 0, spec.mmPerMetre);
      const session = new EditSession(spec, settings, projection);
      // Half over the river along the south edge, half on its bank.
      const box: AddedShape = { id: 'b', kind: 'box', layer: 'buildings', at: projection.modelToGeo(0, -25), points: [], rotationDeg: 0, sizeMm: 6, depthMm: 6, heightMm: 2, liftMm: 0, followGround: false, text: '', font: 'montserrat' };
      const edited = await session.edited({ ...emptyEdits(), shapes: [box] }, DEFAULT_PALETTE);
      const solids = edited.layers.flatMap((l) => l.solids).filter((s): s is PrismSolid => s.key === 's:b' && s.kind === 'prism');
      const wet = solids.filter((s) => pointInMulti(0, -27.5, [s.polygon]));
      const dry = solids.filter((s) => pointInMulti(0, -23, [s.polygon]));
      expect([wet.length, dry.length]).toEqual([1, 1]);
      // Cut out, there's nothing under the water but the bed. A layer has its floor.
      expect(wet[0].bottom).toBeCloseTo(mode === 'cut' ? 0 : 1.3 - settings.land.embedMm, 6);
      expect(dry[0].bottom as number).toBeGreaterThan(1.3);
      const { parts } = await meshLayers(edited.layers);
      for (const part of parts) closed(part);
    }
  });

  it('fills water the survey missed from mapped water, and only there', async () => {
    // A pond in the north-east corner that returned nothing, mapped a bit larger.
    const pond = (surface: PreparedSurface) => {
      const { layers, grid } = surface;
      for (let j = 95; j < 115; j++) {
        for (let i = 120; i < 150; i++) {
          const k = j * grid.nx + i;
          layers.count[k] = 0;
          layers.top[k] = layers.solid[k] = layers.ground[k] = NaN;
        }
      }
      return surface;
    };
    const frame = new Projection([-87.63, 41.88], 0, 1);
    const ring = [[36, 30], [72, 30], [72, 58], [36, 58], [36, 30]].map(([x, y]) => frame.localToGeo(x, y));
    const mapWater: SourceFeature[] = [{ id: 'pond', geometry: { type: 'Polygon', coordinates: [ring] }, props: { subtype: 'lake', class: 'lake' } }];
    const settings = lidarSettings();
    const without = await surfaceModel({ area: area('rectangle'), settings, surface: pond(prepared(area('rectangle'))) });
    const spec = await surfaceModel({ area: area('rectangle'), settings, surface: pond(prepared(area('rectangle'))), mapWater });
    expect(spec.stats.lidar_model_water_bodies).toBe((without.stats.lidar_model_water_bodies as number) + 1);
    expect(spec.stats.lidar_model_water_map_cells).toBe(20 * 30);
    // A swimming pool isn't open water.
    const pool = await surfaceModel({ area: area('rectangle'), settings, surface: pond(prepared(area('rectangle'))), mapWater: [{ ...mapWater[0], props: { class: 'swimming_pool' } }] });
    expect(pool.stats.lidar_model_water_bodies).toBe(without.stats.lidar_model_water_bodies);
  });

  it('lifts what stands on the ground by the height scale only', async () => {
    const tall = async (heightScale: number) => {
      const settings = lidarSettings((s) => (s.lidarModel.heightScale = heightScale));
      const spec = await surfaceModel({ area: area('rectangle'), settings, surface: prepared(area('rectangle')) });
      return partsBounds((await meshLayers(spec.layers)).parts)[5];
    };
    expect((await tall(2)) - (await tall(1))).toBeCloseTo(0.5 * 40, 0);
  });
});
