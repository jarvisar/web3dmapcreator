import { describe, expect, it } from 'vitest';
import { makeShape, shapeContains } from '../layout/shapes';
import { boxCentres, nearestIn, rowSpan, rowsSpan } from './place';

describe('where a box fits', () => {
  it('finds the lowest a box can sit in a circle', () => {
    const circle = makeShape('circle', 0, 0, 100, 100);
    const region = boxCentres(circle, 60, 10);
    const lowest = Math.max(...region.map(([, y]) => y));
    // Bottom corners on the rim: half-width 30 at 40 below the centre.
    expect(lowest).toBeCloseTo(50 + 40 - 5, 2);
  });

  it('keeps every corner of the box inside a hexagon', () => {
    const hex = makeShape('hexagon', 0, 0, 120, 120 * (Math.sqrt(3) / 2));
    const region = boxCentres(hex, 40, 12);
    expect(region.length).toBeGreaterThan(3);
    for (const [x, y] of region) {
      for (const [dx, dy] of [
        [-20, -6],
        [20, -6],
        [-20, 6],
        [20, 6],
      ]) {
        expect(shapeContains(makeShape('hexagon', -1e-6, -1e-6, 120 + 2e-6, 120 * (Math.sqrt(3) / 2) + 2e-6), [x + dx, y + dy])).toBe(true);
      }
    }
  });

  it('has nowhere for a box wider than the shape', () => {
    expect(boxCentres(makeShape('circle', 0, 0, 50, 50), 51, 2)).toEqual([]);
  });

  it('still fits a box exactly as wide as a rectangle', () => {
    expect(boxCentres(makeShape('rect', 0, 0, 50, 20), 50, 20).length).toBeGreaterThan(0);
  });

  it('weights the distance to slide a wide box along an edge', () => {
    const square = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as [number, number][];
    expect(nearestIn(square, [5, 5])).toEqual([5, 5]);
    expect(nearestIn(square, [12, 14])).toEqual([10, 10]);
    const [x, y] = nearestIn(square, [12, 11], 1, 10)!;
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(10, 9);
  });
});

describe('row spans', () => {
  it('narrows towards the top and bottom of round shapes', () => {
    const circle = makeShape('circle', 0, 0, 100, 100);
    expect(rowSpan(circle, 50)).toEqual([0, 100]);
    const [a, b] = rowSpan(circle, 90)!;
    expect(b - a).toBeCloseTo(60, 9);
    expect(rowSpan(circle, 101)).toBeNull();
    // The narrower end wins.
    const [c, d] = rowsSpan(circle, 50, 90)!;
    expect(d - c).toBeCloseTo(60, 9);
  });

  it('follows a rounded rectangle into its corners', () => {
    const rounded = makeShape('rounded', 0, 0, 100, 50, 10);
    expect(rowSpan(rounded, 25)).toEqual([0, 100]);
    expect(rowSpan(rounded, 0)![0]).toBeCloseTo(10, 9);
  });
});
