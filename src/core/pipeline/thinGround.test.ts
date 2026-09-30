import { describe, expect, it } from 'vitest';
import { difference, intersection, multiArea, rectangle, union } from '../geometry/polygon';
import { cloneSettings } from '../settings';
import type { MultiPolygon, Polygon } from '../types';
import { settleThinGround, stripWidth, thinGround } from './thinGround';
import type { WaterBody } from './water';

// A 40 mm lake with its shore at y = -20 and y = 20.
const LAKE = rectangle(-20, -20, 20, 20);
// Mapped piers: a 0.2 mm one from the south shore, a T whose walkway is
// thin and whose head isn't, a wide one out in the water, and a quay
// overlapping the north shore by 0.1 mm.
const THIN_PIER = rectangle(-0.1, -20, 0.1, 0);
const WALKWAY = rectangle(9.9, -20, 10.1, -5);
const HEAD = rectangle(8, -5, 12, -3);
const WIDE_PIER = rectangle(5, 5, 8, 8);
const QUAY = rectangle(-20, 19.9, -5, 20);
const DECKS = union(THIN_PIER, WALKWAY, HEAD, WIDE_PIER, QUAY);
// Islands mapped as holes in the lake, 0.2 and 0.3 mm wide.
const NARROW_ISLAND = rectangle(-15, -10, -14.8, 10);
const ISLAND = rectangle(-12, -10, -11.7, 10);

function lake(): WaterBody[] {
  const polygon = difference(LAKE, union(NARROW_ISLAND, ISLAND))[0];
  return [{ polygon, kind: 'cut', bed: 1, top: 0.75, areaM2: 1e5 }];
}

function water(changes: Partial<ReturnType<typeof cloneSettings>['water']>) {
  return { ...cloneSettings().water, ...changes };
}

const near = (mp: MultiPolygon, box: MultiPolygon) => multiArea(intersection(mp, box));

describe('thinGround', () => {
  it('finds ground with water on both sides, not ground along a shore', () => {
    const open = difference(LAKE, DECKS);
    const thin = thinGround(open, 0.42);
    expect(near(thin, rectangle(-1, -21, 1, 1))).toBeCloseTo(4, 2);
    expect(near(thin, rectangle(9, -21, 11, -5))).toBeCloseTo(3, 2);
    expect(near(thin, HEAD)).toBeLessThan(0.01);
    expect(near(thin, WIDE_PIER)).toBe(0);
    expect(near(thin, rectangle(-21, 19, -4, 21))).toBe(0);
  });

  it('measures a strip by its width, however it bends', () => {
    expect(stripWidth(rectangle(0, 0, 10, 0.3)[0])).toBeCloseTo(0.3, 6);
    expect(stripWidth(rectangle(0, 0, 0.3, 0.3)[0])).toBeCloseTo(0.3, 6);
    const ell: Polygon = union(rectangle(0, 0, 10, 0.25), rectangle(0, 0, 0.25, 6))[0];
    expect(stripWidth(ell)).toBeCloseTo(0.25, 6);
  });
});

describe('settleThinGround', () => {
  it('leaves everything as it was with both off', () => {
    const bodies = lake();
    const result = settleThinGround(bodies, DECKS, water({}), 1);
    expect(result.bodies).toBe(bodies);
    expect(result.decks).toBe(DECKS);
  });

  it('fills thin piers and islands with water', () => {
    const result = settleThinGround(lake(), DECKS, water({ skipThinGround: true }), 1);
    expect(near(result.decks, THIN_PIER)).toBe(0);
    expect(near(result.decks, WALKWAY)).toBeLessThan(0.01);
    expect(near(result.decks, HEAD)).toBeCloseTo(8, 2);
    expect(near(result.decks, WIDE_PIER)).toBeCloseTo(9, 6);
    expect(near(result.decks, QUAY)).toBeCloseTo(1.5, 6);
    expect(result.bodies).toHaveLength(1);
    // Both islands are water now, and the lake has no holes left.
    expect(result.bodies[0].polygon).toHaveLength(1);
    expect(multiArea([result.bodies[0].polygon])).toBeCloseTo(1600, 1);
  });

  it('widens thin piers and islands into the water', () => {
    const result = settleThinGround(lake(), DECKS, water({ widenThinGround: true }), 1);
    // 0.42 wide, and 0.11 mm longer at its end.
    expect(near(result.decks, rectangle(-1, -21, 1, 1))).toBeCloseTo(0.42 * 20.11, 2);
    // Each island gets 0.11 or 0.06 mm of kept ground down both sides and round its ends.
    expect(near(result.decks, rectangle(-16, -11, -14.5, 11))).toBeCloseTo(0.42 * 20.22 - 0.2 * 20, 2);
    expect(near(result.decks, rectangle(-12.5, -11, -11.5, 11))).toBeCloseTo(0.42 * 20.12 - 0.3 * 20, 2);
    // The quay along the shore and the wide pier stay as mapped.
    expect(near(result.decks, rectangle(-21, 19, -4, 21))).toBeCloseTo(1.5, 6);
    expect(near(result.decks, rectangle(4, 4, 9, 9))).toBeCloseTo(9, 6);
    expect(result.bodies[0].polygon).toHaveLength(3);
    expect(thinGround(difference(union(...result.bodies.map((b) => [b.polygon])), result.decks), 0.4)).toEqual([]);
  });

  it('drops specks instead of widening them', () => {
    const post = rectangle(3, 3, 3.1, 3.12);
    const rock = rectangle(-3, 3, -2.8, 3.3);
    const polygon = difference(LAKE, rock)[0];
    const result = settleThinGround([{ polygon, kind: 'cut', bed: 1, top: 0.75, areaM2: 1e5 }], union(post, THIN_PIER), water({ widenThinGround: true }), 1);
    expect(near(result.decks, rectangle(2, 2, 4, 4))).toBe(0);
    expect(result.bodies[0].polygon).toHaveLength(1);
    expect(result.skipped).toBe(2);
    expect(result.widened).toBe(1);
    expect(near(result.decks, rectangle(-1, -21, 1, 1))).toBeCloseTo(0.42 * 20.11, 2);
  });

  it('drops slivers of mapping noise instead of widening them', () => {
    const sliver = rectangle(3, -10, 3.01, 5);
    const result = settleThinGround(lake(), union(sliver, THIN_PIER), water({ widenThinGround: true }), 1);
    expect(near(result.decks, rectangle(2, -11, 4, 6))).toBe(0);
  });

  it('widens fingers much thinner than the walkway they come off', () => {
    const walkway = rectangle(-0.175, -20, 0.175, 0);
    const fingers = Array.from({ length: 12 }, (_, i) => rectangle(0.175, -18 + i * 1.5, 1.5, -17.9 + i * 1.5));
    const decks = union(walkway, ...fingers);
    const result = settleThinGround([{ polygon: LAKE[0], kind: 'cut', bed: 1, top: 0.75, areaM2: 1e5 }], decks, water({ widenThinGround: true }), 1);
    expect(thinGround(difference(LAKE, result.decks), 0.4)).toEqual([]);
  });

  it('skips below one width and widens the rest to another', () => {
    const result = settleThinGround(lake(), DECKS, water({ skipThinGround: true, skipThinMm: 0.25, widenThinGround: true }), 1);
    expect(near(result.decks, THIN_PIER)).toBe(0);
    // The narrow island is water, and the other one is widened.
    expect(result.bodies[0].polygon).toHaveLength(2);
    expect(near(result.decks, rectangle(-16, -11, -14.5, 11))).toBe(0);
    expect(near(result.decks, rectangle(-12.5, -11, -11.5, 11))).toBeCloseTo(0.42 * 20.12 - 0.3 * 20, 2);
  });
});
