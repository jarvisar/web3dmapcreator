import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../types';
import { hullRing, minimumAreaRectangle, orientation, pyDist } from './geos';
import { longAxis, pyMod } from './shapes';
import cases from './testdata/rectangles.json';

// Shapely 2.1.2 (GEOS 3.13.1) on Python 3.11.5: minimum_rotated_rectangle
// corners, math.dist of each side, and the long axis the add-on takes.
// Rotated rectangles with noise (opposite sides a few ulps apart), random
// star polygons and Chicago footprints.
describe('GEOS minimum rotated rectangle', () => {
  it('has the same corners, to the bit, as Shapely', () => {
    for (const c of cases) expect(minimumAreaRectangle(c.ring as Vec2[])).toEqual(c.corners);
  });

  it('measures sides like math.dist, which Math.hypot does not', () => {
    let hypotAgrees = 0;
    for (const c of cases) {
      c.corners.forEach((p, i) => {
        const q = c.corners[(i + 1) % 4];
        expect(pyDist(p as Vec2, q as Vec2)).toBe(c.dists[i]);
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) === c.dists[i]) hypotAgrees++;
      });
    }
    expect(hypotAgrees).toBeLessThan(cases.length * 4);
  });

  it('picks the same long side, within an ulp of atan2', () => {
    for (const c of cases) expect(longAxis([[c.ring as Vec2[]]])).toBeCloseTo(c.angle, 14);
  });

  it('traces the hull clockwise from the lowest point, without collinear vertices', () => {
    const ring = hullRing([[0, 0], [2, 0], [4, 0], [4, 3], [2, 1], [0, 3], [0, 1.5]]);
    expect(ring).toEqual([[0, 0], [0, 3], [4, 3], [4, 0], [0, 0]]);
    expect(orientation(0, 0, 1, 0, 0, 1)).toBe(1);
    expect(orientation(0, 0, 1, 0, 2, 0)).toBe(0);
  });

  it('takes a remainder with the sign of the divisor, like Python', () => {
    expect(pyMod(-1, Math.PI / 2)).toBeCloseTo(Math.PI / 2 - 1, 15);
    expect(pyMod(0.1, Math.PI / 2)).toBe(0.1 % (Math.PI / 2));
    expect(Object.is(pyMod(-Math.PI, Math.PI / 2), 0)).toBe(true);
  });
});
