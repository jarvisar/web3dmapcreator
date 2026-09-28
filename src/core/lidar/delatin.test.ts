import { describe, expect, it } from 'vitest';
import { coarsen } from './coarsen';
import { errorScale, gridTin, type Tolerance } from './delatin';
import { NumpyRandom } from './test-helpers';

const nx = 41;
const ny = 31;

function grid(fn: (i: number, j: number) => number): Float64Array {
  const out = new Float64Array(nx * ny);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) out[i * ny + j] = fn(i, j);
  return out;
}

/** Each cell's distance to the TIN as a share of what the tolerance allows, and the cells covered. */
function worst(heights: Float64Array, coords: number[], triangles: number[], tolerance: Tolerance): { error: number; covered: number } {
  let error = 0;
  const seen = new Uint8Array(nx * ny);
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const [ax, ay, bx, by, cx, cy] = [coords[2 * a], coords[2 * a + 1], coords[2 * b], coords[2 * b + 1], coords[2 * c], coords[2 * c + 1]];
    const [za, zb, zc] = [heights[ax * ny + ay], heights[bx * ny + by], heights[cx * ny + cy]];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    expect(area).toBeGreaterThan(0);
    const scale = errorScale(ax, ay, za, bx, by, zb, cx, cy, zc, tolerance);
    for (let i = Math.min(ax, bx, cx); i <= Math.max(ax, bx, cx); i++) {
      for (let j = Math.min(ay, by, cy); j <= Math.max(ay, by, cy); j++) {
        const wa = (bx - i) * (cy - j) - (cx - i) * (by - j);
        const wb = (cx - i) * (ay - j) - (ax - i) * (cy - j);
        const wc = area - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        seen[i * ny + j] = 1;
        error = Math.max(error, Math.abs((wa * za + wb * zb + wc * zc) / area - heights[i * ny + j]) * scale);
      }
    }
  }
  return { error, covered: seen.reduce((s, v) => s + v, 0) };
}

describe('grid TIN', () => {
  const tolerance: Tolerance = { bound: 0.5, across: 0.25, pitch: 0.5 };

  it('covers a plane with two triangles, counter-clockwise', () => {
    const heights = grid((i, j) => 10 + 0.3 * i - 0.1 * j);
    const tin = gridTin(heights, nx, ny, tolerance, 1000);
    expect(tin.triangles.length / 3).toBe(2);
    expect(worst(heights, tin.coords, tin.triangles, tolerance)).toEqual({ error: expect.closeTo(0, 9), covered: nx * ny });
  });

  it('keeps every cell of a rough surface within the tolerance, before and after coarsening', () => {
    const noise = new NumpyRandom(4);
    const heights = grid((i, j) => 20 + (i > 20 ? 6 : 0) + 2 * Math.sin(i / 4) * Math.cos(j / 5) + noise.uniform(-0.3, 0.3)[0]);
    const tin = gridTin(heights, nx, ny, tolerance, 1e6);
    expect(worst(heights, tin.coords, tin.triangles, tolerance).error).toBeLessThanOrEqual(1);
    const kept = coarsen(tin.coords, tin.triangles, heights, nx, ny, tolerance);
    expect(kept.length).toBeLessThan(tin.triangles.length);
    const after = worst(heights, tin.coords, kept, tolerance);
    expect(after.error).toBeLessThanOrEqual(1);
    expect(after.covered).toBe(nx * ny);
  });

  it('lets a diagonal wall run past its staircase within the distance across it', () => {
    // A 45 degree wall between node lines, with every other pair of cells a step out.
    const heights = grid((i, j) => (i + j + (Math.floor(i / 2) % 2) < 36 ? 40 : 10));
    const vertical = gridTin(heights, nx, ny, { ...tolerance, across: 0 }, 1e6);
    const straight = gridTin(heights, nx, ny, { ...tolerance, across: 0.5 }, 1e6);
    expect(straight.triangles.length).toBeLessThan(vertical.triangles.length);
  });

  it('holds weighted cells closer', () => {
    const heights = grid((i, j) => 10 + 0.2 * Math.sin(i / 3) + 0.2 * Math.cos(j / 4));
    const loose = gridTin(heights, nx, ny, tolerance, 1e6);
    const weight = new Float32Array(nx * ny).fill(4);
    const tight = gridTin(heights, nx, ny, { ...tolerance, weight }, 1e6);
    expect(tight.triangles.length).toBeGreaterThan(loose.triangles.length);
  });
});
