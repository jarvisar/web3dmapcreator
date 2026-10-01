import { area, Clipper64, ClipType, FillRule, type Paths64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import type { MultiPolygon, Vec2 } from '../types';
import {
  bufferLines,
  ClipSet,
  clipToBox,
  clipToUnits,
  difference,
  differenceSet,
  intersection,
  multiArea,
  offsetPolygons,
  openSharp,
  pointInMulti,
  rectangle,
  ringArea,
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

  it('keeps everything beside a ring that touches the edge it was cut along', () => {
    // A park cut to a tile in Houston. Its outline has a one unit edge lying on
    // the tile's edge, and the union after the cut lost the 0.065 mm² sliver
    // between that corner and where the outline crossed back out.
    const unit = (points: number[][]) => points.map(([x, y]) => [x / SCALE, y / SCALE] as Vec2);
    const park: MultiPolygon = [[
      unit([[287851, 150004], [287938, 149599], [287939, 149599], [290696, 136610], [294300, 120172], [297612, 118892], [298148, 118502], [306440, 120073], [313661, 124209], [319274, 131287], [315044, 137845], [308660, 142048], [292215, 148400], [289429, 149421]]),
    ]];
    const rect = { left: 258700, top: 29599, right: 378700, bottom: 149599 };
    const box = rectangle(rect.left / SCALE, rect.top / SCALE, rect.right / SCALE, rect.bottom / SCALE);
    const clipped = clipToUnits(park, rect);
    expect(pointInMulti(29.0567, 13.7467, clipped)).toBe(true);
    expect(mismatch(clipped, intersection(park, box))).toBeLessThan(1e-6);
  });

  it('matches a boolean intersection for outlines coming onto the cut and along it', () => {
    // Star shaped rings, so simple, some of whose rays come from outside onto a
    // cut line and step a unit along it. Before the spikes were taken out,
    // 17% came out wrong, by up to 2 mm².
    const next = random(23);
    const rect = { left: 100000, top: 100000, right: 200000, bottom: 200000 };
    const box = rectangle(10, 10, 20, 20);
    let worst = 0;
    for (let trial = 0; trial < 500; trial++) {
      const cx = 150000 + (next() - 0.5) * 60000;
      const cy = 150000 + (next() - 0.5) * 60000;
      const n = 6 + Math.floor(next() * 24);
      const ring: Vec2[] = [];
      const push = (x: number, y: number) => ring.push([x / SCALE, y / SCALE]);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let r = 20000 + next() * 70000;
        const onLine = next() < 0.2;
        if (onLine) {
          const ts = [(rect.left - cx) / dx, (rect.right - cx) / dx, (rect.top - cy) / dy, (rect.bottom - cy) / dy].filter((t) => t > 1000 && Number.isFinite(t));
          if (!ts.length) continue;
          r = Math.min(...ts);
          const b = a - 0.3 / n;
          push(Math.round(cx + (r + 8000) * Math.cos(b)), Math.round(cy + (r + 8000) * Math.sin(b)));
        }
        let x = Math.round(cx + r * dx);
        let y = Math.round(cy + r * dy);
        for (const v of [rect.left, rect.right]) if (Math.abs(x - v) < 2) x = v;
        for (const v of [rect.top, rect.bottom]) if (Math.abs(y - v) < 2) y = v;
        push(x, y);
        const step = next() < 0.5 ? 1 : -1;
        if (onLine && (x === rect.left || x === rect.right)) push(x, y + step);
        else if (onLine && (y === rect.top || y === rect.bottom)) push(x + step, y);
      }
      const polygon: MultiPolygon = [[ring]];
      // Only simple rings: the boolean engine isn't a reference otherwise.
      if (Math.abs(multiArea(union(polygon)) - Math.abs(ringArea(ring))) > 1e-4) continue;
      worst = Math.max(worst, mismatch(clipToUnits(polygon, rect), intersection(polygon, box)));
    }
    // Rounding where the cut crosses edges, under a tenth of a micron along them.
    expect(worst).toBeLessThan(1e-3);
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
    const fn = (local: MultiPolygon) => openSharp(differenceSet(local, clip), 0.1);

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

describe('openSharp', () => {
  const nearest = (mp: MultiPolygon, [x, y]: Vec2) => Math.min(...mp.flat(2).map(([u, v]) => Math.hypot(u - x, v - y)));

  it('keeps the corners a cut leaves and drops what is under twice the distance across', () => {
    const land = union(
      difference(rectangle(0, 0, 10, 10), rectangle(4, -1, 6, 11)),
      rectangle(20, 0, 20.15, 10),
      rectangle(10, 4, 13, 4.15),
    );
    const opened = openSharp(land, 0.1);
    for (const corner of [[4, 0], [4, 10], [6, 0], [6, 10], [0, 0], [10, 10]] as Vec2[]) {
      expect(nearest(opened, corner)).toBeLessThan(1e-3);
    }
    // The strip goes, and of the tail only a nub at its root.
    expect(intersection(opened, rectangle(19, -1, 21, 11))).toEqual([]);
    expect(intersection(opened, rectangle(10.3, 0, 14, 10))).toEqual([]);
    const round = offsetPolygons(offsetPolygons(land, -0.1, 'round'), 0.1, 'round');
    expect(nearest(round, [4, 0])).toBeGreaterThan(0.03);
  });

  it('never grows past what it opened', () => {
    const next = random(5);
    const parts: MultiPolygon[] = [];
    for (let i = 0; i < 40; i++) parts.push(blob(next, next() * 60, next() * 60, 2 + next() * 6));
    // Corners chamfered shorter than the shrink, which a mitre runs back out to.
    parts.push([[[[70, 0.05], [70.05, 0], [75, 0], [75, 5], [70, 5]]]]);
    const land = differenceSet(union(...parts), new ClipSet([roadNetwork(next, 30)]));
    const opened = openSharp(land, 0.1);
    // Only rounding along shared edges, under a micron wide.
    expect(offsetPolygons(difference(opened, land), -5e-4)).toEqual([]);
    expect(nearest(opened, [70, 0])).toBeGreaterThan(0.03);
    const round = offsetPolygons(offsetPolygons(land, -0.1, 'round'), 0.1, 'round');
    expect(multiArea(opened)).toBeGreaterThan(multiArea(round));
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
