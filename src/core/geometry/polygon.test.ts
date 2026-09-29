import { area, Clipper64, ClipType, FillRule, type Paths64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import type { MultiPolygon, Vec2 } from '../types';
import {
  bufferLines,
  ClipSet,
  clipToBox,
  difference,
  differenceSet,
  intersection,
  multiArea,
  offsetPolygons,
  rectangle,
  SCALE,
  separateTouching,
  tiled,
  toPaths,
  union,
} from './polygon';

function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function blob(next: () => number, cx: number, cy: number, radius: number): MultiPolygon {
  const ring: Vec2[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = radius * (0.6 + 0.4 * next());
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return [[ring]];
}

function roadNetwork(next: () => number, count: number): MultiPolygon {
  const lines: Vec2[][] = [];
  for (let i = 0; i < count; i++) lines.push([[next() * 60, next() * 60], [next() * 60, next() * 60]]);
  return bufferLines(lines.map((points) => ({ points, width: 0.6 })));
}

// Area of a - b from the raw output rings. Two results of different rounding
// cross by less than a unit along shared edges, and the engine's tree can
// then leave a hole at the top level, so areas of collected polygons would
// count it twice. The signed ring areas stay exact.
function differenceArea(a: MultiPolygon, b: MultiPolygon): number {
  const clipper = new Clipper64();
  clipper.addSubject(toPaths(a));
  clipper.addClip(toPaths(b));
  const out: Paths64 = [];
  clipper.execute(ClipType.Difference, FillRule.NonZero, out);
  return out.reduce((sum, path) => sum + area(path), 0) / (SCALE * SCALE);
}

function mismatch(a: MultiPolygon, b: MultiPolygon): number {
  return differenceArea(a, b) + differenceArea(b, a);
}

describe('booleans', () => {
  it('keep a hole that crosses its outer by less than a unit as a hole', () => {
    // One strip clipped two ways, so the rings differ by a unit of rounding
    // and their long edges cross. The engine returns the second reversed at
    // the top level, which used to come back as a 2.45 mm² solid.
    const unit = (points: number[][]): MultiPolygon => [[points.map(([x, y]) => [x / SCALE, y / SCALE] as Vec2)]];
    const a = unit([[293932, 363526], [323197, 400388], [315535, 400388], [293932, 373176]]);
    const b = unit([[323196, 400387], [315534, 400387], [293933, 373177], [293933, 363527]]);
    expect(multiArea(difference(a, b))).toBeLessThan(1e-3);
    expect(multiArea(difference(b, a))).toBeLessThan(1e-3);
    expect(multiArea(union(a, b))).toBeCloseTo(multiArea(a), 3);
  });
});

describe('clipToBox', () => {
  it('matches a boolean intersection, including rings that wrap around a corner', () => {
    const next = random(5);
    // Buffered crossing lines leave rings with hundreds of vertices and many
    // holes, which is where Clipper2's rectClip dropped corners.
    const roads = roadNetwork(next, 30);
    for (let trial = 0; trial < 200; trial++) {
      const x = next() * 55;
      const y = next() * 55;
      const box: [number, number, number, number] = [x, y, x + 0.5 + next() * 8, y + 0.5 + next() * 8];
      const expected = intersection(roads, rectangle(...box));
      // The box is rounded outward to whole Clipper units, a band 0.1 micron wide.
      const band = 2 * (box[2] - box[0] + box[3] - box[1]) * 1e-4;
      expect(mismatch(clipToBox(roads, box, 0), expected)).toBeLessThan(band);
    }
  });
});

describe('tiled', () => {
  it('matches one pass of a difference and an opening, across tile edges', () => {
    const next = random(11);
    const parts: MultiPolygon[] = [];
    for (let i = 0; i < 40; i++) parts.push(blob(next, next() * 60, next() * 60, 2 + next() * 6));
    // A sliver crossing a tile edge at a shallow angle, which an opening per
    // cut piece would eat back from the edge.
    parts.push([[[[5, 19.6], [35, 20.4], [35, 21.4], [5, 20.6]]]]);
    const subject = union(...parts);
    const clip = new ClipSet([roadNetwork(next, 30)]);
    const fn = (local: MultiPolygon) => {
      const kept = differenceSet(local, clip);
      return offsetPolygons(offsetPolygons(kept, -0.1, 'round'), 0.1, 'round');
    };

    const whole = fn(subject);
    const pieces = tiled(subject, 10, 1, fn);
    const joined = union(pieces);
    expect(pieces.length).toBeGreaterThan(whole.length);
    expect(multiArea(whole)).toBeGreaterThan(500);
    // Only rounding slivers along the tile edges, a tenth of a micron wide.
    expect(mismatch(whole, joined)).toBeLessThan(1e-2);
  });

  it('runs once when the subject fits a tile', () => {
    let calls = 0;
    const out = tiled([[[[0, 0], [5, 0], [5, 5], [0, 5]]]], 10, 1, (local) => {
      calls++;
      return local;
    });
    expect(calls).toBe(1);
    expect(multiArea(out)).toBeCloseTo(25, 6);
  });
});

describe('separateTouching', () => {
  it('pulls apart polygons meeting at a corner, and leaves the rest alone', () => {
    const touching = [...rectangle(0, 0, 1, 1), ...rectangle(1, 1, 2, 2)];
    const apart = separateTouching(touching);
    const corners = new Set(apart.flatMap((p) => p[0].map(([x, y]) => `${Math.round(x * SCALE)},${Math.round(y * SCALE)}`)));
    expect(corners.size).toBe(8);
    expect(multiArea(apart)).toBeCloseTo(2, 2);
    const separate = [...rectangle(0, 0, 1, 1), ...rectangle(2, 2, 3, 3)];
    expect(separateTouching(separate)).toBe(separate);
  });
});
