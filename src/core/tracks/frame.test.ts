import { describe, expect, it } from 'vitest';
import { shapeRing, validateArea } from '../geo/area';
import { Projection } from '../geo/projection';
import { pointInPolygon } from '../geometry/polygon';
import type { AreaSpec } from '../settings';
import type { LonLat } from '../types';
import { areaAroundTracks, shareOutside } from './frame';

const base: AreaSpec = { center: [0, 0], widthM: 1000, heightM: 1000, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const origin = new Projection([-87.63, 41.88], 0, 1);
const geo = (x: number, y: number): LonLat => origin.localToGeo(x, y);

// About 6 km east to west and 2 km north to south.
const wide: LonLat[][] = [[geo(-3000, 0), geo(-1000, 800), geo(1000, -1000), geo(3000, 900)]];

function inside(area: AreaSpec, lines: LonLat[][]): boolean {
  const projection = new Projection(area.center, area.rotationDeg, 1);
  const ring = shapeRing(area.shape, area.widthM, area.heightM, area.cornerRadius * Math.min(area.widthM, area.heightM), 1);
  return lines.every((line) => line.every(([lon, lat]) => pointInPolygon(...projection.toModel(lon, lat), [ring])));
}

describe('framing the area around routes', () => {
  it('holds every point in each shape, with a margin', () => {
    for (const shape of ['rectangle', 'rounded', 'circle', 'hexagon'] as const) {
      const area = areaAroundTracks(wide, { ...base, shape, cornerRadius: 0.25 })!;
      expect(inside(area, wide), shape).toBe(true);
      expect(shareOutside(wide, area)).toBe(0);
      // Not much bigger than it needs to be.
      expect(area.widthM, shape).toBeLessThan({ rectangle: 7000, rounded: 7500, circle: 8000, hexagon: 8500 }[shape]);
    }
    const rect = areaAroundTracks(wide, base)!;
    expect(rect.widthM).toBeGreaterThan(6000);
    expect(rect.heightM).toBeGreaterThan(1900);
    expect(rect.heightM).toBeLessThan(2400);
  });

  it('keeps the rotation unless asked to turn, and turns for a diagonal route', () => {
    const diagonal: LonLat[][] = [[geo(-3000, -3000), geo(3000, 3000)]];
    const kept = areaAroundTracks(diagonal, { ...base, rotationDeg: 10 })!;
    expect(kept.rotationDeg).toBe(10);
    expect(inside(kept, diagonal)).toBe(true);
    const turned = areaAroundTracks(diagonal, base, true)!;
    expect(Math.abs(Math.abs(turned.rotationDeg) - 45)).toBeLessThan(2);
    expect(turned.widthM * turned.heightM).toBeLessThan(kept.widthM * kept.heightM * 0.5);
    expect(inside(turned, diagonal)).toBe(true);
  });

  it('stays put when turning frames them only a little smaller', () => {
    const almost: LonLat[][] = [[geo(-1000, -600), geo(1000, -500), geo(1000, 600), geo(-1000, 500)]];
    expect(areaAroundTracks(almost, base, true)!.rotationDeg).toBe(0);
  });

  it('frames a straight route tightly in a rounded area', () => {
    const meridian: LonLat[][] = [[[-87, 41.87], [-87, 41.89]]];
    const area = areaAroundTracks(meridian, { ...base, shape: 'rounded' })!;
    expect(inside(area, meridian)).toBe(true);
    expect(area.heightM).toBeGreaterThan(2200);
    expect(area.heightM).toBeLessThan(3000);
  });

  it('frames routes on both sides of the date line together', () => {
    const crossing: LonLat[][] = [[[179.99, 10], [179.999, 10]], [[-179.999, 10], [-179.99, 10]]];
    const area = areaAroundTracks(crossing, base)!;
    expect(Math.abs(area.center[0])).toBeGreaterThan(179.99);
    expect(area.widthM).toBeLessThan(3000);
    expect(inside(area, crossing)).toBe(true);
    expect(validateArea(area)).toMatch(/180th meridian/);
  });

  it('keeps a tiny hexagon in proportion at the minimum size', () => {
    const tiny = [[geo(0, 0), geo(1, 1)]];
    const area = areaAroundTracks(tiny, { ...base, shape: 'hexagon' })!;
    expect(area.heightM).toBeGreaterThanOrEqual(50);
    expect(area.heightM / area.widthM).toBeCloseTo(Math.sqrt(3) / 2, 6);
    expect(inside(area, tiny)).toBe(true);
  });

  it('measures how much of a route is off the area', () => {
    const area = { ...base, center: geo(0, 0), widthM: 3000, heightM: 3000 };
    expect(shareOutside(wide, area)).toBeGreaterThan(0.2);
    expect(shareOutside(wide, area)).toBeLessThan(0.8);
    expect(areaAroundTracks([], base)).toBeNull();
  });

  it('measures it by length, not by the points simplifying left', () => {
    const area = { ...base, center: geo(0, 0), widthM: 1000, heightM: 1000 };
    // 300 points along 800 m on the area, then on 4 km in one step, 3.9 km of it off the area.
    const dense = Array.from({ length: 300 }, (_, i) => geo(-400 + i * (800 / 299), 0));
    const share = shareOutside([[...dense, geo(4400, 0)]], area);
    expect(share).toBeCloseTo(3900 / 4800, 2);
    expect(shareOutside([[geo(0, 0), geo(0, 0)]], area)).toBe(0);
  });

  it('frames a hull with more corners than a call takes arguments', () => {
    const ring: LonLat[] = Array.from({ length: 150_000 }, (_, i) => geo(2000 * Math.cos((i / 150_000) * 2 * Math.PI), 1000 * Math.sin((i / 150_000) * 2 * Math.PI)));
    const area = areaAroundTracks([ring], base)!;
    expect(area.widthM).toBeGreaterThan(4000);
    expect(inside(area, [ring])).toBe(true);
  });
});
