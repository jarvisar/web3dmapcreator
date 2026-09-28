import { describe, expect, it } from 'vitest';
import { regularize } from './regularize';
import { NumpyRandom } from './test-helpers';

const nx = 60;
const ny = 50;
const pitch = 0.5;
// 8 cells and 2.5 m: a square bump d cells across and h metres tall goes when d * h < 20.
const feature = 8;
const layer = 2.5;

function grid(fn: (i: number, j: number) => number): Float64Array {
  const out = new Float64Array(nx * ny);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) out[i * ny + j] = fn(i, j);
  return out;
}

const all = () => new Uint8Array(nx * ny).fill(1);
const none = () => new Uint8Array(nx * ny);
const inBox = (i: number, j: number, i0: number, j0: number, i1: number, j1: number) => i >= i0 && i < i1 && j >= j0 && j < j1;

describe('regularize', () => {
  it('puts a noisy flat roof exactly level', () => {
    const noise = new NumpyRandom(1);
    const out = regularize(grid(() => 20 + noise.uniform(-0.1, 0.1)[0]), nx, ny, pitch, feature, layer, none(), all());
    expect(Math.max(...out) - Math.min(...out)).toBeLessThan(1e-9);
    expect(Math.abs(out[0] - 20)).toBeLessThan(0.02);
  });

  it('keeps a gable ridge sharp where the two faces meet', () => {
    const noise = new NumpyRandom(2);
    const roof = (i: number) => 30 - Math.abs(i - 30) * pitch * 0.8;
    const out = regularize(grid((i) => roof(i) + noise.uniform(-0.05, 0.05)[0]), nx, ny, pitch, feature, layer, none(), all());
    for (let i = 2; i < nx - 2; i++) for (let j = 2; j < ny - 2; j++) expect(Math.abs(out[i * ny + j] - roof(i))).toBeLessThan(0.05);
  });

  it('flattens a bump too small to print and keeps one that can', () => {
    const small = (i: number, j: number) => inBox(i, j, 5, 5, 8, 8);
    const large = (i: number, j: number) => inBox(i, j, 30, 20, 42, 32);
    const out = regularize(grid((i, j) => (small(i, j) ? 21.5 : large(i, j) ? 23 : 20)), nx, ny, pitch, feature, layer, none(), all());
    expect(out[6 * ny + 6]).toBe(20);
    expect(out[36 * ny + 26]).toBe(23);
    expect(out[45 * ny + 26]).toBe(20);
  });

  it('fills a pit narrower than a feature however deep it is', () => {
    const out = regularize(grid((i, j) => (inBox(i, j, 20, 20, 22, 23) ? -10 : 20)), nx, ny, pitch, feature, layer, none(), all());
    expect(out[21 * ny + 21]).toBe(20);
  });

  it('leaves spires, and cells outside the mask, as they were', () => {
    const heights = grid((i, j) => (i === 30 && j === 25 ? 60 : 20 + 0.01 * ((i * 7 + j * 3) % 5)));
    const keep = none();
    keep[30 * ny + 25] = 1;
    const mask = grid((i) => (i < 50 ? 1 : 0));
    const out = regularize(heights, nx, ny, pitch, feature, layer, keep, Uint8Array.from(mask));
    expect(out[30 * ny + 25]).toBe(60);
    expect(out[31 * ny + 25]).toBe(heights[31 * ny + 25]);
    for (let j = 0; j < ny; j++) expect(out[55 * ny + j]).toBe(heights[55 * ny + j]);
    expect(out[10 * ny + 10]).toBe(out[40 * ny + 40]);
  });
});
