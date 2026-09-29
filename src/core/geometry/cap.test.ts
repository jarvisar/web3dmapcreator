import { describe, expect, it } from 'vitest';
import { capBoundary, constrainedUnderside, meshCap, undersideTriangles } from './cap';
import { clipRegion, MeshBuilder } from './mesher';
import { intersection } from './polygon';
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

  it("leaves out a section that only the cap's box reaches", () => {
    // Inside the L's box but off the L, which used to count as a failed cut.
    const out = new MeshBuilder();
    expect(meshCap(cap, out, clipRegion([[[[6, 5], [9, 5], [9, 9], [6, 9]]]]))).toBe('empty');
    expect(out.indexCount).toBe(0);
  });

  it('cuts through a concave corner of the outline', () => {
    // A V cut into the top edge. The line through its point leaves the upper
    // section two parts touching there, which the cap refuses as it is.
    const outline: [number, number][] = [[1, 1], [9, 1], [9, 9], [5, 5], [1, 9]];
    const notched = clipTin(gridTin(10, 1, (x, y) => 20 + 0.3 * x + 0.1 * y), [[outline]])!;
    const solid: CapSolid = { kind: 'cap', role: 'building', vertices: notched.vertices, triangles: notched.triangles, bottom: 15 };
    const whole = new MeshBuilder();
    expect(meshCap(solid, whole)).toBe('ok');
    const expected = closed(whole);
    let volume = 0;
    for (const [y0, y1] of [[0, 5], [5, 10]]) {
      const out = new MeshBuilder();
      const region = intersection([[[[0, y0], [10, y0], [10, y1], [0, y1]]]], [[outline]]);
      expect(meshCap(solid, out, clipRegion(region))).toBe('ok');
      const { positions, indices } = closed(out);
      volume += signedVolume(positions, indices);
    }
    // Less the 0.1 micron the upper section's region was shrunk by.
    const wholeVolume = signedVolume(expected.positions, expected.indices);
    expect(Math.abs(volume - wholeVolume)).toBeLessThan(1e-3 * wholeVolume);
  });

  it('covers the underside by constrained triangulation too, every outline vertex used', () => {
    // A long, barely sloping edge: the clip leaves a point on it at every
    // grid line, all but in line, like a LiDAR only surface cut along a river.
    const tin = clipTin(gridTin(40, 0.25, (x, y) => 5 + 0.1 * x + 0.05 * y), [
      [
        [[0.3, 0.3], [9.7, 0.31], [9.7, 9.7], [0.3, 9.7]],
        [[3, 3], [3, 6], [6, 6], [6, 3]],
      ],
    ])!;
    const boundary = capBoundary(tin)!;
    const under = constrainedUnderside(tin, boundary)!;
    expect(under).not.toBeNull();
    const used = new Set(under.triangles);
    for (const [a] of boundary) expect(used.has(a)).toBe(true);
    const v = tin.vertices;
    let area = 0;
    for (let t = 0; t < under.triangles.length; t += 3) {
      const [a, b, c] = [3 * under.triangles[t], 3 * under.triangles[t + 1], 3 * under.triangles[t + 2]];
      const cross = (v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[b + 1] - v[a + 1]) * (v[c] - v[a]);
      expect(cross).toBeGreaterThan(0);
      area += cross / 2;
    }
    expect(area).toBeCloseTo(9.4 * 9.395 - 9, 6);
  });

  it('refuses two outline loops touching at a vertex', () => {
    const pinched = clipTin(gridTin(4, 1, () => 10), [[[[0, 0], [2, 0], [2, 2], [0, 2]]], [[[2, 2], [4, 2], [4, 4], [2, 4]]]])!;
    expect(capBoundary(pinched)).toBeNull();
  });
});
