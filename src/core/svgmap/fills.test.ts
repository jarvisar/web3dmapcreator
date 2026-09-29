import type { Paths64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import { areaMm2, linesOutside, makeFillTester, resolveSurfaces, toPath64, unionAll } from './fills';

const square = (x: number, y: number, s: number) =>
  toPath64([
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
  ]);

const empty = { buildings: [], decks: [], water: [], aeroways: [], rocks: [], sand: [], greens: [], waterGaps: [] };

// Disjoint when the union has the same area as the sum.
function disjoint(layers: Paths64[]) {
  const sum = layers.reduce((a, l) => a + areaMm2(l), 0);
  return Math.abs(areaMm2(unionAll(layers.flat())) - sum) < 1e-6;
}

describe('fills', () => {
  it('merges overlapping parts into one outline', () => {
    const merged = unionAll([square(0, 0, 10), square(5, 5, 10)]);
    expect(merged).toHaveLength(1);
    expect(areaMm2(merged)).toBeCloseTo(175, 9);
  });

  it('keeps a courtyard empty', () => {
    const outer = square(0, 0, 10);
    const hole = [...square(3, 3, 4)].reverse();
    expect(areaMm2(unionAll([outer, hole]))).toBeCloseTo(84, 9);
  });

  it('cuts a building standing in water out of it, with a gap', () => {
    const water = [square(0, 0, 50)];
    const building = [square(20, 20, 5)];
    const out = resolveSurfaces({ ...empty, water, buildings: building }, { waterHalo: 0.5 });
    // 25 mm2 of building plus a 0.5 mm band around it, corners rounded.
    const removed = 2500 - areaMm2(out.water);
    expect(removed).toBeGreaterThan(25 + 4 * 5 * 0.5);
    expect(removed).toBeLessThan(36);
    expect(disjoint([out.water, out.buildings])).toBe(true);
  });

  it('leaves water alone when nothing stands in it', () => {
    const out = resolveSurfaces({ ...empty, water: [square(0, 0, 10)], buildings: [square(20, 20, 5)] }, { waterHalo: 0.5 });
    expect(areaMm2(out.water)).toBeCloseTo(100, 9);
  });

  it('gives every piece of ground to at most one fill', () => {
    const out = resolveSurfaces(
      {
        ...empty,
        buildings: [square(10, 10, 10)],
        water: [square(0, 0, 30)],
        greens: [square(15, 15, 30)],
        sand: [square(25, 0, 10)],
        rocks: [square(28, 5, 10)],
      },
      { waterHalo: 0.2 },
    );
    expect(disjoint([out.buildings, out.water, out.greens, out.sand, out.rocks])).toBe(true);
  });

  it('trims lines that run inside a filled area', () => {
    const inside = linesOutside(
      [
        [
          [0, 5],
          [30, 5],
        ],
      ],
      [square(10, 0, 10)],
    );
    const total = inside.reduce((sum, p) => sum + Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), 0);
    expect(total).toBeCloseTo(20, 6);
  });

  it('tests points against filled ground', () => {
    const covered = makeFillTester([unionAll([square(0, 0, 10), [...square(3, 3, 4)].reverse()])])!;
    expect(covered([1, 1])).toBe(true);
    expect(covered([5, 5])).toBe(false);
    expect(covered([20, 20])).toBe(false);
  });
});
