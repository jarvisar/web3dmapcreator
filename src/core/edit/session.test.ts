import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { filamentUse, preparePlates } from '../export/common';
import { Projection } from '../geo/projection';
import { bufferLines, difference, intersection, multiArea, offsetPolygons, pointInMulti, pointInPolygon, polygonArea } from '../geometry/polygon';
import type { PrismSolid, Solid } from '../geometry/solid';
import { edgeReport } from '../geometry/validate';
import { generateModel, type ModelSpec } from '../pipeline/generate';
import { meshLayers } from '../pipeline/mesh';
import { buildPlates } from '../pipeline/plates';
import type { SourceData, SourceFeature } from '../pipeline/source';
import type { MultiPolygon } from '../types';
import { cloneSettings, DEFAULT_PALETTE, type AreaSpec } from '../settings';
import { parseOutlineFont } from '../svgmap/text/loadFont';
import { editOf } from './keys';
import { roadLines } from './lines';
import { RoadTiles } from './roads';
import { EditSession } from './session';
import { shapeFootprint } from './shapes';
import { emptyEdits, followsGround, MAX_SHAPES, mergeEdits, sanitizeEdits, type AddedShape, type ModelEdits } from './types';
import { solidPeak } from './heights';
import { parseHershey, type HersheyFile } from '../svgmap/text/hershey';

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

async function setUp(options: { data?: SourceData; groundRaisedParts?: boolean; bridges?: boolean; supports?: boolean; through?: boolean; water?: boolean } = {}) {
  const settings = cloneSettings();
  settings.terrain.resolution = 96;
  settings.trees.enabled = true;
  if (options.groundRaisedParts !== undefined) settings.buildings.groundRaisedParts = options.groundRaisedParts;
  if (options.bridges) {
    // Steep and high enough over the 100 m river for piers.
    settings.bridges.enabled = true;
    settings.bridges.maxGrade = 0.5;
    settings.bridges.clearanceMm = 1.5;
  }
  if (options.supports === false) settings.supports = false;
  if (options.through) settings.water.mode = 'through';
  if (options.water === false) settings.water.enabled = false;
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

function solidsIn(model: ModelSpec, layer: string): PrismSolid[] {
  return (model.layers.find((l) => l.id === layer)?.solids ?? []).filter((s): s is PrismSolid => s.kind === 'prism');
}

/** The terrain's ground, as opposed to the flat floors under water. */
function groundOf(model: ModelSpec): PrismSolid[] {
  return solidsIn(model, 'terrain').filter((s) => typeof s.top === 'function');
}

function covers(solids: Solid[], x: number, y: number): boolean {
  return solids.some((s) => s.kind === 'prism' && pointInPolygon(x, y, s.polygon));
}

/** How much of the solids lies in a square around a point, from above. */
function areaNear(solids: Solid[], x: number, y: number, r: number): number {
  const square: MultiPolygon = [[[[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]]]];
  return multiArea(intersection(solids.flatMap((s) => (s.kind === 'prism' ? [s.polygon] : [])), square));
}

function shapeSolids(model: ModelSpec, key: string): PrismSolid[] {
  return model.layers.flatMap((l) => l.solids).filter((s): s is PrismSolid => s.key === key && s.kind === 'prism');
}

async function expectClosed(model: ModelSpec) {
  for (const multiPlate of [false, true]) {
    const { plates, failed } = await buildPlates(model, { multiPlate, sectionWidthMm: 60, sectionHeightMm: 60, bedWidth: 256, bedDepth: 256 });
    expect(failed).toBe(0);
    for (const plate of plates) {
      for (const part of plate.parts) {
        const report = edgeReport(part.indices, part.positions.length / 3);
        expect({ part: part.id, open: report.open, repeated: report.repeated }).toEqual({ part: part.id, open: 0, repeated: 0 });
      }
    }
  }
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

  it('keeps hollows for water left out, widths for bridges, and bridges kept on their own', () => {
    const edits = sanitizeEdits({
      objects: {
        'w:lake': { removed: true, hollow: true },
        'w:pond': { hollow: true },
        'br:deck': { widthMm: 2, removed: false, heightMm: 3 },
        'b:tower': { removed: false, heightM: 20 },
      },
    });
    expect(edits.objects['w:lake']).toEqual({ removed: true, hollow: true });
    expect(edits.objects['w:pond']).toBeUndefined();
    expect(edits.objects['br:deck']).toEqual({ removed: false, widthMm: 2 });
    expect(edits.objects['b:tower']).toEqual({ heightM: 20 });
  });
});

describe('mergeEdits', () => {
  const layer = (id: string, hex = '#FF0000') => ({ id, name: id, hex, line: 'PLA Basic' as const });

  it("adds theirs to ours, and theirs win where both changed something", () => {
    const ours: ModelEdits = { ...emptyEdits(), layers: [layer('A')], objects: { 'b:1': { layer: 'A' }, 'b:2': { removed: true } }, shapes: [shape({ id: 'mine' })] };
    const theirs: ModelEdits = { ...emptyEdits(), layers: [layer('B', '#0000FF')], objects: { 'b:2': { heightM: 30 }, 'r:9': { layer: 'B' } }, shapes: [shape({ id: 'theirs' })] };
    const merged = mergeEdits(ours, theirs);
    expect(merged.edits.layers.map((l) => l.id)).toEqual(['A', 'B']);
    expect(merged.edits.objects).toEqual({ 'b:1': { layer: 'A' }, 'b:2': { heightM: 30 }, 'r:9': { layer: 'B' } });
    expect(merged.edits.shapes.map((s) => s.id)).toEqual(['mine', 'theirs']);
    expect([merged.added, merged.replaced, merged.left]).toEqual([3, 1, 0]);
    // Ours are left as they were.
    expect(ours.objects['b:2']).toEqual({ removed: true });
  });

  it('changes nothing for the same edits again', () => {
    const ours: ModelEdits = { ...emptyEdits(), layers: [layer('A')], objects: { 'b:1': { layer: 'A' } }, shapes: [shape({ id: 's' })] };
    const merged = mergeEdits(ours, structuredClone(ours));
    expect([merged.added, merged.replaced, merged.left]).toEqual([0, 0, 0]);
    expect(merged.edits).toEqual(ours);
  });

  it('keeps ours first, so the limits leave out theirs', () => {
    const ours: ModelEdits = { ...emptyEdits(), shapes: Array.from({ length: MAX_SHAPES }, (_, i) => shape({ id: `mine${i}` })) };
    const merged = mergeEdits(ours, { ...emptyEdits(), shapes: [shape({ id: 'theirs' }), shape({ id: 'more' })] });
    expect(merged.edits.shapes).toHaveLength(MAX_SHAPES);
    expect(merged.edits.shapes.every((s) => s.id.startsWith('mine'))).toBe(true);
    expect(merged.left).toBe(2);
  });

  it('follows the ground only while a shape is on it', () => {
    expect(followsGround({ followGround: true, liftMm: 0 })).toBe(true);
    expect(followsGround({ followGround: true, liftMm: 2 })).toBe(false);
    expect(followsGround({ followGround: false, liftMm: 0 })).toBe(false);
  });
});

describe('editOf', () => {
  it("gives a bridge its road's removal, colour and width, unless it has its own", () => {
    const edits: ModelEdits = { ...emptyEdits(), objects: { 'r:x': { removed: true, layer: 'L', widthMm: 2, heightMm: 3 }, 'br:y': { widthMm: 1 } } };
    expect(editOf(edits, 'br:x')).toEqual({ removed: true, layer: 'L', widthMm: 2 });
    expect(editOf({ ...edits, objects: { ...edits.objects, 'br:x': { removed: false, widthMm: 1 } } }, 'br:x')).toEqual({ removed: false, layer: 'L', widthMm: 1 });
    expect(editOf(edits, 'br:y')).toEqual({ widthMm: 1 });
    expect(editOf(edits, 'r:x')).toBe(edits.objects['r:x']);
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

  it('keeps the crack filled between a road given a colour or height of its own and the one beside it', async () => {
    const data = town();
    // 7 m apart, their ribbons leave a 0.035 mm crack, which comes filled.
    data.features.segment!.push(
      feature('north', { type: 'LineString', coordinates: [at(-100, 257), at(100, 257)] }, { subtype: 'road', class: 'residential' }),
      feature('south', { type: 'LineString', coordinates: [at(-100, 250), at(100, 250)] }, { subtype: 'road', class: 'residential' }),
    );
    const { session, spec, projection } = await setUp({ data });
    const footprint = (model: ModelSpec) =>
      model.layers.filter((l) => ['roads', 'rail', 'paths'].includes(l.id) || l.id.startsWith('layer:')).flatMap((l) => l.solids.flatMap((s) => (s.kind === 'prism' ? [s.polygon] : [])));
    const generated = footprint(spec);
    const [cx, cy] = projection.toModel(...at(-50, 253.5));
    expect(pointInMulti(cx, cy, generated)).toBe(true);
    let version = 0;
    for (const edit of [{ layer: 'L' }, { heightMm: 0.8 }]) {
      const edits = { ...emptyEdits(), layers: [{ id: 'L', name: 'L', hex: '#FF0000', line: 'PLA Basic' as const }], objects: { 'r:north': edit } };
      await session.update(edits, ++version);
      const edited = await session.edited(edits, DEFAULT_PALETTE);
      // Only hairlines where tiles were split and joined again.
      expect(offsetPolygons(difference(generated, footprint(edited)), -0.0005)).toEqual([]);
      // And no grass or water where the crack was.
      expect(edited.layers.some((l) => l.solids.some((s) => s.key?.startsWith('lf:')))).toBe(false);
    }
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
    // No bare ground left where it was, and the fill only where the slab isn't.
    const trail = spec.edit!.roads.filter((p) => p.sourceId === 'trail').map((p) => ({ points: p.points, width: p.widthMm }));
    const inForest = intersection(bufferLines(trail), spec.edit!.land!.regions.forest!);
    const slab = forest.solids.filter((s) => s.key !== 'lf:forest').map((s) => (s as PrismSolid).polygon);
    expect(multiArea(difference(inForest, forest.solids.map((s) => (s as PrismSolid).polygon)))).toBeLessThan(1e-4);
    expect(multiArea(intersection(filled.map((s) => s.polygon), slab))).toBeLessThan(1e-4);
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

  it('makes a building as tall as asked from the parts left, when its tallest is removed', async () => {
    const { session, spec } = await setUp({ data: townWithArcade() });
    const base = spec.edit!.objects.get('b:arcade')!.base!;
    const edits = { ...emptyEdits(), objects: { 'b:arcade': { heightM: 50 }, 'b:arcade/arcade-upper': { removed: true } } };
    const kept = shapeSolids(await session.edited(edits, DEFAULT_PALETTE), 'b:arcade');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.some((s) => s.sub === 'arcade-upper')).toBe(false);
    // Scaled by the upper floors' height it came out at 15 m times 50 / 40.
    expect(Math.max(...kept.map(solidPeak))).toBeCloseTo(base + 50 * session.buildingScale, 2);
  });

  it('sends everything again after an update that failed part way', async () => {
    const { session } = await setUp();
    const tall = (mm: number): ModelEdits => ({
      ...emptyEdits(),
      objects: { 'b:tower': { heightM: mm / session.buildingScale }, 'b:shed': { heightM: mm / session.buildingScale }, 'r:main': { widthMm: 2 } },
    });
    expect((await session.update(tall(10), 1)).parts.map((p) => p.id)).toContain('roads');
    const target = session as unknown as { mesh(layer: string, role: string, solids: Solid[]): Promise<unknown> };
    const mesh = target.mesh;
    let buildings = 0;
    const spy = vi.spyOn(target, 'mesh').mockImplementation(function (this: unknown, layer, role, solids) {
      if (solids.some((s) => s.key?.startsWith('b:')) && ++buildings === 2) return Promise.reject(new Error('out of memory'));
      return mesh.call(this, layer, role, solids);
    });
    await expect(session.update(tall(12), 2)).rejects.toThrow('out of memory');
    spy.mockRestore();
    // The first building went through, but the viewer never got it.
    const again = await session.update(tall(12), 3);
    expect(again.reset).toBe(true);
    expect(again.objects.map((o) => o.key).sort()).toEqual(['b:shed', 'b:tower']);
    expect(again.parts.map((p) => p.id)).toContain('roads');
    const next = await session.update(tall(12), 4);
    expect(next.reset).toBeUndefined();
    expect([next.objects, next.parts]).toEqual([[], []]);
  });

  it('exports the edits asked for while an update is still rebuilding roads', async () => {
    // Download clicked right after an undo, while the undone edit is still being applied.
    const { session } = await setUp();
    const kept: ModelEdits = { ...emptyEdits(), objects: { 'r:cross': { widthMm: 2 } } };
    const undone: ModelEdits = { ...emptyEdits(), objects: { 'r:cross': { widthMm: 2 }, 'r:main': { widthMm: 3 } } };
    await session.update(kept, 1);
    const roadArea = (model: ModelSpec) => multiArea(solidsIn(model, 'roads').map((s) => s.polygon));
    const expected = roadArea(await session.edited(kept, DEFAULT_PALETTE));
    const tile = RoadTiles.prototype.tile;
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached = () => {};
    const blocked = new Promise<void>((resolve) => (reached = resolve));
    const spy = vi.spyOn(RoadTiles.prototype, 'tile').mockImplementation(async function (this: RoadTiles, ...args) {
      if (++calls === 2) {
        reached();
        await gate;
      }
      return tile.apply(this, args);
    });
    try {
      const updating = session.update(undone, 2);
      await blocked;
      expect(roadArea(await session.edited(kept, DEFAULT_PALETTE))).toBeCloseTo(expected, 3);
      release();
      await updating;
      expect(roadArea(await session.edited(undone, DEFAULT_PALETTE))).toBeGreaterThan(expected + 1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Edits in and over water', () => {
  it('fills water left out with ground up to its banks, or keeps the hollow', async () => {
    const { session, spec, projection } = await setUp();
    const river = spec.edit!.bodies.find((b) => b.key === 'w:river')!;
    const [x, y] = projection.toModel(...at(-400, -10));
    expect(covers(groundOf(spec), x, y)).toBe(false);
    const filled = { ...emptyEdits(), objects: { 'w:river': { removed: true } } };
    const update = await session.update(filled, 1);
    expect(update.parts.map((p) => p.id)).toEqual(['terrain']);
    const edited = await session.edited(filled, DEFAULT_PALETTE);
    const ground = groundOf(edited).filter((s) => pointInPolygon(x, y, s.polygon));
    expect(ground).toHaveLength(1);
    expect((ground[0].top as (x: number, y: number) => number)(x, y)).toBeCloseTo(river.bed, 3);
    // No floor left under it either.
    expect(solidsIn(edited, 'terrain').filter((s) => typeof s.top === 'number' && pointInPolygon(x, y, s.polygon))).toEqual([]);
    await expectClosed(edited);

    // The hollow is the recess the water sat in, so the terrain is as generated.
    const hollow = { ...emptyEdits(), objects: { 'w:river': { removed: true, hollow: true } } };
    const kept = await session.update(hollow, 2);
    expect(kept.parts).toEqual([{ id: 'terrain', part: null }]);
    const recess = await session.edited(hollow, DEFAULT_PALETTE);
    const generated = spec.layers.find((l) => l.id === 'terrain')!.solids;
    expect(recess.layers.find((l) => l.id === 'terrain')!.solids.every((s, i) => s === generated[i])).toBe(true);
    expect(recess.layers.find((l) => l.id === 'water')!.solids.some((s) => s.key === 'w:river')).toBe(false);
    expect((await session.update(emptyEdits(), 3)).parts).toEqual([]);
  });

  it('leaves water edits alone with the water turned off, as the editor lists them', async () => {
    const { session, spec } = await setUp({ water: false });
    expect(session.describe()['w:river']).toBeUndefined();
    expect(spec.edit!.bodies.some((b) => b.key === 'w:river')).toBe(true);
    const edits = { ...emptyEdits(), objects: { 'w:river': { removed: true } } };
    expect((await session.update(edits, 1)).parts).toEqual([]);
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    const generated = spec.layers.find((l) => l.id === 'terrain')!.solids;
    expect(edited.layers.find((l) => l.id === 'terrain')!.solids.every((s, i) => s === generated[i])).toBe(true);
  });

  it('keeps a floor under a hollow in water that ran down to the base', async () => {
    const { session, spec, projection } = await setUp({ through: true });
    const river = spec.edit!.bodies.find((b) => b.key === 'w:river')!;
    expect(river.floor).toBeNull();
    const [x, y] = projection.toModel(...at(-400, -10));
    const edits = { ...emptyEdits(), objects: { 'w:river': { removed: true, hollow: true } } };
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    const floor = solidsIn(edited, 'terrain').filter((s) => pointInPolygon(x, y, s.polygon));
    expect(floor).toHaveLength(1);
    const top = floor[0].top as number;
    expect(top).toBeLessThan(river.top);
    expect(top - spec.baseZ).toBeGreaterThanOrEqual(0.6 - 1e-9);
    await expectClosed(edited);
  });

  it('gives a pond left out in a park its grass back', async () => {
    const { session, spec, projection } = await setUp();
    const [x, y] = projection.toModel(...at(320, 315));
    const edits = { ...emptyEdits(), objects: { 'w:pond': { removed: true } } };
    const update = await session.update(edits, 1);
    expect(update.objects.find((o) => o.key === 'lf:green')?.mesh?.indices.length).toBeGreaterThan(0);
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    expect(covers(solidsIn(edited, 'land-green').filter((s) => s.key === 'lf:green'), x, y)).toBe(true);
    expect(covers(groundOf(edited), x, y)).toBe(true);
    // All of it, corners too: the fill was opened on its own and left a notch at each.
    const pond = spec.edit!.bodies.filter((b) => b.key === 'w:pond').map((b) => b.polygon);
    expect(multiArea(difference(pond, solidsIn(edited, 'land-green').map((s) => s.polygon)))).toBeLessThan(1e-4);
    await expectClosed(edited);
  });

  it('leaves no hole through the model under a mooring or a hut in the water', async () => {
    const data = town();
    // 1 x 1.5 m (0.0074 mm²) mapped as a pier, and a 1.4 m square hut: both
    // under the 0.01 mm² of ground that used to be dropped, with nothing
    // else under them.
    data.features.infrastructure = [feature('mooring', { type: 'Polygon', coordinates: rect(-300, -20, -299, -18.5) }, { subtype: 'pier', class: 'pier' })];
    data.features.building!.push(feature('hut', { type: 'Polygon', coordinates: rect(-200, -20, -198.6, -18.6) }, { height: 4 }));
    for (const supports of [true, false]) {
      const { session, spec, projection } = await setUp({ data, supports });
      const through = (model: ModelSpec) => offsetPolygons(difference([model.crop], solidsIn(model, 'terrain').map((s) => s.polygon)), -0.0005);
      expect(through(spec)).toEqual([]);
      // The mooring is too small to print as ground, so the water covers it.
      const [mx, my] = projection.toModel(...at(-299.5, -19.25));
      expect(covers(solidsIn(spec, 'water'), mx, my)).toBe(true);
      const [hx, hy] = projection.toModel(...at(-199.3, -19.3));
      expect(covers(solidsIn(spec, 'buildings'), hx, hy)).toBe(true);
      // And the same once the edits rebuild the water.
      const edits = { ...emptyEdits(), objects: { 'r:cross': { removed: true } } };
      await session.update(edits, 1);
      expect(through(await session.edited(edits, DEFAULT_PALETTE))).toEqual([]);
    }
  });

  it('gives the water back whole where a road in it goes, with no ground left over', async () => {
    for (const supports of [true, false]) {
      const { session, spec } = await setUp({ supports });
      const river = spec.edit!.bodies.filter((b) => b.key === 'w:river').map((b) => b.polygon);
      const edits = { ...emptyEdits(), objects: { 'r:cross': { removed: true } } };
      await session.update(edits, 1);
      const edited = await session.edited(edits, DEFAULT_PALETTE);
      // Nothing else stands in the river. Opening the removed footprint on its
      // own left tabs at the banks and hairlines of the old outline.
      const water = solidsIn(edited, 'water').filter((s) => s.key === 'w:river').map((s) => s.polygon);
      expect(water.every((p) => p.length === 1)).toBe(true);
      expect(multiArea(difference(river, water))).toBeLessThan(1e-6);
      expect(multiArea(intersection(groundOf(edited).map((s) => s.polygon), river))).toBeLessThan(1e-6);
      await expectClosed(edited);
    }
  });

  it('keeps a thread of water too thin to print as ground, where a road between a building and the bank goes', async () => {
    for (const supports of [true, false]) {
      const data = town();
      // 4 m (0.28 mm) off the south bank, with a road over the gap running on past it.
      data.features.building!.push(feature('boathouse', { type: 'Polygon', coordinates: rect(300, -56, 450, 20) }, { height: 6 }));
      data.features.segment!.push(feature('quay', { type: 'LineString', coordinates: [at(200, -58), at(550, -58)] }, { subtype: 'road', class: 'service' }));
      const { session, projection } = await setUp({ data, supports });
      const edits = { ...emptyEdits(), objects: { 'r:quay': { removed: true } } };
      await session.update(edits, 1);
      const edited = await session.edited(edits, DEFAULT_PALETTE);
      const water = solidsIn(edited, 'water');
      const [gx, gy] = projection.toModel(...at(375, -58));
      expect(covers(groundOf(edited), gx, gy)).toBe(true);
      expect(covers(water, gx, gy)).toBe(false);
      // Past the boathouse, beside open water, it's water again.
      const [ox, oy] = projection.toModel(...at(250, -57));
      expect(covers(water, ox, oy)).toBe(true);
      expect(covers(groundOf(edited), ox, oy)).toBe(false);
      await expectClosed(edited);
    }
  });

  it('takes away ground kept in the water for a road that goes, and only that', async () => {
    const { session, spec, projection } = await setUp();
    const [x, y] = projection.toModel(...at(5, -10));
    expect(pointInMulti(x, y, spec.edit!.kept.roads)).toBe(true);
    expect(covers(groundOf(spec), x, y)).toBe(true);
    const edits = { ...emptyEdits(), objects: { 'r:cross': { removed: true } } };
    const update = await session.update(edits, 1);
    expect(update.parts.map((p) => p.id)).toEqual(expect.arrayContaining(['roads', 'terrain', 'water']));
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    expect(covers(groundOf(edited), x, y)).toBe(false);
    expect(covers(solidsIn(edited, 'water').filter((s) => s.key === 'w:river'), x, y)).toBe(true);
    // Land stays land: only ground that was kept in the water went.
    const land = (model: ModelSpec) => multiArea(difference(groundOf(model).map((s) => s.polygon), spec.edit!.noGround));
    expect(land(edited)).toBeCloseTo(land(spec), 1);
    await expectClosed(edited);
    const back = await session.update(emptyEdits(), 2);
    expect(back.parts.map((p) => [p.id, p.part])).toEqual(expect.arrayContaining([['terrain', null], ['water', null]]));
  });

  it('gives new road area over water ground under it', async () => {
    const { session, spec, projection } = await setUp();
    // 20 m east of the cross road's line, inside it once it's 4 mm (57 m) wide.
    const [x, y] = projection.toModel(...at(25, -10));
    expect(covers(groundOf(spec), x, y)).toBe(false);
    const edits = { ...emptyEdits(), objects: { 'r:cross': { widthMm: 4 } } };
    await session.update(edits, 1);
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    expect(covers(solidsIn(edited, 'roads'), x, y)).toBe(true);
    expect(covers(groundOf(edited), x, y)).toBe(true);
    expect(covers(solidsIn(edited, 'water'), x, y)).toBe(false);
    await expectClosed(edited);
  });

  it('builds roads down through the water with supports off, new road area too', async () => {
    const { session, spec, projection } = await setUp({ supports: false });
    const river = spec.edit!.bodies.find((b) => b.key === 'w:river')!;
    const [x, y] = projection.toModel(...at(5, -10));
    const down = (model: ModelSpec, px: number, py: number) =>
      solidsIn(model, 'roads').filter((s) => pointInPolygon(px, py, s.polygon) && typeof s.bottom === 'number' && Math.abs(s.bottom - (river.floor! - 0.04)) < 1e-6);
    // As generated: the road over the river reaches its floor, and there's no ground under it.
    expect(down(spec, x, y)).toHaveLength(1);
    expect(covers(groundOf(spec), x, y)).toBe(false);
    expect(covers(solidsIn(spec, 'water'), x, y)).toBe(false);
    expect(solidsIn(spec, 'terrain').some((s) => s.top === river.floor && pointInPolygon(x, y, s.polygon))).toBe(true);
    // Widened, the new road area goes down too, and the water makes room.
    const [wx, wy] = projection.toModel(...at(25, -10));
    const wide = { ...emptyEdits(), objects: { 'r:cross': { widthMm: 4 } } };
    const update = await session.update(wide, 1);
    expect(update.parts.map((p) => p.id)).toEqual(expect.arrayContaining(['roads', 'water']));
    expect(update.parts.map((p) => p.id)).not.toContain('terrain');
    const widened = await session.edited(wide, DEFAULT_PALETTE);
    expect(down(widened, wx, wy)).toHaveLength(1);
    expect(covers(solidsIn(widened, 'water'), wx, wy)).toBe(false);
    await expectClosed(widened);
    // Removed, the water comes back over the floor it stood on.
    const gone = { ...emptyEdits(), objects: { 'r:cross': { removed: true } } };
    const removed = await session.edited(gone, DEFAULT_PALETTE);
    expect(covers(solidsIn(removed, 'water'), x, y)).toBe(true);
    expect(covers(groundOf(removed), x, y)).toBe(false);
    await expectClosed(removed);
  });

  it('stands drawn roads over water on ground of their own, and text on the floor under the water', async () => {
    const { session, spec, projection } = await setUp();
    const river = spec.edit!.bodies.find((b) => b.key === 'w:river')!;
    const path = shape({ id: 'p', kind: 'path', layer: 'roads', points: [at(-300, -150), at(-300, 150)], sizeMm: 1, heightMm: 0.6, followGround: true });
    const label = shape({ id: 't', kind: 'text', text: 'RIVER', at: at(-600, -10), sizeMm: 3, heightMm: 1 });
    const edits = { ...emptyEdits(), shapes: [path, label] };
    const update = await session.update(edits, 1);
    expect(update.parts.map((p) => p.id)).toEqual(expect.arrayContaining(['terrain', 'water']));
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    const [px, py] = projection.toModel(...at(-300, -10));
    expect(covers(groundOf(edited), px, py)).toBe(true);
    expect(covers(solidsIn(edited, 'water'), px, py)).toBe(false);
    // The text stands a millimetre over the water, and goes down through it
    // to the floor, so it still stands with the water left out in the slicer.
    const text = edited.layers.flatMap((l) => l.solids).filter((s): s is PrismSolid => s.key === 's:t' && s.kind === 'prism');
    expect(text.length).toBeGreaterThan(0);
    for (const solid of text) {
      expect(solid.bottom).toBeCloseTo(river.floor! - 0.04, 6);
      expect(solid.top).toBeCloseTo(river.top + 1, 6);
    }
    const water = solidsIn(edited, 'water').map((s) => s.polygon);
    const letters = text.map((s) => s.polygon);
    expect(multiArea(intersection(letters, water))).toBeLessThan(1e-3);
    expect(solidsIn(edited, 'terrain').some((s) => s.top === river.floor && text.some((t) => pointInPolygon(...centre(t), s.polygon)))).toBe(true);
    await expectClosed(edited);
  });
});

describe('Shapes standing on things', () => {
  it('stands on the ground, not down to the base', async () => {
    const { session } = await setUp();
    const edited = await session.edited({ ...emptyEdits(), shapes: [shape({})] }, DEFAULT_PALETTE);
    const box = edited.layers.flatMap((l) => l.solids).filter((s): s is PrismSolid => s.key === 's:s1' && s.kind === 'prism');
    expect(box.length).toBeGreaterThan(0);
    expect(box.every((s) => typeof s.bottom === 'function')).toBe(true);
  });

  it('stands a raised shape on the roof under it, and builds what hangs over down to the ground', async () => {
    const { session, spec, projection } = await setUp();
    const facts = session.describe()['b:tower'];
    const roof = spec.edit!.objects.get('b:tower')!.base! + facts.heightMm!;
    const lift = facts.heightMm! + 3;
    const onRoof = shape({ id: 'r', at: at(70, 170), sizeMm: 1, depthMm: 1, liftMm: lift });
    // Half of it past the tower's east wall at 90 m.
    const over = shape({ id: 'o', at: at(90, 170), sizeMm: 1.4, depthMm: 1, liftMm: lift });
    const edits = { ...emptyEdits(), shapes: [onRoof, over] };
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    const solids = (key: string) => edited.layers.flatMap((l) => l.solids).filter((s): s is PrismSolid => s.key === key && s.kind === 'prism');
    for (const solid of solids('s:r')) expect(solid.bottom).toBeCloseTo(roof - 0.04, 3);
    const pieces = solids('s:o');
    const onTop = pieces.filter((s) => typeof s.bottom === 'number');
    const down = pieces.filter((s) => typeof s.bottom === 'function');
    expect(onTop.length).toBeGreaterThan(0);
    expect(down.length).toBeGreaterThan(0);
    for (const solid of onTop) expect(solid.bottom).toBeCloseTo(roof - 0.04, 3);
    const [x, y] = projection.toModel(...at(92, 170));
    expect(down.some((s) => pointInPolygon(x, y, s.polygon))).toBe(true);
    await expectClosed(edited);
    // Made lower, the tower still holds it up, at its new roof.
    const lower = { ...edits, objects: { 'b:tower': { heightM: 15 } } };
    const lowered = await session.edited(lower, DEFAULT_PALETTE);
    const newRoof = spec.edit!.objects.get('b:tower')!.base! + 15 * session.buildingScale;
    for (const solid of lowered.layers.flatMap((l) => l.solids).filter((s): s is PrismSolid => s.key === 's:r' && s.kind === 'prism')) {
      expect(solid.bottom).toBeCloseTo(newRoof - 0.04, 3);
    }
    // Updates follow the building too.
    await session.update(edits, 1);
    const update = await session.update(lower, 2);
    expect(update.objects.map((o) => o.key)).toEqual(expect.arrayContaining(['b:tower', 's:r', 's:o']));
  });

  it('moves a shape raised onto a roof with the roof, and brings it down when the building goes', async () => {
    const { session, spec, projection } = await setUp();
    const facts = session.describe()['b:tower'];
    const base = spec.edit!.objects.get('b:tower')!.base!;
    const roof = base + facts.heightMm!;
    const [x, y] = projection.toModel(...at(70, 170));
    // Placed the way the editor does it, the lift measured from the ground where it lands.
    const pin = shape({ id: 'p', kind: 'pin', at: at(70, 170), sizeMm: 0.8, heightMm: 1, liftMm: roof - spec.edit!.heightAt(x, y) });
    const on = shapeSolids(await session.edited({ ...emptyEdits(), shapes: [pin] }, DEFAULT_PALETTE), 's:p');
    expect(on.length).toBeGreaterThan(0);
    for (const s of on) expect(s.bottom as number).toBeCloseTo(roof - 0.04, 1);
    // Made taller, the tower takes it up rather than burying it.
    const taller = shapeSolids(await session.edited({ ...emptyEdits(), objects: { 'b:tower': { heightM: 45 } }, shapes: [pin] }, DEFAULT_PALETTE), 's:p');
    const newRoof = base + 45 * session.buildingScale;
    for (const s of taller) expect(s.bottom as number).toBeCloseTo(newRoof - 0.04, 1);
    // Removed, it comes down to the ground rather than standing on a column.
    const gone = shapeSolids(await session.edited({ ...emptyEdits(), objects: { 'b:tower': { removed: true } }, shapes: [pin] }, DEFAULT_PALETTE), 's:p');
    expect(gone.length).toBeGreaterThan(0);
    for (const s of gone) {
      expect(typeof s.bottom).toBe('function');
      expect(s.top as number).toBeLessThan(spec.edit!.heightAt(x, y) + 1.5);
    }
  });

  it('stands a shape raised onto a deck on it, and leaves the water under the bridge alone', async () => {
    for (const supports of [true, false]) {
      const { session, spec, projection } = await setUp({ bridges: true, supports });
      // Over the river between two piers, where the cross street's deck runs.
      const [x, y] = projection.toModel(...at(5, 1.5));
      const deck = solidsIn(spec, 'bridges').find((s) => s.key === 'br:cross' && pointInPolygon(x, y, s.polygon))!;
      expect(deck).toBeDefined();
      expect(covers(solidsIn(spec, 'water'), x, y)).toBe(true);
      const deckTop = (deck.top as (x: number, y: number) => number)(x, y);
      const deckBottom = (deck.bottom as (x: number, y: number) => number)(x, y);
      const lift = deckTop - spec.edit!.heightAt(x, y);
      // A box stands on ground of its own in the water with supports on, text on the floor.
      for (const placed of [shape({ id: 'd', at: at(5, 1.5), sizeMm: 1, depthMm: 1, heightMm: 1, liftMm: lift }), shape({ id: 'd', kind: 'text', text: 'HI', at: at(5, 1.5), sizeMm: 1, heightMm: 0.5, liftMm: lift })]) {
        const edits = { ...emptyEdits(), objects: { 'br:cross': { widthMm: 3 } }, shapes: [placed] };
        await session.update(edits, 1);
        const edited = await session.edited(edits, DEFAULT_PALETTE);
        expect(areaNear(solidsIn(edited, 'water'), x, y, 1.5)).toBeCloseTo(areaNear(solidsIn(spec, 'water'), x, y, 1.5), 3);
        expect(areaNear(groundOf(edited), x, y, 1.5)).toBeCloseTo(areaNear(groundOf(spec), x, y, 1.5), 3);
        const solids = shapeSolids(edited, 's:d');
        expect(solids.length).toBeGreaterThan(0);
        for (const s of solids) expect(s.bottom as number).toBeGreaterThan(deckBottom);
        await expectClosed(edited);
      }
    }
  });

  it("notes text whose font didn't load, and warns once, not on every edit", async () => {
    const { spec, settings, projection } = await setUp();
    const session = new EditSession(spec, settings, projection, {
      load: async () => {
        throw new Error('Offline.');
      },
    });
    const edits = { ...emptyEdits(), shapes: [shape({ id: 't', kind: 'text', text: 'Hi', sizeMm: 5 })] };
    const first = await session.update(edits, 1);
    expect(first.notes['s:t']).toMatch(/font couldn't be loaded/);
    expect(first.warnings).toEqual(['The font for “Hi” could not be loaded. Offline.']);
    const second = await session.update({ ...edits, objects: { 'b:shed': { removed: true } } }, 2);
    expect(second.notes['s:t']).toMatch(/font couldn't be loaded/);
    expect(second.warnings).toEqual([]);
    // An export says so every time, since the file is missing the text.
    expect((await session.edited(edits, DEFAULT_PALETTE)).warnings).toContain('The font for “Hi” could not be loaded. Offline.');
  });

  it('notes characters the font has no glyph for, and what prints instead', async () => {
    const { spec, settings, projection } = await setUp();
    const hershey = parseHershey(JSON.parse(readFileSync('public/fonts/hershey/futural.json', 'utf8')) as HersheyFile);
    const session = new EditSession(spec, settings, projection, { load: async (id) => (id === 'hershey-sans' ? { kind: 'stroke', font: hershey } : font) });
    const update = await session.update(
      {
        ...emptyEdits(),
        shapes: [
          shape({ id: 'a', kind: 'text', text: 'Café 日本', sizeMm: 6 }),
          shape({ id: 'b', kind: 'text', text: 'Café', font: 'hershey-sans', sizeMm: 6 }),
          shape({ id: 'c', kind: 'text', text: 'Café', sizeMm: 6 }),
        ],
      },
      1,
    );
    expect(update.notes['s:a']).toBe('This font has no “日” or “本”, so they print as boxes.');
    expect(update.notes['s:b']).toBe('This font has no “é”, so it prints as a question mark.');
    expect(update.notes['s:c']).toBeUndefined();
  });

  it('notes a shape hidden inside a building', async () => {
    const { session } = await setUp();
    const update = await session.update({ ...emptyEdits(), shapes: [shape({ id: 'in', at: at(70, 170), sizeMm: 1, depthMm: 1, heightMm: 0.5 })] }, 1);
    expect(update.notes['s:in']).toMatch(/inside a building/);
  });

  it('stands raised text on the roof, though text follows the ground by default', async () => {
    // Following the ground, its letters ran from the street up through every layer of the building.
    const { session, spec } = await setUp();
    const facts = session.describe()['b:tower'];
    const roof = spec.edit!.objects.get('b:tower')!.base! + facts.heightMm!;
    const label = shape({ id: 't', kind: 'text', text: 'HI', at: at(70, 170), sizeMm: 1, heightMm: 0.6, liftMm: facts.heightMm!, followGround: true });
    const edited = await session.edited({ ...emptyEdits(), shapes: [label] }, DEFAULT_PALETTE);
    const letters = edited.layers.flatMap((l) => l.solids).filter((s): s is PrismSolid => s.key === 's:t' && s.kind === 'prism');
    expect(letters.length).toBeGreaterThan(0);
    for (const solid of letters) {
      expect(solid.bottom).toBeCloseTo(roof - 0.04, 3);
      expect(typeof solid.top).toBe('number');
      expect(solid.top as number).toBeGreaterThan(roof + 0.5);
    }
    await expectClosed(edited);
  });

  it('notes a shape following the ground that was dragged into a building, and only then', async () => {
    const { session } = await setUp();
    const inside = shape({ id: 'in', at: at(70, 170), sizeMm: 1, depthMm: 1, heightMm: 0.5, followGround: true });
    const open = shape({ id: 'open', at: at(300, -150), sizeMm: 1, depthMm: 1, heightMm: 0.5, followGround: true });
    const update = await session.update({ ...emptyEdits(), shapes: [inside, open] }, 1);
    expect(update.notes['s:in']).toMatch(/inside a building/);
    expect(update.notes['s:open']).toBeUndefined();
    // The note follows the building, though the shape itself doesn't change.
    const removed = await session.update({ ...emptyEdits(), objects: { 'b:tower': { removed: true } }, shapes: [inside, open] }, 2);
    expect(removed.notes['s:in']).toBeUndefined();
    expect(removed.objects.map((o) => o.key)).not.toContain('s:in');
  });
});

describe('Bridges', () => {
  const deckArea = (model: ModelSpec, key = 'br:cross') => multiArea(solidsIn(model, 'bridges').filter((s) => s.key === key).map((s) => s.polygon));

  it("widens a bridge with its road, or on its own, and cuts piers to a narrower deck", async () => {
    const { session, spec } = await setUp({ bridges: true });
    const facts = session.describe()['br:cross'];
    expect(facts?.kind).toBe('bridge');
    expect(facts.widthMm).toBeGreaterThan(0);
    const before = deckArea(spec);
    expect(before).toBeGreaterThan(0);
    const wide = { ...emptyEdits(), objects: { 'r:cross': { widthMm: facts.widthMm! * 2 } } };
    const update = await session.update(wide, 1);
    expect(update.objects.find((o) => o.key === 'br:cross' && o.part === 'bridges')?.mesh?.indices.length).toBeGreaterThan(0);
    const edited = await session.edited(wide, DEFAULT_PALETTE);
    expect(deckArea(edited) / before).toBeGreaterThan(1.7);
    await expectClosed(edited);

    const narrow = { ...emptyEdits(), objects: { 'r:cross': { widthMm: facts.widthMm! * 2 }, 'br:cross': { widthMm: 0.3 } } };
    const narrowed = await session.update(narrow, 2);
    expect(narrowed.objects.map((o) => o.part)).toEqual(expect.arrayContaining(['bridges', 'piers']));
    const thin = await session.edited(narrow, DEFAULT_PALETTE);
    expect(deckArea(thin) / before).toBeLessThan(0.8);
    const deck = solidsIn(thin, 'bridges').filter((s) => s.key === 'br:cross').map((s) => s.polygon);
    for (const pier of solidsIn(thin, 'piers').filter((s) => s.key === 'br:cross')) {
      expect(multiArea(difference([pier.polygon], deck))).toBeLessThan(1e-3);
    }
    await expectClosed(thin);
  });

  it('takes a bridge, its piers and the ground kept for them away with its road', async () => {
    const { session, spec } = await setUp({ bridges: true });
    const piers = solidsIn(spec, 'piers').filter((s) => s.key === 'br:cross');
    expect(piers.length).toBeGreaterThan(0);
    const wet = piers.find((p) => pointInMulti(...centre(p), spec.edit!.kept.piers))!;
    expect(wet).toBeDefined();
    const edits = { ...emptyEdits(), objects: { 'r:cross': { removed: true } } };
    await session.update(edits, 1);
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    expect(deckArea(edited)).toBe(0);
    expect(solidsIn(edited, 'piers').some((s) => s.key === 'br:cross')).toBe(false);
    expect(covers(groundOf(edited), ...centre(wet))).toBe(false);
    expect(covers(solidsIn(edited, 'water'), ...centre(wet))).toBe(true);
    await expectClosed(edited);
    // Put back on its own, the bridge stays while the road is gone.
    const kept = { ...emptyEdits(), objects: { 'r:cross': { removed: true }, 'br:cross': { removed: false } } };
    const back = await session.edited(kept, DEFAULT_PALETTE);
    expect(deckArea(back)).toBeCloseTo(deckArea(spec), 6);
    expect(covers(groundOf(back), ...centre(wet))).toBe(true);
  });
});

function centre(solid: PrismSolid): [number, number] {
  const ring = solid.polygon[0];
  return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
}

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
