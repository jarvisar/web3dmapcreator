import { describe, expect, it } from 'vitest';
import type { Polygon } from '../types';
import { MeshBuilder, meshPrism, meshSolid, newMeshStats } from './mesher';
import { difference, polygonArea, rectangle, union } from './polygon';
import { edgeReport, signedVolume } from './validate';

function mesh(polygon: Polygon, top: number | ((x: number, y: number) => number), bottom: number | ((x: number, y: number) => number), drape = 0) {
  const out = new MeshBuilder();
  const result = meshPrism(polygon, { top, bottom, drape }, out);
  const { positions, indices } = out.finish();
  return { result, positions, indices, report: edgeReport(indices, positions.length / 3), volume: signedVolume(positions, indices) };
}

function circle(cx: number, cy: number, r: number, n = 48, clockwise = false) {
  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((clockwise ? -1 : 1) * 2 * Math.PI * i) / n;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return ring;
}

describe('meshPrism', () => {
  it('closes a flat box with the right volume', () => {
    const m = mesh(rectangle(0, 0, 10, 5)[0], 3, 1);
    expect(m.result).toBe('ok');
    expect(m.report.open).toBe(0);
    expect(m.report.repeated).toBe(0);
    expect(m.volume).toBeCloseTo(100, 6);
  });

  it('accepts either ring orientation', () => {
    const cw: Polygon = [[[0, 0], [0, 5], [10, 5], [10, 0]]];
    const m = mesh(cw, 1, 0);
    expect(m.report.open).toBe(0);
    expect(m.volume).toBeCloseTo(50, 6);
  });

  it('keeps holes open', () => {
    const polygon = difference(rectangle(0, 0, 20, 20), rectangle(5, 5, 15, 15))[0];
    const m = mesh(polygon, 2, 0);
    expect(m.report.open).toBe(0);
    expect(m.volume).toBeCloseTo(2 * (400 - 100), 6);
  });

  it('drapes a lattice over a sloped surface and stays closed', () => {
    const polygon: Polygon = [circle(0, 0, 20), circle(4, 3, 5, 24, true)];
    const slope = (x: number, y: number) => 2 + 0.1 * x + 0.05 * y + Math.sin(x / 3);
    const m = mesh(polygon, (x, y) => slope(x, y) + 0.4, (x, y) => slope(x, y) - 0.15, 0.75);
    expect(m.result).toBe('ok');
    expect(m.report.open).toBe(0);
    expect(m.report.repeated).toBe(0);
    // Interior points were added.
    expect(m.indices.length / 3).toBeGreaterThan(2000);
    const area = polygonArea(polygon);
    expect(m.volume).toBeGreaterThan(area * 0.5);
    expect(m.volume).toBeLessThan(area * 0.6);
  });

  it('uses the outline only for a flat bottom under a draped top', () => {
    const polygon = rectangle(0, 0, 30, 30)[0];
    const draped = mesh(polygon, (x) => 2 + x * 0.01, 0, 1);
    const both = mesh(polygon, (x) => 2 + x * 0.01, (x) => x * 0.0001 - 0.001, 1);
    expect(draped.report.open).toBe(0);
    expect(draped.indices.length).toBeLessThan(both.indices.length * 0.8);
    expect(draped.volume).toBeCloseTo(30 * 30 * (2 + 0.15), 3);
  });

  it('handles touching holes and pinch points from boolean results', () => {
    const blocks = union(rectangle(0, 0, 10, 10), rectangle(10, 10, 20, 20));
    // Two squares meeting at a corner: one polygon with a pinch or two polygons.
    const out = new MeshBuilder();
    const stats = newMeshStats();
    for (const polygon of blocks) {
      meshSolid({ kind: 'prism', role: 'terrain', polygon, top: 1, bottom: 0, drape: 0.7 }, out, undefined, stats);
    }
    const { positions, indices } = out.finish();
    expect(stats.failed).toBe(0);
    expect(edgeReport(indices, positions.length / 3).open).toBe(0);
    expect(signedVolume(positions, indices)).toBeCloseTo(200, 4);
  });

  it('parts a hole whose tip touches the outline instead of sharing an edge', () => {
    const notch: Polygon = [[[5, 0], [7, 4], [3, 4]]];
    const pinched = difference(rectangle(0, 0, 10, 10), [notch]);
    const out = new MeshBuilder();
    const stats = newMeshStats();
    for (const polygon of pinched) {
      meshSolid({ kind: 'prism', role: 'terrain', polygon, top: 2, bottom: 0, drape: 0.5 }, out, undefined, stats);
    }
    const { positions, indices } = out.finish();
    const report = edgeReport(indices, positions.length / 3);
    expect(stats.failed).toBe(0);
    expect(report.open).toBe(0);
    expect(report.repeated).toBe(0);
    // Shrinking by a tenth of a micron costs perimeter x 1e-4 x height.
    expect(signedVolume(positions, indices)).toBeCloseTo(2 * (100 - 8), 1);
  });

  it('does not count a draped triangle smaller than a cell as a fallback', () => {
    const stats = newMeshStats();
    const triangle: Polygon = [[[0, 0], [0.3, 0], [0, 0.3]]];
    meshSolid({ kind: 'prism', role: 'terrain', polygon: triangle, top: (x) => 1 + x, bottom: 0, drape: 1 }, new MeshBuilder(), undefined, stats);
    expect(stats).toEqual({ solids: 1, failed: 0, fallbacks: 0 });
  });

  it('leaves a tree crossing a section edge out of the section', () => {
    const tree = (x: number) => ({
      kind: 'mesh' as const,
      role: 'tree' as const,
      positions: new Float32Array([x - 0.5, 0, 0, x + 0.5, 0, 0, x, 0.5, 1]),
      indices: [0, 1, 2],
      anchor: [x, 0] as [number, number],
    });
    const count = (x: number) => {
      const out = new MeshBuilder();
      meshSolid(tree(x), out, rectangle(0, -5, 10, 5));
      return out.triangleCount;
    };
    expect(count(5)).toBe(1);
    expect(count(9.8)).toBe(0);
    expect(count(10.2)).toBe(0);
  });

  it('clips a solid to a section', () => {
    const out = new MeshBuilder();
    meshSolid(
      { kind: 'prism', role: 'terrain', polygon: rectangle(0, 0, 10, 10)[0], top: 2, bottom: 0, drape: 0 },
      out,
      rectangle(5, -1, 20, 20),
    );
    const { positions, indices } = out.finish();
    expect(signedVolume(positions, indices)).toBeCloseTo(100, 6);
  });

  it('never makes a prism thinner than the minimum', () => {
    const m = mesh(rectangle(0, 0, 4, 4)[0], 0, 1);
    expect(m.report.open).toBe(0);
    expect(m.volume).toBeGreaterThan(0);
  });

  it('meshes a long thin ribbon with many collinear points', () => {
    const ribbon: Polygon = [[[0, 0], [200, 0], [200, 0.5], [0, 0.5]]];
    const m = mesh(ribbon, (x) => 1 + Math.sin(x / 10), (x) => Math.sin(x / 10) - 0.15, 0.8);
    expect(m.report.open).toBe(0);
    expect(m.volume).toBeCloseTo(200 * 0.5 * 1.15, 1);
  });
});
