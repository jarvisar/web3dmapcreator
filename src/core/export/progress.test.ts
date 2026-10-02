import { describe, expect, it } from 'vitest';
import type { ExportRequest } from '../engine/protocol';
import { DEFAULT_PALETTE } from '../settings';
import type { MeshPart } from '../types';
import { exportPlates } from './index';
import { box, part, plate } from './test-helpers';

const FORMATS: ExportRequest['format'][] = ['bambu', 'prusa', '3mf', 'stl-zip', 'stl'];

/** A part of `count` triangles in a fan, with as many vertices: an exact multiple of the tally's chunk. */
function fan(count: number): MeshPart {
  const positions = new Float32Array(count * 3);
  const indices = new Uint32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions.set([Math.cos(i), Math.sin(i), i * 1e-4], i * 3);
    indices.set([0, i, (i + 1) % count], i * 3);
  }
  return { id: 'buildings', name: 'Buildings', role: 'building', positions, indices };
}

describe('export progress', () => {
  it('counts every row it writes, in every format', () => {
    const plates = [plate('Map', [part('terrain', 'Terrain', 'terrain', box(-5, -5, 0, 10, 10, 2)), fan(65536)], [-5, -5, 5, 5])];
    for (const format of FORMATS) {
      const fractions: number[] = [];
      exportPlates(plates, { format, printer: 'P1S', palette: DEFAULT_PALETTE, multiPlate: false, sectionWidthMm: 200, sectionHeightMm: 200, fileBase: 'test' }, [], true, (f) => fractions.push(f));
      expect(fractions.length, format).toBeGreaterThan(1);
      for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
      expect(fractions.at(-1), format).toBeCloseTo(1, 9);
    }
  });
});
