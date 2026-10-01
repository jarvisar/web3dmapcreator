// Measured buildings through the whole generation pipeline, from a synthetic
// survey: the envelope replaces the mapped box, and every shell stays closed,
// also when a print section cuts through the measured roof.

import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { edgeReport, signedVolume } from '../geometry/validate';
import { generateModel } from '../pipeline/generate';
import { meshLayers } from '../pipeline/mesh';
import { buildPlates } from '../pipeline/plates';
import type { SourceData, SourceFeature } from '../pipeline/source';
import { cloneSettings, type AreaSpec } from '../settings';
import { measureFeatures } from './features';
import { emptyPoints } from './points';
import { publish } from './publish';

const LON = 0.01;
const LAT = 45;
const frame = new Projection([LON, LAT], 0, 1);
const area: AreaSpec = { center: [LON, LAT], widthM: 1500, heightM: 1000, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };

// A 40 x 30 m podium, 30 m high, with a 12 x 12 m tower to 60 m, on ground at 100 m in the survey's datum.
const footprint: [number, number][] = [
  [-20, -15],
  [20, -15],
  [20, 15],
  [-20, 15],
];
const tower = (x: number, y: number) => x > -6 && x < 6 && y > -6 && y < 6;

function survey() {
  const rows: number[][] = [];
  for (let x = -60; x <= 60; x += 0.5) {
    for (let y = -55; y <= 55; y += 0.5) {
      const inside = x > -20 && x < 20 && y > -15 && y < 15;
      if (inside) rows.push([x + 0.1, y + 0.1, tower(x, y) ? 160 : 130, 6]);
      else rows.push([x + 0.1, y + 0.1, 100 + 0.01 * x, 2]);
    }
  }
  const points = emptyPoints(rows.length);
  rows.forEach(([x, y, z, cls], i) => {
    points.x[i] = x;
    points.y[i] = y;
    points.z[i] = z;
    points.cls[i] = cls;
    points.single[i] = 1;
  });
  return points;
}

const lonlat = (ring: [number, number][]) => [...ring, ring[0]].map(([x, y]) => frame.localToGeo(x, y));

function data(): SourceData {
  const building: SourceFeature = { id: 'b1', geometry: { type: 'Polygon', coordinates: [lonlat(footprint)] }, props: { height: 20 } };
  return { release: 'test', features: { building: [building], water: [] } };
}

async function measured() {
  const feature = { id: 'b1', props: { height: 20 }, geometry: [[footprint]] };
  const result = await measureFeatures([feature], survey(), {
    minWidthM: 0.1 / 0.07,
    minStepM: Math.max(0.25, 0.05 / 0.077),
    roofPlanes: true,
    roofMode: 'FACETED',
    surfaceScale: [0.07, 0.077],
    preferLidar: true,
    roi: [[[[-100, -100], [100, -100], [100, 100], [-100, 100]]]],
    partsByParent: new Map(),
    sourcePartsByParent: new Map(),
    neighboursById: new Map(),
  });
  const record = result.records.get('b1');
  expect(record, JSON.stringify(Object.fromEntries(result.rejected))).toBeDefined();
  return publish(record!, frame);
}

describe('LiDAR buildings in a model', () => {
  it('replaces the mapped box with a closed measured building', async () => {
    const record = await measured();
    expect(record.method).toBe('faceted_roof');
    expect(record.heightM).toBeCloseTo(30, 0);
    const settings = cloneSettings();
    settings.terrain.resolution = 64;
    settings.lidar.enabled = true;
    const hills = { sample: (lon: number, lat: number) => 30 + 20 * Math.sin((lon - LON) * 500) + 10 * Math.cos((lat - LAT) * 400) };
    const spec = await generateModel({ area, settings, data: data(), elevation: hills, lidar: { records: { b1: record }, rejected: {}, counts: {}, surveys: [], failures: [], candidates: 1, downloadedBytes: 0, reused: false, offers: [], found: [] } });
    expect(spec.stats.lidar_buildings).toBe(1);
    expect(spec.stats.lidar_envelopes).toBe(1);
    const layer = spec.layers.find((l) => l.id === 'buildings')!;
    expect(layer.solids.some((s) => s.kind === 'cap')).toBe(true);
    const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ });
    expect(meshed.failed).toBe(0);
    const part = meshed.parts.find((p) => p.id === 'buildings')!;
    const report = edgeReport(part.indices, part.positions.length / 3);
    expect(report.open).toBe(0);
    expect(report.repeated).toBe(0);
    expect(signedVolume(part.positions, part.indices)).toBeGreaterThan(0);
    // The tower stands 30 m (2.3 mm at 0.07 x 1.1) above the podium, not at the mapped 20 m.
    let low = Infinity;
    let high = -Infinity;
    for (let i = 2; i < part.positions.length; i += 3) {
      low = Math.min(low, part.positions[i]);
      high = Math.max(high, part.positions[i]);
    }
    expect(high - low).toBeGreaterThan(60 * 0.07 * 1.1 * 0.9);

    // Two sections split at x = 0 run through the middle of the building.
    const { plates, failed } = await buildPlates(spec, { multiPlate: true, sectionWidthMm: 52.5, sectionHeightMm: 70, bedWidth: 180, bedDepth: 180 });
    expect(failed).toBe(0);
    let volume = 0;
    for (const plate of plates) {
      const piece = plate.parts.find((p) => p.id === 'buildings');
      if (!piece) continue;
      const cut = edgeReport(piece.indices, piece.positions.length / 3);
      expect(cut.open).toBe(0);
      expect(cut.repeated).toBe(0);
      volume += signedVolume(piece.positions, piece.indices);
    }
    expect(volume).toBeCloseTo(signedVolume(part.positions, part.indices), 2);
  });

  it('leaves the mapped building when LiDAR is not given', async () => {
    const settings = cloneSettings();
    settings.terrain.elevation = false;
    const spec = await generateModel({ area, settings, data: data(), elevation: null });
    expect(spec.stats.lidar_buildings).toBeUndefined();
    expect(spec.layers.find((l) => l.id === 'buildings')!.solids.every((s) => s.kind === 'prism')).toBe(true);
  });
});
