import { describe, expect, it } from 'vitest';
import { difference, pointInPolygon } from '../geometry/polygon';
import { HeightField } from '../terrain/heightfield';
import type { MultiPolygon, Polygon } from '../types';
import { shapeBeaches } from './beaches';

const box = (x0: number, y0: number, x1: number, y1: number): Polygon => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];

// Water below y = 0.1 at 1 mm, ground at 2 mm, 0.5 mm cells.
function scene() {
  const hf = HeightField.build([-16, -16, 16, 16], 64, (_, y) => (y < 0.1 ? 1.25 : 2));
  const crop: MultiPolygon = [box(-15, -15, 15, 15)];
  const water = box(-15, -15, 15, 0.1);
  const ground = difference(crop, [water]);
  // Sand stopping 0.3 mm short of the water, and a road down to it.
  const sand: MultiPolygon = [box(-10, 0.4, 0, 5)];
  const road = box(2, 0.1, 4, 8);
  const park = box(-10, 5, 0, 10);
  const beaches = shapeBeaches(hf, {
    cut: [{ polygons: [water], top: 1 }],
    crop,
    ground,
    sand,
    blockers: [road],
    cover: [park],
    width: 1.5,
  })!;
  return { hf, beaches };
}

const inside = (mp: MultiPolygon, x: number, y: number) => mp.some((polygon) => pointInPolygon(x, y, polygon));

describe('shapeBeaches', () => {
  it('runs the sand on to the water across the gap, but not past its ends', () => {
    const { beaches } = scene();
    expect(beaches.filled).toBeGreaterThan(2.5);
    expect(inside(beaches.sand, -5, 0.25)).toBe(true);
    expect(inside(beaches.sand, -11.5, 0.25)).toBe(false);
    expect(inside(beaches.sand, -11, 3)).toBe(false);
    expect(inside(beaches.sand, 3, 0.25)).toBe(false);
  });

  it('slopes the ground down to the water on the beach only', () => {
    const { hf, beaches } = scene();
    expect(beaches.lowered).toBeGreaterThan(0);
    // At the water's surface where the beach meets it, never below, rising to the old ground.
    expect(hf.heightAt(-5, 0.1)).toBeGreaterThanOrEqual(1);
    expect(hf.heightAt(-5, 0.1)).toBeLessThan(1.05);
    expect(hf.heightAt(-5, 0.75)).toBeLessThan(1.5);
    expect(hf.heightAt(-5, 2)).toBe(2);
    // The road keeps its bank, and so does shore with no sand near it.
    expect(hf.heightAt(3, 0.5)).toBe(2);
    expect(hf.heightAt(12, 0.5)).toBe(2);
  });
});
