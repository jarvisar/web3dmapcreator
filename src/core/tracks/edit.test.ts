import { describe, expect, it } from 'vitest';
import type { LonLat, Vec2 } from '../types';
import { cutSpan, flatFrame, handleIndexes, nearestOnLines, replaceSpan, reverseLines, spanLengthM, trimLines, warpSpan } from './edit';
import { distanceM } from './track';

const straight = (n: number): Vec2[] => Array.from({ length: n }, (_, i) => [i, 0]);

describe('handleIndexes', () => {
  it('only puts handles on the ends of a straight line', () => {
    expect(handleIndexes(straight(100), 0.5, 5)).toEqual([0, 99]);
  });

  it('keeps corners', () => {
    const path: Vec2[] = [...straight(50), ...Array.from({ length: 50 }, (_, i): Vec2 => [49, i + 1])];
    expect(handleIndexes(path, 0.5, 5)).toEqual([0, 49, 99]);
  });

  it('keeps points it is asked to, even close to others', () => {
    expect(handleIndexes(straight(100), 0.5, 5, [1, 50])).toEqual([0, 1, 50, 99]);
  });

  it('spaces handles out', () => {
    const zigzag: Vec2[] = Array.from({ length: 40 }, (_, i) => [i, i % 2]);
    const handles = handleIndexes(zigzag, 0.1, 5);
    for (let i = 1; i < handles.length - 1; i++) expect(handles[i] - handles[i - 1]).toBeGreaterThanOrEqual(5);
  });
});

describe('editing lines', () => {
  const lines = [
    ['a', 'b', 'c', 'd', 'e'],
    ['f', 'g'],
  ];

  it('replaces a span', () => {
    expect(replaceSpan(lines, 0, 1, 3, ['x'])).toEqual([
      ['a', 'x', 'e'],
      ['f', 'g'],
    ]);
  });

  it('cuts the middle out into a gap', () => {
    expect(cutSpan(lines, 0, 1, 3)).toEqual([
      ['a', 'b'],
      ['d', 'e'],
      ['f', 'g'],
    ]);
  });

  it('trims when the cut reaches an end', () => {
    expect(cutSpan(lines, 0, 0, 2)).toEqual([
      ['c', 'd', 'e'],
      ['f', 'g'],
    ]);
    expect(cutSpan(lines, 0, 2, 4)).toEqual([
      ['a', 'b', 'c'],
      ['f', 'g'],
    ]);
    expect(cutSpan(lines, 1, 0, 1)).toEqual([['a', 'b', 'c', 'd', 'e']]);
  });

  it('reverses lines and their order', () => {
    expect(reverseLines(lines)).toEqual([
      ['g', 'f'],
      ['e', 'd', 'c', 'b', 'a'],
    ]);
  });
});

describe('warpSpan', () => {
  it('moves the point and the points either side follow less and less', () => {
    expect(warpSpan(straight(5), 0, 2, 4, [2, 2])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 1],
      [4, 0],
    ]);
  });

  it('works on an end point', () => {
    expect(warpSpan(straight(3), 0, 0, 2, [0, 2])).toEqual([
      [0, 2],
      [1, 1],
      [2, 0],
    ]);
  });
});

describe('nearestOnLines', () => {
  it('finds the segment and where along it', () => {
    expect(nearestOnLines([straight(5)], [2.5, 0.2], 1)).toMatchObject({ line: 0, segment: 2, t: 0.5, point: [2.5, 0] });
    expect(nearestOnLines([straight(5)], [2.5, 3], 1)).toBeNull();
  });
});

describe('trimLines', () => {
  // About 1.1 km along the equator, a point every 111 m.
  const line: LonLat[] = Array.from({ length: 11 }, (_, i) => [i / 1000, 0]);

  it('takes metres off the start', () => {
    const [out] = trimLines([line], 150, 'start');
    expect(spanLengthM(out)).toBeCloseTo(spanLengthM(line) - 150, 3);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it('takes metres off the finish', () => {
    const [out] = trimLines([line], 150, 'finish');
    expect(spanLengthM(out)).toBeCloseTo(spanLengthM(line) - 150, 3);
    expect(out[0]).toEqual(line[0]);
  });

  it('carries on into the next line when the first runs out', () => {
    const short: LonLat[] = [
      [0, 1],
      [0.0005, 1],
    ];
    const out = trimLines([short, line], 100, 'start');
    expect(out).toHaveLength(1);
    expect(spanLengthM(out[0])).toBeCloseTo(spanLengthM(line) - (100 - spanLengthM(short)), 3);
  });

  it('trims across the antimeridian without the cut jumping round the world', () => {
    const across: LonLat[] = [
      [179.999, 0],
      [-179.999, 0],
    ];
    const [out] = trimLines([across], 50, 'start');
    expect(spanLengthM(out)).toBeCloseTo(spanLengthM(across) - 50, 3);
    expect(Math.abs(out[0][0])).toBeGreaterThan(179.99);
  });
});

describe('flatFrame', () => {
  it('comes back exactly, however far out', () => {
    const frame = flatFrame([-87.63, 41.88]);
    for (const p of [[-87.62, 41.89], [-71.06, 42.36], [-122.42, 37.77], [179.99, -10]] as LonLat[]) {
      const [lon, lat] = frame.toLonLat(frame.toLocal(p));
      expect(lon).toBeCloseTo(p[0], 9);
      expect(lat).toBeCloseTo(p[1], 9);
    }
  });

  it('measures in metres near its centre', () => {
    const frame = flatFrame([-87.63, 41.88]);
    const a: LonLat = [-87.62, 41.885];
    const b: LonLat = [-87.64, 41.875];
    const [ax, ay] = frame.toLocal(a);
    const [bx, by] = frame.toLocal(b);
    expect(Math.hypot(ax - bx, ay - by) / distanceM(a, b)).toBeCloseTo(1, 3);
  });
});
