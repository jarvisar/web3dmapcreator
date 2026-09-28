import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ByteCache } from '../data/cache';
import { Projection } from '../geo/projection';
import { surfaceClassTable, type PointReceiver } from '../lidar/read/normalize';
import { setLazDecoder } from '../lidar/read/laz';
import { discover, type Candidate } from '../lidar/sources';
import { NumpyRandom } from '../lidar/test-helpers';
import type { AreaSpec } from '../settings';
import { cellSize, gridProblem, MAX_CELLS } from './grid';
import { prepareSurface, setSurfaceStore, type SurfaceJob, type SurfaceOutcome, type SurfaceRunner } from './prepare';
import { BlockRaster, EMPTY_SHARE, occupiedCell, ProbeSink } from './raster';

vi.mock('../lidar/sources', async (original) => ({ ...(await original<typeof import('../lidar/sources')>()), discover: vi.fn() }));

setLazDecoder({ decodeFile: () => ({ records: new Uint8Array(), pointCount: 0, pointSize: 0 }), chunkDecoder: () => ({ decode: (chunk) => chunk, free: () => undefined }) });

describe('BlockRaster', () => {
  const grid = { x0: 0, y0: 0, dx: 1, dy: 1 };

  it('keeps the second highest return, ground and class counts per cell', () => {
    const raster = new BlockRaster(grid, { rows: [0, 10], columns: [0, 10] });
    // Cell (row 2, column 3): ground, two roof returns and a bird. Cell (5, 5): a tree over ground.
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
    expect(layers.top[at(2, 3)]).toBeCloseTo(30.2, 4);
    expect(layers.count[at(2, 3)]).toBe(4);
    expect(layers.ground[at(2, 3)]).toBeCloseTo(10);
    expect(layers.building[at(2, 3)]).toBe(2);
    // The tree cell's solid top leaves out the canopy returns.
    expect(layers.vegetation[at(5, 5)]).toBe(2);
    expect(layers.top[at(5, 5)]).toBeCloseTo(19);
    expect(layers.solid[at(5, 5)]).toBeCloseTo(10);
    expect(layers.top[at(0, 0)]).toBeNaN();
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

/** A runner that invents returns over each job's box: a 50 m tower 80 x 60 m in the middle, ground at 10 m, every 0.25 m. */
function fakeRunner(calls: SurfaceJob[], height = 50): SurfaceRunner {
  return {
    concurrency: 2,
    async surface(job): Promise<SurfaceOutcome> {
      calls.push(job);
      const frame = new Projection(job.center, job.rotationDeg, 1);
      const [x0, y0] = [job.grid.x0 + (job.block.columns[0] - 0.5) * job.grid.dx, job.grid.y0 + (job.block.rows[0] - 0.5) * job.grid.dy];
      const [x1, y1] = [job.grid.x0 + (job.block.columns[1] - 0.5) * job.grid.dx, job.grid.y0 + (job.block.rows[1] - 0.5) * job.grid.dy];
      const sink = job.probe !== undefined ? new ProbeSink(x0, y0) : new BlockRaster(job.grid, job.block);
      const step = 0.25;
      for (let lon = job.query.west; lon <= job.query.east; lon += step / 80000) {
        for (let lat = job.query.south; lat <= job.query.north; lat += step / 111000) {
          const [x, y] = frame.toLocal(lon, lat);
          const tower = Math.abs(x) < 40 && Math.abs(y) < 30;
          (sink as PointReceiver).push(x, y, tower ? height : 10, tower ? 6 : 2, 1, 0, 0);
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

  it('prefers a survey dense enough for the cells, then the newest', async () => {
    const sparse = { ...survey('sparse', 2022), densityM2: 2 };
    const dense = { ...survey('dense', 2012), densityM2: 30 };
    const alsoDense = { ...survey('also dense', 2018), densityM2: 12 };
    vi.mocked(discover).mockResolvedValue({ candidates: [sparse, dense], failures: [] });
    let calls: SurfaceJob[] = [];
    // One metre cells need about four returns per m²: the new sparse survey can't fill them.
    await prepareSurface({ area, cellM: 1, runner: fakeRunner(calls) });
    expect(new Set(calls.map((c) => c.survey.name))).toEqual(new Set(['dense']));
    vi.mocked(discover).mockResolvedValue({ candidates: [sparse, dense, alsoDense], failures: [] });
    calls = [];
    await prepareSurface({ area, cellM: 1.01, runner: fakeRunner(calls) });
    expect(new Set(calls.map((c) => c.survey.name))).toEqual(new Set(['also dense']));
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

  it('says when no survey covers the area', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [survey('far', 2020, [0, 0, 1, 1])], failures: [] });
    await expect(prepareSurface({ area, cellM: 1, runner: fakeRunner([]) })).rejects.toThrow(/No LiDAR survey/);
  });
});
