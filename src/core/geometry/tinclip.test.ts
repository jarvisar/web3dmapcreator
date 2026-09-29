import { describe, expect, it } from 'vitest';
import type { MultiPolygon } from '../types';
import { multiArea } from './polygon';
import grazing from './testdata/grazing-clip.json';
import { clipTin, faceLocator, tinArea, type Tin } from './tinclip';

/** A grid TIN over [0, n*step]^2 with heights from `fn`. */
function gridTin(n: number, step: number, fn: (x: number, y: number) => number): Tin {
  const vertices: number[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) vertices.push(i * step, j * step, fn(i * step, j * step));
  const triangles: number[] = [];
  const id = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      triangles.push(id(i, j), id(i + 1, j), id(i + 1, j + 1));
      triangles.push(id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  }
  return { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(triangles) };
}

/** Every edge used at most twice, boundary edges once, and all faces counter-clockwise. */
function checkConforming(tin: Tin) {
  const uses = new Map<string, number>();
  const v = tin.vertices;
  for (let t = 0; t < tin.triangles.length; t += 3) {
    const [a, b, c] = [tin.triangles[t], tin.triangles[t + 1], tin.triangles[t + 2]];
    const cross = (v[3 * b] - v[3 * a]) * (v[3 * c + 1] - v[3 * a + 1]) - (v[3 * c] - v[3 * a]) * (v[3 * b + 1] - v[3 * a + 1]);
    expect(cross).toBeGreaterThan(0);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = `${p},${q}`;
      expect(uses.has(key), 'directed edge used twice').toBe(false);
      uses.set(key, 1);
    }
  }
}

describe('clipTin', () => {
  const plane = (x: number, y: number) => 10 + 0.5 * x - 0.25 * y;

  it('clips a plane to a rotated square and keeps its heights', () => {
    const tin = gridTin(10, 1, plane);
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const ring: [number, number][] = [
      [-3, -3],
      [3, -3],
      [3, 3],
      [-3, 3],
    ].map(([x, y]) => [5 + x * c - y * s, 5 + x * s + y * c]);
    const region: MultiPolygon = [[ring]];
    const out = clipTin(tin, region)!;
    expect(out).not.toBeNull();
    expect(tinArea(out)).toBeCloseTo(multiArea(region), 9);
    checkConforming(out);
    for (let i = 0; i < out.vertices.length; i += 3) expect(out.vertices[i + 2]).toBeCloseTo(plane(out.vertices[i], out.vertices[i + 1]), 9);
  });

  it('handles outline edges along TIN edges, vertices on edges and holes', () => {
    const tin = gridTin(8, 1, (x, y) => (x > 4 ? 20 : 5) + y);
    // Outline on grid lines, a hole with a corner on a TIN diagonal.
    const region: MultiPolygon = [
      [
        [[1, 1], [7, 1], [7, 7], [1, 7]],
        [[3, 3], [3, 5], [5.5, 5.5], [5, 3]],
      ],
    ];
    const out = clipTin(tin, region)!;
    expect(out).not.toBeNull();
    expect(tinArea(out)).toBeCloseTo(multiArea(region), 9);
    checkConforming(out);
    const locate = faceLocator(tin);
    for (let i = 0; i < out.vertices.length; i += 3) {
      const [x, y, z] = [out.vertices[i], out.vertices[i + 1], out.vertices[i + 2]];
      const face = locate(x, y);
      expect(Math.abs(locate.height(face, x, y) - z)).toBeLessThan(1e-9);
    }
  });

  it('keeps only the covered part where the region reaches past the TIN', () => {
    const tin = gridTin(4, 1, () => 1);
    const out = clipTin(tin, [[[[-1, -1], [2, -1], [2, 2], [-1, 2]]]])!;
    expect(tinArea(out)).toBeCloseTo(4, 9);
    checkConforming(out);
  });

  it('finishes when the outline grazes the TIN, where the triangulation alone never did', () => {
    // A Paris roof cut at the model edge, whose crossings left Constrainautor
    // rescanning one degenerate quad forever.
    const tin = { vertices: Float64Array.from(grazing.vertices), triangles: Uint32Array.from(grazing.triangles) };
    const region = grazing.region as MultiPolygon;
    const out = clipTin(tin, region)!;
    expect(Math.abs(tinArea(out) - multiArea(region))).toBeLessThan(1e-3);
    checkConforming(out);
  }, 10000);

  describe('a TIN large enough to clip only near the outline', () => {
    // 70 x 70 cells, two triangles each: past the size where the rest is kept whole.
    const tin = gridTin(70, 1, plane);

    it('keeps the triangles clear of a hexagon with a hole and cuts the rest', () => {
      const hexagon = Array.from({ length: 6 }, (_, i) => [35 + 30 * Math.cos((Math.PI / 3) * i + 0.1), 35 + 30 * Math.sin((Math.PI / 3) * i + 0.1)] as [number, number]);
      const hole: [number, number][] = [[30.5, 30.5], [30.5, 40.25], [41, 40.25], [41, 30.5]];
      const region: MultiPolygon = [[hexagon, hole]];
      const out = clipTin(tin, region)!;
      expect(tinArea(out)).toBeCloseTo(multiArea(region), 8);
      checkConforming(out);
      for (let i = 0; i < out.vertices.length; i += 3) expect(out.vertices[i + 2]).toBeCloseTo(plane(out.vertices[i], out.vertices[i + 1]), 9);
      // Joined by index: each vertex once.
      const seen = new Set<string>();
      for (let i = 0; i < out.vertices.length; i += 3) seen.add(`${out.vertices[i]},${out.vertices[i + 1]}`);
      expect(seen.size).toBe(out.vertices.length / 3);
    });

    it('returns the whole TIN for a region around it and nothing for one away from it', () => {
      const around = clipTin(tin, [[[[-5, -5], [80, -5], [80, 80], [-5, 80]]]])!;
      expect(around.triangles.length).toBe(tin.triangles.length);
      expect(tinArea(around)).toBeCloseTo(70 * 70, 9);
      expect(clipTin(tin, [[[[100, 100], [110, 100], [110, 110], [100, 110]]]])!.triangles.length).toBe(0);
    });
  });
});
