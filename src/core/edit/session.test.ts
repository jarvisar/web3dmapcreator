import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filamentUse, preparePlates } from '../export/common';
import { Projection } from '../geo/projection';
import { multiArea, pointInMulti, polygonArea } from '../geometry/polygon';
import type { PrismSolid } from '../geometry/solid';
import { edgeReport } from '../geometry/validate';
import { generateModel } from '../pipeline/generate';
import { meshLayers } from '../pipeline/mesh';
import { buildPlates } from '../pipeline/plates';
import type { SourceData, SourceFeature } from '../pipeline/source';
import { cloneSettings, DEFAULT_PALETTE, type AreaSpec } from '../settings';
import { parseOutlineFont } from '../svgmap/text/loadFont';
import { roadLines } from './lines';
import { EditSession } from './session';
import { shapeFootprint } from './shapes';
import { emptyEdits, sanitizeEdits, type AddedShape, type ModelEdits } from './types';

const LAT = 45;
const LON = 0.01;
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (x: number, y: number): [number, number] => [LON + x * M_LON, LAT + y * M_LAT];
const rect = (x0: number, y0: number, x1: number, y1: number) => [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]];

function feature(id: string, geometry: SourceFeature['geometry'], props: Record<string, unknown>): SourceFeature {
  return { id, geometry, props };
}

function town(): SourceData {
  const data: SourceData = {
    release: 'test',
    features: {
      water: [
        feature('river', { type: 'Polygon', coordinates: rect(-900, -60, 900, 40) }, { subtype: 'river', class: 'river', names: { primary: 'Test River' } }),
        feature('pond', { type: 'Polygon', coordinates: rect(300, 300, 340, 330) }, { subtype: 'water', class: 'pond' }),
      ],
      land_use: [feature('park', { type: 'Polygon', coordinates: rect(200, 200, 500, 450) }, { subtype: 'park', class: 'park' })],
      land: [feature('forest', { type: 'Polygon', coordinates: rect(-500, 150, -200, 400) }, { subtype: 'forest', class: 'forest' })],
      segment: [
        feature('main', { type: 'LineString', coordinates: [at(-800, 120), at(800, 130)] }, { subtype: 'road', class: 'primary', names: { primary: 'Main Street' } }),
        feature('cross', { type: 'LineString', coordinates: [at(0, -500), at(10, 500)] }, { subtype: 'road', class: 'residential' }),
        feature('trail', { type: 'LineString', coordinates: [at(-600, 300), at(-400, 450)] }, { subtype: 'road', class: 'path' }),
        feature('rail', { type: 'LineString', coordinates: [at(-800, -300), at(800, -280)] }, { subtype: 'rail', class: 'standard_gauge' }),
      ],
      building: [
        feature('tower', { type: 'Polygon', coordinates: rect(50, 150, 90, 190) }, { height: 30, names: { primary: 'Tower' } }),
        feature('block', { type: 'Polygon', coordinates: rect(-150, -200, -100, -150) }, { num_floors: 4, has_parts: true }),
        feature('shed', { type: 'Polygon', coordinates: rect(600, -200, 640, -170) }, {}),
      ],
      building_part: [
        feature('podium', { type: 'Polygon', coordinates: rect(-150, -200, -120, -170) }, { building_id: 'block', height: 20 }),
      ],
    },
  };
  return data;
}

/** The town with an arcade: upper floors mapped as a part raised over the ground floor. */
function townWithArcade(): SourceData {
  const data = town();
  data.features.building!.push(feature('arcade', { type: 'Polygon', coordinates: rect(-400, -220, -340, -180) }, { height: 40, has_parts: true }));
  data.features.building_part!.push(
    feature('arcade-floor', { type: 'Polygon', coordinates: rect(-400, -220, -340, -180) }, { building_id: 'arcade', height: 15 }),
    feature('arcade-upper', { type: 'Polygon', coordinates: rect(-400, -220, -340, -180) }, { building_id: 'arcade', min_height: 15, height: 40 }),
  );
  return data;
}

const area: AreaSpec = { center: [LON, LAT], widthM: 1500, heightM: 1000, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const hills = { sample: (lon: number, lat: number) => 30 + 20 * Math.sin((lon - LON) / M_LON / 200) + 10 * Math.cos((lat - LAT) / M_LAT / 150) };
const montserrat = readFileSync('public/fonts/Montserrat-SemiBold.ttf');
const font = parseOutlineFont(montserrat.buffer.slice(montserrat.byteOffset, montserrat.byteOffset + montserrat.byteLength) as ArrayBuffer);

async function setUp(options: { data?: SourceData; groundRaisedParts?: boolean } = {}) {
  const settings = cloneSettings();
  settings.terrain.resolution = 96;
  settings.trees.enabled = true;
  if (options.groundRaisedParts !== undefined) settings.buildings.groundRaisedParts = options.groundRaisedParts;
  const spec = await generateModel({ area, settings, data: options.data ?? town(), elevation: hills });
  const projection = new Projection(area.center, area.rotationDeg, spec.mmPerMetre);
  const session = new EditSession(spec, settings, projection, { load: async () => font });
  return { settings, spec, projection, session };
}

function shape(patch: Partial<AddedShape>): AddedShape {
  return {
    id: 's1',
    kind: 'box',
    layer: 'buildings',
    at: at(0, 300),
    points: [],
    rotationDeg: 0,
    sizeMm: 10,
    depthMm: 4,
    heightMm: 2,
    liftMm: 0,
    followGround: false,
    text: '',
    font: 'montserrat',
    ...patch,
  };
}

function maxZ(positions: Float32Array): number {
  let z = -Infinity;
  for (let i = 2; i < positions.length; i += 3) z = Math.max(z, positions[i]);
  return z;
}

describe('sanitizeEdits', () => {
  it('keeps what is valid and drops or clamps the rest', () => {
    const edits = sanitizeEdits({
      layers: [
        { id: 'a', name: '  Route ', hex: '#ff0000', line: 'PLA Matte' },
        { id: 'a', name: 'Duplicate', hex: '#00ff00' },
        { id: 'b', name: 'Bad colour', hex: 'red' },
      ],
      objects: {
        'b:tower': { heightM: 9000, layer: 'a', removed: true },
        // A printed height from before building heights were kept in metres.
        'b:shed': { heightMm: 12 },
        'r:main': { widthMm: 0.01, heightMm: 3, layer: 'missing' },
        'w:river': { widthMm: 2 },
        nonsense: { removed: true },
      },
      shapes: [
        { id: 'x', kind: 'text', at: at(0, 0), text: 'Hello', sizeMm: 1e6 },
        { id: 'y', kind: 'path', points: [at(0, 0)] },
        { id: 'z', kind: 'star', at: at(0, 0) },
      ],
    });
    expect(edits.layers).toEqual([{ id: 'a', name: 'Route', hex: '#FF0000', line: 'PLA Matte' }]);
    expect(edits.objects['b:tower']).toEqual({ removed: true, layer: 'a', heightM: 5000 });
    expect(edits.objects['b:shed']).toBeUndefined();
    expect(edits.objects['r:main']).toEqual({ heightMm: 3, widthMm: 0.2 });
    expect(edits.objects['w:river']).toBeUndefined();
    expect(edits.objects.nonsense).toBeUndefined();
    expect(edits.shapes.map((s) => s.id)).toEqual(['x']);
    expect(edits.shapes[0].sizeMm).toBe(300);
    expect(edits.shapes[0].layer).toBe('buildings');
  });

  it('gives an empty set for anything else', () => {
    expect(sanitizeEdits(null)).toEqual(emptyEdits());
    expect(sanitizeEdits('edits')).toEqual(emptyEdits());
  });
});

describe('object keys', () => {
  it('keys buildings with their parts, water and trees', async () => {
    const { spec } = await setUp();
    const keyed = spec.layers.flatMap((l) => l.solids.map((s) => [l.id, s.key, s.sub]));
    expect(keyed).toContainEqual(['buildings', 'b:tower', 'tower']);
    expect(keyed).toContainEqual(['buildings', 'b:block', 'podium']);
    expect(keyed).toContainEqual(['water', 'w:river', undefined]);
    expect(keyed.some(([layer, key]) => layer === 'trees' && key?.startsWith('t:'))).toBe(true);
    expect(spec.edit!.objects.get('b:tower')).toMatchObject({ kind: 'building', name: 'Tower', heightM: 30 });
    expect(spec.edit!.objects.get('w:river')).toMatchObject({ kind: 'water', name: 'Test River' });
    expect(spec.edit!.roads.find((p) => p.sourceId === 'main')?.name).toBe('Main Street');
  });

  it('records which triangles each object made', async () => {
    const { spec } = await setUp();
    const { parts } = await meshLayers(spec.layers, { zShift: -spec.baseZ, objects: true });
    const buildings = parts.find((p) => p.id === 'buildings')!;
    const objects = buildings.objects!;
    const covered = new Uint8Array(buildings.indices.length / 3);
    for (let r = 0; r < objects.runs.length; r += 5) {
      const [, t0, t1, v0, v1] = objects.runs.subarray(r, r + 5);
      for (let t = t0; t < t1; t++) {
        covered[t]++;
        for (let k = 0; k < 3; k++) {
          const v = buildings.indices[t * 3 + k];
          expect(v >= v0 && v < v1).toBe(true);
        }
      }
    }
    expect(covered.every((c) => c === 1)).toBe(true);
    expect(new Set(objects.keys)).toEqual(new Set(['b:tower', 'b:block', 'b:shed']));
    expect(parts.find((p) => p.id === 'roads')!.objects).toBeUndefined();
  });
});

describe('EditSession', () => {
  it('describes objects with their printed height', async () => {
    const { session, spec } = await setUp();
    const facts = session.describe();
    expect(facts['b:tower'].heightMm).toBeCloseTo(30 * spec.mmPerMetre * 1.1, 1);
  });

  it('sends nothing for no edits, and nothing for removals or colours', async () => {
    const { session } = await setUp();
    expect(await session.update(emptyEdits(), 1)).toEqual({ model: 0, version: 1, objects: [], parts: [], hidden: [], notes: {}, warnings: [] });
    const edits: ModelEdits = { ...emptyEdits(), layers: [{ id: 'L', name: 'Home', hex: '#123456', line: 'PLA Basic' }], objects: { 'b:tower': { layer: 'L' }, 'b:shed': { removed: true } } };
    const update = await session.update(edits, 2);
    expect(update.objects).toEqual([]);
    expect(update.parts).toEqual([]);
  });

  it('makes a building as tall as asked, and puts it back', async () => {
    const { session, spec } = await setUp();
    const base = spec.edit!.objects.get('b:tower')!.base!;
    const heightM = 12 / session.buildingScale;
    const update = await session.update({ ...emptyEdits(), objects: { 'b:tower': { heightM } } }, 1);
    expect(update.objects).toHaveLength(1);
    const mesh = update.objects[0].mesh!;
    expect(maxZ(mesh.positions) + spec.baseZ).toBeCloseTo(base + 12, 3);
    expect(edgeReport(mesh.indices, mesh.positions.length / 3).open).toBe(0);
    // The same edit again sends nothing.
    expect((await session.update({ ...emptyEdits(), objects: { 'b:tower': { heightM } } }, 2)).objects).toEqual([]);
    const back = await session.update(emptyEdits(), 3);
    expect(back.objects).toEqual([{ key: 'b:tower', part: 'buildings', mesh: null }]);
  });

  it('gives a part its own height inside its building', async () => {
    const { session, spec } = await setUp();
    const update = await session.update({ ...emptyEdits(), objects: { 'b:block/podium': { heightM: 5 / session.buildingScale } } }, 1);
    const mesh = update.objects[0].mesh!;
    const base = spec.edit!.objects.get('b:block')!.base!;
    const runs = mesh.objects!;
    const podium = runs.subs.indexOf('podium');
    let peak = -Infinity;
    for (let r = 0; r < runs.runs.length; r += 5) {
      if (runs.runs[r] !== podium) continue;
      for (let v = runs.runs[r + 3]; v < runs.runs[r + 4]; v++) peak = Math.max(peak, mesh.positions[v * 3 + 2]);
    }
    expect(peak + spec.baseZ).toBeCloseTo(base + 5, 3);
  });

  it('rebuilds roads around an edited one and puts them back', async () => {
    const { session, spec } = await setUp();
    const lines = roadLines(spec.edit!, -spec.baseZ, 0.4);
    expect(lines.keys).toContain('r:main');
    const layer = { id: 'L', name: 'Race', hex: '#FF0000', line: 'PLA Basic' as const };
    const update = await session.update({ ...emptyEdits(), layers: [layer], objects: { 'r:main': { layer: 'L', widthMm: 2, heightMm: 1 } } }, 1);
    const ids = update.parts.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['roads', 'layer:L']));
    const race = update.parts.find((p) => p.id === 'layer:L')!.part!;
    expect(race.colour).toEqual({ hex: '#FF0000', line: 'PLA Basic', label: 'Race' });
    expect(edgeReport(race.indices, race.positions.length / 3).open).toBe(0);

    const edited = await session.edited({ ...emptyEdits(), layers: [layer], objects: { 'r:main': { layer: 'L', widthMm: 2, heightMm: 1 } } }, DEFAULT_PALETTE);
    const roads = edited.layers.find((l) => l.id === 'roads')!.solids as PrismSolid[];
    const racing = edited.layers.find((l) => l.id === 'layer:L')!.solids as PrismSolid[];
    // Main Street left the roads for its layer, at the new width.
    const mid = spec.edit!.roads.find((p) => p.sourceId === 'main')!.points;
    const probe: [number, number] = [(mid[0][0] + mid[1][0]) / 2 + 20, (mid[0][1] + mid[1][1]) / 2];
    expect(pointInMulti(probe[0], probe[1], roads.map((s) => s.polygon))).toBe(false);
    expect(pointInMulti(probe[0], probe[1], racing.map((s) => s.polygon))).toBe(true);
    const width = multiArea(racing.map((s) => s.polygon)) / 105;
    expect(width).toBeGreaterThan(1.8);
    expect(width).toBeLessThan(2.1);

    const back = await session.update(emptyEdits(), 2);
    expect(back.parts.map((p) => [p.id, p.part])).toEqual(expect.arrayContaining([['roads', null], ['layer:L', null]]));
  });

  it('removes a road from the model', async () => {
    const { session, spec } = await setUp();
    const edits = { ...emptyEdits(), objects: { 'r:trail': { removed: true } } };
    await session.update(edits, 1);
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    const before = spec.layers.find((l) => l.id === 'paths')!.solids.length;
    expect(before).toBeGreaterThan(0);
    expect(edited.layers.find((l) => l.id === 'paths')).toBeUndefined();
  });

  it('gives a removed path its land cover back', async () => {
    const { session, spec } = await setUp();
    const edits = { ...emptyEdits(), objects: { 'r:trail': { removed: true } } };
    const update = await session.update(edits, 1);
    const fill = update.objects.find((o) => o.key === 'lf:forest');
    expect(fill?.part).toBe('land-forest');
    expect(fill?.mesh?.indices.length).toBeGreaterThan(0);
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    const forest = edited.layers.find((l) => l.id === 'land-forest')!;
    const filled = forest.solids.filter((s) => s.key === 'lf:forest') as PrismSolid[];
    const before = spec.layers.find((l) => l.id === 'land-forest')!.solids.length;
    expect(forest.solids.length).toBe(before + filled.length);
    // The trail at its 0.45 mm along the 42 m (2.9 mm) of it inside the forest.
    const area = multiArea(filled.map((s) => s.polygon));
    expect(area).toBeGreaterThan(0.45 * 2.9 * 0.8);
    expect(area).toBeLessThan(0.45 * 2.9 * 1.3);
    const { plates } = await buildPlates(edited, { multiPlate: false, sectionWidthMm: 200, sectionHeightMm: 200, bedWidth: 256, bedDepth: 256 });
    const part = plates[0].parts.find((p) => p.id === 'land-forest')!;
    expect(edgeReport(part.indices, part.positions.length / 3).open).toBe(0);
    // Put back, the fill goes.
    const back = await session.update(emptyEdits(), 2);
    expect(back.objects).toContainEqual({ key: 'lf:forest', part: 'land-forest', mesh: null });
  });

  it('exports custom layers as their own parts, closed, in every section', async () => {
    const { session } = await setUp();
    const edits: ModelEdits = {
      ...emptyEdits(),
      layers: [{ id: 'L', name: 'Home', hex: '#FF00FF', line: 'PLA Matte' }],
      objects: { 'b:tower': { layer: 'L', heightM: 110 }, 'b:shed': { removed: true }, 'w:pond': { removed: true } },
      shapes: [shape({ id: 't', kind: 'text', text: 'HOME', layer: 'L', followGround: true }), shape({ id: 'b', layer: 'green' })],
    };
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    const ids = edited.layers.map((l) => l.id);
    expect(ids).toContain('layer:L');
    expect(ids).toContain('added-green');
    const buildings = edited.layers.find((l) => l.id === 'buildings')!;
    expect(buildings.solids.some((s) => s.key === 'b:shed' || s.key === 'b:tower')).toBe(false);
    expect(edited.layers.find((l) => l.id === 'water')!.solids.some((s) => s.key === 'w:pond')).toBe(false);
    for (const multiPlate of [false, true]) {
      const { plates, failed } = await buildPlates(edited, { multiPlate, sectionWidthMm: 60, sectionHeightMm: 60, bedWidth: 256, bedDepth: 256 });
      expect(failed).toBe(0);
      for (const plate of plates) {
        for (const part of plate.parts) {
          const report = edgeReport(part.indices, part.positions.length / 3);
          expect({ part: part.id, open: report.open, repeated: report.repeated }).toEqual({ part: part.id, open: 0, repeated: 0 });
        }
      }
      if (!multiPlate) {
        const home = plates[0].parts.find((p) => p.id === 'layer:L')!;
        expect(home.colour).toEqual({ hex: '#FF00FF', line: 'PLA Matte', label: 'Home' });
        const use = filamentUse(preparePlates(plates, DEFAULT_PALETTE));
        expect(use.labels.flat()).toContain('Home');
        expect(use.filaments.some((f) => f.hex === '#FF00FF' && f.line === 'PLA Matte')).toBe(true);
      }
    }
  });

  it('hides trees a shape stands on', async () => {
    const { session, spec } = await setUp();
    const tree = spec.layers.find((l) => l.id === 'trees')!.solids[0];
    if (tree.kind !== 'mesh') throw new Error('expected a tree');
    const projection = new Projection(area.center, area.rotationDeg, spec.mmPerMetre);
    const [lon, lat] = projection.modelToGeo(tree.anchor[0], tree.anchor[1]);
    const update = await session.update({ ...emptyEdits(), shapes: [shape({ at: [lon, lat], sizeMm: 6, depthMm: 6 })] }, 1);
    expect(update.hidden).toContain(tree.key);
  });
  it('keeps building heights in real metres, so they follow the scale', async () => {
    const { session, spec } = await setUp();
    const base = spec.edit!.objects.get('b:tower')!.base!;
    const update = await session.update({ ...emptyEdits(), objects: { 'b:tower': { heightM: 100 } } }, 1);
    const peak = maxZ(update.objects[0].mesh!.positions) + spec.baseZ;
    // Buildings are 1.1 times as tall as the scale makes them by default.
    expect(peak - base).toBeCloseTo(100 * spec.mmPerMetre * 1.1, 2);
    expect(session.buildingScale).toBeCloseTo(spec.mmPerMetre * 1.1, 9);
  });

  it('lists the parts of a building, tallest first', async () => {
    const { session } = await setUp({ data: townWithArcade() });
    const parts = session.describe()['b:arcade'].parts!;
    expect(parts.map((p) => p.sub)).toEqual(['arcade-upper', 'arcade-floor']);
    expect(parts[0].heightMm).toBeGreaterThan(parts[1].heightMm);
    expect(session.describe()['b:tower'].parts).toBeUndefined();
  });

  it('brings a raised part down to the ground when what held it up is removed', async () => {
    const { session } = await setUp({ data: townWithArcade(), groundRaisedParts: false });
    const upper = (edited: Awaited<ReturnType<EditSession['edited']>>) =>
      edited.layers.flatMap((l) => l.solids).filter((s) => s.key === 'b:arcade' && s.sub === 'arcade-upper') as PrismSolid[];
    // As generated, the upper floors stand on the ground floor.
    const before = upper(await session.edited(emptyEdits(), DEFAULT_PALETTE));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((s) => typeof s.bottom === 'number')).toBe(true);
    const edits = { ...emptyEdits(), objects: { 'b:arcade/arcade-floor': { removed: true } } };
    const update = await session.update(edits, 1);
    expect(update.objects.map((o) => o.key)).toEqual(['b:arcade']);
    const after = upper(await session.edited(edits, DEFAULT_PALETTE));
    expect(after.every((s) => typeof s.bottom === 'function')).toBe(true);
    // A lower floor still holds it up.
    const lowered = { ...emptyEdits(), objects: { 'b:arcade/arcade-floor': { heightM: 14.9 } } };
    expect(upper(await session.edited(lowered, DEFAULT_PALETTE)).every((s) => typeof s.bottom === 'number')).toBe(true);
    // Half as tall, it doesn't.
    const halved = { ...emptyEdits(), objects: { 'b:arcade/arcade-floor': { heightM: 7 } } };
    expect(upper(await session.edited(halved, DEFAULT_PALETTE)).every((s) => typeof s.bottom === 'function')).toBe(true);
  });

  it('sends nothing for a removed part that leaves nothing on air', async () => {
    const { session } = await setUp({ data: townWithArcade() });
    // By default raised parts reach the ground anyway.
    const update = await session.update({ ...emptyEdits(), objects: { 'b:arcade/arcade-floor': { removed: true } } }, 1);
    expect(update.objects).toEqual([]);
  });

  it('notes shapes too thin to print, or outside the model', async () => {
    const { session } = await setUp();
    const update = await session.update(
      {
        ...emptyEdits(),
        shapes: [
          shape({ id: 'tiny', kind: 'text', text: 'Main Street', sizeMm: 1 }),
          shape({ id: 'big', kind: 'text', text: 'Main Street', sizeMm: 6 }),
          shape({ id: 'blank', kind: 'text', text: ' ' }),
          shape({ id: 'away', at: at(5000, 5000) }),
          shape({ id: 'thin', kind: 'path', points: [at(-100, 300), at(100, 300)], sizeMm: 0.3 }),
        ],
      },
      1,
    );
    expect(Object.keys(update.notes).sort()).toEqual(['s:away', 's:blank', 's:thin', 's:tiny']);
    expect(update.notes['s:tiny']).toMatch(/thinner than/);
    expect(update.notes['s:away']).toMatch(/outside the model/);
  });
});

describe('shapeFootprint', () => {
  const projection = new Projection(area.center, 30, 0.07);
  const crop = [[[[-200, -200], [200, -200], [200, 200], [-200, 200]]]] as const;
  const footprint = (patch: Partial<AddedShape>) => shapeFootprint(shape({ at: area.center, ...patch }), projection, crop as never, font)!;

  it('sizes boxes and cylinders in printed mm', () => {
    expect(multiArea(footprint({ kind: 'box', sizeMm: 10, depthMm: 4 }))).toBeCloseTo(40, 2);
    expect(multiArea(footprint({ kind: 'cylinder', sizeMm: 10 }))).toBeCloseTo(Math.PI * 25, 0);
  });

  it('turns shapes from north, whatever the area is turned by', () => {
    // The area is turned 30 degrees, so north in the model points 30 degrees left of +y.
    const box = footprint({ kind: 'box', sizeMm: 20, depthMm: 2, rotationDeg: 30 })[0][0];
    const xs = box.map((p) => p[0]);
    const ys = box.map((p) => p[1]);
    // Turned by 30 from north and 30 back by the area: the long side runs along x.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2, 3);
  });

  it('puts the tip of a pin on its spot, with a hole in the head', () => {
    const pin = footprint({ kind: 'pin', sizeMm: 8, rotationDeg: 30 });
    expect(pin).toHaveLength(1);
    expect(pin[0]).toHaveLength(2);
    const lowest = pin[0][0].reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(Math.hypot(lowest[0], lowest[1])).toBeLessThan(0.05);
  });

  it('keeps the counters of letters as holes', () => {
    const letters = footprint({ kind: 'text', text: 'O', sizeMm: 10 });
    expect(letters).toHaveLength(1);
    expect(letters[0].length).toBe(2);
    expect(polygonArea(letters[0])).toBeGreaterThan(10);
  });

  it('needs a font for text', () => {
    expect(shapeFootprint(shape({ kind: 'text', text: 'A' }), projection, crop as never, null)).toBeNull();
  });

  it('cuts shapes to the model', () => {
    // Square to the model, 185 to 205 across an edge at 200.
    const outside = footprint({ kind: 'box', at: projection.modelToGeo(195, 0), sizeMm: 20, depthMm: 20, rotationDeg: 30 });
    expect(multiArea(outside)).toBeCloseTo(15 * 20, 1);
  });
});
