// The one terrain surface every layer is aligned to. The elevation source is
// resampled once, in model millimetres, onto the grid the terrain mesh is
// built from, and roads, water, parks, trees and foundations all interpolate
// this grid. A road then cannot sink into a hill the terrain mesh renders
// differently, because both read the same numbers.

import type { Box } from '../geometry/polygon';
import { rowCrossings } from '../geometry/scanline';
import type { Polygon, Ring, Vec2 } from '../types';

export class HeightField {
  readonly minX: number;
  readonly minY: number;
  /** Cells are square. */
  readonly step: number;
  readonly cols: number;
  readonly rows: number;
  values: Float64Array;

  constructor(minX: number, minY: number, step: number, cols: number, rows: number, values?: Float64Array) {
    if (cols < 2 || rows < 2) throw new Error('Height field must be at least 2 x 2');
    this.minX = minX;
    this.minY = minY;
    this.step = step;
    this.cols = cols;
    this.rows = rows;
    this.values = values ?? new Float64Array(cols * rows);
  }

  /**
   * A grid covering `bounds` with `resolution` cells across the longer side,
   * sampled with `sample(x, y)` in model mm.
   */
  static build(bounds: Box, resolution: number, sample: (x: number, y: number) => number): HeightField {
    const width = bounds[2] - bounds[0];
    const height = bounds[3] - bounds[1];
    const step = Math.max(width, height) / Math.max(2, Math.min(1024, Math.round(resolution)));
    const cols = Math.max(2, Math.ceil(width / step) + 1);
    const rows = Math.max(2, Math.ceil(height / step) + 1);
    // Centre the grid on the bounds so both edges get the same overhang.
    const minX = (bounds[0] + bounds[2]) / 2 - ((cols - 1) * step) / 2;
    const minY = (bounds[1] + bounds[3]) / 2 - ((rows - 1) * step) / 2;
    const field = new HeightField(minX, minY, step, cols, rows);
    for (let r = 0; r < rows; r++) {
      const y = minY + r * step;
      for (let c = 0; c < cols; c++) field.values[r * cols + c] = sample(minX + c * step, y);
    }
    return field;
  }

  static flat(bounds: Box, resolution: number, height = 0): HeightField {
    return HeightField.build(bounds, resolution, () => height);
  }

  get maxX(): number {
    return this.minX + (this.cols - 1) * this.step;
  }

  get maxY(): number {
    return this.minY + (this.rows - 1) * this.step;
  }

  nodeX(c: number): number {
    return this.minX + c * this.step;
  }

  nodeY(r: number): number {
    return this.minY + r * this.step;
  }

  clone(): HeightField {
    return new HeightField(this.minX, this.minY, this.step, this.cols, this.rows, this.values.slice());
  }

  min(): number {
    let m = Infinity;
    for (const v of this.values) if (v < m) m = v;
    return m;
  }

  max(): number {
    let m = -Infinity;
    for (const v of this.values) if (v > m) m = v;
    return m;
  }

  /** Bilinear height, clamped to the grid edge outside it. */
  heightAt(x: number, y: number): number {
    let fx = (x - this.minX) / this.step;
    let fy = (y - this.minY) / this.step;
    const maxC = this.cols - 1;
    const maxR = this.rows - 1;
    if (fx < 0) fx = 0;
    else if (fx > maxC) fx = maxC;
    if (fy < 0) fy = 0;
    else if (fy > maxR) fy = maxR;
    let c = Math.floor(fx);
    let r = Math.floor(fy);
    if (c >= maxC) c = maxC - 1;
    if (r >= maxR) r = maxR - 1;
    const tx = fx - c;
    const ty = fy - r;
    const v = this.values;
    const i = r * this.cols + c;
    const lower = v[i] * (1 - tx) + v[i + 1] * tx;
    const upper = v[i + this.cols] * (1 - tx) + v[i + this.cols + 1] * tx;
    return lower * (1 - ty) + upper * ty;
  }

  /**
   * Replace every node by the mean of its (2r + 1) square neighbourhood. The
   * elevation tiles carry a metre or two of pixel noise, which prints as
   * one-layer steps along draped roads. The window is clipped at the edges.
   */
  smooth(radius: number): void {
    if (radius <= 0) return;
    const { cols, rows } = this;
    const pass = (input: Float64Array, horizontal: boolean): Float64Array => {
      const out = new Float64Array(input.length);
      const lines = horizontal ? rows : cols;
      const length = horizontal ? cols : rows;
      const stride = horizontal ? 1 : cols;
      for (let line = 0; line < lines; line++) {
        const base = horizontal ? line * cols : line;
        for (let p = 0; p < length; p++) {
          const lo = Math.max(0, p - radius);
          const hi = Math.min(length - 1, p + radius);
          let sum = 0;
          for (let q = lo; q <= hi; q++) sum += input[base + q * stride];
          out[base + p * stride] = sum / (hi - lo + 1);
        }
      }
      return out;
    };
    this.values = pass(pass(this.values, true), false);
  }

  // Node sets depend only on the grid and the polygon, and water asks for
  // the same polygon several times. The arrays are shared: don't mutate them.
  private readonly insideCache = new WeakMap<Polygon, number[]>();

  /** Grid node indices inside a polygon (outer ring then holes), found by scanline. */
  nodesInside(polygon: Polygon): number[] {
    const cached = this.insideCache.get(polygon);
    if (cached) return cached;
    const nodes: number[] = [];
    if (!polygon.length || polygon[0].length < 3) return nodes;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of polygon[0]) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const firstRow = Math.max(0, Math.ceil((minY - this.minY) / this.step));
    const lastRow = Math.min(this.rows - 1, Math.floor((maxY - this.minY) / this.step));
    const rows = rowCrossings(polygon, this.minY, this.step, firstRow, lastRow - firstRow + 1);
    for (let i = 0; i < rows.length; i++) {
      const r = firstRow + i;
      const crossings = rows[i];
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const first = Math.max(0, Math.ceil((crossings[k] - this.minX) / this.step));
        const last = Math.min(this.cols - 1, Math.floor((crossings[k + 1] - this.minX) / this.step));
        for (let c = first; c <= last; c++) nodes.push(r * this.cols + c);
      }
    }
    this.insideCache.set(polygon, nodes);
    return nodes;
  }

  /**
   * Clamp nodes inside a polygon to `level`. Lowering only by default, so a
   * water polygon that overlaps a bank a little does not flood it.
   */
  flattenInside(polygon: Polygon, level: number, raise = false): number {
    let changed = 0;
    for (const i of this.nodesInside(polygon)) {
      const v = this.values[i];
      if (v > level || (raise && v < level)) {
        this.values[i] = level;
        changed++;
      }
    }
    return changed;
  }

  minOver(points: Iterable<Vec2>): number {
    let m = Infinity;
    for (const [x, y] of points) m = Math.min(m, this.heightAt(x, y));
    return Number.isFinite(m) ? m : 0;
  }

  maxOver(points: Iterable<Vec2>): number {
    let m = -Infinity;
    for (const [x, y] of points) m = Math.max(m, this.heightAt(x, y));
    return Number.isFinite(m) ? m : 0;
  }

  /** An order statistic of the height over points: 0.5 is the median. */
  percentileOver(points: Iterable<Vec2>, fraction: number): number {
    const samples: number[] = [];
    for (const [x, y] of points) samples.push(this.heightAt(x, y));
    if (!samples.length) return 0;
    samples.sort((a, b) => a - b);
    return samples[Math.floor(Math.max(0, Math.min(1, fraction)) * (samples.length - 1))];
  }
}

/** Sorted x positions where the horizontal line at `y` crosses the polygon's edges. */
export function lineCrossings(polygon: Polygon | Ring[], y: number): number[] {
  const xs: number[] = [];
  for (const ring of polygon) {
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      // Half-open rule so a vertex on the line is counted once.
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
  }
  xs.sort((a, b) => a - b);
  return xs;
}

/** Points on a regular grid inside a polygon, `spacing` apart. */
export function interiorPoints(polygon: Polygon, spacing: number, limit = Infinity): Vec2[] {
  const out: Vec2[] = [];
  if (!polygon.length || !(spacing > 0)) return out;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of polygon[0]) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const first = Math.floor(minY / spacing);
  const count = Math.max(0, Math.ceil((maxY - spacing / 2) / spacing) - first + 1);
  const rows = rowCrossings(polygon, spacing / 2, spacing, first, count);
  for (let i = 0; i < rows.length && out.length < limit; i++) {
    const y = (first + i) * spacing + spacing / 2;
    if (y >= maxY) break;
    const xs = rows[i];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.ceil((xs[k] - spacing / 2) / spacing) * spacing + spacing / 2;
      for (let x = x0; x < xs[k + 1]; x += spacing) {
        out.push([x, y]);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}
