// The grid a LiDAR Only model is read into: vertices on the area's own
// rectangle in its rotated frame (metres), each cell centred on a vertex, so
// nothing is resampled between reading the survey and meshing it.

import { rowCrossings } from '../geometry/scanline';
import type { ModelSettings } from '../settings';
import type { MultiPolygon } from '../types';
import type { GridOrigin } from './raster';

/** Printed size of one cell by default: about 0.71 m at 0.07 mm per metre, twice a USGS QL1 survey's return spacing. */
export const DEFAULT_DETAIL_MM = 0.05;
export const MIN_CELL_M = 0.25;
export const MAX_CELL_M = 5;
// Past this, composing and meshing take minutes and too much memory for a
// browser tab, so large areas get larger cells instead.
export const MAX_CELLS = 8_000_000;
// A cell given in metres never grows for the area, so the grid has a hard
// limit instead, from the memory the machine has. This one is for a machine
// that doesn't say (Firefox, Safari).
export const MAX_FIXED_CELLS = 16_000_000;
// GB of memory (navigator.deviceMemory, a power of two up to 32 in Chrome)
// and the cells allowed from there up. San Francisco's 0.25 m grid repeated
// to 33 and 66 million cells peaked at 3.5 and 6.9 GB in Edge, composing and
// meshing with the tile workers. Chrome holds about 16 GB of typed arrays
// per tab, whatever the machine has.
const FIXED_TIERS: [memoryGb: number, cells: number][] = [
  [32, 64_000_000],
  [16, 32_000_000],
  [8, 16_000_000],
];
const SMALL_MACHINE_CELLS = 8_000_000;
/** Blocks read, checkpointed and resumed one at a time. */
export const BLOCK_M = 256;

type CellChoice = Pick<ModelSettings['lidarModel'], 'cellMode' | 'detailMm' | 'cellM'>;

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

/** The cell asked for in metres: worked out from the printed detail, or the one given, whatever the area or scale. */
export function requestedCell(choice: CellChoice, mmPerMetre: number, widthM: number, heightM: number): number {
  if (choice.cellMode !== 'metres') return cellSize(choice.detailMm, mmPerMetre, widthM, heightM);
  if (!(choice.cellM > 0)) throw new Error('The cell size must be more than zero');
  return Math.round(Math.min(Math.max(choice.cellM, MIN_CELL_M), MAX_CELL_M) * 100) / 100;
}

/** The most cells a grid given in metres may have with this much memory in GB, null when the machine doesn't say. `larger` takes the largest tier anyway. */
export function fixedCellLimit(memoryGb: number | null, larger = false): number {
  if (larger) return FIXED_TIERS[0][1];
  if (memoryGb === null || !(memoryGb > 0)) return MAX_FIXED_CELLS;
  for (const [gb, cells] of FIXED_TIERS) if (memoryGb >= gb) return cells;
  return SMALL_MACHINE_CELLS;
}

/** The GB navigator.deviceMemory would report for this many bytes of memory: the nearest power of two, for scripts. */
export function reportedMemoryGb(bytes: number): number {
  return 2 ** Math.round(Math.log2(bytes / 2 ** 30));
}

/** The most cells allowed whatever the machine says (`larger` in fixedCellLimit). */
export const LARGEST_FIXED_CELLS = FIXED_TIERS[0][1];

export function gridCells(widthM: number, heightM: number, cell: number): number {
  return (Math.round(widthM / cell) + 1) * (Math.round(heightM / cell) + 1);
}

/** Why an area is too large for a LiDAR only model at this cell size, or null. `fixedLimit` is the limit for a cell given in metres (fixedCellLimit). */
export function gridProblem(widthM: number, heightM: number, cell: number, fixedLimit?: number): string | null {
  const cells = gridCells(widthM, heightM, cell);
  if (fixedLimit !== undefined) {
    // A little over, so a 2 km square at 0.5 m (4001 x 4001 points) passes 16 million.
    if (cells <= fixedLimit * 1.01) return null;
    const km2 = (fixedLimit * cell * cell) / 1e6;
    return `At ${cell} m cells this area is ${(cells / 1e6).toFixed(1)} million cells, and the limit on this computer is ${fixedLimit / 1e6} million. Use larger cells, or an area under about ${km2 < 10 ? km2.toFixed(1) : Math.round(km2)} km².`;
  }
  // Cells stop growing at MAX_CELL_M, so a big enough area still passes MAX_CELLS.
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

/** Cells of a block whose centre lies in `shape`, one byte each. */
export function cellsInside(shape: MultiPolygon, grid: GridOrigin, block: Block): Uint8Array {
  const width = block.columns[1] - block.columns[0];
  const height = block.rows[1] - block.rows[0];
  const out = new Uint8Array(width * height);
  const rows = rowCrossings(shape.flat(), grid.y0, grid.dy, block.rows[0], height);
  for (let r = 0; r < height; r++) {
    const xs = rows[r];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(block.columns[0], Math.ceil((xs[k] - grid.x0) / grid.dx));
      const c1 = Math.min(block.columns[1], Math.ceil((xs[k + 1] - grid.x0) / grid.dx));
      for (let c = c0; c < c1; c++) out[r * width + (c - block.columns[0])] = 1;
    }
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
