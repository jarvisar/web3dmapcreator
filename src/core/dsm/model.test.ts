// LiDAR Only models through meshing and print sections, from a synthetic
// grid: every part stays one closed shell whatever the area shape.

import { describe, expect, it } from 'vitest';
import { areaModelRing } from '../geo/area';
import { polygonArea } from '../geometry/polygon';
import { edgeReport, signedVolume } from '../geometry/validate';
import { meshLayers, partsBounds } from '../pipeline/mesh';
import { buildPlates } from '../pipeline/plates';
import { cloneSettings, type AreaSpec, type ModelSettings } from '../settings';
import type { MeshPart } from '../types';
import { gridSpec } from './grid';
import { emptyLayers } from './layers';
import { surfaceModel } from './model';
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
  return { layers, grid, requestedCellM: 1, densityM2: 10, coverage: 1, points: 0, surveys: [], failures: [], downloadedBytes: 0, blocks: 1, reusedBlocks: 0 };
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
    const plates = await buildPlates(spec, { multiPlate: true, sectionWidthMm: 35, sectionHeightMm: 35, bedWidth: 256, bedDepth: 256 });
    expect(plates.length).toBeGreaterThan(2);
    for (const plate of plates) for (const part of plate.parts) closed(part);
  });

  it('cuts the river away and still closes, in sections too', async () => {
    const settings = lidarSettings((s) => {
      s.lidarModel.cutWater = true;
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
    const plates = await buildPlates(spec, { multiPlate: true, sectionWidthMm: 35, sectionHeightMm: 35, bedWidth: 256, bedDepth: 256 });
    for (const plate of plates) for (const part of plate.parts) closed(part);
    // Under the minimum it's recessed as before.
    settings.water.cutMinAreaM2 = 5000;
    const recessed = await surfaceModel({ area: area('rectangle'), settings, surface: prepared(area('rectangle')) });
    expect(recessed.stats.lidar_model_cut_water_cells).toBe(0);
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
