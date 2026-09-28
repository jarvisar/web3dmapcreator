import { describe, expect, it } from 'vitest';
import { capBoundary, meshCap, undersideTriangles } from './cap';
import { clipRegion, MeshBuilder } from './mesher';
import type { CapSolid } from './solid';
import { clipTin, type Tin } from './tinclip';
import { edgeReport, signedVolume } from './validate';

function gridTin(n: number, step: number, fn: (x: number, y: number) => number): Tin {
  const vertices: number[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) vertices.push(i * step, j * step, fn(i * step, j * step));
  const triangles: number[] = [];
  const id = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) triangles.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
  }
  return { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(triangles) };
}

function closed(out: MeshBuilder) {
  const { positions, indices } = out.finish();
  const report = edgeReport(indices, positions.length / 3);
  expect(report.open).toBe(0);
  expect(report.repeated).toBe(0);
  expect(signedVolume(positions, indices)).toBeGreaterThan(0);
  return { positions, indices };
}

describe('meshCap', () => {
  // A roof over an L-shaped footprint with a courtyard, as measurement produces it.
  const roof = clipTin(gridTin(10, 1, (x, y) => 20 + (x > 5 ? 8 : 0) + 0.2 * y), [
    [
      [[1, 1], [9, 1], [9, 4], [5, 4], [5, 9], [1, 9]],
      [[2, 5], [2, 7], [4, 7], [4, 5]],
    ],
  ])!;
  const cap: CapSolid = { kind: 'cap', role: 'building', vertices: roof.vertices, triangles: roof.triangles, bottom: 15 };

  it('closes a whole cap', () => {
    expect(capBoundary(roof)).not.toBeNull();
    const out = new MeshBuilder();
    expect(meshCap(cap, out)).toBe('ok');
    const { positions } = closed(out);
    let lowest = Infinity;
    for (let i = 2; i < positions.length; i += 3) lowest = Math.min(lowest, positions[i]);
    expect(lowest).toBe(15);
  });

  it('covers the underside from the outline, keeping the vertices along straight walls', () => {
    // A finer roof over the same outline, as a measured one is.
    const fine = clipTin(gridTin(40, 0.25, (x, y) => 20 + (x > 5 ? 8 : 0) + 0.2 * y), [
      [
        [[1, 1], [9, 1], [9, 4], [5, 4], [5, 9], [1, 9]],
        [[2, 5], [2, 7], [4, 7], [4, 5]],
      ],
    ])!;
    const boundary = capBoundary(fine)!;
    const under = undersideTriangles(fine, boundary)!;
    expect(under).not.toBeNull();
    const tris = under.triangles.length / 3;
    expect(tris).toBeLessThan(fine.triangles.length / 3 / 4);
    // Every outline vertex is used, straight runs and the courtyard included.
    const used = new Set(under.triangles);
    for (const [a] of boundary) expect(used.has(a)).toBe(true);
    const out = new MeshBuilder();
    meshCap({ ...cap, vertices: fine.vertices, triangles: fine.triangles }, out);
    const { indices } = closed(out);
    expect(indices.length / 3).toBe(fine.triangles.length / 3 + tris + 2 * boundary.length);
  });

  it('closes each piece of a cap cut by a section', () => {
    for (const box of [
      [0, 0, 4.5, 20],
      [4.5, 0, 20, 20],
      [0, 0, 20, 6],
      [0, 6, 20, 20],
    ]) {
      const out = new MeshBuilder();
      const region = clipRegion([[[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]]]);
      expect(meshCap(cap, out, region)).toBe('ok');
      closed(out);
    }
    // Entirely outside a section: nothing written.
    const out = new MeshBuilder();
    expect(meshCap(cap, out, clipRegion([[[[30, 30], [40, 30], [40, 40], [30, 40]]]]))).toBe('empty');
    expect(out.indexCount).toBe(0);
  });

  it('refuses two outline loops touching at a vertex', () => {
    const pinched = clipTin(gridTin(4, 1, () => 10), [[[[0, 0], [2, 0], [2, 2], [0, 2]]], [[[2, 2], [4, 2], [4, 4], [2, 4]]]])!;
    expect(capBoundary(pinched)).toBeNull();
  });
});
