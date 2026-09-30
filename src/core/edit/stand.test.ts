import { describe, expect, it } from 'vitest';
import { intersection, multiArea } from '../geometry/polygon';
import type { PrismSolid } from '../geometry/solid';
import type { MultiPolygon, Polygon } from '../types';
import { holdersOf, standPieces, type Holder } from './stand';

const square = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
];

describe('standPieces', () => {
  // A deck 40 mm long, its underside rising from the ground at x = 0 to 10 mm up at x = 40.
  const deck: PrismSolid = { kind: 'prism', role: 'bridge', polygon: square(0, -1, 40, 1), top: (x) => x / 4 + 1, bottom: (x) => x / 4, drape: 0, sub: 'deck' };

  it("doesn't hang a shape under a span because the deck comes down to the ground elsewhere", () => {
    const holders = holdersOf(deck, 'bridge');
    expect(holders.length).toBeGreaterThan(1);
    // A box on the ground under the high end, its base at 2 mm. Whole, the
    // deck's lowest underside was under that and held it up there.
    const high = standPieces([square(30, -3, 34, 3)], 2, 4, holders, [], 0.04);
    expect(high.every((p) => p.bottom === null && !p.held)).toBe(true);
    // Where the deck is under it, it stands on the deck.
    const low = standPieces([square(2, -3, 6, 3)], 2, 4, holders, [], 0.04);
    const held = low.filter((p) => p.held);
    expect(held.length).toBeGreaterThan(0);
    for (const piece of held) expect(piece.bottom!).toBeLessThan(2);
  });

  it("keeps a shape sunk into a deck above the deck's underside", () => {
    // Nearly level, so it stays whole. The shape's base is over the deck's
    // lowest underside, at x = 0, but under it where the shape is.
    const low: PrismSolid = { ...deck, top: (x) => 1.1 + x * 0.002, bottom: (x) => 0.5 + x * 0.002 };
    const holders = holdersOf(low, 'bridge');
    expect(holders).toHaveLength(1);
    const pieces = standPieces([square(10, -0.5, 12, 0.5)], 0.51, 9, holders, [], 0.04);
    const held = pieces.filter((p) => p.held);
    expect(held).toHaveLength(1);
    // Its underside under the piece reaches 0.524: set at its base it hung below the deck.
    expect(held[0].bottom!).toBeGreaterThanOrEqual(0.524 - 1e-9);
  });

  it('keeps a level deck whole', () => {
    const level: PrismSolid = { ...deck, top: () => 5, bottom: () => 4 };
    expect(holdersOf(level, 'bridge')).toHaveLength(1);
    // Buildings on a slope aren't cut up either.
    expect(holdersOf(deck, 'building')).toHaveLength(1);
  });

  it('splits a footprint among many overlapping holders without gaps or overlaps', () => {
    const footprint: MultiPolygon = [square(0, 0, 30, 30)];
    const holders: Holder[] = [];
    // A grid of overlapping flat roofs at different heights under the base.
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        const polygon = square(i * 2.5 - 1, j * 2.5 - 1, i * 2.5 + 2, j * 2.5 + 2);
        const top = ((i * 7 + j * 3) % 5) * 0.5;
        holders.push({ kind: 'building', polygon, box: [i * 2.5 - 1, j * 2.5 - 1, i * 2.5 + 2, j * 2.5 + 2], topAt: () => top, flat: top, bottom: -1 });
      }
    }
    const pieces = standPieces(footprint, 3, 5, holders, [], 0.04);
    const total = pieces.reduce((sum, p) => sum + multiArea(p.polygons), 0);
    expect(total).toBeCloseTo(900, 3);
    for (let a = 0; a < pieces.length; a++) {
      for (let b = a + 1; b < pieces.length; b++) expect(multiArea(intersection(pieces[a].polygons, pieces[b].polygons))).toBeLessThan(1e-6);
    }
    // Where roofs overlap, the higher one holds it.
    const at = (x: number, y: number) => pieces.find((p) => multiArea(intersection(p.polygons, [square(x - 0.01, y - 0.01, x + 0.01, y + 0.01)])) > 0)!;
    const tops = holders.filter((h) => h.box[0] < 1.6 && h.box[2] > 1.6 && h.box[1] < 1.6 && h.box[3] > 1.6).map((h) => h.flat!);
    expect(at(1.6, 1.6).bottom).toBeCloseTo(Math.max(...tops) - 0.04, 6);
  });
});
