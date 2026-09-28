import { describe, expect, it } from 'vitest';
import { explodedOffsets, plateOrigin, sectionGrid } from './sections';

describe('sectionGrid', () => {
  it('fits exact limits and splits an uneven model evenly', () => {
    expect(sectionGrid([-105, -105, 105, 105])).toHaveLength(1);
    expect(sectionGrid([0, 0, 420, 210])).toHaveLength(2);
    const cells = sectionGrid([-237.3, -123.8, 237.3, 123.8]);
    expect(cells.map((c) => [c.row, c.column])).toEqual([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]]);
    for (const cell of cells) {
      const [w, s, e, n] = cell.bounds;
      expect(e - w).toBeLessThanOrEqual(210);
      expect(n - s).toBeLessThanOrEqual(210);
    }
    // Neighbours share the identical float at a seam.
    expect(cells[0].bounds[2]).toBe(cells[1].bounds[0]);
    expect(cells[1].bounds[2]).toBe(cells[2].bounds[0]);
    expect(cells[0].bounds[1]).toBe(cells[3].bounds[3]);
    expect(cells[0].name).toBe('Section R1 C1');
    // Rows run north to south.
    expect(cells[0].bounds[3]).toBe(123.8);
    expect(cells[5].bounds).toEqual([cells[5].bounds[0], -123.8, 237.3, cells[5].bounds[3]]);
  });

  it('does not add a section for float noise', () => {
    // 3 km and 6 km at 0.07 mm/m
    expect(sectionGrid([0, 0, 3000 * 0.07, 3000 * 0.07], 210, 210)).toHaveLength(1);
    expect(sectionGrid([0, 0, 6000 * 0.07, 6000 * 0.07], 210, 210)).toHaveLength(4);
    expect(sectionGrid([0, 0, 210.01, 100], 210, 210)).toHaveLength(2);
  });

  it('takes custom limits and bed sizes and rejects bad input', () => {
    expect(sectionGrid([0, 0, 400, 200], 100, 50)).toHaveLength(16);
    // The A1 mini bed is 180 mm: the default 210 mm maxima do not fit it.
    expect(() => sectionGrid([0, 0, 400, 200], 210, 210, 180, 180)).toThrow(/180 x 180/);
    expect(sectionGrid([0, 0, 400, 200], 180, 180, 180, 180)).toHaveLength(6);
    // An H2D section may be wider than the 256 mm beds.
    expect(sectionGrid([0, 0, 700, 300], 350, 320, 350, 320)).toHaveLength(2);
    const bad: [[number, number, number, number], number, number][] = [
      [[0, 0, 0, 1], 210, 210],
      [[0, 0, 1, NaN], 210, 210],
      [[0, 0, 1, 1], 0, 210],
      [[0, 0, 1, 1], 257, 210],
      [[0, 0, 1, 1], 210, Infinity],
      [[0, 0, 10000, 10000], 210, 210],
    ];
    for (const [bounds, width, height] of bad) expect(() => sectionGrid(bounds, width, height)).toThrow();
    expect(() => sectionGrid([0, 0, 10000, 10000], 210, 210)).toThrow(/48 x 48 grid/);
    // Bambu's 36-plate limit is the Bambu writer's business, not the grid's.
    expect(sectionGrid([0, 0, 1680, 1680], 210, 210)).toHaveLength(64);
    expect(() => sectionGrid([0, 0, 1, 1], 210, 210, 0, 256)).toThrow(/positive/);
  });
});

describe('plate layout', () => {
  it('follows Bambu PartPlateList', () => {
    expect(plateOrigin(1, 2)).toEqual([307.2, 0]);
    expect(plateOrigin(3, 6)).toEqual([0, -307.2]);
    expect(plateOrigin(1, 2, 180, 180)).toEqual([216, 0]);
    expect(plateOrigin(2, 4, 350, 320)).toEqual([0, -384]);
    expect(plateOrigin(0, 1)).toEqual([0, 0]);
  });

  it('pulls grid cells apart while keeping their places', () => {
    const cells = sectionGrid([0, 0, 400, 300], 200, 150);
    expect(explodedOffsets(cells.map((c) => c.bounds), 10)).toEqual([[0, 0], [10, 0], [0, -10], [10, -10]]);
  });
});
