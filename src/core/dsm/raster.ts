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

// Each cell keeps this many of its highest returns to judge floating ones
// by. The rest are only counted. Houston's haze put up to 14 returns in a
// cell over a roof with 20 to 30.
const KEEP = 24;
// Returns above an empty band at least this tall float, unless the cells
// around have returns bridging it. Houston's 2018 survey left thousands of
// unclassified returns, haze or cloud, 250 to 900 m over downtown, while
// the Willis Tower's antennas are hit every few metres of their height.
const FLOAT_GAP_M = 30;
// Floating returns are noise when they're fewer than this share of their
// cell's returns, or of the block's usual returns per cell. A roof or a
// deck stops the laser, so it has most of its cell's returns. Haze lets
// most pulses through to the ground, and birds and crane jibs are small.
const FLOAT_SHARE = 0.5;
// A neighbour with a surface this close to the floating returns' heights
// makes them the edge of that surface, a roof or a deck, whatever lies under.
const EDGE_M = 3;
// A layer is a surface, never haze however few its returns, when it has
// this many within TIGHT_M of one height and so do three neighbours. The
// densest haze over Houston had six in a cell, and a cloud deck three or
// four in many cells side by side. San Francisco's glass-roofed Embarcadero
// towers have a quarter of their block's usual returns, and under a third
// of their cells' returns, the rest being floors seen through the glass.
const SURFACE_RETURNS = 5;
const TIGHT_M = 0.5;
// Cells read past each side of a block, and how far a patch of haze over
// ground that returned nothing looks for what's around it. Houston's haze
// over a pond had up to three empty cells between cells with a return.
export const MARGIN = 4;

const isVegetation = (cls: number, single: number) => cls === 3 || cls === 4 || cls === 5 || (cls === 1 && !single);
const isGround = (cls: number) => cls === 2 || cls === 8 || cls === 20;

/**
 * Counts returns into the cells of one block. Returns past the block are
 * ignored, so neighbouring blocks never count one twice, apart from a
 * margin of MARGIN cells kept for judging floating returns (`floating`).
 * Vegetation-like returns are the vegetation classes and multiple returns
 * nobody classified: what a classified survey calls a tree, and what an
 * unclassified one has in a canopy.
 */
export class BlockRaster implements PointReceiver {
  /** Returns offered, for the readers' budget. */
  count = 0;
  /** Returns inside the block. */
  kept = 0;
  /** Floating returns left out by `layers`. */
  noise = 0;
  private readonly width: number;
  private readonly height: number;
  // The block and its margin: cell (i, j) of the block is (i + MARGIN, j + MARGIN) here.
  private readonly outerWidth: number;
  private readonly outerHeight: number;
  private readonly held: Uint8Array;
  private readonly heights: Float32Array;
  // Class, and 128 for a single return.
  private readonly kinds: Uint8Array;
  // The lowest kept return, once a cell holds KEEP.
  private readonly lowest: Float32Array;
  // Every return of the block and its margin.
  private readonly outerTotal: Uint32Array;
  // The highest and second highest of everything but vegetation.
  private readonly solidHigh: Float64Array;
  private readonly solidSecond: Float64Array;
  private readonly solidCount: Uint32Array;
  private readonly groundSum: Float64Array;
  private readonly groundCount: Uint32Array;
  private readonly waterSum: Float64Array;
  private readonly vegetation: Uint32Array;
  private readonly water: Uint32Array;
  private readonly building: Uint32Array;

  constructor(
    private readonly grid: GridOrigin,
    private readonly block: Block,
  ) {
    this.width = block.columns[1] - block.columns[0];
    this.height = block.rows[1] - block.rows[0];
    this.outerWidth = this.width + 2 * MARGIN;
    this.outerHeight = this.height + 2 * MARGIN;
    const outer = this.outerWidth * this.outerHeight;
    this.held = new Uint8Array(outer);
    this.heights = new Float32Array(outer * KEEP);
    this.kinds = new Uint8Array(outer * KEEP);
    this.lowest = new Float32Array(outer);
    this.outerTotal = new Uint32Array(outer);
    const size = this.width * this.height;
    this.solidHigh = new Float64Array(size).fill(-Infinity);
    this.solidSecond = new Float64Array(size).fill(-Infinity);
    this.solidCount = new Uint32Array(size);
    this.groundSum = new Float64Array(size);
    this.groundCount = new Uint32Array(size);
    this.waterSum = new Float64Array(size);
    this.vegetation = new Uint32Array(size);
    this.water = new Uint32Array(size);
    this.building = new Uint32Array(size);
  }

  push(x: number, y: number, z: number, cls: number, single: number): void {
    this.count++;
    const oi = Math.floor((x - this.grid.x0) / this.grid.dx + 0.5) - this.block.columns[0] + MARGIN;
    const oj = Math.floor((y - this.grid.y0) / this.grid.dy + 0.5) - this.block.rows[0] + MARGIN;
    if (oi < 0 || oi >= this.outerWidth || oj < 0 || oj >= this.outerHeight || !Number.isFinite(z)) return;
    const cell = oj * this.outerWidth + oi;
    this.hold(cell, z, cls | (single ? 128 : 0));
    this.outerTotal[cell]++;
    const i = oi - MARGIN;
    const j = oj - MARGIN;
    if (i < 0 || i >= this.width || j < 0 || j >= this.height) return;
    const k = j * this.width + i;
    this.kept++;
    if (isVegetation(cls, single)) this.vegetation[k]++;
    else {
      this.solidCount[k]++;
      if (z > this.solidHigh[k]) {
        this.solidSecond[k] = this.solidHigh[k];
        this.solidHigh[k] = z;
      } else if (z > this.solidSecond[k]) this.solidSecond[k] = z;
    }
    if (isGround(cls)) {
      this.groundSum[k] += z;
      this.groundCount[k]++;
    } else if (cls === 9) {
      this.waterSum[k] += z;
      this.water[k]++;
    } else if (cls === 6) this.building[k]++;
  }

  /** Keeps the cell's KEEP highest returns, in no order until `sort`. */
  private hold(cell: number, z: number, kind: number): void {
    const { heights, kinds } = this;
    const base = cell * KEEP;
    const n = this.held[cell];
    if (n < KEEP) {
      heights[base + n] = z;
      kinds[base + n] = kind;
      this.held[cell] = n + 1;
      if (n === 0 || z < this.lowest[cell]) this.lowest[cell] = z;
      return;
    }
    if (z <= this.lowest[cell]) return;
    let low = this.lowest[cell];
    let next = Infinity;
    let replaced = false;
    for (let k = base; k < base + KEEP; k++) {
      if (!replaced && heights[k] === low) {
        heights[k] = z;
        kinds[k] = kind;
        replaced = true;
      }
      if (heights[k] < next) next = heights[k];
    }
    this.lowest[cell] = next;
  }

  /** Puts every cell's kept returns highest first. */
  private sort(): void {
    const { heights, kinds, held } = this;
    for (let cell = 0; cell < held.length; cell++) {
      const base = cell * KEEP;
      for (let i = base + 1; i < base + held[cell]; i++) {
        const z = heights[i];
        const kind = kinds[i];
        let at = i;
        for (; at > base && heights[at - 1] < z; at--) {
          heights[at] = heights[at - 1];
          kinds[at] = kinds[at - 1];
        }
        heights[at] = z;
        kinds[at] = kind;
      }
    }
  }

  /**
   * How many of each cell's kept returns float, block and margin. A cell's
   * returns split into layers at empty bands FLOAT_GAP_M tall. A layer
   * floats when nothing in the eight cells around bridges the band under
   * it, it's too few for a surface and it isn't a tight surface shared with
   * its neighbours, or when it's over a layer that floats. It stays when a
   * neighbour with the usual returns has a surface at its heights or up to
   * FLOAT_GAP_M over them: the edge or the wall of a roof or a deck.
   */
  private floating(): Uint8Array {
    this.sort();
    const W = this.outerWidth;
    const H = this.outerHeight;
    const cells = W * H;
    const { held, heights, outerTotal } = this;
    const drop = new Uint8Array(cells);
    // Usual returns per cell over the block's cells with any.
    const counts: number[] = [];
    for (let j = MARGIN; j < this.height + MARGIN; j++) for (let i = MARGIN; i < this.width + MARGIN; i++) if (outerTotal[j * W + i]) counts.push(outerTotal[j * W + i]);
    counts.sort((a, b) => a - b);
    const sparse = FLOAT_SHARE * (counts.length ? counts[counts.length >> 1] : 0);
    const solid = Math.max(2, sparse);
    const around = (cell: number, visit: (other: number) => boolean | void) => {
      const oi = cell % W;
      const oj = (cell - oi) / W;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = oi + di;
          const j = oj + dj;
          if ((di || dj) && i >= 0 && j >= 0 && i < W && j < H && visit(j * W + i)) return;
        }
      }
    };
    const band: number[] = [];
    // Whether nothing in the cells around fills the band from lo up to hi.
    const open = (cell: number, lo: number, hi: number) => {
      band.length = 0;
      around(cell, (other) => {
        for (let k = 0; k < held[other]; k++) {
          const z = heights[other * KEEP + k];
          if (z > lo && z < hi) band.push(z);
        }
      });
      band.sort((a, b) => a - b);
      band.push(hi);
      let below = lo;
      for (const z of band) {
        if (z - below >= FLOAT_GAP_M) return true;
        below = z;
      }
      return false;
    };
    // Whether kept returns from..to of a cell hold SURFACE_RETURNS within
    // TIGHT_M of one height, and three neighbours hold as many there.
    const tight = (cell: number, from: number, to: number, at: number) => {
      let n = 0;
      for (let k = from; k < to; k++) if (Math.abs(heights[cell * KEEP + k] - at) <= TIGHT_M) n++;
      return n >= SURFACE_RETURNS;
    };
    const surface = (cell: number, from: number, to: number) => {
      const base = cell * KEEP;
      let best = 0;
      let at = 0;
      for (let i = from, j = from; i < to; i++) {
        while (heights[base + j] - heights[base + i] > 2 * TIGHT_M) j++;
        if (i - j + 1 > best) {
          best = i - j + 1;
          at = (heights[base + i] + heights[base + j]) / 2;
        }
      }
      if (best < SURFACE_RETURNS) return false;
      let agree = 0;
      around(cell, (other) => {
        if (tight(other, 0, held[other], at)) agree++;
        return agree >= 3;
      });
      return agree >= 3;
    };
    // Layers by where each ends (the returns over its gap). The top layers
    // that float are left out, down to the first that doesn't, so haze over
    // a roof edge goes and the edge stays.
    const layered: { cell: number; ends: number[]; open: boolean[]; flat: boolean[]; edge: boolean[] }[] = [];
    for (let cell = 0; cell < cells; cell++) {
      const base = cell * KEEP;
      let ends: number[] | null = null;
      let loose = false;
      const bands: boolean[] = [];
      const surfaces: boolean[] = [];
      for (let k = 1; k < held[cell]; k++) {
        if (heights[base + k - 1] - heights[base + k] < FLOAT_GAP_M) continue;
        const top = ends?.length ? ends[ends.length - 1] : 0;
        (ends ??= []).push(k);
        const flat = surface(cell, top, k);
        const floats = !flat && (k < FLOAT_SHARE * outerTotal[cell] || k < sparse) && open(cell, heights[base + k], heights[base + k - 1]);
        bands.push(floats);
        surfaces.push(flat);
        loose ||= floats;
      }
      if (ends && loose) layered.push({ cell, ends, open: bands, flat: surfaces, edge: bands.map(() => false) });
    }
    const floats: boolean[] = [];
    const settle = (entry: (typeof layered)[number]) => {
      const { ends, open, flat, edge } = entry;
      floats.length = ends.length;
      let below = false;
      for (let l = ends.length - 1; l >= 0; l--) below = floats[l] = !edge[l] && !flat[l] && (below || open[l]);
      let d = 0;
      for (let l = 0; l < ends.length && floats[l]; l++) d = ends[l];
      drop[entry.cell] = d;
    };
    for (const entry of layered) settle(entry);
    // Edges of a surface, passed on along it.
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const entry of layered) {
        const { cell, ends, edge } = entry;
        const base = cell * KEEP;
        settle(entry);
        for (let l = 0; l < ends.length; l++) {
          if (!floats[l]) continue;
          const lo = heights[base + ends[l] - 1] - EDGE_M;
          // Up to FLOAT_GAP_M under a neighbour's surface, they're its wall.
          const hi = heights[base + (l ? ends[l - 1] : 0)] + FLOAT_GAP_M;
          around(cell, (other) => {
            const from = drop[other];
            const n = held[other] - from;
            if (outerTotal[other] - from < solid || n < 2) return;
            let at = 0;
            for (let k = from; k < held[other]; k++) {
              const z = heights[other * KEEP + k];
              if (z >= lo && z <= hi) at++;
            }
            edge[l] = at >= 2;
            return edge[l];
          });
          changed ||= edge[l];
        }
        settle(entry);
      }
      if (!changed) break;
    }
    this.floatingPatches(drop, sparse, surface);
    return drop;
  }

  /**
   * Haze over ground that returned nothing (a pond, a wet roof) has nothing
   * under it in its own cells. Sparse cells whose returns sit in one band
   * are joined into patches across up to MARGIN cells, and a patch floats
   * when the cells within MARGIN of it have nothing within FLOAT_GAP_M under
   * its lowest return, nothing at or over it, and something lower down. A
   * dark roof has walls, trees or the rest of the roof around it.
   */
  private floatingPatches(drop: Uint8Array, sparse: number, surface: (cell: number, from: number, to: number) => boolean): void {
    const W = this.outerWidth;
    const H = this.outerHeight;
    const { held, heights, outerTotal } = this;
    const loose = (cell: number) => {
      const n = held[cell];
      if (!n || drop[cell] || n !== outerTotal[cell] || n >= sparse) return false;
      for (let k = 1; k < n; k++) if (heights[cell * KEEP + k - 1] - heights[cell * KEEP + k] >= FLOAT_GAP_M) return false;
      return !surface(cell, 0, n);
    };
    const within = (cell: number, visit: (other: number) => void) => {
      const oi = cell % W;
      const oj = (cell - oi) / W;
      for (let j = Math.max(0, oj - MARGIN); j <= Math.min(H - 1, oj + MARGIN); j++) {
        for (let i = Math.max(0, oi - MARGIN); i <= Math.min(W - 1, oi + MARGIN); i++) visit(j * W + i);
      }
    };
    const patch = new Int32Array(W * H).fill(-1);
    const members: number[] = [];
    for (let seed = 0; seed < W * H; seed++) {
      if (patch[seed] >= 0 || !loose(seed)) continue;
      members.length = 0;
      members.push(seed);
      patch[seed] = seed;
      let low = heights[seed * KEEP + held[seed] - 1];
      let high = heights[seed * KEEP];
      for (let at = 0; at < members.length; at++) {
        within(members[at], (cell) => {
          if (patch[cell] >= 0 || !loose(cell)) return;
          const top = heights[cell * KEEP];
          const bottom = heights[cell * KEEP + held[cell] - 1];
          if (bottom - high >= FLOAT_GAP_M || low - top >= FLOAT_GAP_M) return;
          patch[cell] = seed;
          members.push(cell);
          low = Math.min(low, bottom);
          high = Math.max(high, top);
        });
      }
      let under = false;
      let near = false;
      for (let at = 0; at < members.length && !near; at++) {
        within(members[at], (cell) => {
          if (patch[cell] === seed) return;
          for (let k = drop[cell]; k < held[cell]; k++) {
            if (heights[cell * KEEP + k] > low - FLOAT_GAP_M) near = true;
            else under = true;
          }
        });
      }
      if (near || !under) continue;
      for (const member of members) drop[member] = held[member];
    }
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
    const drop = this.floating();
    const { heights, kinds, held } = this;
    this.noise = 0;
    for (let j = 0; j < this.height; j++) {
      for (let i = 0; i < this.width; i++) {
        const k = j * this.width + i;
        const cell = (j + MARGIN) * this.outerWidth + i + MARGIN;
        const base = cell * KEEP;
        const d = drop[cell];
        let n = this.outerTotal[cell];
        let vegetation = this.vegetation[k];
        let water = this.water[k];
        let building = this.building[k];
        let groundSum = this.groundSum[k];
        let groundCount = this.groundCount[k];
        let waterSum = this.waterSum[k];
        let solidCount = this.solidCount[k];
        for (let r = 0; r < d; r++) {
          const z = heights[base + r];
          const cls = kinds[base + r] & 127;
          const single = kinds[base + r] & 128;
          n--;
          if (isVegetation(cls, single)) vegetation--;
          else solidCount--;
          if (isGround(cls)) {
            groundSum -= z;
            groundCount--;
          } else if (cls === 9) {
            waterSum -= z;
            water--;
          } else if (cls === 6) building--;
        }
        this.noise += d;
        const left = held[cell] - d;
        // The second highest return, or the highest where only one: a bird or one stray return can't raise a cell.
        if (!n || !left) out.top[k] = NaN;
        else out.top[k] = n === 1 || left === 1 ? heights[base + d] : heights[base + d + 1];
        if (!d) {
          const s = solidCount;
          out.solid[k] = s === 0 ? NaN : s === 1 ? this.solidHigh[k] : this.solidSecond[k];
        } else {
          // The same from the kept returns left, where the floating ones were counted in.
          let first = NaN;
          let second = NaN;
          for (let r = d; r < held[cell]; r++) {
            const kind = kinds[base + r];
            if (isVegetation(kind & 127, kind & 128)) continue;
            if (first !== first) first = heights[base + r];
            else {
              second = heights[base + r];
              break;
            }
          }
          out.solid[k] = !solidCount ? NaN : solidCount === 1 || second !== second ? first : second;
        }
        out.ground[k] = groundCount ? groundSum / groundCount : NaN;
        out.waterZ[k] = water ? waterSum / water : NaN;
        out.count[k] = Math.min(n, COUNT_LIMIT);
        out.vegetation[k] = Math.min(vegetation, COUNT_LIMIT);
        out.water[k] = Math.min(water, COUNT_LIMIT);
        out.building[k] = Math.min(building, COUNT_LIMIT);
      }
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
