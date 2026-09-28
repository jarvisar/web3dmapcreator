import { describe, expect, it } from 'vitest';
import { edgeReport, signedVolume } from '../geometry/validate';
import { cloneSettings, type AreaSpec } from '../settings';
import { generateModel } from './generate';
import { meshLayers, partsBounds } from './mesh';
import { buildPlates } from './plates';
import type { SourceData, SourceFeature } from './source';

// Synthetic town around lon 0.01, lat 45: a river through the middle, a pond,
// a park, streets (one crossing the river), a railway and a few buildings.
const LAT = 45;
const LON = 0.01;
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (x: number, y: number): [number, number] => [LON + x * M_LON, LAT + y * M_LAT];
const rect = (x0: number, y0: number, x1: number, y1: number) => [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]];

let nextId = 1;
function feature(geometry: SourceFeature['geometry'], props: Record<string, unknown>): SourceFeature {
  return { id: `f${nextId++}`, geometry, props };
}

function town(): SourceData {
  return {
    release: 'test',
    features: {
      water: [
        feature({ type: 'Polygon', coordinates: rect(-900, -60, 900, 40) }, { subtype: 'river', class: 'river' }),
        feature({ type: 'Polygon', coordinates: rect(300, 300, 340, 330) }, { subtype: 'water', class: 'pond' }),
      ],
      land_use: [feature({ type: 'Polygon', coordinates: rect(200, 200, 500, 450) }, { subtype: 'park', class: 'park' })],
      land: [feature({ type: 'Polygon', coordinates: rect(-500, 150, -200, 400) }, { subtype: 'forest', class: 'forest' })],
      segment: [
        feature({ type: 'LineString', coordinates: [at(-800, 120), at(800, 130)] }, { subtype: 'road', class: 'primary' }),
        feature({ type: 'LineString', coordinates: [at(0, -500), at(10, 500)] }, { subtype: 'road', class: 'residential' }),
        feature(
          { type: 'LineString', coordinates: [at(-100, -500), at(-90, 500)] },
          { subtype: 'road', class: 'footway', subclass: 'sidewalk' },
        ),
        feature({ type: 'LineString', coordinates: [at(-800, -300), at(800, -280)] }, { subtype: 'rail', class: 'standard_gauge' }),
        feature(
          { type: 'LineString', coordinates: [at(-300, -500), at(-300, 500)] },
          { subtype: 'road', class: 'secondary', road_flags: [{ values: ['is_tunnel'], between: [0.4, 0.6] }] },
        ),
      ],
      building: [
        feature({ type: 'Polygon', coordinates: rect(50, 150, 90, 190) }, { height: 30 }),
        feature({ type: 'Polygon', coordinates: rect(-150, -200, -100, -150) }, { num_floors: 4 }),
        feature({ type: 'Polygon', coordinates: rect(600, -200, 640, -170) }, {}),
      ],
    },
  };
}

const area: AreaSpec = { center: [LON, LAT], widthM: 1500, heightM: 1000, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const hills = { sample: (lon: number, lat: number) => 30 + 20 * Math.sin((lon - LON) / M_LON / 200) + 10 * Math.cos((lat - LAT) / M_LAT / 150) };

async function build(settingsPatch?: (s: ReturnType<typeof cloneSettings>) => void, areaPatch?: Partial<AreaSpec>) {
  const settings = cloneSettings();
  settings.terrain.resolution = 96;
  settings.trees.enabled = true;
  settingsPatch?.(settings);
  const spec = await generateModel({ area: { ...area, ...areaPatch }, settings, data: town(), elevation: hills });
  const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ });
  return { spec, meshed };
}

describe('generateModel', () => {
  it('builds closed parts for every layer', async () => {
    const { spec, meshed } = await build();
    const ids = meshed.parts.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['terrain', 'water', 'roads', 'rail', 'land-green', 'land-forest', 'buildings', 'trees']));
    expect(meshed.failed).toBe(0);
    for (const part of meshed.parts) {
      const report = edgeReport(part.indices, part.positions.length / 3);
      expect({ part: part.id, open: report.open, repeated: report.repeated }).toEqual({ part: part.id, open: 0, repeated: 0 });
      expect(signedVolume(part.positions, part.indices)).toBeGreaterThan(0);
    }
    // The model sits on z = 0 and fits the 105 x 70 mm outline.
    const b = partsBounds(meshed.parts);
    expect(b[2]).toBeCloseTo(0, 5);
    expect(b[3] - b[0]).toBeCloseTo(105, 0);
    expect(b[4] - b[1]).toBeCloseTo(70, 0);
    expect(spec.stats.water_cut_bodies).toBe(1);
    expect(spec.stats.water_basins).toBe(1);
    expect(spec.stats.skipped_sidepaths).toBeGreaterThan(0);
    expect(spec.stats.skipped_tunnels).toBeGreaterThan(0);
  });

  it('keeps ground under the road over the river only when asked', async () => {
    const on = await build();
    const off = await build((s) => (s.supports = false));
    const volume = (r: typeof on) => signedVolume(r.meshed.parts.find((p) => p.id === 'terrain')!.positions, r.meshed.parts.find((p) => p.id === 'terrain')!.indices);
    expect(volume(on)).toBeGreaterThan(volume(off));
  });

  it('crops to a rotated hexagon and a circle', async () => {
    for (const shape of ['hexagon', 'circle'] as const) {
      const { meshed } = await build(undefined, { shape, rotationDeg: 30, widthM: 1000, heightM: 1000 });
      for (const part of meshed.parts) expect(edgeReport(part.indices, part.positions.length / 3).open).toBe(0);
      const b = partsBounds(meshed.parts);
      expect(b[3] - b[0]).toBeLessThanOrEqual(70.01);
    }
  });

  it('builds decks and piers over the river when bridges are on', async () => {
    const { spec, meshed } = await build((s) => (s.bridges.enabled = true));
    const ids = meshed.parts.map((p) => p.id);
    expect(ids).toContain('bridges');
    expect(spec.stats.bridge_crossings_recovered).toBeGreaterThan(0);
    for (const part of meshed.parts) {
      const report = edgeReport(part.indices, part.positions.length / 3);
      expect({ part: part.id, open: report.open }).toEqual({ part: part.id, open: 0 });
    }
    // The deck clears the water: its lowest point over the river is above the water's top.
    const water = meshed.parts.find((p) => p.id === 'water')!;
    const deck = meshed.parts.find((p) => p.id === 'bridges')!;
    let waterTop = -Infinity;
    for (let i = 2; i < water.positions.length; i += 3) waterTop = Math.max(waterTop, water.positions[i]);
    let deckLow = Infinity;
    for (let i = 0; i < deck.positions.length; i += 3) {
      if (Math.abs(deck.positions[i + 1] - -0.7) < 1.5) deckLow = Math.min(deckLow, deck.positions[i + 2]);
    }
    expect(deckLow).toBeGreaterThan(waterTop);
  });

  it('splits into closed sections that add up to the whole', async () => {
    const { spec, meshed } = await build();
    const plates = await buildPlates(spec, { multiPlate: true, sectionWidthMm: 40, sectionHeightMm: 40, bedWidth: 180, bedDepth: 180 });
    expect(plates.length).toBe(3 * 2);
    const total = (parts: typeof meshed.parts) => parts.reduce((v, p) => v + signedVolume(p.positions, p.indices), 0);
    let sum = 0;
    for (const plate of plates) {
      for (const part of plate.parts) expect(edgeReport(part.indices, part.positions.length / 3).open).toBe(0);
      sum += total(plate.parts);
    }
    // Trees are kept whole in one section, so allow a little difference.
    expect(sum).toBeCloseTo(total(meshed.parts), -1);
  });

  it('builds a flat base without elevation', async () => {
    const { meshed } = await build((s) => (s.terrain.elevation = false));
    const terrain = meshed.parts.find((p) => p.id === 'terrain')!;
    expect(edgeReport(terrain.indices, terrain.positions.length / 3).open).toBe(0);
  });
});
