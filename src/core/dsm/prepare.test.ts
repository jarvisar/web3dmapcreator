import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ByteCache } from '../data/cache';
import { Projection } from '../geo/projection';
import { surfaceClassTable, type PointReceiver } from '../lidar/read/normalize';
import { setLazDecoder } from '../lidar/read/laz';
import { OffersError } from '../lidar/offers';
import { discover, type Candidate } from '../lidar/sources';
import { NumpyRandom } from '../lidar/test-helpers';
import type { AreaSpec } from '../settings';
import { cellSize, fixedCellLimit, gridCells, gridProblem, LARGEST_FIXED_CELLS, MAX_CELLS, MAX_FIXED_CELLS, reportedMemoryGb, requestedCell } from './grid';
import { COUNT_LAYERS, FLOAT_LAYERS, type SurfaceLayers } from './layers';
import { prepareSurface, setSurfaceStore, surfaceCodes, unpackLayers, type SurfaceJob, type SurfaceOutcome, type SurfaceRunner } from './prepare';
import { BlockRaster, EMPTY_SHARE, occupiedCell, ProbeSink } from './raster';

vi.mock('../lidar/sources', async (original) => ({ ...(await original<typeof import('../lidar/sources')>()), discover: vi.fn() }));
vi.mock('../lidar/read/tiles', async (original) => ({ ...(await original<typeof import('../lidar/read/tiles')>()), checkTile: vi.fn(async () => undefined) }));
// Indexes aren't read: surveys keep their catalog densities.
vi.mock('../lidar/read/density', () => ({ localDensity: vi.fn(async () => null) }));

setLazDecoder({ decodeFile: () => ({ records: new Uint8Array(), pointCount: 0, pointSize: 0 }), chunkDecoder: () => ({ decode: (chunk) => chunk, free: () => undefined }) });

describe('BlockRaster', () => {
  const grid = { x0: 0, y0: 0, dx: 1, dy: 1 };

  it('keeps the second highest return, ground and class counts per cell', () => {
    const raster = new BlockRaster(grid, { rows: [0, 10], columns: [0, 10] });
    // Cell (row 2, column 3): ground, two roof returns and a bird 50 m up, which floats. Cell (5, 5): a tree over ground.
    const points: [number, number, number, number, number][] = [
      [3.0, 2.0, 10.0, 2, 1],
      [3.1, 2.1, 30.0, 6, 1],
      [2.9, 1.9, 30.2, 6, 1],
      [3.0, 2.0, 80.0, 1, 1],
      [5.0, 5.0, 10.0, 2, 1],
      [5.1, 5.0, 19.0, 5, 0],
      [5.0, 5.1, 20.0, 1, 0],
      [5.2, 4.9, 12.0, 1, 1],
    ];
    for (const [x, y, z, cls, single] of points) raster.push(x, y, z, cls, single);
    const layers = raster.layers();
    const at = (row: number, column: number) => row * 10 + column;
    expect(layers.top[at(2, 3)]).toBeCloseTo(30, 4);
    expect(layers.count[at(2, 3)]).toBe(3);
    expect(raster.noise).toBe(1);
    expect(layers.ground[at(2, 3)]).toBeCloseTo(10);
    expect(layers.building[at(2, 3)]).toBe(2);
    // The tree cell's solid top leaves out the canopy returns.
    expect(layers.vegetation[at(5, 5)]).toBe(2);
    expect(layers.top[at(5, 5)]).toBeCloseTo(19);
    expect(layers.solid[at(5, 5)]).toBeCloseTo(10);
    expect(layers.top[at(0, 0)]).toBeNaN();
  });

  it('leaves out haze over a well-sampled surface but keeps a spire and a high deck', () => {
    const raster = new BlockRaster(grid, { rows: [0, 20], columns: [0, 20] });
    const at = (row: number, column: number) => row * 20 + column;
    const rng = new NumpyRandom(3);
    const put = (row: number, column: number, z: number, cls = 1, single = 1) => raster.push(column + rng.random() * 0.8 - 0.4, row + rng.random() * 0.8 - 0.4, z, cls, single);
    for (let row = 0; row < 20; row++) {
      for (let column = 0; column < 20; column++) {
        const roof = row >= 10 && column >= 10;
        const deck = row < 4 && column >= 10;
        for (let k = 0; k < 20; k++) put(row, column, roof ? 30 + 0.01 * k : deck ? 50 : 10, roof ? 6 : deck ? 17 : 2);
        // The deck is 40 m up, and a few returns reach the ground under it.
        if (deck) for (let k = 0; k < 3; k++) put(row, column, 10, 2);
      }
    }
    // Two unclassified returns 400 m up over the street in most cells of a patch, fourteen in one.
    for (let row = 4; row < 9; row++) {
      for (let column = 2; column < 7; column++) {
        const n = row === 6 && column === 4 ? 14 : 2;
        for (let k = 0; k < n; k++) put(row, column, 400 + k, 1, 0);
      }
    }
    // A spire on the roof, hit every 8 m of its 60 m.
    for (let z = 38; z <= 90; z += 8) put(15, 15, z);
    // The roof's edge in a street cell, with haze over it.
    for (let k = 0; k < 2; k++) put(12, 9, 30, 6);
    for (let k = 0; k < 2; k++) put(12, 9, 400 + k, 1, 0);
    const layers = raster.layers();
    expect(layers.top[at(5, 3)]).toBeCloseTo(10);
    expect(layers.count[at(5, 3)]).toBe(20);
    expect(layers.vegetation[at(5, 3)]).toBe(0);
    expect(layers.top[at(6, 4)]).toBeCloseTo(10);
    expect(layers.count[at(6, 4)]).toBe(20);
    expect(layers.top[at(15, 15)]).toBeCloseTo(78);
    expect(layers.top[at(2, 12)]).toBeCloseTo(50);
    expect(layers.top[at(12, 9)]).toBeCloseTo(30);
    expect(raster.noise).toBe(24 * 2 + 14 + 2);
  });

  it('leaves out haze over a pond that returned nothing but keeps a dark roof', () => {
    const raster = new BlockRaster(grid, { rows: [0, 30], columns: [0, 30] });
    const at = (row: number, column: number) => row * 30 + column;
    const rng = new NumpyRandom(5);
    const put = (row: number, column: number, z: number, cls = 1) => raster.push(column + rng.random() * 0.8 - 0.4, row + rng.random() * 0.8 - 0.4, z, cls, 1);
    const pond = (row: number, column: number) => row >= 3 && row < 11 && column >= 3 && column < 11;
    const roof = (row: number, column: number) => row >= 15 && row < 25 && column >= 15 && column < 25;
    for (let row = 0; row < 30; row++) {
      for (let column = 0; column < 30; column++) {
        if (pond(row, column)) {
          // A sheet of haze 600 m up in every other cell.
          if ((row + column) % 2) for (let k = 0; k < 2; k++) put(row, column, 600 + row + k);
        } else if (roof(row, column)) {
          // Dark: three returns a cell, and its walls hit every 5 m.
          for (let k = 0; k < 3; k++) put(row, column, 50, 6);
          if (row === 15 || column === 15) for (let z = 15; z < 50; z += 5) put(row, column, z, 1);
        } else for (let k = 0; k < 20; k++) put(row, column, 10, 2);
      }
    }
    const layers = raster.layers();
    for (let row = 3; row < 11; row++) for (let column = 3; column < 11; column++) expect(layers.top[at(row, column)]).toBeNaN();
    expect(layers.top[at(20, 20)]).toBeCloseTo(50);
    expect(layers.top[at(24, 24)]).toBeCloseTo(50);
    expect(raster.noise).toBe(32 * 2);
  });

  it('keeps a glass roof, most of whose returns are floors under it, and a ledge under a taller roof', () => {
    const raster = new BlockRaster(grid, { rows: [0, 30], columns: [0, 30] });
    const at = (row: number, column: number) => row * 30 + column;
    const rng = new NumpyRandom(7);
    const put = (row: number, column: number, z: number, cls = 1) => raster.push(column + rng.random() * 0.8 - 0.4, row + rng.random() * 0.8 - 0.4, z, cls, 1);
    for (let row = 0; row < 30; row++) {
      for (let column = 0; column < 30; column++) {
        if (row >= 10 && row < 20 && column >= 10 && column < 20) {
          for (let k = 0; k < 8; k++) put(row, column, 100 + 0.02 * k, 6);
          for (let k = 0; k < 20; k++) put(row, column, 20 + k, 1);
        } else {
          for (let k = 0; k < 40; k++) put(row, column, 10, 2);
          // A ledge 12 m under the roof along one side.
          if (column === 9 && row >= 10 && row < 20) for (let k = 0; k < 2; k++) put(row, column, 88);
        }
      }
    }
    const layers = raster.layers();
    for (let row = 10; row < 20; row++) for (let column = 10; column < 20; column++) expect(layers.top[at(row, column)]).toBeCloseTo(100, 0);
    expect(layers.top[at(15, 9)]).toBeCloseTo(88);
    expect(raster.noise).toBe(0);
  });

  it('never counts a return in two blocks', () => {
    const left = new BlockRaster(grid, { rows: [0, 10], columns: [0, 5] });
    const right = new BlockRaster(grid, { rows: [0, 10], columns: [5, 10] });
    for (const raster of [left, right]) {
      raster.push(4.4, 4, 1, 2, 1);
      raster.push(4.6, 4, 2, 2, 1);
    }
    const total = (r: BlockRaster) => r.layers().count.reduce((sum, n) => sum + n, 0);
    expect(total(left) + total(right)).toBe(2);
  });
});

describe('surfaceClassTable', () => {
  it('keeps every surface class of a standard survey, unclassified included', () => {
    const table = surfaceClassTable(undefined);
    expect([0, 1, 2, 7, 9, 17, 18, 26].map((c) => table[c] > 0)).toEqual([true, true, true, false, true, true, false, false]);
    expect(table[0]).toBe(1);
  });

  it('keeps water and bridges under a building mapping and drops codes it leaves out', () => {
    const mapping = { '1': 'unclassified', '2': 'ground', '6': 'building', '67': 'unclassified' };
    const table = surfaceClassTable(mapping, { '64': 'unclassified' });
    expect([1, 2, 6, 9, 17, 64, 65, 66, 67].map((c) => table[c])).toEqual([1, 2, 6, 9, 17, 1, 0, 0, 1]);
  });

  it("leaves a topobathy survey's seabed and water column out, in five-bit classes too", () => {
    // 40-45 arrive as 8-13 from LAS 1.2 EPT builds. 8 is ground (model key points) anywhere else.
    const table = surfaceClassTable(undefined, surfaceCodes({ provider: 'USGS', name: 'FL_TopobathyFLKeysNOAA_Hydroflattened_2019' }));
    expect([2, 8, 9, 10, 11, 13, 40, 41, 42, 45].map((c) => table[c])).toEqual([2, 0, 9, 9, 0, 0, 0, 9, 9, 0]);
    expect(surfaceClassTable(undefined, surfaceCodes({ provider: 'USGS', name: 'IL_Cook_2017' }))[8]).toBe(8);
    // Under NOAA's mapping as well.
    const noaa = surfaceClassTable({ '2': 'ground', '41': 'water' }, surfaceCodes({ provider: 'NOAA', name: '2018 NOAA NGS Topobathy Lidar: West Biscayne Bay, FL' }));
    expect([2, 8, 10, 41].map((c) => noaa[c])).toEqual([2, 0, 9, 9]);
  });
});

describe('occupiedCell', () => {
  const probe = (points: [number, number][], cls = 2) => {
    const sink = new ProbeSink(0, 0);
    for (const [x, y] of points) sink.push(x, y, 0, cls);
    return sink;
  };

  it('grows the cell until land is filled', () => {
    const rng = new NumpyRandom(3);
    const dense = Array.from({ length: 40000 }, () => [rng.random() * 64, rng.random() * 64] as [number, number]);
    const found = occupiedCell(probe(dense), 64, 64, 0.3)!;
    expect(found.density).toBeCloseTo(40000 / 64 ** 2, 0);
    expect(found.cell).toBeGreaterThan(0.3);
    // Scan lines 1.2 m apart: cells must nearly span a gap however dense the lines are.
    const lines = Array.from({ length: 30000 }, () => [rng.random() * 64, Math.floor((rng.random() * 64) / 1.2) * 1.2] as [number, number]);
    expect(occupiedCell(probe(lines), 64, 64, 0.3)!.cell).toBeGreaterThanOrEqual(1.2 * (1 - EMPTY_SHARE));
    expect(occupiedCell(probe([[1, 1]]), 64, 64, 0.3)).toBeNull();
  });

  it('leaves a cell the survey fills as it is', () => {
    const points: [number, number][] = [];
    for (let x = 0.05; x < 64; x += 0.25) for (let y = 0.05; y < 64; y += 0.25) points.push([x, y]);
    expect(occupiedCell(probe(points), 64, 64, 1.1)!.cell).toBe(1.1);
  });

  it('leaves water returns out of the land it measures', () => {
    // Filled land on the west half, and a lake returning a point per 10 m² on the east.
    const rng = new NumpyRandom(4);
    const land: [number, number][] = [];
    for (let x = 0.05; x < 32; x += 0.25) for (let y = 0.05; y < 64; y += 0.25) land.push([x, y]);
    const lake = Array.from({ length: 200 }, () => [32 + rng.random() * 32, rng.random() * 64] as [number, number]);
    const sink = probe(land);
    for (const [x, y] of lake) sink.push(x, y, 0, 9);
    expect(occupiedCell(sink, 64, 64, 1.1)!.cell).toBe(1.1);
    // Unclassified, the lake reads as sparse land, as in the add-on.
    expect(occupiedCell(probe([...land, ...lake], 1), 64, 64, 1.1)!.cell).toBeGreaterThan(2);
    // Unless it's among water returns: a bay every 1.6 m, half filed as water and half left unclassified.
    const bay = probe(land);
    for (let x = 32.5; x < 64; x += 1.6) {
      for (let y = 0.5; y < 64; y += 1.6) {
        bay.push(x, y, 0, 9);
        bay.push(x + 0.1, y, 0, 1);
      }
    }
    expect(occupiedCell(bay, 64, 64, 1.1)!.cell).toBe(1.1);
  });
});

describe('cellSize', () => {
  it('follows the scale and grows for large areas', () => {
    expect(cellSize(0.05, 0.07, 1000, 1000)).toBeCloseTo(0.71);
    expect(cellSize(0.05, 1, 100, 100)).toBe(0.25);
    const big = cellSize(0.05, 0.07, 6000, 6000);
    expect((6000 / big) ** 2).toBeLessThanOrEqual(MAX_CELLS * 1.01);
  });

  it('refuses an area past what the largest cells keep under the limit', () => {
    expect(gridProblem(6000, 6000, cellSize(0.05, 0.07, 6000, 6000))).toBeNull();
    expect(gridProblem(20000, 20000, cellSize(0.05, 0.07, 20000, 20000))).toMatch(/too large/);
  });

  it('takes a cell in metres as given, whatever the area or scale', () => {
    const metres = { cellMode: 'metres' as const, detailMm: 0.05, cellM: 0.25 };
    expect(requestedCell(metres, 0.07, 1000, 1000)).toBe(0.25);
    expect(requestedCell(metres, 0.01, 6000, 6000)).toBe(0.25);
    expect(requestedCell({ ...metres, cellM: 0.1 }, 1, 100, 100)).toBe(0.25);
    expect(requestedCell({ ...metres, cellMode: 'detail' }, 0.07, 6000, 6000)).toBe(cellSize(0.05, 0.07, 6000, 6000));
  });

  it('allows a larger grid for a cell in metres, up to a hard limit', () => {
    expect(gridProblem(1000, 1000, 0.25)).toMatch(/too large/);
    expect(gridProblem(1000, 1000, 0.25, MAX_FIXED_CELLS)).toBeNull();
    expect(gridProblem(2000, 2000, 0.25, MAX_FIXED_CELLS)).toMatch(/64\.0 million cells.*16 million.*1\.0 km²/);
    expect(gridProblem(2000, 2000, 0.5, MAX_FIXED_CELLS)).toBeNull();
    expect(gridCells(2000, 2000, 0.5)).toBeGreaterThan(MAX_FIXED_CELLS);
    expect(gridProblem(2000, 2000, 0.25, 64_000_000)).toBeNull();
    expect(gridProblem(2000, 2000, 0.25, 32_000_000)).toMatch(/limit on this computer is 32 million.*2\.0 km²/);
  });

  it('sets the limit for a cell in metres from the memory the machine reports', () => {
    expect(fixedCellLimit(null)).toBe(MAX_FIXED_CELLS);
    expect(fixedCellLimit(2)).toBe(8_000_000);
    expect(fixedCellLimit(4)).toBe(8_000_000);
    expect(fixedCellLimit(8)).toBe(MAX_FIXED_CELLS);
    expect(fixedCellLimit(16)).toBe(32_000_000);
    expect(fixedCellLimit(32)).toBe(64_000_000);
    expect(fixedCellLimit(64)).toBe(64_000_000);
    expect(fixedCellLimit(null, true)).toBe(LARGEST_FIXED_CELLS);
    expect(fixedCellLimit(4, true)).toBe(LARGEST_FIXED_CELLS);
    // As navigator.deviceMemory rounds: 31.2 GB reports 32.
    expect(reportedMemoryGb(31.2 * 2 ** 30)).toBe(32);
    expect(reportedMemoryGb(15.9 * 2 ** 30)).toBe(16);
    expect(reportedMemoryGb(7.7 * 2 ** 30)).toBe(8);
  });
});

// ------------------------------------------------------------------ prepare

const area: AreaSpec = { center: [-87.6305, 41.884], widthM: 300, heightM: 200, rotationDeg: 20, shape: 'rectangle', cornerRadius: 0.1 };

function survey(name: string, year: number, box = [-180, -80, 180, 80]): Candidate {
  const [w, s, e, n] = box;
  return {
    provider: 'USGS',
    id: name,
    name,
    url: `https://example.com/${name}/ept.json`,
    format: 'EPT',
    coverage: [[[[w, s], [e, s], [e, n], [w, n]]]],
    acquisitionEnd: `${year}-05-01`,
    attribution: `${name} credit`,
    sourcePage: 'https://example.com',
    projectYearHint: year,
  };
}

/** The same, as whole files: four 100 MB tiles around the area. */
function tiled(name: string, year: number, box?: number[]): Candidate {
  const [lon, lat] = area.center;
  const tiles = [[-1, -1], [0, -1], [-1, 0], [0, 0]].map(([i, j]) => ({ url: `https://example.com/${name}/${i}_${j}.laz`, bbox: [lon + i * 0.01, lat + j * 0.01, lon + (i + 1) * 0.01, lat + (j + 1) * 0.01] as [number, number, number, number], size: 100e6 }));
  return { ...survey(name, year, box), provider: 'Somewhere', url: `https://example.com/${name}/`, format: 'LAZ', tiles };
}

/** A runner that invents returns over each job's box: a 50 m tower 80 x 60 m in the middle, ground at 10 m, every 0.25 m unless `spacing` says, wherever `has` says, or water. */
function fakeRunner(calls: SurfaceJob[], height = 50, spacing: (job: SurfaceJob) => number = () => 0.25, has: (job: SurfaceJob, x: number, y: number) => boolean | 'water' = () => true): SurfaceRunner {
  return {
    concurrency: 2,
    async surface(job): Promise<SurfaceOutcome> {
      calls.push(job);
      const frame = new Projection(job.center, job.rotationDeg, 1);
      const [x0, y0] = [job.grid.x0 + (job.block.columns[0] - 0.5) * job.grid.dx, job.grid.y0 + (job.block.rows[0] - 0.5) * job.grid.dy];
      const [x1, y1] = [job.grid.x0 + (job.block.columns[1] - 0.5) * job.grid.dx, job.grid.y0 + (job.block.rows[1] - 0.5) * job.grid.dy];
      const sink = job.probe !== undefined ? new ProbeSink(x0, y0) : new BlockRaster(job.grid, job.block);
      const step = spacing(job);
      for (let lon = job.query.west; lon <= job.query.east; lon += step / 80000) {
        for (let lat = job.query.south; lat <= job.query.north; lat += step / 111000) {
          const [x, y] = frame.toLocal(lon, lat);
          const kind = has(job, x, y);
          if (!kind) continue;
          const tower = Math.abs(x) < 40 && Math.abs(y) < 30;
          if (kind === 'water') (sink as PointReceiver).push(x, y, 9, 9, 1, 0, 0);
          else (sink as PointReceiver).push(x, y, tower ? height : 10, tower ? 6 : 2, 1, 0, 0);
        }
      }
      if (sink instanceof ProbeSink) return { probe: occupiedCell(sink, x1 - x0, y1 - y0, job.probe!), points: sink.count };
      return { layers: sink.layers(), points: sink.kept };
    },
  };
}

function memoryStore(): ByteCache & { keys: () => string[] } {
  const map = new Map<string, ArrayBuffer>();
  return {
    get: async (key) => map.get(key),
    put: async (key, data) => void map.set(key, data),
    keys: () => [...map.keys()],
  };
}

describe('prepareSurface', () => {
  beforeEach(() => {
    setSurfaceStore(memoryStore());
    vi.mocked(discover).mockReset();
  });

  it('reads the grid, then reuses its blocks', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('survey', 2020)], failures: [] });
    const calls: SurfaceJob[] = [];
    const result = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls) });
    expect(result.coverage).toBeGreaterThan(0.99);
    expect(result.surveys.map((s) => [s.name, s.year])).toEqual([['survey', 2020]]);
    expect(result.grid.cell).toBe(1);
    let top = -Infinity;
    for (const v of result.layers.top) if (v > top) top = v;
    expect(top).toBe(50);
    // The middle of the grid is the tower, the corner is the street.
    const { nx, ny } = result.layers;
    expect(result.layers.top[(ny >> 1) * nx + (nx >> 1)]).toBe(50);
    expect(result.layers.building[(ny >> 1) * nx + (nx >> 1)]).toBeGreaterThan(0);
    expect(result.layers.top[0]).toBe(10);
    expect(result.reusedBlocks).toBe(0);
    const reads = calls.length;
    const again = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls) });
    expect(calls.length).toBe(reads);
    expect(again.reusedBlocks).toBe(again.blocks);
    expect(Array.from(again.layers.top)).toEqual(Array.from(result.layers.top));
  });

  it('rebuilds the layers exactly from its block checkpoints, read or reused', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('survey', 2020)], failures: [] });
    const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const same = (a: SurfaceLayers, b: SurfaceLayers) => {
      expect([b.nx, b.ny]).toEqual([a.nx, a.ny]);
      for (const name of [...FLOAT_LAYERS, ...COUNT_LAYERS]) expect(bytes(b[name])).toEqual(bytes(a[name]));
    };
    const read = await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) });
    expect(read.checkpoints.length).toBe(read.blocks);
    expect(read.blocks).toBeGreaterThan(1);
    same(read.layers, unpackLayers(read.grid, read.checkpoints));
    const reused = await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) });
    expect(reused.reusedBlocks).toBe(reused.blocks);
    same(read.layers, unpackLayers(reused.grid, reused.checkpoints));
    // Without a store nothing is saved, but the checkpoints are still made.
    setSurfaceStore(null);
    const unsaved = await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) });
    same(read.layers, unpackLayers(unsaved.grid, unsaved.checkpoints));
    expect(() => unpackLayers(read.grid, read.checkpoints.slice(1))).toThrow();
  });

  it('grows the cell a sparse survey cannot fill, and remembers that', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('survey', 2020)], failures: [] });
    const calls: SurfaceJob[] = [];
    const result = await prepareSurface({ area, cellM: 0.1, runner: fakeRunner(calls) });
    expect(result.requestedCellM).toBe(0.1);
    expect(result.grid.cell).toBeGreaterThan(0.2);
    expect(result.densityM2).toBeGreaterThan(10);
    const probes = calls.filter((c) => c.probe !== undefined).length;
    expect(probes).toBe(1);
    await prepareSurface({ area, cellM: 0.1, runner: fakeRunner(calls) });
    expect(calls.filter((c) => c.probe !== undefined).length).toBe(probes);
  });

  it('prefers a survey that covers the whole area, and fills the rest from others', async () => {
    const frame = new Projection(area.center, 0, 1);
    const [westEdge] = frame.localToGeo(-400, 0);
    const [middle] = frame.localToGeo(0, 0);
    // The newer survey only covers the west, so the older complete one comes first.
    const partial = survey('newer', 2024, [westEdge, 41.8, middle, 41.95]);
    const whole = survey('older', 2015);
    vi.mocked(discover).mockResolvedValue({ candidates: [partial, whole], failures: [] });
    const calls: SurfaceJob[] = [];
    const result = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls) });
    expect(result.surveys.map((s) => s.name)).toEqual(['older']);
    expect(calls.every((c) => c.survey.name === 'older')).toBe(true);
    // Without a complete survey, blocks take cells from the newest first and the rest from the next.
    vi.mocked(discover).mockResolvedValue({ candidates: [partial, survey('eastern', 2010, [middle, 41.8, 180, 41.95])], failures: [] });
    const mixed = await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) });
    expect(mixed.surveys.map((s) => s.name).sort()).toEqual(['eastern', 'newer']);
    expect(mixed.coverage).toBeGreaterThan(0.99);
  });

  it('leaves ground an outline claims without points near it to the next survey, but keeps holes', async () => {
    // The newer survey's outline holds the whole area, its points stop 100 m
    // short of the west side, and its tower roof returned nothing.
    const claims = survey('claims', 2024);
    const older = survey('older', 2015);
    vi.mocked(discover).mockResolvedValue({ candidates: [claims, older], failures: [] });
    const has = (job: SurfaceJob, x: number, y: number) => job.survey.name !== 'claims' || (x > -50 && !(Math.abs(x) < 8 && Math.abs(y) < 8));
    const calls: SurfaceJob[] = [];
    const result = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls, 50, () => 0.25, has) });
    expect(result.surveys.map((s) => s.name)).toEqual(['claims', 'older']);
    expect(result.coverage).toBeGreaterThan(0.99);
    const { nx, ny } = result.layers;
    expect(result.layers.top[(ny >> 1) * nx + 10]).toBe(10);
    // The roof's hole stays the newer survey's: it holds the newer roof.
    expect(result.layers.count[(ny >> 1) * nx + (nx >> 1)]).toBe(0);
    // Blocks wholly on its points read nothing else.
    const blocks = new Set(calls.filter((c) => c.survey.name === 'older' && c.probe === undefined).map((c) => c.block.columns[0]));
    expect(blocks).toEqual(new Set([0]));
    // A river 55 m wide with nothing in it, banks on both sides, stays the newer survey's.
    setSurfaceStore(memoryStore());
    const river = (job: SurfaceJob, _x: number, y: number) => job.survey.name !== 'claims' || !(y > 40 && y < 95);
    const reads: SurfaceJob[] = [];
    const kept = await prepareSurface({ area, cellM: 1, runner: fakeRunner(reads, 50, () => 0.25, river) });
    expect(kept.surveys.map((s) => s.name)).toEqual(['claims']);
    expect(reads.some((c) => c.survey.name === 'older')).toBe(false);
    // Nor does a lake out to the edge whose returns stop in the water.
    setSurfaceStore(memoryStore());
    const lake = (job: SurfaceJob, x: number) => (job.survey.name !== 'claims' || x < 60 ? true : x < 90 ? 'water' : false);
    const lakeReads: SurfaceJob[] = [];
    const shore = await prepareSurface({ area, cellM: 1, runner: fakeRunner(lakeReads, 50, () => 0.25, lake) });
    expect(shore.surveys.map((s) => s.name)).toEqual(['claims']);
    expect(lakeReads.some((c) => c.survey.name === 'older')).toBe(false);
  });

  it('reads an older survey first where the newest cannot fill the cells, within the years allowed', async () => {
    // Returns every 2 m: about 2.6 m cells come out full, at 1 m asked for.
    const runner = (calls: SurfaceJob[]) => fakeRunner(calls, 50, (job) => (job.survey.name === 'sparse' ? 2 : 0.25));
    const sparse = { ...survey('sparse', 2022), densityM2: 2 };
    const dense = { ...survey('dense', 2019), densityM2: 30 };
    vi.mocked(discover).mockResolvedValue({ candidates: [sparse, dense], failures: [] });
    let calls: SurfaceJob[] = [];
    const result = await prepareSurface({ area, cellM: 1, runner: runner(calls) });
    expect(new Set(calls.filter((c) => c.probe === undefined).map((c) => c.survey.name))).toEqual(new Set(['dense']));
    expect(result.found.map((s) => s.name)).toEqual(['dense', 'sparse']);
    expect(result.found[0].note).toMatch(/^The newer sparse \(2022\) only filled 2\.\d+ m cells/);
    expect(result.grid.cell).toBe(1);
    // Twelve years older is past twice the five allowed, unless more are.
    const old = { ...dense, acquisitionEnd: '2010-05-01', projectYearHint: 2010 };
    vi.mocked(discover).mockResolvedValue({ candidates: [sparse, old], failures: [] });
    calls = [];
    await prepareSurface({ area, cellM: 1.02, runner: runner(calls) });
    expect(new Set(calls.filter((c) => c.probe === undefined).map((c) => c.survey.name))).toEqual(new Set(['sparse']));
    calls = [];
    await prepareSurface({ area, cellM: 1.04, runner: runner(calls), rules: { preference: 'balanced', years: 12 } });
    expect(new Set(calls.filter((c) => c.probe === undefined).map((c) => c.survey.name))).toEqual(new Set(['dense']));
    // Or always the newest.
    vi.mocked(discover).mockResolvedValue({ candidates: [sparse, dense], failures: [] });
    calls = [];
    await prepareSurface({ area, cellM: 1.06, runner: runner(calls), rules: { preference: 'newest', years: 5 } });
    expect(new Set(calls.filter((c) => c.probe === undefined).map((c) => c.survey.name))).toEqual(new Set(['sparse']));
  });

  it('keeps the newest survey where it fills the cells, next to a much denser one', async () => {
    const dense = { ...survey('dense', 2023), densityM2: 60 };
    vi.mocked(discover).mockResolvedValue({ candidates: [{ ...survey('newer', 2025), densityM2: 20 }, dense], failures: [] });
    const calls: SurfaceJob[] = [];
    const result = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls) });
    expect(new Set(calls.map((c) => c.survey.name))).toEqual(new Set(['newer']));
    // Measured once, for the ranking and the cell size alike.
    expect(calls.filter((c) => c.probe !== undefined)).toHaveLength(1);
    expect(result.found[0].note).toBe('dense (2023) is denser, but this newer one fills the 1 m cells near the middle of the area.');
  });

  it('reads a survey picked by hand first, the others filling in where it does not reach', async () => {
    const frame = new Projection(area.center, 0, 1);
    const [middle] = frame.localToGeo(0, 0);
    const west = survey('west', 2015, [-180, -80, middle, 80]);
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('whole', 2020), west], failures: [] });
    const automatic = await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) });
    expect(automatic.surveys.map((s) => s.name)).toEqual(['whole']);
    expect(automatic.found.map((s) => s.name)).toEqual(['whole', 'west']);
    const picked = await prepareSurface({ area, cellM: 1, runner: fakeRunner([]), survey: west.url });
    expect(picked.surveys.map((s) => s.name).sort()).toEqual(['west', 'whole']);
    expect(picked.coverage).toBeGreaterThan(0.99);
    expect(picked.found.map((s) => s.name)).toEqual(['whole', 'west']);
  });

  it('offers a whole-file survey picked by hand for every block it would be read for', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('streamed', 2021), tiled('tiles', 2020)], failures: [] });
    expect((await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) })).offers).toEqual([]);
    const picked = await prepareSurface({ area, cellM: 1, runner: fakeRunner([]), survey: 'https://example.com/tiles/' });
    expect(picked.surveys.map((s) => s.name)).toEqual(['streamed']);
    expect(picked.offers.map((o) => [o.name, o.reason, o.tiles.length])).toEqual([['tiles', 'chosen', 4]]);
  });

  it('retries a block whose read failed, next time', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('survey', 2020)], failures: [] });
    const calls: SurfaceJob[] = [];
    let fail = true;
    const flaky: SurfaceRunner = {
      concurrency: 1,
      surface: (job, progress) => {
        if (fail && job.probe === undefined) {
          fail = false;
          return Promise.reject(new Error('Network down'));
        }
        return fakeRunner(calls).surface(job, progress);
      },
    };
    const first = await prepareSurface({ area, cellM: 1, runner: flaky });
    expect(first.failures).toEqual([{ source: 'survey', reason: 'Network down' }]);
    const second = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls) });
    expect(second.failures).toEqual([]);
    expect(second.reusedBlocks).toBe(second.blocks - 1);
  });

  it('offers a whole-file survey instead of reading it, and reads it once approved', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [tiled('tiles', 2021)], failures: [] });
    const calls: SurfaceJob[] = [];
    const offered = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls) }).catch((error: OffersError) => error);
    expect(offered).toBeInstanceOf(OffersError);
    expect(calls).toEqual([]);
    const [offer] = (offered as OffersError).offers;
    expect(offer).toMatchObject({ name: 'tiles', reason: 'gap', bytes: 400e6, unsized: 0 });
    expect(offer.tiles).toHaveLength(4);
    const read = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls), approved: new Set(offer.tiles) });
    expect(read.surveys.map((s) => s.name)).toEqual(['tiles']);
    expect(read.offers).toEqual([]);
    expect(read.coverage).toBeGreaterThan(0.99);
    // Blocks read with it are kept, and cost nothing to use without approval.
    const count = calls.length;
    const again = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls) });
    expect(calls.length).toBe(count);
    expect(again.reusedBlocks).toBe(again.blocks);
    expect(again.offers).toEqual([]);
  });

  it("says a survey it could read failed, rather than that the offer is the only LiDAR", async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('streamed', 2012), tiled('tiles', 2024)], failures: [] });
    const down: SurfaceRunner = { concurrency: 1, surface: () => Promise.reject(new Error('Network down')) };
    const error = (await prepareSurface({ area, cellM: 1, runner: down }).catch((e: OffersError) => e)) as OffersError;
    expect(error).toBeInstanceOf(OffersError);
    expect(error.message).toContain('streamed: Network down');
    expect(error.offers.length).toBeGreaterThan(0);
    expect(error.offers.every((o) => o.failure === 'streamed: Network down')).toBe(true);
    // Nothing failed: the offer stands on its own.
    vi.mocked(discover).mockResolvedValue({ candidates: [tiled('tiles', 2024)], failures: [] });
    const alone = (await prepareSurface({ area, cellM: 1, runner: down }).catch((e: OffersError) => e)) as OffersError;
    expect(alone.offers.every((o) => o.failure === undefined)).toBe(true);
  });

  it('reads a streamed survey in place of a whole-file one, and offers that only when much newer', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('streamed', 2012), tiled('tiles', 2024)], failures: [] });
    const calls: SurfaceJob[] = [];
    const result = await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls) });
    expect(new Set(calls.map((c) => c.survey.name))).toEqual(new Set(['streamed']));
    expect(result.surveys.map((s) => s.name)).toEqual(['streamed']);
    expect(result.offers.map((o) => [o.name, o.reason, o.tiles.length])).toEqual([['tiles', 'newer', 4]]);
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('recent', 2021), tiled('tiles', 2024)], failures: [] });
    expect((await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) })).offers).toEqual([]);
  });

  it('offers a whole-file survey for the part nothing else covers', async () => {
    const frame = new Projection(area.center, 0, 1);
    const [middle] = frame.localToGeo(0, 0);
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('west', 2020, [-180, -80, middle, 80]), tiled('tiles', 2015)], failures: [] });
    const result = await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) });
    expect(result.surveys.map((s) => s.name)).toEqual(['west']);
    expect(result.coverage).toBeLessThan(0.7);
    expect(result.offers.map((o) => [o.name, o.reason])).toEqual([['tiles', 'gap']]);
    const filled = await prepareSurface({ area, cellM: 1, runner: fakeRunner([]), approved: new Set(result.offers[0].tiles) });
    expect(filled.surveys.map((s) => s.name)).toContain('tiles');
    expect(filled.coverage).toBeGreaterThan(0.99);
  });

  it('says how much of the area no survey covers', async () => {
    const frame = new Projection(area.center, 0, 1);
    const [middle] = frame.localToGeo(0, 0);
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('west', 2020, [-180, -80, middle, 80])], failures: [] });
    expect((await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) })).uncovered).toBeCloseTo(0.5, 1);
    // Only the area's shape counts: an octagon around a circle misses the square's corners.
    const square: AreaSpec = { ...area, rotationDeg: 0, widthM: 200, heightM: 200 };
    const octagon = Array.from({ length: 9 }, (_, k) => frame.localToGeo(110 * Math.cos((k * Math.PI) / 4), 110 * Math.sin((k * Math.PI) / 4)));
    vi.mocked(discover).mockResolvedValue({ candidates: [{ ...survey('octagon', 2020), coverage: [[octagon]] }], failures: [] });
    expect((await prepareSurface({ area: square, cellM: 1, runner: fakeRunner([]) })).uncovered).toBeGreaterThan(0.05);
    expect((await prepareSurface({ area: { ...square, shape: 'circle' }, cellM: 1, runner: fakeRunner([]) })).uncovered).toBe(0);
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('whole', 2020)], failures: [] });
    expect((await prepareSurface({ area, cellM: 1, runner: fakeRunner([]) })).uncovered).toBe(0);
  });

  it('says when no survey covers the area', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('far', 2020, [0, 0, 1, 1])], failures: [] });
    await expect(prepareSurface({ area, cellM: 1, runner: fakeRunner([]) })).rejects.toThrow(/No LiDAR survey/);
  });
});
