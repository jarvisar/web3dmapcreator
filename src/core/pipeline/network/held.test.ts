import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../types';
import { MINOR_ROAD_CLASSES } from '../linework';
import type { RoadPiece } from '../roads';
import { tidyNetwork, type NetworkInput } from '.';

let serial = 0;

function piece(roadClass: string, points: Vec2[], options: { oneway?: -1 | 0 | 1 } = {}): RoadPiece {
  const minor = MINOR_ROAD_CLASSES.has(roadClass);
  return {
    sourceId: `${roadClass}-${serial++}`,
    points,
    roadClass,
    subclass: '',
    widthM: 0,
    flags: new Set(),
    level: 0,
    oneway: options.oneway ?? 0,
    group: minor ? 'path' : 'road',
    widthMm: minor ? 0.45 : 0.7,
  };
}

function tidy(pieces: RoadPiece[], held: RoadPiece[] = [], input: Partial<NetworkInput> = {}) {
  const set = new Set(held);
  return tidyNetwork({
    pieces,
    leftOut: [],
    hidden: [],
    onEdge: () => false,
    isDeck: () => false,
    isHeld: (p) => set.has(p),
    gapMm: 0.4,
    removeDoubled: true,
    mergeDivided: true,
    joinEnds: true,
    removeFragments: true,
    ...input,
  }).pieces;
}

const of = (pieces: RoadPiece[], source: RoadPiece) => pieces.filter((p) => p.sourceId === source.sourceId);
// Some line runs along y = `y` somewhere between x0 and x1.
const onY = (pieces: RoadPiece[], y: number, x0: number, x1: number) =>
  pieces.some((p) =>
    p.points.some((a, i) => {
      const b = p.points[i + 1];
      return !!b && Math.abs(a[1] - y) < 1e-6 && Math.abs(b[1] - y) < 1e-6 && Math.max(a[0], b[0]) > x0 && Math.min(a[0], b[0]) < x1;
    }),
  );

// A divided street along the x axis, split at cross streets every 5 mm.
function dividedStreet() {
  const blocks = [0, 5, 10, 15];
  const east = blocks.map((x) => piece('secondary', [[x, 0], [x + 5, 0]], { oneway: 1 }));
  const west = blocks.map((x) => piece('secondary', [[x + 5, 1], [x, 1]], { oneway: 1 }));
  const cross = [0, 5, 10, 15, 20].flatMap((x) => [
    piece('residential', [[x, -5], [x, 0]]),
    piece('residential', [[x, 0], [x, 1]]),
    piece('residential', [[x, 1], [x, 6]]),
  ]);
  return { east, west, cross };
}

describe('held pieces in the tidy', () => {
  it('keeps a held carriageway and its twin where they are, and merges the rest of the street', () => {
    const { east, west, cross } = dividedStreet();
    const free = tidy([...east, ...west, ...cross]);
    expect(onY(free, 0.5, 6, 9)).toBe(true);

    const out = tidy([...east, ...west, ...cross], [east[1]]);
    expect(of(out, east[1]).map((p) => p.points)).toEqual([east[1].points]);
    // The other carriageway beside it stays, nothing runs down the middle there.
    expect(onY(out, 1, 6, 9)).toBe(true);
    expect(onY(out, 0.5, 6, 9)).toBe(false);
    // Blocks the route doesn't use are still merged.
    expect(onY(out, 0.5, 16, 19)).toBe(true);
  });

  it('keeps a held footway that doubles a street, and still drops one that isn\'t held', () => {
    const street = piece('primary', [[0, 0], [20, 0]]);
    const walk = piece('footway', [[0, 0.7], [20, 0.7]]);
    const other = piece('footway', [[0, -0.7], [20, -0.7]]);
    expect(of(tidy([street, walk, other]), walk)).toEqual([]);

    const out = tidy([street, walk, other], [walk]);
    expect(of(out, walk).map((p) => p.points)).toEqual([walk.points]);
    expect(of(out, other)).toEqual([]);
  });

  it('never moves a held end onto the road it nearly meets', () => {
    const street = piece('residential', [[0, 0], [20, 0]]);
    // Met a sidewalk that was left out, so the tidy would pull it onto the street.
    const path = piece('residential', [[10, 0.6], [10, 8]]);
    const leftOut: Vec2[][] = [[[9, 0.6], [11, 0.6]]];
    const joined = of(tidy([street, path], [], { leftOut }), path);
    expect(joined[0].points.length).toBe(3);

    const out = of(tidy([street, path], [path], { leftOut }), path);
    expect(out.map((p) => p.points)).toEqual([path.points]);
  });

  it('never prunes a held spur', () => {
    const street = piece('residential', [[0, 0], [20, 0]]);
    const spur = piece('residential', [[10, 0], [10, 0.5]]);
    const leftOut: Vec2[][] = [[[9, 0.5], [11, 0.5]]];
    expect(of(tidy([street, spur], [], { leftOut, joinEnds: false }), spur)).toEqual([]);
    expect(of(tidy([street, spur], [spur], { leftOut, joinEnds: false }), spur).map((p) => p.points)).toEqual([spur.points]);
  });

  it('gives the same network as before with nothing held', () => {
    const { east, west, cross } = dividedStreet();
    const pieces = [...east, ...west, ...cross];
    const without = tidyNetwork({ pieces, leftOut: [], hidden: [], onEdge: () => false, isDeck: () => false, gapMm: 0.4, removeDoubled: true, mergeDivided: true, joinEnds: true, removeFragments: true });
    expect(tidy(pieces)).toEqual(without.pieces);
  });
});
