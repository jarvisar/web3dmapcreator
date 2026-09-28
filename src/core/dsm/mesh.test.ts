import { describe, expect, it } from 'vitest';
import { meshCap } from '../geometry/cap';
import { MeshBuilder } from '../geometry/mesher';
import { edgeReport, signedVolume } from '../geometry/validate';
import { NumpyRandom } from '../lidar/test-helpers';
import { Collapser, gridSide, meshSurface, rtinBlock, type HeightGrid, type MeshLimits } from './mesh';

interface Surface {
  vertices: Float64Array;
  triangles: Uint32Array;
}

function grid(nx: number, ny: number, height: (i: number, j: number) => number, detail?: (i: number, j: number) => number): HeightGrid {
  const heights = new Float32Array(nx * ny);
  const factors = new Float32Array(nx * ny).fill(1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      heights[j * nx + i] = height(i, j);
      if (detail) factors[j * nx + i] = detail(i, j);
    }
  }
  return { heights, detail: factors, nx, ny, x0: 0, y0: 0, x1: nx - 1, y1: ny - 1, dx: 1, dy: 1 };
}

/** Plan area, and how many triangles are not counter-clockwise. */
function tiling(s: Surface): { area: number; flipped: number } {
  const v = s.vertices;
  const f = s.triangles;
  let area = 0;
  let flipped = 0;
  for (let t = 0; t < f.length; t += 3) {
    const [a, b, c] = [3 * f[t], 3 * f[t + 1], 3 * f[t + 2]];
    const cross = (v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1]);
    if (cross <= 0) flipped++;
    area += cross / 2;
  }
  return { area, flipped };
}

/** Edges used by one triangle only, all of which must lie on the rectangle. */
function rimOnly(s: Surface, x1: number, y1: number): boolean {
  const f = s.triangles;
  const v = s.vertices;
  const uses = new Map<string, number>();
  for (let t = 0; t < f.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = f[t + k];
      const b = f[t + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of uses) {
    if (n > 2) return false;
    if (n === 2) continue;
    const [a, b] = key.split(',').map(Number);
    const onSide = (value: (i: number) => number, edge: number) => value(a) === edge && value(b) === edge;
    const x = (i: number) => v[3 * i];
    const y = (i: number) => v[3 * i + 1];
    if (!(onSide(x, 0) || onSide(x, x1) || onSide(y, 0) || onSide(y, y1))) return false;
  }
  return true;
}

/** Height of the surface over (x, y), and its slope's cosine there. NaN outside every face. */
function sample(s: Surface, x: number, y: number): [number, number] {
  const v = s.vertices;
  const f = s.triangles;
  for (let t = 0; t < f.length; t += 3) {
    const [a, b, c] = [3 * f[t], 3 * f[t + 1], 3 * f[t + 2]];
    const det = (v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1]);
    const wa = ((v[b] - x) * (v[c + 1] - y) - (v[b + 1] - y) * (v[c] - x)) / det;
    const wb = ((v[c] - x) * (v[a + 1] - y) - (v[c + 1] - y) * (v[a] - x)) / det;
    const wc = 1 - wa - wb;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
    const gx = ((v[b + 2] - v[a + 2]) * (v[c + 1] - v[a + 1]) - (v[c + 2] - v[a + 2]) * (v[b + 1] - v[a + 1])) / det;
    const gy = ((v[c + 2] - v[a + 2]) * (v[b] - v[a]) - (v[b + 2] - v[a + 2]) * (v[c] - v[a])) / det;
    return [wa * v[a + 2] + wb * v[b + 2] + wc * v[c + 2], 1 / Math.sqrt(1 + gx * gx + gy * gy)];
  }
  return [NaN, NaN];
}

/** Largest distance square to the surface over the grid points, as a share of each point's allowance. */
function worst(s: Surface, g: HeightGrid, deviation: number): number {
  let out = 0;
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const [z, square] = sample(s, i, j);
      out = Math.max(out, (Math.abs(z - g.heights[j * g.nx + i]) * square) / (deviation * g.detail[j * g.nx + i]));
    }
  }
  return out;
}

function rtinSurface(g: HeightGrid, tolerance: number): Surface {
  const tris = rtinBlock(g.heights, null, g.nx, g.ny, tolerance);
  const vertices = new Float64Array((tris.length / 2) * 3);
  const triangles = new Uint32Array(tris.length / 2);
  for (let k = 0; k < tris.length; k += 2) {
    const n = k / 2;
    vertices[3 * n] = tris[k];
    vertices[3 * n + 1] = tris[k + 1];
    vertices[3 * n + 2] = g.heights[tris[k + 1] * g.nx + tris[k]];
    triangles[n] = n;
  }
  return { vertices, triangles };
}

const cumulative = (rng: NumpyRandom, nx: number, ny: number, scale: number) => {
  const values = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = (rng.random() - 0.5) * scale + (j ? values[(j - 1) * nx + i] : 0);
  return values;
};

describe('rtin', () => {
  it('covers a rectangle that is not a power of two', () => {
    const rng = new NumpyRandom(3);
    const values = cumulative(rng, 53, 37, 2);
    const g = grid(53, 37, (i, j) => values[j * 53 + i]);
    for (const tolerance of [1e-9, 0.5, 5]) {
      const s = rtinSurface(g, tolerance);
      const { area, flipped } = tiling(s);
      expect(flipped).toBe(0);
      expect(area).toBeCloseTo(52 * 36, 9);
    }
  });

  it('keeps every grid point within the tolerance', () => {
    const g = grid(45, 33, (i, j) => Math.sin(i / 5) * 3 + j * 0.3 + (i >= 12 && i < 30 && j >= 10 && j < 20 ? 8 : 0));
    const s = rtinSurface(g, 0.25);
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) expect(Math.abs(sample(s, i, j)[0] - g.heights[j * g.nx + i])).toBeLessThanOrEqual(0.25 + 1e-9);
    }
  });

  it('needs few triangles on flat ground', () => {
    const tris = rtinBlock(new Float32Array(65 * 65), null, 65, 65, 0.01);
    // Only the refinement forced along the block's edge remains.
    expect(tris.length / 6).toBeLessThan(65 * 4 * 4);
  });
});

const LIMITS = (deviation: number, threshold: number): MeshLimits => ({ deviation, threshold, minGap: 1e-3 });

describe('meshSurface', () => {
  it('collapses a flat rectangle to two triangles', async () => {
    const s = await meshSurface(grid(31, 21, () => 0), LIMITS(0.1, 0.01));
    expect(s.triangles.length / 3).toBe(2);
    const corners = new Set<string>();
    for (let k = 0; k < s.vertices.length; k += 3) corners.add(`${s.vertices[k]},${s.vertices[k + 1]}`);
    expect(corners).toEqual(new Set(['0,0', '30,0', '0,20', '30,20']));
  });

  it('keeps a block, its outline and the bound', async () => {
    const g = grid(41, 41, (i, j) => (i >= 15 && i < 21 && j >= 14 && j < 20 ? 15 : i >= 12 && i < 28 && j >= 10 && j < 30 ? 12 : 0));
    const s = await meshSurface(g, LIMITS(0.5, 1));
    const { area, flipped } = tiling(s);
    expect(flipped).toBe(0);
    expect(area).toBeCloseTo(40 * 40, 9);
    expect(rimOnly(s, 40, 40)).toBe(true);
    expect(s.triangles.length / 3).toBeLessThan(200);
    // Roof, step and ground stay where they were, away from the walls.
    expect(sample(s, 20, 25)[0]).toBeCloseTo(12, 0);
    expect(sample(s, 17.5, 16.5)[0]).toBeCloseTo(15, 0);
    expect(sample(s, 4, 4)[0]).toBeCloseTo(0, 0);
    expect(sample(s, 36, 36)[0]).toBeCloseTo(0, 0);
    expect(worst(s, g, 0.5)).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('straightens a wall drawn in stairs', async () => {
    // A 45 degree wall in one-cell stairs.
    const g = grid(41, 41, (i, j) => (i + j > 40 ? 20 : 0));
    const before = rtinSurface(g, 0.5).triangles.length / 3;
    const s = await meshSurface(g, LIMITS(1, 16));
    expect(s.triangles.length / 3).toBeLessThan(before / 20);
    expect(tiling(s).flipped).toBe(0);
    expect(worst(s, g, 1)).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('keeps a penthouse a box', async () => {
    // Priced only against the faces as they are, a corner could slide down
    // its wall a little at a time until the penthouse was a pyramid.
    const g = grid(61, 61, (i, j) => {
      if (i >= 26 && i < 34 && j >= 27 && j < 33) return 30;
      return i >= 10 && i < 50 && j >= 10 && j < 50 ? 24 : 0;
    });
    const s = await meshSurface(g, LIMITS(1, 16));
    for (const [x, y] of [[26.5, 27.5], [33, 27.5], [26.5, 32], [33, 32], [30, 30]]) expect(sample(s, x, y)[0]).toBeGreaterThan(29);
    expect(worst(s, g, 1)).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('holds finer detail where asked', async () => {
    const rng = new NumpyRandom(8);
    const values = cumulative(rng, 40, 30, 1.5);
    const g = grid(40, 30, (i, j) => values[j * 40 + i], (i) => (i < 20 ? 0.4 : 1));
    const s = await meshSurface(g, LIMITS(1, 16));
    expect(worst(s, g, 1)).toBeLessThanOrEqual(1 + 1e-6);
    const coarse = await meshSurface({ ...g, detail: new Float32Array(g.detail.length).fill(1) }, LIMITS(1, 16));
    expect(s.triangles.length).toBeGreaterThan(coarse.triangles.length);
  });

  it('simplifies tiles apart and joins them at their seams', async () => {
    const rng = new NumpyRandom(5);
    const g = grid(71, 50, (i, j) => {
      const block = (i * 7 + j * 3) % 23 < 9 && ((i >> 3) + (j >> 3)) % 2 === 0;
      return (block ? 10 + ((i >> 3) % 3) * 4 : 0) + rng.random() * 0.2;
    });
    const s = await meshSurface(g, LIMITS(0.5, 4), { tile: 16, concurrency: 3 });
    const { area, flipped } = tiling(s);
    expect(flipped).toBe(0);
    expect(area).toBeCloseTo(70 * 49, 9);
    expect(rimOnly(s, 70, 49)).toBe(true);
    expect(worst(s, g, 0.5)).toBeLessThanOrEqual(1 + 1e-6);
    // The seams collapsed too: about as few triangles as one tile.
    const whole = await meshSurface(g, LIMITS(0.5, 4), { tile: 128 });
    expect(s.triangles.length).toBeLessThan(whole.triangles.length * 1.15);
  });

  it('closes into a solid with the cap walls and underside', async () => {
    const g = grid(19, 25, (i, j) => (i >= 4 && i < 12 && j >= 5 && j < 15 ? 6 : 0));
    const s = await meshSurface(g, LIMITS(0.3, 0.5));
    const out = new MeshBuilder();
    expect(meshCap({ kind: 'cap', role: 'terrain', vertices: s.vertices, triangles: s.triangles, bottom: -2 }, out)).toBe('ok');
    const { positions, indices } = out.finish();
    const report = edgeReport(indices, positions.length / 3);
    expect([report.open, report.repeated]).toEqual([0, 0]);
    const expected = 18 * 24 * 2 + 8 * 10 * 6;
    expect(signedVolume(positions, indices)).toBeCloseTo(expected, -Math.log10(expected * 0.02));
  });
});

describe('Collapser', () => {
  it('slides rim vertices along their side only and never moves corners', () => {
    const g = grid(9, 9, (i, j) => (i === 4 && j === 0 ? 3 : 0));
    const s = rtinSurface(g, 1e-9);
    // Deduplicate RTIN's per-triangle vertices.
    const index = new Map<string, number>();
    const positions: number[] = [];
    const triangles = new Uint32Array(s.triangles.length);
    for (let k = 0; k < s.triangles.length; k++) {
      const v = 3 * s.triangles[k];
      const key = `${s.vertices[v]},${s.vertices[v + 1]}`;
      if (!index.has(key)) {
        index.set(key, positions.length / 3);
        positions.push(s.vertices[v], s.vertices[v + 1], s.vertices[v + 2]);
      }
      triangles[k] = index.get(key)!;
    }
    const n = positions.length / 3;
    const side = new Uint8Array(n);
    for (let v = 0; v < n; v++) side[v] = gridSide(positions[3 * v], positions[3 * v + 1], 9, 9);
    const collapser = new Collapser(
      { positions: Float64Array.from(positions), triangles, side, pinned: new Uint8Array(n), detail: new Float32Array(n).fill(1), keys: new Int32Array(n).fill(-1) },
      LIMITS(0.5, 10),
      null,
    );
    collapser.run();
    const out = collapser.result();
    const result = { vertices: out.positions, triangles: out.triangles };
    expect(tiling(result).area).toBeCloseTo(64, 9);
    expect(rimOnly(result, 8, 8)).toBe(true);
    const points = new Set<string>();
    for (let k = 0; k < out.positions.length; k += 3) points.add(`${out.positions[k]},${out.positions[k + 1]}`);
    for (const corner of ['0,0', '8,0', '0,8', '8,8']) expect(points.has(corner)).toBe(true);
  });
});
