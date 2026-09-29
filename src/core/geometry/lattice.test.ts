import { describe, expect, it } from 'vitest';
import { HeightField } from '../terrain/heightfield';
import type { Vec2 } from '../types';
import { inOneTriangle, latticeTin } from './lattice';
import { MeshBuilder, meshSolid } from './mesher';
import { bufferLines, polygonArea, rectangle } from './polygon';
import type { PrismSolid } from './solid';
import { type Tin, clipTin, faceLocator } from './tinclip';

// Steep hills on a coarse grid, where separately triangulated surfaces parted by 1.5 mm.
const hills = (x: number, y: number) => 6 * Math.sin(x / 9) * Math.cos(y / 13) + 3 * Math.sin((x + y) / 5);

const tinArea = (tin: Tin) => {
  let sum = 0;
  const v = tin.vertices;
  for (let t = 0; t < tin.triangles.length; t += 3) {
    const [a, b, c] = [3 * tin.triangles[t], 3 * tin.triangles[t + 1], 3 * tin.triangles[t + 2]];
    sum += ((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1])) / 2;
  }
  return sum;
};

/** The z of a mesh's upward (or downward) faces over a point. */
function surface(positions: Float32Array, indices: Uint32Array, up: boolean) {
  const kept: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [3 * indices[t], 3 * indices[t + 1], 3 * indices[t + 2]];
    const nz = (positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) - (positions[c] - positions[a]) * (positions[b + 1] - positions[a + 1]);
    if (up ? nz > 1e-9 : nz < -1e-9) kept.push(indices[t], indices[t + 1], indices[t + 2]);
  }
  const tin = { vertices: Float64Array.from(positions), triangles: Uint32Array.from(kept) };
  const locate = faceLocator(tin);
  return (x: number, y: number) => {
    const face = locate(x, y);
    return face < 0 ? null : locate.height(face, x, y);
  };
}

describe('the terrain lattice', () => {
  it('is what the height field interpolates', () => {
    const hf = HeightField.build([0, 0, 40, 40], 8, hills);
    const tin = latticeTin(hf.lattice, [[[0, 0], [40, 0], [40, 40], [0, 40]]]);
    for (let i = 0; i < tin.vertices.length; i += 3) tin.vertices[i + 2] = hf.heightAt(tin.vertices[i], tin.vertices[i + 1]);
    const locate = faceLocator(tin);
    for (let k = 0; k < 500; k++) {
      const x = 1 + ((k * 7919) % 3800) / 100;
      const y = 1 + ((k * 104729) % 3800) / 100;
      expect(hf.heightAt(x, y)).toBeCloseTo(locate.height(locate(x, y), x, y), 9);
    }
  });

  it('keeps a road on the ground between its vertices, however big the cells', () => {
    const size = 150;
    const lines: { points: Vec2[]; width: number }[] = [];
    for (let i = 0; i < 12; i++) lines.push({ points: [[5 + i * 11, 3], [140 - i * 7, 147]], width: 0.6 });
    const roads = bufferLines(lines);
    const embed = 0.15;
    for (const resolution of [24, 48]) {
      const hf = HeightField.build([0, 0, size, size], resolution, hills);
      const terrain = new MeshBuilder();
      for (const polygon of rectangle(0, 0, size, size)) {
        meshSolid({ kind: 'prism', role: 'terrain', polygon, top: (x, y) => hf.heightAt(x, y), bottom: -20, drape: hf.step, lattice: hf.lattice } as PrismSolid, terrain);
      }
      const road = new MeshBuilder();
      for (const polygon of roads) {
        meshSolid({ kind: 'prism', role: 'road', polygon, top: (x, y) => hf.heightAt(x, y) + 0.6, bottom: (x, y) => hf.heightAt(x, y) - embed, drape: hf.step, lattice: hf.lattice } as PrismSolid, road);
      }
      const t = terrain.finish();
      const r = road.finish();
      const ground = surface(t.positions, t.indices, true);
      const underside = surface(r.positions, r.indices, false);
      let worst = -Infinity;
      for (let i = 0; i < r.positions.length; i += 3) {
        // Between vertices: the middle of each vertex's neighbourhood along the road.
        const x = r.positions[i] + 0.05;
        const y = r.positions[i + 1] + 0.05;
        const a = ground(x, y);
        const b = underside(x, y);
        if (a !== null && b !== null) worst = Math.max(worst, b - a);
      }
      expect(worst).toBeLessThan(-embed + 1e-3);
    }
  });

  it('only builds the cells a thin diagonal strip touches', () => {
    // A beach taper on a 0.1 mm lattice, corner to corner of a 300 mm area.
    const lattice = { x0: 0, y0: 0, step: 0.1 };
    const strip = bufferLines([{ points: [[1, 1], [299, 297]], width: 0.3 }]);
    for (const polygon of strip) {
      const tin = latticeTin(lattice, polygon);
      expect(tin.triangles.length / 3).toBeLessThan(0.02 * 2 * 3000 * 3000);
      const cut = clipTin(tin, [polygon])!;
      expect(tinArea(cut)).toBeCloseTo(polygonArea(polygon), 3);
    }
  });

  it('covers a polygon with a hole', () => {
    const lattice = { x0: 0.37, y0: -0.2, step: 1.3 };
    const ring = (x: number, y: number, w: number, h: number): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const polygon = [ring(0, 0, 40, 30), ring(10, 10, 12, 8).reverse()];
    const cut = clipTin(latticeTin(lattice, polygon), [polygon])!;
    expect(tinArea(cut)).toBeCloseTo(polygonArea(polygon), 6);
  });

  it('knows when a footprint sits in one triangle of the terrain', () => {
    const lattice = { x0: 0, y0: 0, step: 3 };
    const square = (x: number, y: number, w: number): [number, number][][] => [[[x, y], [x + w, y], [x + w, y + w], [x, y + w]]];
    // Below the diagonal of cell (1, 1), then across it, then across the cell's edge.
    expect(inOneTriangle(lattice, square(4.8, 3.2, 0.5))).toBe(true);
    expect(inOneTriangle(lattice, square(3.2, 4.8, 0.5))).toBe(true);
    expect(inOneTriangle(lattice, square(4.2, 4.2, 0.5))).toBe(false);
    expect(inOneTriangle(lattice, square(5.8, 3.2, 0.5))).toBe(false);
  });
});
