import { describe, expect, it } from 'vitest';
import { Projection } from '../../geo/projection';
import { multiArea } from '../../geometry/polygon';
import { cloneSettings, type ModelSettings } from '../../settings';
import { HeightField } from '../../terrain/heightfield';
import type { Polygon, Ring, Vec2 } from '../../types';
import { Progress, type Context } from '../context';
import { MINOR_ROAD_CLASSES, polylineLength } from '../linework';
import { bufferRoads, collectRoadPieces, type RoadPiece } from '../roads';
import type { SourceFeature } from '../source';
import { tidyNetwork, type NetworkInput } from '.';
import { fillThinHoles, gapStrips } from './gaps';

let serial = 0;

function piece(roadClass: string, points: Vec2[], options: { width?: number; flags?: string[]; oneway?: -1 | 0 | 1; subclass?: string } = {}): RoadPiece {
  const minor = MINOR_ROAD_CLASSES.has(roadClass);
  return {
    sourceId: `${roadClass}-${serial++}`,
    points,
    roadClass,
    subclass: options.subclass ?? '',
    widthM: 0,
    flags: new Set(options.flags ?? []),
    level: 0,
    oneway: options.oneway ?? 0,
    group: roadClass === 'rail' ? 'rail' : minor ? 'path' : 'road',
    widthMm: options.width ?? (minor ? 0.45 : 0.7),
  };
}

function tidy(pieces: RoadPiece[], input: Partial<NetworkInput> = {}) {
  return tidyNetwork({
    pieces,
    leftOut: [],
    hidden: [],
    onEdge: () => false,
    isDeck: (p) => p.flags.has('is_bridge'),
    gapMm: 0.4,
    removeDoubled: true,
    mergeDivided: true,
    joinEnds: true,
    removeFragments: true,
    ...input,
  }).pieces;
}

const kept = (pieces: RoadPiece[], source: RoadPiece) => pieces.filter((p) => p.sourceId === source.sourceId);
const length = (pieces: RoadPiece[]) => pieces.reduce((sum, p) => sum + polylineLength(p.points), 0);
const reaches = (pieces: RoadPiece[], y: number) => pieces.some((p) => p.points.some((q) => Math.abs(q[1] - y) < 1e-6));

// A divided street along the x axis, eastbound at y = 0 and westbound at
// y = 1, split at cross streets every 5 mm. 0.3 mm of ground between 0.7 mm
// ribbons.
function dividedStreet(oneway: -1 | 0 | 1 = 1) {
  const blocks = [0, 5, 10, 15];
  const east = blocks.map((x) => piece('secondary', [[x, 0], [x + 5, 0]], { oneway }));
  const west = blocks.map((x) => piece('secondary', [[x + 5, 1], [x, 1]], { oneway }));
  const cross = [0, 5, 10, 15, 20].flatMap((x) => [
    piece('residential', [[x, -5], [x, 0]]),
    piece('residential', [[x, 0], [x, 1]]),
    piece('residential', [[x, 1], [x, 6]]),
  ]);
  return { east, west, cross };
}

describe('tidyNetwork', () => {
  it('merges a divided street onto the middle of the street, straight through its junctions', () => {
    const { east, west, cross } = dividedStreet();
    const out = tidy([...east, ...west, ...cross]);
    const road = out.filter((p) => p.roadClass === 'secondary');
    for (const p of road) for (const [, y] of p.points) expect(y).toBeCloseTo(0.5, 6);
    expect(length(road)).toBeCloseTo(20, 6);
    // Of the two carriageways only one is left.
    expect([east, west].map((side) => side.flatMap((p) => kept(out, p)).length).sort()).toEqual([0, 4]);
    // Cross streets stay straight and still cross it: the stub across the
    // median shrinks away and each side meets the middle.
    for (const x of [0, 5, 10, 15, 20]) {
      const street = out.filter((p) => p.roadClass === 'residential' && p.points.some(([px]) => Math.abs(px - x) < 1e-9));
      for (const p of street) for (const [px] of p.points) expect(px).toBeCloseTo(x, 9);
      expect(length(street)).toBeCloseTo(11, 6);
      expect(reaches(street, 0.5)).toBe(true);
    }
  });

  it('leaves two-way streets side by side as they are', () => {
    const { east, west, cross } = dividedStreet(0);
    const out = tidy([...east, ...west, ...cross]);
    for (const p of [...east, ...west]) expect(kept(out, p).map((q) => q.points)).toEqual([p.points]);
  });

  it("doesn't merge three carriageways", () => {
    const a = piece('primary', [[0, 0], [20, 0]], { oneway: 1 });
    const b = piece('primary', [[20, 1], [0, 1]], { oneway: 1 });
    const c = piece('primary', [[0, 2], [20, 2]], { oneway: 1 });
    const out = tidy([a, b, c]);
    for (const p of [a, b, c]) expect(kept(out, p).map((q) => q.points)).toEqual([p.points]);
  });

  it('runs the merged line of a divided stretch to the forks either end', () => {
    const before = piece('primary', [[0, 0], [0, 10]]);
    const west = piece('primary', [[0, 10], [-0.5, 11], [-0.5, 19], [0, 20]], { oneway: 1 });
    const east = piece('primary', [[0, 20], [0.5, 19], [0.5, 11], [0, 10]], { oneway: 1 });
    const after = piece('primary', [[0, 20], [0, 30]]);
    const out = tidy([before, west, east, after]);
    const merged = [...kept(out, west), ...kept(out, east)];
    expect(merged).toHaveLength(1);
    for (const [x] of merged[0].points) expect(Math.abs(x)).toBeLessThan(1e-9);
    expect(merged[0].points[0][1]).toBeCloseTo(merged[0].points[0][1] < 15 ? 10 : 20, 9);
    expect(length(merged)).toBeCloseTo(10, 6);
  });

  it('slides a street meeting a divided road at an angle along itself to the middle', () => {
    const east = piece('primary', [[0, 0], [20, 0]], { oneway: 1 });
    const west = piece('primary', [[20, 1], [0, 1]], { oneway: 1 });
    // Meets the northern carriageway at 45 degrees.
    const side = piece('residential', [[15, 6], [10, 1]]);
    const out = tidy([east, west, side]);
    const [street] = kept(out, side);
    const [x, y] = street.points[street.points.length - 1];
    expect(y).toBeCloseTo(0.5, 6);
    expect(x).toBeCloseTo(9.5, 6);
    // Still one straight line.
    expect(street.points).toHaveLength(2);
  });

  it("keeps a service road the merge moves away from, even if it doubled one carriageway", () => {
    const east = piece('secondary', [[0, 0], [20, 0]], { oneway: 1 });
    const west = piece('secondary', [[20, 1], [0, 1]], { oneway: 1 });
    // 0.75 mm from the eastbound carriageway: too close to print apart, but
    // 1.25 mm from the middle.
    const alley = piece('service', [[0, -0.75], [20, -0.75]], { width: 0.45 });
    const out = tidy([east, west, alley]);
    expect(length(kept(out, alley))).toBeCloseTo(20, 6);
  });

  it('keeps the tracks of a rail yard, however close', () => {
    const tracks = [0, 0.3, 0.6, 0.9, 1.2].map((y) => piece('rail', [[0, y], [20, y]], { width: 0.45 }));
    const out = tidy(tracks);
    for (const track of tracks) expect(length(kept(out, track))).toBeCloseTo(20, 6);
  });

  it('drops a footway beside a street and joins the part that turns into the park', () => {
    const street = piece('residential', [[0, 0], [20, 0]]);
    const footway = piece('footway', [[2, 0.7], [12, 0.7], [12, 6]]);
    const out = tidy([street, footway], { leftOut: [[[2, 0.7], [2, -0.7]]] });
    const left = kept(out, footway);
    expect(left.some((p) => p.points.some(([x, y]) => x < 11 && Math.abs(y - 0.7) < 1e-6))).toBe(false);
    expect(length(left)).toBeCloseTo(6, 1);
    expect(reaches(left, 0)).toBe(true);
  });

  it('drops a tram running in the street', () => {
    const street = piece('secondary', [[0, 0], [20, 0]]);
    const tram = piece('rail', [[0, 0.1], [20, 0.1]], { width: 0.45 });
    expect(kept(tidy([street, tram]), tram)).toHaveLength(0);
  });

  it('keeps a street whole where it only briefly runs beside a bigger road', () => {
    const primary = piece('primary', [[0, 0], [30, 0]]);
    const street = piece('residential', [[0, 5], [10, 5], [12, 0.9], [16, 0.9], [18, 5], [30, 5]]);
    const out = tidy([primary, street]);
    expect(length(kept(out, street))).toBeCloseTo(polylineLength(street.points), 6);
  });

  it('removes a speck touching nothing but keeps a longer isolated path', () => {
    const steps = piece('steps', [[0, 0], [0.8, 0]]);
    const footway = piece('footway', [[10, 0], [13, 0]]);
    const out = tidy([steps, footway], { leftOut: [[[0, -1], [0, 1]], [[0.8, -1], [0.8, 1]]] });
    expect(kept(out, steps)).toHaveLength(0);
    expect(length(kept(out, footway))).toBeCloseTo(3, 6);
  });

  it('removes kerb stubs and nubs but keeps real dead ends', () => {
    const street = piece('residential', [[0, 0], [20, 0]]);
    // Its loose end met a sidewalk that was left out.
    const stub = piece('footway', [[5, 0], [5, 0.9]]);
    const driveway = piece('service', [[10, 0], [10, 1.2]], { width: 0.45 });
    const nub = piece('service', [[15, 0], [15, 0.6]], { width: 0.45 });
    const out = tidy([street, stub, driveway, nub], { leftOut: [[[0, 0.9], [20, 0.9]]] });
    expect(kept(out, stub)).toHaveLength(0);
    expect(length(kept(out, driveway))).toBeCloseTo(1.2, 6);
    expect(kept(out, nub)).toHaveLength(0);
    expect(length(kept(out, street))).toBeCloseTo(20, 6);
  });

  it('carries a path that stopped at a dropped sidewalk straight on to the street, but not a real dead end', () => {
    const street = piece('residential', [[0, 0], [20, 0]]);
    const path = piece('footway', [[10, 5], [10, 1]]);
    const deadEnd = piece('service', [[15, 5], [15, 1]], { width: 0.45 });
    // Too close to leave printable ground between them.
    const closeDeadEnd = piece('service', [[18, 5], [18, 0.8]], { width: 0.45 });
    const out = tidy([street, path, deadEnd, closeDeadEnd], { leftOut: [[[0, 1], [12, 1]]] });
    const [joined] = kept(out, path);
    expect(joined.points[joined.points.length - 1]).toEqual([10, 0]);
    expect(reaches(kept(out, deadEnd), 0)).toBe(false);
    expect(reaches(kept(out, closeDeadEnd), 0)).toBe(true);
  });

  it("doesn't bend a path running alongside a street into it", () => {
    const street = piece('residential', [[0, 0], [20, 0]]);
    // Its end met a sidewalk that was left out, running beside the street.
    const path = piece('footway', [[10, 6], [10, 2], [4, 1.3]]);
    const out = tidy([street, path], { leftOut: [[[4, 1.3], [4, 3]]] });
    for (const p of kept(out, path)) for (const [, y] of p.points) expect(y).toBeGreaterThan(1.2);
  });

  it("doesn't pull a path ending at a tunnel onto the street", () => {
    const street = piece('residential', [[0, 0], [20, 0]]);
    const path = piece('footway', [[10, 5], [10, 1]]);
    const out = tidy([street, path], { hidden: [[[10, 1], [10, -3]]] });
    expect(reaches(kept(out, path), 0)).toBe(false);
    expect(length(kept(out, path))).toBeCloseTo(4, 6);
  });

  it('never prunes a line cut by the edge of the model', () => {
    const scrap = piece('footway', [[0, 0], [0.5, 0]]);
    const out = tidy([scrap], { onEdge: ([x]) => x <= 0 });
    expect(length(kept(out, scrap))).toBeCloseTo(0.5, 6);
  });

  it('keeps a bridge deck over the road it runs along', () => {
    const street = piece('residential', [[0, 0], [20, 0]]);
    const deck = piece('residential', [[0, 0.5], [20, 0.5]], { flags: ['is_bridge'] });
    const out = tidy([street, deck]);
    expect(length(kept(out, deck))).toBeCloseTo(20, 6);
    expect(length(kept(out, street))).toBeCloseTo(20, 6);
  });

  it('removes a flight of steps lying inside a road', () => {
    const street = piece('residential', [[0, 0], [10, 0]]);
    const steps = piece('steps', [[4, 0.1], [4.5, 0.1]]);
    const out = tidy([street, steps]);
    expect(kept(out, steps)).toHaveLength(0);
  });

  it("doesn't touch parking aisles beside a service road", () => {
    const road = piece('service', [[0, 0], [20, 0]], { width: 0.45, oneway: 1 });
    const aisle = piece('service', [[20, 0.7], [0, 0.7]], { width: 0.45, oneway: 1, subclass: 'parking_aisle' });
    const out = tidy([road, aisle]);
    expect(kept(out, road).map((p) => p.points)).toEqual([road.points]);
    expect(kept(out, aisle).map((p) => p.points)).toEqual([aisle.points]);
  });

  it('changes nothing with every step off', () => {
    const { east, west } = dividedStreet();
    const pieces = [...east, ...west, piece('steps', [[30, 0], [30.5, 0]])];
    const out = tidy(pieces, { removeDoubled: false, mergeDivided: false, joinEnds: false, removeFragments: false });
    expect(out.map((p) => p.points)).toEqual(pieces.map((p) => p.points));
  });
});

describe('gapStrips', () => {
  it('fills a crack between two roads side by side', () => {
    // 0.85 mm apart, 0.7 mm wide: 0.15 mm of ground between them.
    const strips = gapStrips([piece('residential', [[0, 0], [10, 0]]), piece('residential', [[0, 0.85], [10, 0.85]])], 0.4);
    expect(strips.road).toHaveLength(1);
    const ys = strips.road[0][0].map(([, y]) => y);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(0.85, 6);
  });

  it('leaves a groove the nozzle can print, even under the minimum gap', () => {
    // 0.3 mm of ground: two roads, not one block.
    expect(gapStrips([piece('residential', [[0, 0], [10, 0]]), piece('residential', [[0, 1], [10, 1]])], 0.4).road).toHaveLength(0);
  });

  it('carries a strip on while the crack stays close to the limit', () => {
    // 0.15 mm of ground, then 0.23 mm: one strip the whole way, not a stub.
    const strips = gapStrips([piece('residential', [[0, 0], [10, 0]]), piece('residential', [[0, 0.85], [5, 0.85], [5.2, 0.93], [10, 0.93]])], 0.4);
    expect(strips.road).toHaveLength(1);
    const xs = strips.road[0][0].map(([x]) => x);
    expect(Math.min(...xs)).toBeLessThan(0.3);
    expect(Math.max(...xs)).toBeGreaterThan(9.7);
  });

  it('leaves printable gaps and crossing streets alone', () => {
    expect(gapStrips([piece('residential', [[0, 0], [10, 0]]), piece('residential', [[0, 1.2], [10, 1.2]])], 0.4).road).toHaveLength(0);
    expect(gapStrips([piece('residential', [[0, 0], [10, 0]]), piece('residential', [[5, -5], [5, 5]])], 0.4).road).toHaveLength(0);
  });

  it("doesn't fill between tracks", () => {
    const strips = gapStrips([piece('rail', [[0, 0], [10, 0]], { width: 0.45 }), piece('rail', [[0, 0.55], [10, 0.55]], { width: 0.45 })], 0.4);
    expect(strips.rail).toHaveLength(0);
  });

  it("doesn't fill between colours", () => {
    const strips = gapStrips([piece('footway', [[0, 0.7], [10, 0.7]]), piece('residential', [[0, 0], [10, 0]])], 0.4);
    expect(strips.path).toHaveLength(0);
    expect(strips.road).toHaveLength(0);
  });
});

describe('fillThinHoles', () => {
  const square = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const hole = (x0: number, y0: number, x1: number, y1: number): Ring => [...square(x0, y0, x1, y1)].reverse();

  it('fills enclosed ground too thin to print anywhere, and keeps a block', () => {
    const polygon: Polygon = [square(0, 0, 20, 10), hole(1, 1, 10, 1.15), hole(12, 2, 18, 8)];
    const { polygons, filled } = fillThinHoles([polygon], 0.4);
    expect(filled).toBe(1);
    expect(polygons[0]).toHaveLength(2);
    expect(multiArea(polygons)).toBeCloseTo(200 - 36, 6);
  });
});

describe('collectRoadPieces', () => {
  const HALF = 30;
  const CROP: Ring = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]];

  function context(patch?: (settings: ModelSettings) => void): Context {
    const settings = cloneSettings();
    patch?.(settings);
    return {
      settings,
      projection: new Projection([0.01, 45], 0, settings.scale.mmPerMetre),
      crop: [CROP],
      cropSet: [[CROP]],
      cropBox: [-HALF, -HALF, HALF, HALF],
      bounds: { west: 0, south: 44.99, east: 0.02, north: 45.01 },
      heightfield: HeightField.flat([-HALF - 2, -HALF - 2, HALF + 2, HALF + 2], 64, 0),
      stats: {},
      warnings: [],
      progress: new Progress(),
    };
  }

  const segment = (ctx: Context, id: string, props: Record<string, unknown>, points: Vec2[]): SourceFeature => ({
    id,
    props: { subtype: 'road', ...props },
    geometry: { type: 'LineString', coordinates: points.map(([x, y]) => ctx.projection.modelToGeo(x, y)) },
  });

  function features(ctx: Context) {
    return [
      segment(ctx, 'street', { class: 'residential' }, [[-20, 0], [20, 0]]),
      segment(ctx, 'sidewalk', { class: 'footway', subclass: 'sidewalk' }, [[-20, 5], [20, 5]]),
      segment(ctx, 'steps', { class: 'steps' }, [[0, 5], [0, 5.8]]),
      segment(ctx, 'corridor', { class: 'footway', road_flags: [{ values: ['is_indoor'] }] }, [[10, 10], [10, 20]]),
    ];
  }

  it('leaves out scraps and indoor corridors', async () => {
    const ctx = context();
    const { pieces } = await collectRoadPieces(features(ctx), ctx);
    expect(pieces.map((p) => p.sourceId)).toEqual(['street']);
    expect(ctx.stats.skipped_indoor).toBe(1);
  });

  it('keeps every piece with the tidy off', async () => {
    const ctx = context((s) => (s.roads.tidy = false));
    const { pieces } = await collectRoadPieces(features(ctx), ctx);
    expect(pieces.map((p) => p.sourceId)).toEqual(['street', 'steps']);
  });

  it('merges a divided road mapped as two one-way segments', async () => {
    const ctx = context();
    const oneway = { access_restrictions: [{ access_type: 'denied', when: { heading: 'backward' } }] };
    const { pieces } = await collectRoadPieces(
      [segment(ctx, 'east', { class: 'primary', ...oneway }, [[-20, 0], [20, 0]]), segment(ctx, 'west', { class: 'primary', ...oneway }, [[20, 1], [-20, 1]])],
      ctx,
    );
    expect(pieces).toHaveLength(1);
    for (const [, y] of pieces[0].points) expect(y).toBeCloseTo(0.5, 3);
  });

  it('prints two roads with a hairline between them as one', async () => {
    const pieces = [piece('residential', [[-10, 0], [10, 0]]), piece('residential', [[-10, 0.85], [10, 0.85]])];
    const filled = await bufferRoads(pieces, context());
    const apart = await bufferRoads(pieces, context((s) => (s.roads.fillGaps = false)));
    expect(filled.road).toHaveLength(1);
    expect(apart.road).toHaveLength(2);
  });
});
