import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { intersection, multiArea, union } from '../geometry/polygon';
import { signedVolume } from '../geometry/validate';
import { generateModel, type ModelSpec } from '../pipeline/generate';
import { meshLayers } from '../pipeline/mesh';
import type { SourceData, SourceFeature } from '../pipeline/source';
import { cloneSettings, DEFAULT_PALETTE, type AreaSpec } from '../settings';
import type { MultiPolygon } from '../types';
import { EditSession, SHAPES_PART } from './session';
import { shapeFootprint } from './shapes';
import { emptyEdits, type AddedShape, type ModelEdits } from './types';

const LAT = 45;
const LON = 0.01;
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (x: number, y: number): [number, number] => [LON + x * M_LON, LAT + y * M_LAT];
const rect = (x0: number, y0: number, x1: number, y1: number) => [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]];

function feature(id: string, geometry: SourceFeature['geometry'], props: Record<string, unknown>): SourceFeature {
  return { id, geometry, props };
}

// A park with a street running past it and one running into it.
function town(): SourceData {
  return {
    release: 'test',
    features: {
      water: [feature('river', { type: 'Polygon', coordinates: rect(-900, -60, 900, 40) }, { subtype: 'river', class: 'river' })],
      land_use: [feature('park', { type: 'Polygon', coordinates: rect(200, 200, 500, 450) }, { subtype: 'park', class: 'park' })],
      segment: [
        feature('main', { type: 'LineString', coordinates: [at(-800, 120), at(800, 130)] }, { subtype: 'road', class: 'primary' }),
        feature('cross', { type: 'LineString', coordinates: [at(0, -500), at(10, 500)] }, { subtype: 'road', class: 'residential' }),
        feature('park-path', { type: 'LineString', coordinates: [at(350, 130), at(350, 400)] }, { subtype: 'road', class: 'footway' }),
      ],
      building: [feature('shed', { type: 'Polygon', coordinates: rect(600, -200, 640, -170) }, {})],
    },
  };
}

const area: AreaSpec = { center: [LON, LAT], widthM: 1500, heightM: 1000, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const hills = { sample: (lon: number, lat: number) => 30 + 20 * Math.sin((lon - LON) / M_LON / 200) + 10 * Math.cos((lat - LAT) / M_LAT / 150) };

async function setUp() {
  const settings = cloneSettings();
  settings.terrain.resolution = 96;
  const spec = await generateModel({ area, settings, data: town(), elevation: hills });
  const projection = new Projection(area.center, area.rotationDeg, spec.mmPerMetre);
  const session = new EditSession(spec, settings, projection);
  return { settings, spec, projection, session };
}

function shape(patch: Partial<AddedShape>): AddedShape {
  return {
    id: 's1',
    kind: 'path',
    layer: 'roads',
    at: at(-100, 325),
    points: [at(-100, 325), at(550, 325)],
    rotationDeg: 0,
    sizeMm: 1.5,
    depthMm: 1.5,
    heightMm: 0.6,
    liftMm: 0,
    followGround: true,
    text: '',
    font: 'montserrat',
    ...patch,
  };
}

function withShapes(...shapes: AddedShape[]): ModelEdits {
  return { ...emptyEdits(), shapes };
}

function polygonsOf(spec: ModelSpec, id: string): MultiPolygon {
  return spec.layers.find((l) => l.id === id)?.solids.flatMap((s) => (s.kind === 'prism' ? [s.polygon] : [])) ?? [];
}

/** How much of a part's footprint lies under a shape. */
function overlap(spec: ModelSpec, id: string, footprint: MultiPolygon): number {
  const polygons = polygonsOf(spec, id);
  return polygons.length ? multiArea(intersection(union(polygons), footprint)) : 0;
}

async function volumeOf(spec: ModelSpec, id: string): Promise<number> {
  const layer = spec.layers.find((l) => l.id === id);
  if (!layer) return 0;
  const { parts } = await meshLayers([layer], { zShift: -spec.baseZ });
  return parts.reduce((sum, part) => sum + signedVolume(part.positions, part.indices), 0);
}

describe('what shapes on the ground take from under them', () => {
  it('cuts land cover and roads under a drawn road, in the view and the export', async () => {
    const { spec, projection, session } = await setUp();
    const road = shape({});
    const footprint = shapeFootprint(road, projection, [spec.crop], null)!;
    expect(overlap(spec, 'land-green', footprint)).toBeGreaterThan(1);
    expect(overlap(spec, 'roads', footprint)).toBeGreaterThan(0.5);
    expect(overlap(spec, 'paths', footprint)).toBeGreaterThan(0.1);

    const edits = withShapes(road);
    const update = await session.update(edits, 1);
    const green = update.parts.find((p) => p.id === 'land-green');
    expect(green?.part?.indices.length).toBeGreaterThan(0);
    expect(update.parts.some((p) => p.id === 'roads' && p.part)).toBe(true);

    const edited = await session.edited(edits, DEFAULT_PALETTE);
    expect(overlap(edited, 'land-green', footprint)).toBeLessThan(1e-3);
    expect(overlap(edited, 'roads', footprint)).toBeLessThan(1e-3);
    expect(overlap(edited, 'paths', footprint)).toBeLessThan(1e-3);
    // The rest of the park stays.
    expect(multiArea(polygonsOf(edited, 'land-green'))).toBeCloseTo(multiArea(polygonsOf(spec, 'land-green')) - overlap(spec, 'land-green', footprint), 1);

    // The view's land part holds what the export does.
    const shown = signedVolume(green!.part!.positions, green!.part!.indices);
    const exported = await volumeOf(edited, 'land-green');
    expect(Math.abs(shown - exported)).toBeLessThan(0.003 * exported + 0.01);
  });

  it('gives everything back when the road goes', async () => {
    const { spec, session } = await setUp();
    await session.update(withShapes(shape({})), 1);
    const back = await session.update(emptyEdits(), 2);
    expect(back.parts.find((p) => p.id === 'land-green')).toEqual({ id: 'land-green', part: null });
    expect(back.parts.find((p) => p.id === 'roads')).toEqual({ id: 'roads', part: null });
    const edited = await session.edited(emptyEdits(), DEFAULT_PALETTE);
    expect(multiArea(polygonsOf(edited, 'land-green'))).toBeCloseTo(multiArea(polygonsOf(spec, 'land-green')), 6);
    expect(multiArea(polygonsOf(edited, 'roads'))).toBeCloseTo(multiArea(polygonsOf(spec, 'roads')), 6);
  });

  it('follows a road as it moves, and only sends the parts that changed', async () => {
    const { spec, projection, session } = await setUp();
    await session.update(withShapes(shape({})), 1);
    const moved = shape({ points: [at(-100, 260), at(550, 260)] });
    const update = await session.update(withShapes(moved), 2);
    expect(update.parts.some((p) => p.id === 'land-green' && p.part)).toBe(true);
    const edited = await session.edited(withShapes(moved), DEFAULT_PALETTE);
    const was = shapeFootprint(shape({}), projection, [spec.crop], null)!;
    const now = shapeFootprint(moved, projection, [spec.crop], null)!;
    expect(overlap(edited, 'land-green', now)).toBeLessThan(1e-3);
    // The park is whole again where it was.
    expect(overlap(edited, 'land-green', was)).toBeCloseTo(overlap(spec, 'land-green', was), 1);
    // Recolouring it changes neither.
    const again = await session.update(withShapes({ ...moved, layer: 'buildings' }), 3);
    expect(again.parts.filter((p) => p.id.startsWith('land-') || p.id === 'roads' || p.id === 'paths')).toEqual([]);
  });

  it("leaves what's under a raised road", async () => {
    const { spec, projection, session } = await setUp();
    const raised = shape({ liftMm: 3, followGround: false });
    const edited = await session.edited(withShapes(raised), DEFAULT_PALETTE);
    const footprint = shapeFootprint(raised, projection, [spec.crop], null)!;
    expect(overlap(edited, 'roads', footprint)).toBeCloseTo(overlap(spec, 'roads', footprint), 6);
  });

  it('cuts land cover under any shape on the ground, but only drawn roads take roads', async () => {
    const { spec, projection, session } = await setUp();
    // Over the park and its path, and over the cross street.
    const box = shape({ id: 'b', kind: 'box', layer: 'buildings', at: at(350, 300), points: [], sizeMm: 6, depthMm: 6, heightMm: 3, followGround: false });
    const text = shape({ id: 't', kind: 'text', layer: 'buildings', at: at(5, 300), points: [], sizeMm: 5, heightMm: 1.2, text: 'HI' });
    const edited = await session.edited(withShapes(box), DEFAULT_PALETTE);
    const footprint = shapeFootprint(box, projection, [spec.crop], null)!;
    expect(overlap(spec, 'land-green', footprint)).toBeGreaterThan(1);
    expect(overlap(edited, 'land-green', footprint)).toBeLessThan(1e-3);
    expect(overlap(edited, 'paths', footprint)).toBeCloseTo(overlap(spec, 'paths', footprint), 6);
    const withText = await session.edited(withShapes(text), DEFAULT_PALETTE);
    expect(multiArea(polygonsOf(withText, 'roads'))).toBeCloseTo(multiArea(polygonsOf(spec, 'roads')), 6);
  });

  it("doesn't put land cover back under a road made into a drawn one", async () => {
    const { spec, projection, session } = await setUp();
    // The park path taken out and drawn again along the same line.
    const drawn = shape({ points: [at(350, 130), at(350, 400)], sizeMm: 0.45, heightMm: 0.6 });
    const edits: ModelEdits = { ...withShapes(drawn), objects: { 'r:park-path': { removed: true } } };
    const footprint = shapeFootprint(drawn, projection, [spec.crop], null)!;
    const removed = await session.edited({ ...emptyEdits(), objects: edits.objects }, DEFAULT_PALETTE);
    // Taken out on its own, the park gets its grass back.
    expect(overlap(removed, 'land-green', footprint)).toBeGreaterThan(0.5 * overlap(spec, 'land-green', footprint) + 0.1);
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    expect(overlap(edited, 'land-green', footprint)).toBeLessThan(1e-3);
    await session.update(edits, 1);
  });

  it('leaves land cover and roads alone under shapes hidden from the download', async () => {
    const { spec, projection, session } = await setUp();
    const road = shape({});
    const footprint = shapeFootprint(road, projection, [spec.crop], null)!;
    const edited = await session.edited(withShapes(road), DEFAULT_PALETTE, [SHAPES_PART, 'added-roads']);
    expect(overlap(edited, 'land-green', footprint)).toBeCloseTo(overlap(spec, 'land-green', footprint), 6);
    expect(overlap(edited, 'roads', footprint)).toBeCloseTo(overlap(spec, 'roads', footprint), 3);
  });
});
