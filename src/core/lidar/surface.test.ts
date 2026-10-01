import { describe, expect, it } from 'vitest';
import { gridSpec } from '../dsm/grid';
import { capBoundary } from '../geometry/cap';
import { tinArea } from '../geometry/tinclip';
import type { MultiPolygon } from '../types';
import { emptyPoints, type Points } from './points';
import { BatchSurface, surfaceAround } from './surface';

const GROUND = 100;
const settings = { cellM: 0.71, widthM: 400, heightM: 300, xyScale: 0.07, zScale: 0.077 };

/** Returns every 0.35 m over a box, from `top(x, y)` (null for ground). */
function survey(top: (x: number, y: number) => number | null, half = 60): Points {
  const rows: number[][] = [];
  for (let x = -half; x <= half; x += 0.35) {
    for (let y = -half; y <= half; y += 0.35) {
      const z = top(x, y);
      rows.push(z === null ? [x, y, GROUND + 0.002 * x, 2] : [x, y, z, 6]);
    }
  }
  const points = emptyPoints(rows.length);
  rows.forEach(([x, y, z, cls], i) => {
    points.x[i] = x;
    points.y[i] = y;
    points.z[i] = z;
    points.cls[i] = cls;
    points.single[i] = 1;
  });
  return points;
}

const box = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [
  [
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  ],
];

function heightsAt(cap: { vertices: Float64Array }, inside: (x: number, y: number) => boolean): number[] {
  const out: number[] = [];
  for (let k = 0; k < cap.vertices.length; k += 3) if (inside(cap.vertices[k], cap.vertices[k + 1])) out.push(cap.vertices[k + 2]);
  return out;
}

describe('measured roofs from the LiDAR surface', () => {
  // A 40 x 30 m podium 30 m tall with a 12 x 12 m tower to 60 m.
  const podium = (x: number, y: number) => (x > -20 && x < 20 && y > -15 && y < 15 ? (x > -6 && x < 6 && y > -6 && y < 6 ? GROUND + 60 : GROUND + 30) : null);

  it('lays its cells on the area grid and keeps the roof heights', () => {
    const surface = BatchSurface.build(survey(podium), [-60, -60, 60, 60], settings)!;
    const grid = gridSpec(settings.widthM, settings.heightM, settings.cellM);
    expect(surface.origin.x0).toBe(grid.x0);
    expect(surface.origin.dx).toBe(grid.dx);
    const footprint = box(-20, -15, 20, 15);
    const { fit, reason } = surface.fit(footprint, GROUND);
    expect(fit, reason ?? '').not.toBeNull();
    expect(Math.abs(tinArea(fit!.cap) - 1200)).toBeLessThan(1e-3);
    expect(capBoundary(fit!.cap)).not.toBeNull();
    expect(fit!.heightM).toBeCloseTo(30, 0);
    const tower = heightsAt(fit!.cap, (x, y) => Math.abs(x) < 7 && Math.abs(y) < 7);
    expect(Math.max(...tower)).toBeCloseTo(60, 0);
  });

  it('carries the roof out to a mapped outline past the wall', () => {
    const surface = BatchSurface.build(survey(podium), [-60, -60, 60, 60], settings)!;
    // The map has the building 1.2 m wider all round than the survey does.
    const { fit, reason } = surface.fit(box(-21.2, -16.2, 21.2, 16.2), GROUND);
    expect(fit, reason ?? '').not.toBeNull();
    // Without that the cap's lowest point would be the street.
    expect(fit!.heightM).toBeGreaterThan(25);
  });

  it("takes a taller neighbour's facade off the roof", () => {
    // A 20 m square at 10 m, and a 60 m tower beside it whose wall the
    // survey has 1.5 m inside our outline.
    const pair = (x: number, y: number) => (y > -10 && y < 10 && x > -10 && x < 30 ? (x > 8.5 ? GROUND + 60 : GROUND + 10) : null);
    const surface = BatchSurface.build(survey(pair), [-60, -60, 60, 60], settings)!;
    const ours = box(-10, -10, 10, 10);
    const theirs = box(10, -10, 30, 10);
    const alone = surface.fit(ours, GROUND).fit!;
    const beside = surface.fit(ours, GROUND, [theirs]).fit!;
    expect(Math.max(...heightsAt(alone.cap, () => true))).toBeGreaterThan(50);
    expect(Math.max(...heightsAt(beside.cap, () => true))).toBeLessThan(12);
  });

  it("makes a surface from a building's own returns outside a batch", () => {
    const surface = surfaceAround(box(-20, -15, 20, 15), survey(podium), [0.07, 0.077])!;
    const { fit } = surface.fit(box(-20, -15, 20, 15), GROUND);
    expect(fit!.heightM).toBeCloseTo(30, 0);
  });
});
