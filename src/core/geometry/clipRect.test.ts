import { area, Clipper64, ClipType, FillRule, type Paths64, type Rect64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../types';
import { clipToRect } from './clipRect';
import { bufferLines, SCALE, toPaths } from './polygon';

function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function run(clipType: ClipType, subject: Paths64, clip: Paths64 = []): Paths64 {
  const clipper = new Clipper64();
  clipper.addSubject(subject);
  if (clip.length) clipper.addClip(clip);
  const out: Paths64 = [];
  clipper.execute(clipType, FillRule.NonZero, out);
  return out;
}

const areaOf = (paths: Paths64) => paths.reduce((sum, path) => sum + area(path), 0);
// Area in one and not the other, in square units.
const mismatch = (a: Paths64, b: Paths64) => areaOf(run(ClipType.Difference, a, b)) + areaOf(run(ClipType.Difference, b, a));

describe('clipToRect', () => {
  it('matches a boolean intersection once unioned, including rings that wrap around a corner', () => {
    const next = random(7);
    const lines: { points: Vec2[]; width: number }[] = [];
    for (let i = 0; i < 30; i++) lines.push({ points: [[next() * 60, next() * 60], [next() * 60, next() * 60]], width: 0.6 });
    // Many holes and rings with hundreds of vertices, as road and water fills
    // have. Clipper2's own rectClip loses corners of these.
    const rings = toPaths(bufferLines(lines));
    for (let trial = 0; trial < 200; trial++) {
      const left = Math.round(next() * 55 * SCALE);
      const top = Math.round(next() * 55 * SCALE);
      const rect: Rect64 = { left, top, right: left + Math.round((0.5 + next() * 8) * SCALE), bottom: top + Math.round((0.5 + next() * 8) * SCALE) };
      const box = [[{ x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom }]];
      const expected = run(ClipType.Intersection, rings, box);
      const clipped = run(ClipType.Union, clipToRect(rect, rings));
      // Cut points are rounded to whole units along the edges.
      expect(mismatch(clipped, expected)).toBeLessThan(2 * (rect.right - rect.left + rect.bottom - rect.top));
    }
  });

  it('keeps a ring that covers the whole rectangle', () => {
    const big = [[{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }]];
    expect(areaOf(clipToRect({ left: 0, top: 0, right: 10, bottom: 10 }, big))).toBe(100);
  });
});
