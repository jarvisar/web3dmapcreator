// The grid a LiDAR Only model is read into: vertices on the area's own
// rectangle in its rotated frame (metres), each cell centred on a vertex, so
// nothing is resampled between reading the survey and meshing it.

/** Printed size of one cell by default: about 0.71 m at 0.07 mm per metre, twice a USGS QL1 survey's return spacing. */
export const DEFAULT_DETAIL_MM = 0.05;
export const MIN_CELL_M = 0.25;
export const MAX_CELL_M = 5;
// Past this, composing and meshing take minutes and too much memory for a
// browser tab, so large areas get larger cells instead.
export const MAX_CELLS = 8_000_000;
/** Blocks read, checkpointed and resumed one at a time. */
export const BLOCK_M = 256;

export interface GridSpec {
  /** The rectangle, centred on the area: vertex (i, j) at (x0 + i dx, y0 + j dy). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cell: number;
  nx: number;
  ny: number;
  dx: number;
  dy: number;
}

/** Cell size in metres for a printed detail, grown so the grid stays under MAX_CELLS. */
export function cellSize(detailMm: number, mmPerMetre: number, widthM: number, heightM: number): number {
  if (!(detailMm > 0 && mmPerMetre > 0)) throw new Error('Detail and scale must be more than zero');
  const cell = Math.max(detailMm / mmPerMetre, Math.sqrt((widthM * heightM) / MAX_CELLS), MIN_CELL_M);
  return Math.round(Math.min(cell, MAX_CELL_M) * 100) / 100;
}

/** Why an area is too large for a LiDAR only model at this cell size, or null. */
export function gridProblem(widthM: number, heightM: number, cell: number): string | null {
  // Cells stop growing at MAX_CELL_M, so a big enough area still passes MAX_CELLS.
  const cells = (Math.round(widthM / cell) + 1) * (Math.round(heightM / cell) + 1);
  if (cells <= MAX_CELLS * 1.05) return null;
  const side = Math.floor((Math.sqrt(MAX_CELLS) * MAX_CELL_M) / 1000);
  return `This area is too large for a LiDAR only model. Keep it under about ${side} km across.`;
}

export function gridSpec(widthM: number, heightM: number, cell: number): GridSpec {
  const x0 = -widthM / 2;
  const y0 = -heightM / 2;
  const nx = Math.max(2, Math.round(widthM / cell) + 1);
  const ny = Math.max(2, Math.round(heightM / cell) + 1);
  return { x0, y0, x1: widthM / 2, y1: heightM / 2, cell, nx, ny, dx: widthM / (nx - 1), dy: heightM / (ny - 1) };
}

export interface Block {
  /** Half-open ranges of rows and columns. */
  rows: [number, number];
  columns: [number, number];
}

export function blocks(grid: GridSpec): Block[] {
  const stepX = Math.max(1, Math.round(BLOCK_M / grid.dx));
  const stepY = Math.max(1, Math.round(BLOCK_M / grid.dy));
  const out: Block[] = [];
  for (let r = 0; r < grid.ny; r += stepY) {
    for (let c = 0; c < grid.nx; c += stepX) out.push({ rows: [r, Math.min(grid.ny, r + stepY)], columns: [c, Math.min(grid.nx, c + stepX)] });
  }
  return out;
}

/** What a block's cells cover, plus `margin` metres: west, south, east, north. */
export function blockExtent(grid: GridSpec, block: Block, margin = 0): [number, number, number, number] {
  const { rows, columns } = block;
  return [
    grid.x0 + (columns[0] - 0.5) * grid.dx - margin,
    grid.y0 + (rows[0] - 0.5) * grid.dy - margin,
    grid.x0 + (columns[1] - 0.5) * grid.dx + margin,
    grid.y0 + (rows[1] - 0.5) * grid.dy + margin,
  ];
}
