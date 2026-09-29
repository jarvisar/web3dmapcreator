import { describe, expect, it } from 'vitest';
import { clipPolylineInside, clipPolylineOutside } from './clip';
import { lonLatToWorld, metresPerPixel, worldToLonLat, zoomForMetres } from './mercator';
import { makeTransform } from './transform';

const box = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
] as [number, number][];

describe('clipping', () => {
  it('keeps the inside of a line that crosses a box', () => {
    expect(clipPolylineInside([[-5, 5], [15, 5]], box)).toEqual([
      [
        [0, 5],
        [10, 5],
      ],
    ]);
  });

  it('splits a line that leaves and comes back', () => {
    const pieces = clipPolylineInside(
      [
        [2, 5],
        [2, 20],
        [8, 20],
        [8, 5],
      ],
      box,
    );
    expect(pieces).toHaveLength(2);
  });

  it('keeps the outside around a label box', () => {
    const pieces = clipPolylineOutside([[-5, 5], [15, 5]], box);
    expect(pieces).toEqual([
      [
        [-5, 5],
        [0, 5],
      ],
      [
        [10, 5],
        [15, 5],
      ],
    ]);
  });

  it('works with either winding', () => {
    const reversed = [...box].reverse();
    expect(clipPolylineInside([[-5, 5], [15, 5]], reversed)).toEqual(clipPolylineInside([[-5, 5], [15, 5]], box));
  });
});

describe('projection', () => {
  it('round-trips longitude and latitude', () => {
    const [x, y] = lonLatToWorld(-87.6298, 41.8781, 14);
    const back = worldToLonLat(x, y, 14);
    expect(back.lon).toBeCloseTo(-87.6298, 9);
    expect(back.lat).toBeCloseTo(41.8781, 9);
  });

  it('agrees with MapLibre about ground per pixel', () => {
    const zoom = zoomForMetres(45, 3000, 600);
    expect(600 * metresPerPixel(45, zoom)).toBeCloseTo(3000, 6);
  });

  it('maps the window width to the requested ground width', () => {
    const t = makeTransform({ lon: 0, lat: 45, bearing: 0, widthM: 2000 }, 14, [100, 50], 160);
    expect(t.metresPerMm).toBeCloseTo(12.5, 9);
    expect(t.toCanvas(t.cx, t.cy)).toEqual([100, 50]);
  });

  it('puts east at the top for a bearing of 90', () => {
    const t = makeTransform({ lon: 0, lat: 0, bearing: 90, widthM: 1000 }, 14, [0, 0], 100);
    const [x, y] = t.toCanvas(t.cx + 100, t.cy);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeLessThan(0);
  });

  it('inverts exactly at any rotation', () => {
    const t = makeTransform({ lon: 12.5, lat: 41.9, bearing: 37, widthM: 3000 }, 14, [80, 60], 160);
    const [x, y] = t.toCanvas(t.cx + 321, t.cy - 123);
    const [wx, wy] = t.toWorld(x, y);
    expect(wx).toBeCloseTo(t.cx + 321, 6);
    expect(wy).toBeCloseTo(t.cy - 123, 6);
  });
});
