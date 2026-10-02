import { describe, expect, it } from 'vitest';
import { EditSession } from '../edit/session';
import { emptyEdits } from '../edit/types';
import { Projection } from '../geo/projection';
import { pointInMulti, pointInPolygon } from '../geometry/polygon';
import type { HeightFn, PrismSolid } from '../geometry/solid';
import { edgeReport, signedVolume } from '../geometry/validate';
import { cloneSettings, DEFAULT_PALETTE, type AreaSpec, type ModelSettings } from '../settings';
import type { TrackLines } from '../tracks/track';
import type { LonLat, Polygon } from '../types';
import { generateModel } from './generate';
import { meshLayers } from './mesh';
import type { SourceData, SourceFeature } from './source';

// A town around lon 0.01, lat 45 with a river across the middle, a street
// crossing it, and a building beside the street.
const LAT = 45;
const LON = 0.01;
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (x: number, y: number): LonLat => [LON + x * M_LON, LAT + y * M_LAT];
const rect = (x0: number, y0: number, x1: number, y1: number) => [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]];

let nextId = 1;
function feature(geometry: SourceFeature['geometry'], props: Record<string, unknown>): SourceFeature {
  return { id: `f${nextId++}`, geometry, props };
}

function town(): SourceData {
  return {
    release: 'test',
    features: {
      water: [feature({ type: 'Polygon', coordinates: rect(-900, -60, 900, 40) }, { subtype: 'river', class: 'river' })],
      segment: [
        feature({ type: 'LineString', coordinates: [at(-800, 200), at(800, 200)] }, { subtype: 'road', class: 'primary' }),
        feature({ type: 'LineString', coordinates: [at(0, -450), at(0, 450)] }, { subtype: 'road', class: 'residential' }),
        feature({ type: 'LineString', coordinates: [at(300, -450), at(300, 450)] }, { subtype: 'road', class: 'residential' }),
      ],
      building: [
        // Beside the street at x 0, and one the route below runs straight through.
        feature({ type: 'Polygon', coordinates: rect(15, 250, 60, 320) }, { height: 30 }),
        feature({ type: 'Polygon', coordinates: rect(-560, 300, -440, 360) }, { height: 20 }),
      ],
    },
  };
}

const area: AreaSpec = { center: [LON, LAT], widthM: 1500, heightM: 1000, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const flat = { sample: () => 20 };

function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/** A run up the street at x 0, across the river, and east along the main road, recorded with GPS drift. */
function run(noise = 7): TrackLines {
  const random = seeded(5);
  const path: [number, number][] = [
    [0, -400],
    [0, 200],
    [250, 200],
  ];
  const points: LonLat[] = [];
  let ex = 0;
  let ey = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    const steps = Math.round(Math.hypot(bx - ax, by - ay) / 3);
    for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
      ex = 0.9 * ex + 0.1 * random() * noise * 2;
      ey = 0.9 * ey + 0.1 * random() * noise * 2;
      points.push(at(ax + ((bx - ax) * k) / steps + ex, ay + ((by - ay) * k) / steps + ey));
    }
  }
  return { id: 'run', name: 'Morning Run', lines: [points] };
}

/** Straight across the river where no road crosses it. */
const wade: TrackLines = { id: 'wade', name: 'Wade', lines: [[at(-600, -300), at(-600, 300)]] };

async function build(tracks: TrackLines[], patch?: (s: ModelSettings) => void) {
  const settings = cloneSettings();
  settings.terrain.resolution = 96;
  patch?.(settings);
  const spec = await generateModel({ area, settings, data: town(), elevation: flat, tracks });
  return { spec, settings };
}

const projection = new Projection(area.center, 0, 0.07);
const model = (x: number, y: number) => projection.toModel(...at(x, y));
const routeSolids = (spec: Awaited<ReturnType<typeof build>>['spec']) => (spec.layers.find((layer) => layer.id === 'routes')?.solids ?? []) as PrismSolid[];
const covers = (solids: PrismSolid[], [x, y]: [number, number]) => solids.some((solid) => pointInPolygon(x, y, solid.polygon as Polygon));
const valueAt = (h: HeightFn | number, x: number, y: number) => (typeof h === 'number' ? h : h(x, y));

describe('routes on a map model', () => {
  it('builds a closed part of their own, keyed for the editor', async () => {
    const { spec } = await build([run()]);
    const routes = spec.layers.find((layer) => layer.id === 'routes');
    expect(routes?.role).toBe('route');
    expect(routes!.solids.every((solid) => solid.key === 'rt:run')).toBe(true);
    expect(spec.edit?.objects.get('rt:run')).toMatchObject({ kind: 'route', name: 'Morning Run' });
    const { parts, failed } = await meshLayers(spec.layers, { zShift: -spec.baseZ });
    expect(failed).toBe(0);
    const part = parts.find((p) => p.id === 'routes')!;
    const report = edgeReport(part.indices, part.positions.length / 3);
    expect(report.open).toBe(0);
    expect(report.repeated).toBe(0);
    expect(signedVolume(part.positions, part.indices)).toBeGreaterThan(0);
  });

  it('snaps the recording onto the street and stands a layer over the road', async () => {
    const { spec, settings } = await build([run()]);
    expect(spec.stats.route_snapped_share).toBeGreaterThan(0.9);
    const solids = routeSolids(spec);
    // On the street's own line, where the drift wandered up to 7 m off it.
    for (const y of [-300, -150, 120]) expect(covers(solids, model(0, y))).toBe(true);
    const [x, y] = model(0, -300);
    const solid = solids.find((s) => pointInPolygon(x, y, s.polygon as Polygon))!;
    const ground = spec.edit!.heightAt(x, y);
    expect(valueAt(solid.top, x, y)).toBeCloseTo(ground + settings.tracks.heightMm, 6);
    expect(valueAt(solid.top, x, y) - ground).toBeGreaterThan(settings.roads.thicknessMm);
  });

  it('keeps ground under it across water, like a road', async () => {
    const { spec } = await build([wade], (s) => (s.tracks.snap = false));
    const kept = spec.edit!.kept.tracks;
    expect(kept.map((track) => track.key)).toEqual(['rt:wade']);
    const water = spec.layers.find((layer) => layer.id === 'water')!.solids as PrismSolid[];
    const [x, y] = model(-600, -10);
    expect(water.some((solid) => pointInPolygon(x, y, solid.polygon as Polygon))).toBe(false);
    expect(pointInMulti(x, y, spec.edit!.terrain!.ground)).toBe(true);
    // With supports off it stands down through the water to the floor instead.
    const { spec: wading } = await build([wade], (s) => {
      s.tracks.snap = false;
      s.supports = false;
    });
    expect(pointInMulti(x, y, wading.edit!.terrain!.ground)).toBe(false);
    const deep = routeSolids(wading).find((solid) => pointInPolygon(x, y, solid.polygon as Polygon))!;
    expect(valueAt(deep.bottom, x, y)).toBeLessThan(wading.edit!.heightAt(x, y) - 0.2);
  });

  it('goes into buildings it runs into, listed before them so they keep the overlap', async () => {
    const straight: TrackLines = { id: 'through', name: 'Through', lines: [[at(-700, 330), at(-300, 330)]] };
    const { spec } = await build([straight], (s) => (s.tracks.snap = false));
    const solids = routeSolids(spec);
    for (const x of [-600, -500, -400]) expect(covers(solids, model(x, 330))).toBe(true);
    const ids = spec.layers.map((layer) => layer.id);
    expect(ids.indexOf('routes')).toBeGreaterThan(ids.indexOf('roads'));
    expect(ids.indexOf('routes')).toBeLessThan(ids.indexOf('buildings'));
  });

  it('marks the start with a dot and the finish with a bar', async () => {
    const line: TrackLines = { id: 'line', name: 'Line', lines: [[at(-700, 450), at(-400, 450)]] };
    const width = 0.6;
    const { spec } = await build([line], (s) => {
      s.tracks.snap = false;
      s.tracks.widthMm = width;
    });
    const solids = routeSolids(spec);
    const [sx, sy] = model(-700, 450);
    // Beside the start, past the line's own width but inside the dot.
    expect(covers(solids, [sx - width, sy])).toBe(true);
    expect(covers(solids, [sx, sy + width])).toBe(true);
    const [fx, fy] = model(-400, 450);
    expect(covers(solids, [fx, fy + width])).toBe(true);
    // Not around the middle.
    const [mx, my] = model(-550, 450);
    expect(covers(solids, [mx, my + width])).toBe(false);
    const { spec: plain } = await build([line], (s) => {
      s.tracks.snap = false;
      s.tracks.markers = false;
    });
    expect(covers(routeSolids(plain), [sx, sy + width])).toBe(false);
  });

  it('rides a bridge deck it runs along', async () => {
    const { spec, settings } = await build([run()], (s) => (s.bridges.enabled = true));
    const solids = routeSolids(spec);
    const [x, y] = model(0, -10);
    const onDeck = solids.find((solid) => pointInPolygon(x, y, solid.polygon as Polygon));
    expect(onDeck).toBeDefined();
    const deck = (spec.layers.find((layer) => layer.id === 'bridges')!.solids as PrismSolid[]).find((solid) => pointInPolygon(x, y, solid.polygon as Polygon))!;
    const lift = settings.tracks.heightMm - settings.roads.thicknessMm;
    expect(valueAt(onDeck!.top, x, y)).toBeCloseTo(valueAt(deck.top, x, y) + lift, 6);
    expect(spec.stats.route_decks).toBeGreaterThan(0);
    // A deck carries it, so no ground is kept under it in the river.
    expect(spec.edit!.kept.tracks).toEqual([]);
  });

  it('is left out with the layer off or without routes', async () => {
    const { spec: off } = await build([run()], (s) => (s.tracks.enabled = false));
    expect(off.layers.some((layer) => layer.id === 'routes')).toBe(false);
    expect(off.edit!.kept.tracks).toEqual([]);
    const { spec: none } = await build([]);
    const { spec: without } = await generateModel({ area, settings: (() => {
      const s = cloneSettings();
      s.terrain.resolution = 96;
      return s;
    })(), data: town(), elevation: flat }).then((spec) => ({ spec }));
    expect(none.layers.map((layer) => layer.id)).toEqual(without.layers.map((layer) => layer.id));
    expect(none.stats).toEqual(without.stats);
  });

  it('goes with its ground in the water when removed in the editor', async () => {
    const { spec, settings } = await build([wade], (s) => (s.tracks.snap = false));
    const session = new EditSession(spec, settings, new Projection(area.center, area.rotationDeg, spec.mmPerMetre));
    const [x, y] = model(-600, -10);
    const waterAt = (layers: typeof spec.layers) => (layers.find((layer) => layer.id === 'water')!.solids as PrismSolid[]).some((solid) => pointInPolygon(x, y, solid.polygon as Polygon));
    expect(waterAt((await session.edited(emptyEdits(), DEFAULT_PALETTE)).layers)).toBe(false);
    const edits = emptyEdits();
    edits.objects['rt:wade'] = { removed: true };
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    expect(edited.layers.some((layer) => layer.id === 'routes')).toBe(false);
    expect(waterAt(edited.layers)).toBe(true);
  });
});
