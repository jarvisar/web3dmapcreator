import { describe, expect, it } from 'vitest';
import { HeightField, interiorPoints, lineCrossings } from './heightfield';

describe('HeightField', () => {
  it('samples bilinearly and clamps outside the grid', () => {
    const field = HeightField.build([0, 0, 10, 10], 10, (x, y) => x + 2 * y);
    expect(field.cols).toBe(11);
    expect(field.heightAt(3.5, 2.25)).toBeCloseTo(3.5 + 4.5, 9);
    expect(field.heightAt(-5, 0)).toBeCloseTo(0, 9);
    expect(field.heightAt(50, 10)).toBeCloseTo(30, 9);
  });

  it('keeps square cells and centres the grid on the bounds', () => {
    const field = HeightField.build([0, 0, 100, 37], 20, () => 0);
    expect(field.step).toBeCloseTo(5);
    expect(field.minX).toBeCloseTo(0);
    expect(field.maxY).toBeGreaterThanOrEqual(37);
    expect((field.minY + field.maxY) / 2).toBeCloseTo(18.5);
  });

  it('smooths with a clipped box mean', () => {
    const field = HeightField.build([0, 0, 4, 4], 4, (x, y) => (x === 2 && y === 2 ? 9 : 0));
    field.smooth(1);
    expect(field.heightAt(2, 2)).toBeCloseTo(1);
    expect(field.heightAt(1, 1)).toBeCloseTo(1);
    expect(field.heightAt(0, 0)).toBeCloseTo(0);
    // The total is kept away from the edges.
    let sum = 0;
    for (const v of field.values) sum += v;
    expect(sum).toBeCloseTo(9);
  });

  it('finds the nodes inside a polygon with holes and flattens them', () => {
    const field = HeightField.build([0, 0, 10, 10], 10, () => 5);
    const polygon = [
      [[1.5, 1.5], [8.5, 1.5], [8.5, 8.5], [1.5, 8.5]] as [number, number][],
      [[3.5, 3.5], [3.5, 6.5], [6.5, 6.5], [6.5, 3.5]] as [number, number][],
    ];
    const nodes = field.nodesInside(polygon);
    expect(nodes.length).toBe(7 * 7 - 3 * 3);
    expect(field.flattenInside(polygon, 2)).toBe(40);
    expect(field.heightAt(2, 2)).toBe(2);
    expect(field.heightAt(5, 5)).toBe(5);
    // Lowering only by default: a higher level changes nothing.
    expect(field.flattenInside(polygon, 3)).toBe(0);
    expect(field.flattenInside(polygon, 3, true)).toBe(40);
  });

  it('computes medians and extremes over points', () => {
    const field = HeightField.build([0, 0, 10, 10], 10, (x) => x);
    const points: [number, number][] = [[1, 0], [2, 0], [9, 0], [4, 0], [5, 0]];
    expect(field.percentileOver(points, 0.5)).toBe(4);
    expect(field.minOver(points)).toBe(1);
    expect(field.maxOver(points)).toBe(9);
  });
});

describe('scanline helpers', () => {
  it('counts a vertex on the scanline once', () => {
    const diamond = [[[0, -1], [1, 0], [0, 1], [-1, 0]] as [number, number][]];
    expect(lineCrossings(diamond, 0)).toEqual([-1, 1]);
  });

  it('places interior points on a regular grid', () => {
    const square = [[[0, 0], [4, 0], [4, 4], [0, 4]] as [number, number][]];
    expect(interiorPoints(square, 1)).toHaveLength(16);
    expect(interiorPoints(square, 1, 5)).toHaveLength(5);
  });
});
