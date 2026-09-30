import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { pointInPolygon } from '../geometry/polygon';
import type { PrismSolid } from '../geometry/solid';
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

async function build(settingsPatch?: (s: ReturnType<typeof cloneSettings>) => void, areaPatch?: Partial<AreaSpec>, roads: SourceFeature[] = []) {
  const settings = cloneSettings();
  settings.terrain.resolution = 96;
  settings.trees.enabled = true;
  settingsPatch?.(settings);
  const data = town();
  data.features.segment!.push(...roads);
  const spec = await generateModel({ area: { ...area, ...areaPatch }, settings, data, elevation: hills });
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

  it('builds what stands in the water down through it with supports off, and keeps mapped piers as ground', async () => {
    for (const mode of ['layer', 'through'] as const) {
      const settings = cloneSettings();
      settings.terrain.resolution = 96;
      settings.supports = false;
      settings.water.mode = mode;
      const data = town();
      // Half a building on the river bank, and a pier out into the river.
      data.features.building!.push(feature({ type: 'Polygon', coordinates: rect(400, 20, 440, 60) }, { height: 12 }));
      data.features.land_use!.push(feature({ type: 'Polygon', coordinates: rect(600, -50, 620, 40) }, { subtype: 'pier', class: 'pier' }));
      const spec = await generateModel({ area, settings, data, elevation: hills });
      const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ });
      expect(meshed.failed).toBe(0);
      for (const part of meshed.parts) {
        const report = edgeReport(part.indices, part.positions.length / 3);
        expect({ mode, part: part.id, open: report.open, repeated: report.repeated }).toEqual({ mode, part: part.id, open: 0, repeated: 0 });
      }
      const river = spec.edit!.bodies.find((b) => b.kind === 'cut')!;
      const footing = mode === 'layer' ? river.floor! - settings.land.embedMm : spec.baseZ;
      const solids = (id: string) => (spec.layers.find((l) => l.id === id)?.solids ?? []) as PrismSolid[];
      const ground = solids('terrain').filter((s) => typeof s.top === 'function');
      const water = solids('water');
      const inside = (list: PrismSolid[], x: number, y: number) => list.filter((s) => pointInPolygon(x, y, s.polygon));
      const projection = new Projection(area.center, area.rotationDeg, spec.mmPerMetre);
      const model = (x: number, y: number) => projection.toModel(...at(x, y));
      // The street over the river and the building in it go down to the floor, or the base.
      for (const [x, y, layer] of [[5, -10, 'roads'], [420, 30, 'buildings']] as const) {
        const [mx, my] = model(x, y);
        const down = inside(solids(layer), mx, my);
        expect(down.length).toBeGreaterThan(0);
        for (const solid of down) expect(solid.bottom).toBeCloseTo(footing, 6);
        expect(inside(ground, mx, my)).toEqual([]);
        expect(inside(water, mx, my)).toEqual([]);
      }
      // The half on land stands on the ground as usual.
      const [lx, ly] = model(420, 50);
      expect(inside(solids('buildings'), lx, ly).every((s) => typeof s.bottom === 'function')).toBe(true);
      // The pier is ground whatever the supports.
      const [px, py] = model(610, -10);
      expect(inside(ground, px, py)).toHaveLength(1);
      expect(inside(water, px, py)).toEqual([]);
    }
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

  it('cuts decks and piers at the model edge', async () => {
    // A bridge along the river, running off the east edge at 750 m, high
    // enough over the water for piers.
    const bridge = feature({ type: 'LineString', coordinates: [at(450, -10), at(950, -10)] }, { subtype: 'road', class: 'primary', road_flags: [{ values: ['is_bridge'] }] });
    const { spec } = await build((s) => ((s.bridges.enabled = true), (s.bridges.clearanceMm = 1.5)), undefined, [bridge]);
    const piers = spec.layers.find((l) => l.id === 'piers')!.solids as PrismSolid[];
    expect(piers.length).toBeGreaterThan(3);
    const edge = 750 * spec.mmPerMetre;
    for (const pier of piers) for (const [x] of pier.polygon[0]) expect(x).toBeLessThanOrEqual(edge + 1e-6);
  });

  it('lifts a ramp that ends partway along another deck with it', async () => {
    const flags = { road_flags: [{ values: ['is_bridge'] }] };
    const main = feature({ type: 'LineString', coordinates: [at(200, -250), at(200, 250)] }, { subtype: 'road', class: 'primary', ...flags });
    const ramp = feature({ type: 'LineString', coordinates: [at(450, -10), at(200, -10)] }, { subtype: 'road', class: 'primary', ...flags });
    const { spec } = await build((s) => (s.bridges.enabled = true), undefined, [main, ramp]);
    expect(spec.stats.bridge_ends_joined_mid_deck).toBeGreaterThanOrEqual(1);
    // Both decks meet at the same height where the ramp joins.
    const x = 200 * spec.mmPerMetre;
    const y = -10 * spec.mmPerMetre;
    const decks = (spec.layers.find((l) => l.id === 'bridges')!.solids as PrismSolid[]).filter((s) => pointInPolygon(x, y, s.polygon));
    expect(decks.length).toBeGreaterThanOrEqual(2);
    const tops = decks.map((s) => (typeof s.top === 'number' ? s.top : s.top(x, y)));
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(0.05);
  });

  it('keeps the rim when the model is cut into sections', async () => {
    const { spec, meshed } = await build((s) => (s.rim.enabled = true));
    const { plates, failed } = await buildPlates(spec, { multiPlate: true, sectionWidthMm: 40, sectionHeightMm: 40, bedWidth: 180, bedDepth: 180 });
    expect(failed).toBe(0);
    const rimVolume = (parts: typeof meshed.parts) =>
      parts.filter((p) => p.id === 'rim').reduce((v, p) => v + signedVolume(p.positions, p.indices), 0);
    const whole = rimVolume(meshed.parts);
    expect(whole).toBeGreaterThan(0);
    expect(plates.reduce((v, plate) => v + rimVolume(plate.parts), 0)).toBeCloseTo(whole, 3);
  });

  it('splits into closed sections that add up to the whole', async () => {
    const { spec, meshed } = await build();
    const { plates, failed } = await buildPlates(spec, { multiPlate: true, sectionWidthMm: 40, sectionHeightMm: 40, bedWidth: 180, bedDepth: 180 });
    expect(failed).toBe(0);
    expect(plates.length).toBe(3 * 2);
    const total = (parts: typeof meshed.parts) =>
      parts.filter((p) => p.id !== 'trees').reduce((v, p) => v + signedVolume(p.positions, p.indices), 0);
    let sum = 0;
    let trees = 0;
    for (const plate of plates) {
      for (const part of plate.parts) {
        expect(edgeReport(part.indices, part.positions.length / 3).open).toBe(0);
        if (part.id !== 'trees') continue;
        // Trees can't be cut, so each one is wholly inside its section.
        trees += part.indices.length;
        const [west, south, east, north] = plate.bounds;
        for (let i = 0; i < part.positions.length; i += 3) {
          expect(part.positions[i]).toBeGreaterThanOrEqual(west - 1e-3);
          expect(part.positions[i]).toBeLessThanOrEqual(east + 1e-3);
          expect(part.positions[i + 1]).toBeGreaterThanOrEqual(south - 1e-3);
          expect(part.positions[i + 1]).toBeLessThanOrEqual(north + 1e-3);
        }
      }
      sum += total(plate.parts);
    }
    expect(sum).toBeCloseTo(total(meshed.parts), 0);
    expect(trees).toBeGreaterThan(0);
    expect(trees).toBeLessThanOrEqual(meshed.parts.find((p) => p.id === 'trees')!.indices.length);
  });

  it('prints water as a thin layer on a terrain floor', async () => {
    const { spec, meshed } = await build();
    const fills = spec.layers.find((l) => l.id === 'water')!.solids as PrismSolid[];
    for (const solid of fills) expect((solid.top as number) - (solid.bottom as number)).toBeCloseTo(1, 9);
    // Floors: flat terrain prisms whose top is the underside of the water.
    const floors = (spec.layers.find((l) => l.id === 'terrain')!.solids as PrismSolid[]).filter((s) => typeof s.top === 'number');
    expect(floors.length).toBeGreaterThanOrEqual(2);
    // The base runs under the water, so the plate is all terrain.
    const water = meshed.parts.find((p) => p.id === 'water')!;
    let low = Infinity;
    for (let i = 2; i < water.positions.length; i += 3) low = Math.min(low, water.positions[i]);
    expect(low).toBeGreaterThanOrEqual(1.3 - 1e-6);
  });

  it('cuts large water through the base when asked', async () => {
    const layer = await build();
    const through = await build((s) => (s.water.mode = 'through'));
    const water = through.meshed.parts.find((p) => p.id === 'water')!;
    for (const part of through.meshed.parts) {
      const report = edgeReport(part.indices, part.positions.length / 3);
      expect({ part: part.id, open: report.open, repeated: report.repeated }).toEqual({ part: part.id, open: 0, repeated: 0 });
    }
    let low = Infinity;
    for (let i = 2; i < water.positions.length; i += 3) low = Math.min(low, water.positions[i]);
    expect(low).toBeCloseTo(0, 5);
    // The river sits above the lowest ground, so its column is taller than the layer.
    const volume = (r: typeof layer, id: string) => {
      const part = r.meshed.parts.find((p) => p.id === id)!;
      return signedVolume(part.positions, part.indices);
    };
    expect(volume(through, 'water')).toBeGreaterThan(volume(layer, 'water'));
    // The pond is sunk the same way in both.
    expect(through.spec.stats.water_basins).toBe(1);
  });

  it('leaves recesses or openings with the water off', async () => {
    const layer = await build((s) => (s.water.enabled = false));
    const through = await build((s) => ((s.water.enabled = false), (s.water.mode = 'through')));
    for (const r of [layer, through]) {
      expect(r.meshed.parts.map((p) => p.id)).not.toContain('water');
      for (const part of r.meshed.parts) expect(edgeReport(part.indices, part.positions.length / 3).open).toBe(0);
    }
    const terrain = (r: typeof layer) => {
      const part = r.meshed.parts.find((p) => p.id === 'terrain')!;
      return signedVolume(part.positions, part.indices);
    };
    expect(terrain(layer)).toBeGreaterThan(terrain(through));
  });

  it('builds a flat base without elevation', async () => {
    const { meshed } = await build((s) => (s.terrain.elevation = false));
    const terrain = meshed.parts.find((p) => p.id === 'terrain')!;
    expect(edgeReport(terrain.indices, terrain.positions.length / 3).open).toBe(0);
  });
});
