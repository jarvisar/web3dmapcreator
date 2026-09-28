// Returns into per-cell statistics as they're read, so a block never holds
// its points: the add-on's rasterize, one point at a time.

import type { PointReceiver } from '../lidar/read/normalize';
import type { Block } from './grid';

const COUNT_LIMIT = 65535;

/** One block's layers (see SurfaceLayers), row-major over its own cells. */
export interface BlockLayers extends Block {
  top: Float32Array;
  solid: Float32Array;
  ground: Float32Array;
  waterZ: Float32Array;
  count: Uint16Array;
  vegetation: Uint16Array;
  water: Uint16Array;
  building: Uint16Array;
}

export interface GridOrigin {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
}

/**
 * Counts returns into the cells of one block. Returns past the block are
 * ignored, so neighbouring blocks never count one twice. Vegetation-like
 * returns are the vegetation classes and multiple returns nobody
 * classified: what a classified survey calls a tree, and what an
 * unclassified one has in a canopy.
 */
export class BlockRaster implements PointReceiver {
  /** Returns offered, for the readers' budget. */
  count = 0;
  /** Returns inside the block. */
  kept = 0;
  private readonly width: number;
  private readonly height: number;
  // Highest and second highest, of everything and of everything but vegetation.
  private readonly high: Float64Array;
  private readonly second: Float64Array;
  private readonly solidHigh: Float64Array;
  private readonly solidSecond: Float64Array;
  private readonly solidCount: Uint32Array;
  private readonly groundSum: Float64Array;
  private readonly groundCount: Uint32Array;
  private readonly waterSum: Float64Array;
  private readonly total: Uint32Array;
  private readonly vegetation: Uint32Array;
  private readonly water: Uint32Array;
  private readonly building: Uint32Array;

  constructor(
    private readonly grid: GridOrigin,
    private readonly block: Block,
  ) {
    this.width = block.columns[1] - block.columns[0];
    this.height = block.rows[1] - block.rows[0];
    const size = this.width * this.height;
    this.high = new Float64Array(size).fill(-Infinity);
    this.second = new Float64Array(size).fill(-Infinity);
    this.solidHigh = new Float64Array(size).fill(-Infinity);
    this.solidSecond = new Float64Array(size).fill(-Infinity);
    this.solidCount = new Uint32Array(size);
    this.groundSum = new Float64Array(size);
    this.groundCount = new Uint32Array(size);
    this.waterSum = new Float64Array(size);
    this.total = new Uint32Array(size);
    this.vegetation = new Uint32Array(size);
    this.water = new Uint32Array(size);
    this.building = new Uint32Array(size);
  }

  push(x: number, y: number, z: number, cls: number, single: number): void {
    this.count++;
    const i = Math.floor((x - this.grid.x0) / this.grid.dx + 0.5) - this.block.columns[0];
    const j = Math.floor((y - this.grid.y0) / this.grid.dy + 0.5) - this.block.rows[0];
    if (i < 0 || i >= this.width || j < 0 || j >= this.height || !Number.isFinite(z)) return;
    const k = j * this.width + i;
    this.kept++;
    this.total[k]++;
    if (z > this.high[k]) {
      this.second[k] = this.high[k];
      this.high[k] = z;
    } else if (z > this.second[k]) this.second[k] = z;
    const vegetation = cls === 3 || cls === 4 || cls === 5 || (cls === 1 && !single);
    if (vegetation) this.vegetation[k]++;
    else {
      this.solidCount[k]++;
      if (z > this.solidHigh[k]) {
        this.solidSecond[k] = this.solidHigh[k];
        this.solidHigh[k] = z;
      } else if (z > this.solidSecond[k]) this.solidSecond[k] = z;
    }
    if (cls === 2 || cls === 8 || cls === 20) {
      this.groundSum[k] += z;
      this.groundCount[k]++;
    } else if (cls === 9) {
      this.waterSum[k] += z;
      this.water[k]++;
    } else if (cls === 6) this.building[k]++;
  }

  layers(): BlockLayers {
    const size = this.width * this.height;
    const out: BlockLayers = {
      rows: this.block.rows,
      columns: this.block.columns,
      top: new Float32Array(size),
      solid: new Float32Array(size),
      ground: new Float32Array(size),
      waterZ: new Float32Array(size),
      count: new Uint16Array(size),
      vegetation: new Uint16Array(size),
      water: new Uint16Array(size),
      building: new Uint16Array(size),
    };
    for (let k = 0; k < size; k++) {
      const n = this.total[k];
      // The second highest return, or the highest where only one: a bird or one stray return can't raise a cell.
      out.top[k] = n === 0 ? NaN : n === 1 ? this.high[k] : this.second[k];
      const s = this.solidCount[k];
      out.solid[k] = s === 0 ? NaN : s === 1 ? this.solidHigh[k] : this.solidSecond[k];
      out.ground[k] = this.groundCount[k] ? this.groundSum[k] / this.groundCount[k] : NaN;
      out.waterZ[k] = this.water[k] ? this.waterSum[k] / this.water[k] : NaN;
      out.count[k] = Math.min(n, COUNT_LIMIT);
      out.vegetation[k] = Math.min(this.vegetation[k], COUNT_LIMIT);
      out.water[k] = Math.min(this.water[k], COUNT_LIMIT);
      out.building[k] = Math.min(this.building[k], COUNT_LIMIT);
    }
    return out;
  }
}

// ------------------------------------------------------------ density probe

// Share of cells on land allowed to have no return. An empty cell takes a
// neighbour's height, and beside a wall that's the street's, so many of them
// notch roof edges. Returns come in scan lines, not evenly, so this is
// measured rather than worked out from the average density.
export const EMPTY_SHARE = 0.03;
const PROBE_CELL_M = 2;
const MAX_GROWTH = 4;

/** Keeps only where returns fell, for measuring how finely a survey fills a grid. */
export class ProbeSink implements PointReceiver {
  count = 0;
  xs = new Float32Array(1 << 16);
  ys = new Float32Array(1 << 16);
  wet = new Uint8Array(1 << 16);

  constructor(
    private readonly x0: number,
    private readonly y0: number,
  ) {}

  push(x: number, y: number, _z: number, cls: number): void {
    if (this.count === this.xs.length) {
      const grow = <T extends Float32Array | Uint8Array>(a: T): T => {
        const out = new (a.constructor as new (n: number) => T)(a.length * 2);
        out.set(a);
        return out;
      };
      this.xs = grow(this.xs);
      this.ys = grow(this.ys);
      this.wet = grow(this.wet);
    }
    // Offsets from the block's corner keep float32 precise.
    this.xs[this.count] = x - this.x0;
    this.ys[this.count] = y - this.y0;
    this.wet[this.count] = cls === 9 ? 1 : 0;
    this.count++;
  }
}

/**
 * The cell a survey fills, and its returns per m² on land, over one block of
 * width x height metres whose corner the probe's offsets start from. Land is
 * 2 m cells with any return that isn't water, so rivers and the sea count
 * for nothing. The add-on counts any return, and Lake Michigan's scattered
 * water returns grew the Chicago lakefront's cells from 0.71 to 2.08 m. The
 * cell grows in 5% steps from `requested` until at most EMPTY_SHARE of the
 * cells on land are empty. Null when the block is mostly not land.
 */
export function occupiedCell(probe: ProbeSink, width: number, height: number, requested: number): { cell: number; density: number } | null {
  const { xs, ys, wet, count } = probe;
  const cw = Math.ceil(width / PROBE_CELL_M);
  const ch = Math.ceil(height / PROBE_CELL_M);
  const coarse = new Uint32Array(cw * ch);
  const dry = new Uint8Array(cw * ch);
  for (let k = 0; k < count; k++) {
    const i = Math.floor(xs[k] / PROBE_CELL_M);
    const j = Math.floor(ys[k] / PROBE_CELL_M);
    if (i < 0 || i >= cw || j < 0 || j >= ch) continue;
    coarse[j * cw + i]++;
    if (!wet[k]) dry[j * cw + i] = 1;
  }
  let land = 0;
  let onLand = 0;
  for (let c = 0; c < coarse.length; c++) {
    if (!dry[c]) continue;
    land++;
    onLand += coarse[c];
  }
  if (land < 0.3 * coarse.length) return null;
  const density = onLand / (land * PROBE_CELL_M ** 2);
  let cell = requested;
  while (cell < requested * MAX_GROWTH) {
    const nx = Math.floor(width / cell);
    const ny = Math.floor(height / cell);
    const fine = new Uint32Array(nx * ny);
    for (let k = 0; k < count; k++) {
      const i = Math.floor(xs[k] / cell);
      const j = Math.floor(ys[k] / cell);
      if (i >= 0 && i < nx && j >= 0 && j < ny) fine[j * nx + i]++;
    }
    let cells = 0;
    let empty = 0;
    for (let j = 0; j < ny; j++) {
      const cj = Math.min(Math.floor(((j + 0.5) * cell) / PROBE_CELL_M), ch - 1);
      for (let i = 0; i < nx; i++) {
        const ci = Math.min(Math.floor(((i + 0.5) * cell) / PROBE_CELL_M), cw - 1);
        if (!dry[cj * cw + ci]) continue;
        cells++;
        if (!fine[j * nx + i]) empty++;
      }
    }
    if (cells && empty / cells <= EMPTY_SHARE) break;
    cell = Math.round(cell * 1.05 * 1000) / 1000;
  }
  // Up to the next centimetre, without 1.1 * 100 = 110.00000000000001 rounding up to 1.11.
  return { cell: Math.ceil(cell * 100 - 1e-9) / 100, density };
}
