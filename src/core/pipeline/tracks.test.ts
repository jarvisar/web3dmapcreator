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
      land_use: [feature({ type: 'Polygon', coordinates: rect(-300, -400, -100, -200) }, { subtype: 'park', class: 'park' })],
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

  it('stays on a street under a viaduct beside it, and rides the viaduct when on it', async () => {
    // A street along y 0 with an elevated road 3 m off its line, not joined to it, on dry land.
    const data: SourceData = {
      release: 'test',
      features: {
        segment: [
          feature({ type: 'LineString', coordinates: [at(-700, 0), at(700, 0)] }, { subtype: 'road', class: 'secondary' }),
          feature({ type: 'LineString', coordinates: [at(-300, 3), at(300, 3)] }, { subtype: 'road', class: 'primary', road_flags: [{ values: ['is_bridge'] }] }),
          feature({ type: 'LineString', coordinates: [at(0, -400), at(0, 400)] }, { subtype: 'road', class: 'residential' }),
        ],
      },
    };
    const lift = async (points: LonLat[], snap: boolean) => {
      const settings = cloneSettings();
      settings.terrain.resolution = 96;
      settings.bridges.enabled = true;
      settings.tracks.snap = snap;
      const spec = await generateModel({ area, settings, data, elevation: flat, tracks: [{ id: 'v', name: 'V', lines: [points] }] });
      const [x, y] = model(150, 1.5);
      const solid = routeSolids(spec).find((s) => pointInPolygon(x, y, s.polygon as Polygon));
      return { decks: spec.stats.route_decks ?? 0, top: solid ? valueAt(solid.top, x, y) : null };
    };
    const line = (from: [number, number], to: [number, number]): LonLat[] => {
      const steps = Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / 3);
      return Array.from({ length: steps + 1 }, (_, k) => at(from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps));
    };
    // Up the cross street and along the street, recorded a metre off it.
    const street = [...line([1, -300], [1, -1]), ...line([3, -1], [400, -1])];
    expect((await lift(street, true)).decks).toBe(0);
    // The same unsnapped: it comes in from the side, so it's under the deck.
    expect((await lift([...line([0, -300], [0, 0.5]), ...line([3, 0.5], [400, 0.5])], false)).decks).toBe(0);
    // Along the deck itself, snapped and not.
    const wobble = (points: LonLat[]) => points.map(([lon, lat], i): LonLat => [lon, lat + (Math.sin(i) * 0.5) * M_LAT]);
    const snapped = await lift(wobble(line([-290, 3.5], [290, 3.5])), true);
    expect(snapped.decks).toBeGreaterThan(0);
    expect(snapped.top).toBeGreaterThan(1);
    expect((await lift(wobble(line([-400, 3.5], [400, 3.5])), false)).decks).toBeGreaterThan(0);
  });

  it('puts markers at the recorded ends, not where the area cut the route', async () => {
    // Starts inside, leaves through the east edge, comes back in from the
    // north and finishes inside. Clipped, the piece coming back in is first.
    const width = 0.6;
    const out: TrackLines = { id: 'out', name: 'Out', lines: [[at(-600, 300), at(1200, 300), at(1200, 1000), at(-500, 1000), at(-500, 380)]] };
    const { spec } = await build([out], (s) => {
      s.tracks.snap = false;
      s.tracks.widthMm = width;
    });
    const solids = routeSolids(spec);
    const [sx, sy] = model(-600, 300);
    expect(covers(solids, [sx - width, sy])).toBe(true);
    const [fx, fy] = model(-500, 380);
    expect(covers(solids, [fx + width, fy])).toBe(true);
    // Starting off the model, it gets no dot.
    const outside: TrackLines = { id: 'outside', name: 'Outside', lines: [[at(-900, 450), at(-400, 450)]] };
    const { spec: off } = await build([outside], (s) => {
      s.tracks.snap = false;
      s.tracks.widthMm = width;
    });
    const [cx, cy] = model(-740, 450);
    expect(covers(routeSolids(off), [cx, cy + width])).toBe(false);
    const [gx, gy] = model(-400, 450);
    expect(covers(routeSolids(off), [gx, gy + width])).toBe(true);
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

  it('cuts the roads and parks it lies on, and gives them back when removed in the editor', async () => {
    // Along the street at x 0, and across the park.
    const park: TrackLines = { id: 'park', name: 'Park', lines: [[at(-280, -300), at(-120, -300)]] };
    const { spec, settings } = await build([run(), park]);
    const solidsOf = (layers: typeof spec.layers, id: string) => (layers.find((layer) => layer.id === id)?.solids ?? []) as PrismSolid[];
    const street = model(0, -300);
    const lawn = model(-200, -300);
    expect(covers(routeSolids(spec), street)).toBe(true);
    expect(covers(solidsOf(spec.layers, 'roads'), street)).toBe(false);
    // Away from it the street is still there.
    expect(covers(solidsOf(spec.layers, 'roads'), model(0, 350))).toBe(true);
    expect(covers(routeSolids(spec), lawn)).toBe(true);
    expect(covers(solidsOf(spec.layers, 'land-green'), lawn)).toBe(false);
    expect(covers(solidsOf(spec.layers, 'land-green'), model(-200, -250))).toBe(true);

    const session = new EditSession(spec, settings, new Projection(area.center, area.rotationDeg, spec.mmPerMetre));
    // A wider street near the route is rebuilt from its lines, and still gives way to the route.
    const streetKey = spec.edit!.roads.find((piece) => piece.points.every(([x]) => Math.abs(x) < 0.5))!;
    const wider = emptyEdits();
    wider.objects[`r:${streetKey.sourceId}`] = { widthMm: 1.2 };
    const widened = await session.edited(wider, DEFAULT_PALETTE);
    expect(covers(solidsOf(widened.layers, 'roads'), street)).toBe(false);
    expect(covers(solidsOf(widened.layers, 'roads'), model(6, -300))).toBe(true);

    const removed = emptyEdits();
    removed.objects['rt:run'] = { removed: true };
    removed.objects['rt:park'] = { removed: true };
    const edited = await session.edited(removed, DEFAULT_PALETTE);
    expect(edited.layers.some((layer) => layer.id === 'routes')).toBe(false);
    expect(covers(solidsOf(edited.layers, 'roads'), street)).toBe(true);
    const lawnBack = edited.layers.filter((layer) => layer.id.startsWith('land-green')).flatMap((layer) => layer.solids as PrismSolid[]);
    expect(covers(lawnBack, lawn)).toBe(true);
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

  it('goes with the bridge carrying it when the editor removes the bridge or its road', async () => {
    // The run, and one only on the bridge, without markers that would reach off it.
    const span: TrackLines = { id: 'span', name: 'Span', lines: [[at(0, -40), at(0, 25)]] };
    const { spec, settings } = await build([run(), span], (s) => {
      s.bridges.enabled = true;
      s.tracks.markers = false;
    });
    const editor = () => new EditSession(spec, settings, new Projection(area.center, area.rotationDeg, spec.mmPerMetre));
    const session = editor();
    const river = model(0, -10);
    const street = model(0, -300);
    const bridge = (spec.layers.find((layer) => layer.id === 'bridges')!.solids as PrismSolid[]).find((solid) => pointInPolygon(...river, solid.polygon as Polygon))!.key!;
    const road = bridge.replace('br:', 'r:');
    const keyed = (solids: PrismSolid[], key: string) => solids.filter((solid) => solid.key === key);
    expect(covers(keyed(routeSolids(spec), 'rt:run'), river)).toBe(true);
    expect(keyed(routeSolids(spec), 'rt:span').length).toBeGreaterThan(0);
    expect(keyed(routeSolids(spec), 'rt:span').every((solid) => spec.edit!.routeDecks!.get(solid) === bridge)).toBe(true);
    for (const removed of [{ [bridge]: { removed: true } }, { [road]: { removed: true } }]) {
      const edits = { ...emptyEdits(), objects: removed };
      const edited = routeSolids(await session.edited(edits, DEFAULT_PALETTE));
      expect(covers(keyed(edited, 'rt:run'), river)).toBe(false);
      expect(covers(keyed(edited, 'rt:run'), street)).toBe(true);
      expect(keyed(edited, 'rt:span')).toEqual([]);
      // The view gets the run without that stretch, and hides the one that was all on it.
      const view = editor();
      const update = await view.update(edits, 1);
      const mesh = update.objects.find((object) => object.key === 'rt:run')?.mesh;
      expect(mesh?.indices.length).toBeGreaterThan(0);
      expect(update.objects.some((object) => object.key === 'rt:span')).toBe(false);
      expect(update.hidden).toContain('rt:span');
      expect(update.hidden).not.toContain('rt:run');
      // Put back, it goes back to the route as generated.
      const back = await view.update(emptyEdits(), 2);
      expect(back.objects).toContainEqual({ key: 'rt:run', part: 'routes', mesh: null });
      expect(back.hidden).not.toContain('rt:span');
    }
    // A bridge kept when its road goes, or only made narrower, still carries it.
    for (const kept of [{ [road]: { removed: true }, [bridge]: { removed: false } }, { [bridge]: { widthMm: 0.3 } }]) {
      const edited = routeSolids(await session.edited({ ...emptyEdits(), objects: kept }, DEFAULT_PALETTE));
      expect(covers(keyed(edited, 'rt:run'), river)).toBe(true);
      expect(keyed(edited, 'rt:span').length).toBeGreaterThan(0);
    }
  });
});
