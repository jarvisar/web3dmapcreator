import { describe, expect, it } from 'vitest';
import { emptyEdits, type AddedShape, type ModelEdits } from '../../core/edit/types';
import { areaModelRing } from '../../core/geo/area';
import { Projection } from '../../core/geo/projection';
import { trackMarkers, trackModelLines } from '../../core/pipeline/tracks';
import { DEFAULT_AREA, type AreaSpec } from '../../core/settings';
import { encodePolyline } from '../../core/tracks/polyline';
import { decodeTrack, mergeTracks, SNAP_MARGIN_M, type Track } from '../../core/tracks/track';
import type { LonLat } from '../../core/types';
import { editsForArea, picksForArea, tracksForLink } from './linkScope';
import type { EditData } from './model';

// Chicago's Loop, and far away San Francisco.
const loop: AreaSpec = { ...DEFAULT_AREA, center: [-87.63, 41.88], widthM: 2000, heightM: 2000, rotationDeg: 0 };
const sf: [number, number] = [-122.41, 37.78];

function pin(id: string, at: [number, number], layer = 'buildings'): AddedShape {
  return { id, kind: 'pin', layer, at, points: [], rotationDeg: 0, sizeMm: 5, depthMm: 5, heightMm: 2, liftMm: 0, followGround: false, text: '', font: 'montserrat' };
}

const data: EditData = {
  editable: true,
  roads: { keys: ['r:wacker'] } as EditData['roads'],
  objects: { 'b:willis': { kind: 'building' } },
  ground: null,
  frame: { center: loop.center, rotationDeg: 0, mmPerMetre: 0.07, buildingMmPerMetre: 0.07 },
};

const edits: ModelEdits = {
  ...emptyEdits(),
  layers: [
    { id: 'race', name: 'Race', hex: '#FF0000', line: 'PLA Basic' },
    { id: 'commute', name: 'Commute', hex: '#0000FF', line: 'PLA Basic' },
  ],
  objects: {
    'b:willis': { heightM: 500 },
    'b:willis/top': { removed: true },
    'r:wacker': { layer: 'race' },
    'b:salesforce': { removed: true },
    't:f3,4': { removed: true },
  },
  shapes: [pin('here', [-87.632, 41.881]), pin('home', sf, 'commute')],
};

describe('what a share link carries', () => {
  it("carries this area's edits and shapes, and the layers they use", () => {
    const { edits: scoped, left, unplaced } = editsForArea(edits, loop, { data, trees: true }, 0.07);
    expect(Object.keys(scoped.objects).sort()).toEqual(['b:willis', 'b:willis/top', 'r:wacker', 't:f3,4']);
    expect(scoped.shapes.map((s) => s.id)).toEqual(['here']);
    expect(scoped.layers.map((l) => l.id)).toEqual(['race']);
    expect([left, unplaced]).toEqual([2, 0]);
  });

  it("leaves object edits out without a model of this area, and still carries its shapes", () => {
    for (const model of [null, { data: { ...data, frame: { ...data.frame!, center: sf } }, trees: true }]) {
      const { edits: scoped, unplaced } = editsForArea(edits, loop, model, 0.07);
      expect(scoped.objects).toEqual({});
      expect(scoped.shapes.map((s) => s.id)).toEqual(['here']);
      expect(unplaced).toBe(5);
    }
  });

  it('carries only the picked roads on the map, and routes that have some', () => {
    const near: [number, number][] = [[-87.631, 41.88], [-87.629, 41.88]];
    const far: [number, number][] = [sf, [sf[0] + 0.001, sf[1]]];
    const { picks, left } = picksForArea(
      {
        routes: [
          { id: 'a', name: 'Loop run', color: '#E4002B', width: 0.6, lines: [near, far] },
          { id: 'b', name: 'Home', color: '#0057B8', width: 0.6, lines: [far] },
        ],
        hiddenLines: [far, near],
      },
      loop,
    );
    expect(picks.routes.map((r) => [r.id, r.lines.length])).toEqual([['a', 1]]);
    expect(picks.hiddenLines).toEqual([near]);
    expect(left).toBe(3);
  });
});

// Metres east and north of the Loop's centre.
const metres = new Projection(loop.center, 0, 1);
const geo = (x: number, y: number): LonLat => metres.localToGeo(x, y);

describe('shapes in a share link', () => {
  const shape = (id: string, kind: AddedShape['kind'], at: LonLat, points: LonLat[] = [], size = 5, text = ''): AddedShape => ({ ...pin(id, at), kind, points, sizeMm: size, depthMm: size, text });
  const shared = (shapes: AddedShape[]) => editsForArea({ ...emptyEdits(), shapes }, loop, null, 0.07).edits.shapes.map((s) => s.id);

  it('carries a shape any of which is on the area, with no point on it', () => {
    // The area is 2 km across, and counts 100 m past its edges.
    const across = shape('across', 'path', geo(-3000, 0), [geo(-3000, 0), geo(3000, 0)]);
    const around = shape('around', 'area', geo(-5000, -5000), [geo(-5000, -5000), geo(5000, -5000), geo(5000, 5000), geo(-5000, 5000)]);
    // 50 mm is 714 m at 0.07 mm/m, so one centred 1.4 km out reaches 1,043 m.
    const beside = shape('beside', 'box', geo(1400, 0), [], 50);
    // 100 by 2 mm, reaching 714 m west of its centre.
    const long = { ...shape('long', 'box', geo(1700, 0), [], 100), depthMm: 2 };
    const wide = shape('wide', 'path', geo(-3000, 1150), [geo(-3000, 1150), geo(3000, 1150)], 10);
    expect(shared([across, around, beside, long, wide])).toEqual(['across', 'around', 'beside', 'long', 'wide']);
  });

  it('leaves out shapes that only come near it', () => {
    const past = shape('past', 'path', geo(-3000, 1500), [geo(-3000, 1500), geo(3000, 1500)]);
    const ring = shape('ring', 'area', geo(2000, 2000), [geo(2000, 2000), geo(4000, 2000), geo(4000, 4000), geo(2000, 4000)]);
    const box = shape('box', 'box', geo(3000, 0), [], 50);
    // The long box turned to run north and south.
    const turned = { ...shape('turned', 'box', geo(1700, 0), [], 100), depthMm: 2, rotationDeg: 90 };
    const label = shape('label', 'text', geo(3000, 0), [], 5, 'Home');
    const far = pin('far', sf);
    expect(shared([past, ring, box, turned, label, far])).toEqual([]);
  });
});

describe('routes in a share link', () => {
  const route = (id: string, points: LonLat[], visible = true): Track => ({ id, name: id, visible, lines: [encodePolyline(points)] });
  // From home 6 km west, along a wiggle through the Loop, to a finish on it.
  const homeRun = route('run', Array.from({ length: 326 }, (_, i) => geo(-6000 + i * 20, 300 * Math.sin(i / 35))));
  const inside = route('inside', [geo(-500, -500), geo(500, 500)]);
  const hidden = route('hidden', [geo(-500, 500), geo(500, -500)], false);

  it('leaves hidden routes out, and cuts the rest to the area and what generation reads past it', () => {
    const shared = tracksForLink([homeRun, hidden, inside], loop);
    expect(shared.map((t) => t.id)).toEqual(['run', 'inside']);
    expect(shared[1]).toBe(inside);
    const reach = 1000 + 100 + SNAP_MARGIN_M;
    const points = decodeTrack(shared[0]).flat();
    for (const [lon, lat] of points) {
      const [x, y] = metres.toModel(lon, lat);
      expect(Math.max(Math.abs(x), Math.abs(y))).toBeLessThan(reach + 1);
    }
    // Home isn't in it, and the finish is.
    expect(metres.toModel(...points[0])[0]).toBeCloseTo(-reach, 0);
    expect(points[points.length - 1]).toEqual(decodeTrack(homeRun)[0].at(-1));
  });

  it('builds the same route into the model as the whole one', () => {
    const [cut] = tracksForLink([homeRun], loop);
    const projection = new Projection(loop.center, 0, 0.07);
    const ctx = { projection, cropSet: [[areaModelRing(loop, 0.07)]] };
    const whole = { id: 'run', name: 'run', lines: decodeTrack(homeRun) };
    const shared = { id: 'run', name: 'run', lines: decodeTrack(cut) };
    const lines = trackModelLines(whole, ctx, [], false).lines;
    expect(trackModelLines(shared, ctx, [], false).lines).toEqual(lines);
    const markers = trackMarkers(whole, lines, ctx, 2.4);
    expect(markers).toHaveLength(1);
    expect(trackMarkers(shared, lines, ctx, 2.4)).toEqual(markers);
  });

  it('comes back to us as the route we already have', () => {
    const [cut] = tracksForLink([homeRun], loop);
    expect(mergeTracks([homeRun], [cut]).added).toBe(0);
    // Passed on under another id, the name still says it's ours.
    expect(mergeTracks([homeRun], [{ ...cut, id: 'other' }]).added).toBe(0);
    // A different route of that name isn't.
    expect(mergeTracks([homeRun], [{ ...inside, name: 'run' }]).added).toBe(1);
  });
});
