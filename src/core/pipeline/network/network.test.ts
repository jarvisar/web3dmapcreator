import { describe, expect, it } from 'vitest';
import { Projection } from '../../geo/projection';
import { cloneSettings, type ModelSettings } from '../../settings';
import { HeightField } from '../../terrain/heightfield';
import type { Ring, Vec2 } from '../../types';
import { Progress, type Context } from '../context';
import { MINOR_ROAD_CLASSES, polylineLength } from '../linework';
import { bufferRoads, collectRoadPieces, type RoadPiece } from '../roads';
import type { SourceFeature } from '../source';
import { tidyNetwork, type NetworkInput } from '.';
import { gapStrips } from './gaps';

let serial = 0;

function piece(roadClass: string, points: Vec2[], options: { width?: number; flags?: string[] } = {}): RoadPiece {
  const minor = MINOR_ROAD_CLASSES.has(roadClass);
  return {
    sourceId: `${roadClass}-${serial++}`,
    points,
    roadClass,
    subclass: '',
    widthM: 0,
    flags: new Set(options.flags ?? []),
    level: 0,
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
    joinEnds: true,
    removeFragments: true,
    ...input,
  }).pieces;
}

const kept = (pieces: RoadPiece[], source: RoadPiece) => pieces.filter((p) => p.sourceId === source.sourceId);
const length = (pieces: RoadPiece[]) => pieces.reduce((sum, p) => sum + polylineLength(p.points), 0);
const reaches = (pieces: RoadPiece[], y: number) => pieces.some((p) => p.points.some((q) => Math.abs(q[1] - y) < 1e-6));

describe('tidyNetwork', () => {
  it('keeps one carriageway of a divided street, block after block', () => {
    // Carriageways 1 mm apart leave a 0.3 mm strip between 0.7 mm ribbons.
    const blocks = [0, 5, 10, 15];
    const north = blocks.map((x) => piece('secondary', [[x, 1], [x + 5, 1]]));
    const south = blocks.map((x) => piece('secondary', [[x, 0], [x + 5, 0]]));
    const cross = [0, 5, 10, 15, 20].map((x) => piece('residential', [[x, -5], [x, 0], [x, 1], [x, 6]]));
    const out = tidy([...south, ...north, ...cross]);
    const northKept = north.map((p) => kept(out, p).length);
    const southKept = south.map((p) => kept(out, p).length);
    // One side whole, the other gone: never hopping between them.
    expect([northKept, southKept]).toContainEqual([1, 1, 1, 1]);
    expect([northKept, southKept]).toContainEqual([0, 0, 0, 0]);
    // The kept one runs down the middle of the street, bending in at its ends.
    const middle = [...north, ...south].flatMap((p) => kept(out, p)).flatMap((p) => p.points).filter(([x]) => x > 4 && x < 16);
    for (const [, y] of middle) expect(y).toBeCloseTo(0.5, 6);
    for (const street of cross) expect(length(kept(out, street))).toBeGreaterThan(10.9);
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

  it('joins a path that stopped at a dropped sidewalk, but not a real dead end', () => {
    const street = piece('residential', [[0, 0], [20, 0]]);
    const path = piece('footway', [[10, 5], [10, 1]]);
    const deadEnd = piece('service', [[15, 5], [15, 1]], { width: 0.45 });
    // Too close to leave printable ground between them.
    const closeDeadEnd = piece('service', [[18, 5], [18, 0.8]], { width: 0.45 });
    const out = tidy([street, path, deadEnd, closeDeadEnd], { leftOut: [[[0, 1], [12, 1]]] });
    expect(reaches(kept(out, path), 0)).toBe(true);
    expect(reaches(kept(out, deadEnd), 0)).toBe(false);
    expect(reaches(kept(out, closeDeadEnd), 0)).toBe(true);
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

  it('moves the kept carriageway of a divided stretch onto the middle of the street', () => {
    const before = piece('primary', [[0, 0], [0, 10]]);
    const west = piece('primary', [[0, 10], [-0.5, 11], [-0.5, 19], [0, 20]]);
    const east = piece('primary', [[0, 10], [0.5, 11], [0.5, 19], [0, 20]]);
    const after = piece('primary', [[0, 20], [0, 30]]);
    const out = tidy([before, west, east, after]);
    const kept = [...out.filter((p) => p.sourceId === west.sourceId || p.sourceId === east.sourceId)];
    expect(kept).toHaveLength(1);
    const points = kept[0].points;
    for (const [x, y] of points) if (y > 13 && y < 17) expect(Math.abs(x)).toBeLessThan(0.02);
    // Bends in no steeper than the taper.
    for (let k = 1; k < points.length; k++) {
      expect(Math.abs(points[k][0] - points[k - 1][0])).toBeLessThanOrEqual(Math.abs(points[k][1] - points[k - 1][1]) / 3 + 0.26);
    }
  });

  it("doesn't pull a service road towards a parking aisle beside it", () => {
    const road = piece('service', [[0, 0], [20, 0]], { width: 0.45 });
    const aisle = { ...piece('service', [[0, 0.7], [20, 0.7]], { width: 0.45 }), subclass: 'parking_aisle' };
    const out = tidy([road, aisle]);
    for (const [, y] of kept(out, road).flatMap((p) => p.points)) expect(y).toBe(0);
  });

  it('changes nothing with every step off', () => {
    const pieces = [piece('residential', [[0, 0], [20, 0]]), piece('residential', [[0, 1], [20, 1]]), piece('steps', [[30, 0], [30.5, 0]])];
    const out = tidy(pieces, { removeDoubled: false, joinEnds: false, removeFragments: false });
    expect(out.map((p) => p.points)).toEqual(pieces.map((p) => p.points));
  });
});

describe('gapStrips', () => {
  it('fills ground too thin to print between two roads side by side', () => {
    // 1 mm apart, 0.7 mm wide: 0.3 mm of ground between them.
    const strips = gapStrips([piece('residential', [[0, 0], [10, 0]]), piece('residential', [[0, 1], [10, 1]])], 0.4);
    expect(strips.road).toHaveLength(1);
    const ys = strips.road[0][0].map(([, y]) => y);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(1, 6);
  });

  it('leaves printable gaps and crossing streets alone', () => {
    expect(gapStrips([piece('residential', [[0, 0], [10, 0]]), piece('residential', [[0, 1.2], [10, 1.2]])], 0.4).road).toHaveLength(0);
    expect(gapStrips([piece('residential', [[0, 0], [10, 0]]), piece('residential', [[5, -5], [5, 5]])], 0.4).road).toHaveLength(0);
  });

  it('gives a gap between a street and a path to the street', () => {
    const strips = gapStrips([piece('footway', [[0, 0.9], [10, 0.9]]), piece('residential', [[0, 0], [10, 0]])], 0.4);
    expect(strips.road).toHaveLength(1);
    expect(strips.path).toHaveLength(0);
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

  it('prints two roads with a hairline between them as one', async () => {
    const pieces = [piece('residential', [[-10, 0], [10, 0]]), piece('residential', [[-10, 1], [10, 1]])];
    const filled = await bufferRoads(pieces, context());
    const apart = await bufferRoads(pieces, context((s) => (s.roads.fillGaps = false)));
    expect(filled.road).toHaveLength(1);
    expect(apart.road).toHaveLength(2);
  });
});
