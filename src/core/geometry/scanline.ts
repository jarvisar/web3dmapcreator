// Where horizontal scanlines cross polygon edges, for many rows at once.
// Edges are bucketed by the rows they span, so a coastline with a hundred
// thousand edges costs about one pass instead of one pass per row.

import type { Vec2 } from '../types';

/**
 * Sorted crossing x positions for rows y = y0 + (first + i) * step, i in
 * [0, count). A vertex exactly on a row is counted once (half-open rule).
 */
export function rowCrossings(rings: readonly (readonly Vec2[])[], y0: number, step: number, first: number, count: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < count; i++) rows.push([]);
  if (count <= 0) return rows;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      if (y1 === y2) continue;
      const lo = Math.min(y1, y2);
      const hi = Math.max(y1, y2);
      // Rows with lo <= y < hi, in this block. One row of slack each side:
      // the exact test below decides, so rounding can't skip a row.
      let r0 = Math.ceil((lo - y0) / step) - first - 1;
      let r1 = Math.ceil((hi - y0) / step) - first;
      if (r0 < 0) r0 = 0;
      if (r1 >= count) r1 = count - 1;
      for (let r = r0; r <= r1; r++) {
        const y = y0 + (first + r) * step;
        if (y < lo || y >= hi) continue;
        rows[r].push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
  }
  for (const row of rows) if (row.length > 1) row.sort((a, b) => a - b);
  return rows;
}
