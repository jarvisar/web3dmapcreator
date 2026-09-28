// A polygon set rasterised onto a fine grid, for fast approximate
// point-in-region tests. Exact to about half a cell at the outline.

import type { MultiPolygon } from '../types';
import { multiBounds, ringBounds } from './polygon';
import { rowCrossings } from './scanline';

export class RasterMask {
  private readonly bits: Uint8Array;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cols: number;
  private readonly rows: number;

  constructor(polygons: MultiPolygon, private readonly cell: number) {
    const box = multiBounds(polygons);
    if (!Number.isFinite(box[0])) {
      this.minX = this.minY = 0;
      this.cols = this.rows = 0;
      this.bits = new Uint8Array(0);
      return;
    }
    this.minX = box[0] - cell;
    this.minY = box[1] - cell;
    this.cols = Math.ceil((box[2] - this.minX) / cell) + 2;
    this.rows = Math.ceil((box[3] - this.minY) / cell) + 2;
    this.bits = new Uint8Array(this.cols * this.rows);
    for (const polygon of polygons) {
      if (!polygon.length || polygon[0].length < 3) continue;
      const box = ringBounds(polygon[0]);
      const r0 = Math.max(0, Math.floor((box[1] - this.minY) / cell) - 1);
      const r1 = Math.min(this.rows - 1, Math.ceil((box[3] - this.minY) / cell) + 1);
      const rows = rowCrossings(polygon, this.minY + 0.5 * cell, cell, r0, r1 - r0 + 1);
      for (let r = r0; r <= r1; r++) {
        const xs = rows[r - r0];
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.round((xs[k] - this.minX) / cell));
          const c1 = Math.min(this.cols - 1, Math.round((xs[k + 1] - this.minX) / cell) - 1);
          for (let c = c0; c <= c1; c++) this.bits[r * this.cols + c] = 1;
        }
      }
    }
  }

  has(x: number, y: number): boolean {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((y - this.minY) / this.cell);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return false;
    return this.bits[r * this.cols + c] === 1;
  }
}
