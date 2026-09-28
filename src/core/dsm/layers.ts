// Per-cell statistics of a LiDAR Only grid, as the survey reading leaves
// them and compose reads them. Heights stay in the survey's own vertical
// datum, since the model only uses their differences.
//
// Grids are row-major with row 0 at the south edge: cell (row, column) is at
// index row * nx + column, centred on grid vertex (column, row).

export interface SurfaceLayers {
  /** Columns. */
  nx: number;
  /** Rows. */
  ny: number;
  /** Second highest return, so one stray return can't raise a cell. NaN where none. */
  top: Float32Array;
  /** The same without vegetation-like returns. */
  solid: Float32Array;
  /** Mean height of ground returns (classes 2, 8, 20). NaN where none. */
  ground: Float32Array;
  /** Mean height of water returns (class 9). NaN where none. */
  waterZ: Float32Array;
  count: Uint16Array;
  /** Vegetation classes, and multiple returns nobody classified. */
  vegetation: Uint16Array;
  water: Uint16Array;
  building: Uint16Array;
}

export const FLOAT_LAYERS = ['top', 'solid', 'ground', 'waterZ'] as const;
export const COUNT_LAYERS = ['count', 'vegetation', 'water', 'building'] as const;

export function emptyLayers(nx: number, ny: number): SurfaceLayers {
  const size = nx * ny;
  return {
    nx,
    ny,
    top: new Float32Array(size).fill(NaN),
    solid: new Float32Array(size).fill(NaN),
    ground: new Float32Array(size).fill(NaN),
    waterZ: new Float32Array(size).fill(NaN),
    count: new Uint16Array(size),
    vegetation: new Uint16Array(size),
    water: new Uint16Array(size),
    building: new Uint16Array(size),
  };
}
