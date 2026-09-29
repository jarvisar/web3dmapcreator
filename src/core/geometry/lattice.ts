// The terrain as triangles: every lattice cell split along the diagonal from
// its low corner to its high one. HeightField reads heights off these
// triangles and draped solids are cut from them, so a road and the ground
// under it are flat over the same pieces. Each used to be triangulated on its
// own, and with big cells on steep ground the two surfaces parted by more
// than the road's embed between vertices: 0.4 mm at 3 mm cells.

import type { Polygon } from '../types';
import { ringBounds } from './polygon';
import { rowCrossings } from './scanline';
import type { Tin } from './tinclip';

export interface Lattice {
  x0: number;
  y0: number;
  step: number;
}

/** Height inside a cell from its corners, tx and ty from 0 to 1 across it. */
export function cellHeight(v00: number, v10: number, v01: number, v11: number, tx: number, ty: number): number {
  return tx >= ty ? v00 + tx * (v10 - v00) + ty * (v11 - v10) : v00 + ty * (v01 - v00) + tx * (v11 - v01);
}

/**
 * The lattice's triangles over the cells a polygon touches, with z = 0: cells
 * whose centre is inside, and every cell within one of the outline. The whole
 * bounding box was 1.8 GB for a thin diagonal beach on a fine lattice.
 */
export function latticeTin(lattice: Lattice, rings: Polygon): Tin {
  const { x0, y0, step } = lattice;
  const [minX, minY, maxX, maxY] = ringBounds(rings[0]);
  const c0 = Math.floor((minX - x0) / step) - 2;
  const r0 = Math.floor((minY - y0) / step) - 2;
  const cols = Math.ceil((maxX - x0) / step) + 2 - c0 + 1;
  const rows = Math.ceil((maxY - y0) / step) + 2 - r0 + 1;
  const cells = new Set<number>();
  const mark = (c: number, r: number) => {
    if (c >= c0 && c < c0 + cols && r >= r0 && r < r0 + rows) cells.add((r - r0) * cols + (c - c0));
  };
  // The outline, sampled every half cell, with the cells around each sample.
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j];
      const [bx, by] = ring[i];
      const n = Math.max(1, Math.ceil((2 * Math.hypot(bx - ax, by - ay)) / step));
      for (let k = 0; k <= n; k++) {
        const c = Math.floor((ax + ((bx - ax) * k) / n - x0) / step);
        const r = Math.floor((ay + ((by - ay) * k) / n - y0) / step);
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) mark(c + dc, r + dr);
      }
    }
  }
  // Cells whose centre is inside.
  const crossings = rowCrossings(rings, y0 + step / 2, step, r0, rows);
  crossings.forEach((xs, i) => {
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const first = Math.ceil((xs[k] - x0) / step - 0.5);
      const last = Math.floor((xs[k + 1] - x0) / step - 0.5);
      for (let c = first; c <= last; c++) mark(c, r0 + i);
    }
  });

  // Lattice nodes shared between cells by index.
  const nodes = new Map<number, number>();
  const coords: number[] = [];
  const node = (c: number, r: number) => {
    const key = (r - r0) * (cols + 1) + (c - c0);
    let id = nodes.get(key);
    if (id === undefined) {
      id = coords.length / 3;
      nodes.set(key, id);
      coords.push(x0 + c * step, y0 + r * step, 0);
    }
    return id;
  };
  const triangles = new Uint32Array(cells.size * 6);
  let t = 0;
  for (const key of cells) {
    const c = c0 + (key % cols);
    const r = r0 + Math.floor(key / cols);
    const a = node(c, r);
    const right = node(c + 1, r);
    const high = node(c + 1, r + 1);
    const top = node(c, r + 1);
    // Counter-clockwise: low corner, right, high corner, and low corner, high corner, top.
    triangles.set([a, right, high, a, high, top], t);
    t += 6;
  }
  return { vertices: Float64Array.from(coords), triangles };
}

/**
 * Whether the rings lie in one lattice triangle, where anything following
 * the lattice is a single plane and the outline alone drapes it exactly.
 */
export function inOneTriangle(lattice: Lattice, rings: Polygon): boolean {
  const { x0, y0, step } = lattice;
  const [minX, minY, maxX, maxY] = ringBounds(rings[0]);
  const cx = ((minX + maxX) / 2 - x0) / step;
  const cy = ((minY + maxY) / 2 - y0) / step;
  const c = Math.floor(cx);
  const r = Math.floor(cy);
  const lower = cx - c >= cy - r;
  const eps = 1e-9;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      const u = (x - x0) / step - c;
      const v = (y - y0) / step - r;
      if (u < -eps || u > 1 + eps || v < -eps || v > 1 + eps) return false;
      if (lower ? u < v - eps : v < u - eps) return false;
    }
  }
  return true;
}
