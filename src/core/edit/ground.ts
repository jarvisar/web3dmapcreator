// The ground grid, sent to the viewer so it can put a shape on the ground
// under the pointer, and read back the same way HeightField reads it. A
// LiDAR only model's surface grid can have cells longer one way than the
// other, hence stepY.

import { cellHeight } from '../geometry/lattice';
import type { EditContext } from '../pipeline/generate';

export interface GroundGrid {
  minX: number;
  minY: number;
  step: number;
  /** When rows are spaced differently from columns. */
  stepY?: number;
  cols: number;
  rows: number;
  /** Heights, row by row. */
  values: ArrayLike<number>;
}

/** The grid as sent to the viewer, in its coordinates. */
export type ViewerGround = GroundGrid & { values: Float32Array };

export function groundGrid(ctx: EditContext, zShift: number): ViewerGround | null {
  const hf = ctx.heightfield;
  const grid: GroundGrid | undefined = hf ? { minX: hf.minX, minY: hf.minY, step: hf.step, cols: hf.cols, rows: hf.rows, values: hf.values } : ctx.grid;
  if (!grid) return null;
  const values = new Float32Array(grid.values.length);
  for (let i = 0; i < values.length; i++) values[i] = grid.values[i] + zShift;
  return { ...grid, values };
}

/** Height on the grid's triangles, clamped to its edge outside it. */
export function groundAt(grid: GroundGrid, x: number, y: number): number {
  const maxC = grid.cols - 1;
  const maxR = grid.rows - 1;
  const fx = Math.min(maxC, Math.max(0, (x - grid.minX) / grid.step));
  const fy = Math.min(maxR, Math.max(0, (y - grid.minY) / (grid.stepY ?? grid.step)));
  const c = Math.min(maxC - 1, Math.floor(fx));
  const r = Math.min(maxR - 1, Math.floor(fy));
  const v = grid.values;
  const i = r * grid.cols + c;
  return cellHeight(v[i], v[i + 1], v[i + grid.cols], v[i + grid.cols + 1], fx - c, fy - r);
}
