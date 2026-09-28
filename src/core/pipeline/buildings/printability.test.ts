import { describe, expect, it } from 'vitest';
import type { Polygon, Ring } from '../../types';
import type { SourceFeature } from '../source';
import { ringWidth, signedArea } from './planar';
import { adjoiningPartWidths, footprintAdmitsMinimumHeight, sourcePartWidths, type PartMass } from './printability';

const rectangle = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const mass = (ring: Ring, top = 6, bottom = 0): PartMass => ({ polygon: [ring], bottom, top });
const own = (masses: PartMass[]) => masses.map((m) => ringWidth(m.polygon[0]));

describe('adjoining part widths', () => {
  it('gives thin partitions the width of the complete footprint', () => {
    const masses = Array.from({ length: 40 }, (_, i) => mass(rectangle(i / 20, 0, (i + 1) / 20, 2)));
    expect(own(masses).every((w) => w < 0.08)).toBe(true);
    for (const width of adjoiningPartWidths(masses)) expect(width).toBeCloseTo(1, 10);
  });

  it('gives no width to detached parts, point contacts or overlaps', () => {
    const first = mass(rectangle(0, 0, 0.1, 2));
    for (const other of [rectangle(0.11, 0, 0.21, 2), rectangle(0.1, 2, 0.2, 4), rectangle(0, 0, 0.1, 2), rectangle(0.05, 0, 0.15, 2)]) {
      const masses = [first, mass(other)];
      expect(adjoiningPartWidths(masses)).toEqual(own(masses));
    }
  });

  it('counts actual shared length, not bounding box contact', () => {
    const masses = [mass(rectangle(0, 0, 0.1, 2)), mass(rectangle(0.1, 1.99, 2, 3))];
    expect(adjoiningPartWidths(masses)).toEqual(own(masses));
  });

  it('supports a short roof step', () => {
    const masses = [mass(rectangle(0, 0, 0.05, 2), 6.05), mass(rectangle(0.05, 0, 2, 2), 6)];
    const widths = adjoiningPartWidths(masses);
    expect(widths[0]).toBeCloseTo(1, 10);
    expect(widths[1]).toBeCloseTo(1, 10);
  });

  it('does not support a long thin extension above its neighbour', () => {
    const masses = [mass(rectangle(0, 0, 0.1, 2), 10), mass(rectangle(0.1, 0, 2, 2), 1)];
    expect(adjoiningPartWidths(masses)).toEqual(own(masses));
  });

  it('does not let a tiny seam become a tall tip', () => {
    const masses = [mass(rectangle(0, 0, 0.05, 2), 7), mass(rectangle(0.05, 0, 2, 2), 6)];
    expect(adjoiningPartWidths(masses)).toEqual(own(masses));
  });

  it('does not let an elevated facade borrow a grounded sibling\'s width', () => {
    const masses = [mass(rectangle(0, 0, 0.1, 2), 6, 1), mass(rectangle(0.1, 0, 2, 2), 6)];
    expect(adjoiningPartWidths(masses)).toEqual(own(masses));
  });

  it('lets equal elevated bases form a tier', () => {
    const widths = adjoiningPartWidths([mass(rectangle(0, 0, 0.1, 2), 6, 1), mass(rectangle(0.1, 0, 2, 2), 6, 1)]);
    expect(widths[0]).toBeCloseTo(1, 10);
    expect(widths[1]).toBeCloseTo(1, 10);
  });

  it('keeps a partitioned ribbon thin', () => {
    const masses = Array.from({ length: 10 }, (_, i) => mass(rectangle(i, 0, i + 1, 0.05)));
    expect(adjoiningPartWidths(masses).every((w) => w < 0.08)).toBe(true);
  });

  it('handles partial edges and reversed winding', () => {
    const reversed: Ring = [[1, 0], [2, 0], [2, 2], [1, 2], [1, 1]].reverse() as Ring;
    const widths = adjoiningPartWidths([mass(rectangle(0, 0, 1, 2)), mass(reversed)]);
    expect(widths[0]).toBeCloseTo(1, 10);
    expect(widths[1]).toBeCloseTo(1, 10);
  });

  it('does not count a courtyard as solid support', () => {
    // Filling part of a courtyard keeps the rest of the hole's perimeter.
    const masses: PartMass[] = [{ polygon: [rectangle(0, 0, 4, 4), rectangle(1, 1, 3, 3)], bottom: 0, top: 6 }, mass(rectangle(1, 1, 1.1, 3))];
    expect(adjoiningPartWidths(masses)[1]).toBeCloseTo((2 * 12.2) / 23.8, 10);
  });

  it('gets no support from other parents or invalid intervals', () => {
    const part = (id: string, parent: string, ring: Ring, props: Record<string, unknown> = {}): SourceFeature => ({
      id,
      props: { building_id: parent, height: 6, ...props },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
    const features = [part('a', 'p', rectangle(0, 0, 0.1, 2)), part('b', 'q', rectangle(0.1, 0, 2, 2)), part('invalid', 'p', rectangle(0.1, 0, 2, 2), { min_height: 8 })];
    const widths = sourcePartWidths(features, (f) => [f.geometry.coordinates as Polygon], (z) => z, 3, 10, 0.08, 30);
    expect(widths.get('a')![0]).toBeCloseTo(ringWidth(rectangle(0, 0, 0.1, 2)), 12);
    expect(widths.has('invalid')).toBe(false);
  });
});

describe('minimum height footprint gate', () => {
  const square = (side: number): Ring => [[0, 0], [side, 0], [side, side], [0, side]];
  const strip = (width: number, length: number): Ring => [[0, 0], [length, 0], [length, width], [0, width]];

  it('admits a square of exactly the threshold', () => {
    expect(footprintAdmitsMinimumHeight(square(0.6), 0.6)).toBe(true);
  });

  it('admits a larger square', () => {
    expect(footprintAdmitsMinimumHeight(square(2.4), 0.6)).toBe(true);
  });

  it('leaves a shed below the threshold alone', () => {
    expect(footprintAdmitsMinimumHeight(square(0.4), 0.6)).toBe(false);
  });

  it('leaves a ribbon with enough area alone', () => {
    // A wall fragment or a row of garages would stretch into a fin.
    const ribbon = strip(0.1, 4);
    expect(Math.abs(signedArea(ribbon))).toBeGreaterThan(0.36);
    expect(footprintAdmitsMinimumHeight(ribbon, 0.6)).toBe(false);
  });

  it('admits a wide low building', () => {
    expect(footprintAdmitsMinimumHeight(strip(1.2, 6), 0.6)).toBe(true);
  });

  it('ignores winding', () => {
    expect(footprintAdmitsMinimumHeight(square(1).reverse(), 0.6)).toBe(true);
  });

  it('admits everything at a zero threshold', () => {
    expect(footprintAdmitsMinimumHeight(square(0.01), 0)).toBe(true);
  });

  it('rejects a degenerate ring', () => {
    expect(footprintAdmitsMinimumHeight([[0, 0], [1, 1]], 0.6)).toBe(false);
  });
});
