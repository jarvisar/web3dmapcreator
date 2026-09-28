import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../types';
import { rowCrossings } from './scanline';

// Deterministic pseudo-random numbers, so a failure reproduces.
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// The plain one-row scan rowCrossings has to agree with.
function lineCrossings(rings: Vec2[][], y: number): number[] {
  const xs: number[] = [];
  for (const ring of rings) {
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
  }
  return xs.sort((a, b) => a - b);
}

describe('rowCrossings', () => {
  it('counts a vertex on the row once', () => {
    const diamond: Vec2[][] = [[[0, -1], [1, 0], [0, 1], [-1, 0]]];
    expect(rowCrossings(diamond, 0, 1, 0, 1)).toEqual([[-1, 1]]);
  });

  it('matches the per-row scan on random rings, including vertices on the rows', () => {
    const next = random(7);
    for (let trial = 0; trial < 50; trial++) {
      const rings: Vec2[][] = [];
      for (let r = 0; r < 3; r++) {
        const ring: Vec2[] = [];
        const n = 3 + Math.floor(next() * 40);
        for (let i = 0; i < n; i++) {
          // Half of the vertices snap to the row grid, the awkward case.
          const y = next() < 0.5 ? Math.round(next() * 40) * 0.5 : next() * 20;
          ring.push([next() * 20, y]);
        }
        rings.push(ring);
      }
      const rows = rowCrossings(rings, 0, 0.5, 0, 41);
      for (let i = 0; i < 41; i++) {
        const expected = lineCrossings(rings, i * 0.5);
        expect(rows[i].length).toBe(expected.length);
        rows[i].forEach((x, k) => expect(x).toBeCloseTo(expected[k], 9));
      }
    }
  });

  it('handles a window of rows starting inside the polygon', () => {
    const square: Vec2[][] = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
    const rows = rowCrossings(square, 0, 1, 3, 4);
    expect(rows).toEqual([[0, 10], [0, 10], [0, 10], [0, 10]]);
  });
});
