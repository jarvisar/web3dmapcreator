import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { generateModel } from '../pipeline/generate';
import type { SourceData, SourceFeature } from '../pipeline/source';
import { cloneSettings, type AreaSpec } from '../settings';
import { EditSession, type EditUpdate } from './session';
import { emptyEdits, type AddedShape, type ModelEdits } from './types';

// What a shape stands on is kept between updates (what holds it up, the
// water under it, its caps). These check an update after other edits comes
// out the same as a new session's for the same edits, and that moving one
// shape builds only that one again when the water spans the whole model.

const LAT = 45;
const LON = 0.01;
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (x: number, y: number): [number, number] => [LON + x * M_LON, LAT + y * M_LAT];
const rect = (x0: number, y0: number, x1: number, y1: number) => [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]];
const feature = (id: string, geometry: SourceFeature['geometry'], props: Record<string, unknown>): SourceFeature => ({ id, geometry, props });

function lakeside(): SourceData {
  return {
    release: 'test',
    features: {
      // A lake from one end of the model to the other.
      water: [feature('lake', { type: 'Polygon', coordinates: rect(-900, -250, 900, 0) }, { subtype: 'lake', class: 'lake' })],
      segment: [feature('shore', { type: 'LineString', coordinates: [at(-800, 60), at(800, 70)] }, { subtype: 'road', class: 'primary' })],
      building: [
        feature('a', { type: 'Polygon', coordinates: rect(-200, 100, -150, 150) }, { height: 30 }),
        feature('b', { type: 'Polygon', coordinates: rect(-140, 100, -90, 160) }, { height: 18 }),
        feature('c', { type: 'Polygon', coordinates: rect(-80, 110, -30, 140) }, { height: 45 }),
        feature('pier', { type: 'Polygon', coordinates: rect(200, -60, 240, 20) }, { height: 8 }),
      ],
    },
  };
}

const area: AreaSpec = { center: [LON, LAT], widthM: 1500, heightM: 1000, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const hills = { sample: (lon: number, lat: number) => 30 + 10 * Math.sin((lon - LON) / M_LON / 200) + 5 * Math.cos((lat - LAT) / M_LAT / 150) };

async function setUp() {
  const settings = cloneSettings();
  settings.terrain.resolution = 96;
  const spec = await generateModel({ area, settings, data: lakeside(), elevation: hills });
  const projection = new Projection(area.center, area.rotationDeg, spec.mmPerMetre);
  const session = () => new EditSession(spec, settings, projection, { load: async () => Promise.reject(new Error('no fonts here')) });
  return { session };
}

function shape(id: string, x: number, y: number, patch: Partial<AddedShape> = {}): AddedShape {
  return {
    id,
    kind: 'box',
    layer: 'buildings',
    at: at(x, y),
    points: [],
    rotationDeg: 0,
    sizeMm: 3,
    depthMm: 3,
    heightMm: 2,
    liftMm: 0,
    followGround: false,
    text: '',
    font: 'montserrat',
    ...patch,
  };
}

function hash(update: EditUpdate['objects'][number]['mesh']): string {
  if (!update) return 'none';
  let h = 2166136261;
  for (const v of update.positions) h = Math.imul(h ^ Math.round(v * 1e5), 16777619);
  for (const v of update.indices) h = Math.imul(h ^ v, 16777619);
  return `${update.positions.length}/${update.indices.length}/${(h >>> 0).toString(36)}`;
}

/** What the viewer would hold after a run of updates: shape meshes by part and key. */
class Shown {
  readonly meshes = new Map<string, string>();
  take(update: EditUpdate): string[] {
    const changed: string[] = [];
    for (const object of update.objects) {
      if (!object.key.startsWith('s:')) continue;
      const id = `${object.part}|${object.key}`;
      changed.push(object.key);
      if (object.mesh) this.meshes.set(id, hash(object.mesh));
      else this.meshes.delete(id);
    }
    return changed;
  }
}

async function fresh(make: () => EditSession, edits: ModelEdits): Promise<Map<string, string>> {
  const shown = new Shown();
  shown.take(await make().update(edits, 1));
  return shown.meshes;
}

describe('shapes kept between updates', () => {
  it('builds only the shape that moved, with water across the whole model', async () => {
    const { session } = await setUp();
    const live = session();
    const shown = new Shown();
    // Some over the lake, some on land.
    const shapes = Array.from({ length: 12 }, (_, i) => shape(`s${i}`, -600 + i * 100, i % 2 ? -120 : 250));
    let version = 0;
    shown.take(await live.update({ ...emptyEdits(), shapes }, ++version));
    expect(shown.meshes.size).toBe(12);
    for (const index of [3, 4, 7]) {
      const moved = shapes.map((s, i) => (i === index ? shape(s.id, -600 + i * 100 + 20, i % 2 ? -140 : 270) : s));
      shapes.splice(0, shapes.length, ...moved);
      const changed = shown.take(await live.update({ ...emptyEdits(), shapes }, ++version));
      expect(changed).toEqual([`s:s${index}`]);
    }
    expect(shown.meshes).toEqual(await fresh(session, { ...emptyEdits(), shapes }));
  });

  it('comes out the same as a new session after height changes and moves over roofs and water', async () => {
    const { session } = await setUp();
    const live = session();
    const shown = new Shown();
    // Over three roofs, the shore road and the lake.
    let big = shape('big', -120, 60, { sizeMm: 25, depthMm: 30 });
    const small = shape('small', -150, 120, { sizeMm: 2, depthMm: 2, liftMm: 5 });
    let version = 0;
    const steps: AddedShape[][] = [];
    steps.push([big, small]);
    big = { ...big, heightMm: 6 };
    steps.push([big, small]);
    big = { ...big, heightMm: 3 };
    steps.push([big, small]);
    big = { ...big, at: at(-100, 50) };
    steps.push([big, small]);
    big = { ...big, heightMm: 9 };
    steps.push([big, { ...small, heightMm: 4 }]);
    for (const shapes of steps) {
      shown.take(await live.update({ ...emptyEdits(), shapes }, ++version));
      expect(shown.meshes).toEqual(await fresh(session, { ...emptyEdits(), shapes }));
    }
  });
});
