import { beforeEach, describe, expect, it, vi } from 'vitest';
import { areaGeoBounds } from '../geo/area';
import { Projection } from '../geo/projection';
import type { SourceFeature } from '../pipeline/source';
import type { AreaSpec } from '../settings';
import type { Candidate, Tile } from './sources';

// No survey to read: enough to see what the prepared result is kept under.
vi.mock('./sources', async (original) => ({ ...(await original<typeof import('./sources')>()), discover: vi.fn(async () => ({ candidates: [], failures: [] })) }));
vi.mock('./read/laz', async (importOriginal) => ({ ...(await importOriginal<typeof import('./read/laz')>()), lazDecoder: async () => undefined }));
// Indexes aren't read: surveys keep their catalog densities.
vi.mock('./read/density', () => ({ localDensity: vi.fn(async () => null) }));
const { discover } = await import('./sources');
const { lidarRequest, nothingMeasured, prepareLidar, setCheckpointStore } = await import('./prepare');
const { BudgetExceeded } = await import('./read/ept');
const { cloneSettings } = await import('../settings');

const stored = new Map<string, ArrayBuffer>();
setCheckpointStore({ get: async (key) => stored.get(key), put: async (key, value) => void stored.set(key, value) });

const square = (x: number, y: number, size = 0.0003): SourceFeature['geometry'] => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
});
const bounds = { west: 0.009, south: 44.999, east: 0.012, north: 45.002 };
const settings = { roofMode: 'envelope' as const, preferLidar: true, minFootprintMm2: 0, rockSurfaces: false, xyScale: 0.07, zScale: 0.077 };

function run(parentProps: Record<string, unknown>, partProps: Record<string, unknown> = { height: 12 }) {
  const buildings: SourceFeature[] = [
    { id: 'parent', geometry: square(0.01, 45), props: parentProps },
    { id: 'house', geometry: square(0.0105, 45.0005), props: { height: 8 } },
  ];
  const parts: SourceFeature[] = [{ id: 'part', geometry: square(0.0101, 45.0001, 0.0001), props: { building_id: 'parent', ...partProps } }];
  return prepareLidar({ bounds, buildings, parts, settings });
}

const world: [number, number][][][] = [[[[-180, -80], [180, -80], [180, 80], [-180, 80]]]];
const ept: Candidate = { provider: 'Test', id: 'ept', name: 'ept', url: 'https://example.com/ept/', format: 'EPT', coverage: world, attribution: 'x', sourcePage: 'x', projectYearHint: 2020 };
const measured = { method: 'height_only', heightM: 10, tiers: [], coverage: 1, explainedFraction: 1, roofSupportDensityM2: 5 };

/** Measures every building it's given, and notes which. */
function measuring(seen: string[]) {
  return {
    concurrency: 1,
    async run(job: { batch: { id: string }[] }) {
      for (const f of job.batch) seen.push(f.id);
      return { outcome: { records: Object.fromEntries(job.batch.map((f) => [f.id, { ...measured }])), rejected: {}, observations: {} }, downloaded: 0 };
    },
  } as never;
}

/** An 8 m square at x, y in the area's own frame, in lon/lat. */
function local(frame: Projection, x: number, y: number, size = 8): SourceFeature['geometry'] {
  const ring = [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]].map(([u, v]) => frame.localToGeo(u, v));
  return { type: 'Polygon', coordinates: [ring] };
}

describe('prepared LiDAR results', () => {
  beforeEach(() => {
    vi.mocked(discover).mockResolvedValue({ candidates: [], failures: [] });
  });

  it('are reused only for the same measurement inputs', async () => {
    expect((await run({ height: 10, num_floors: 3 })).reused).toBe(false);
    expect((await run({ height: 10, num_floors: 3 })).reused).toBe(true);
    // Each of these decides whether a measurement is accepted.
    expect((await run({ height: 100, num_floors: 30 })).reused).toBe(false);
    expect((await run({ height: 10, num_floors: 3, sources: [{ property: '/properties/height', dataset: 'Microsoft ML Buildings' }] })).reused).toBe(false);
    expect((await run({ height: 10, num_floors: 3 }, { height: 12, num_floors: 9 })).reused).toBe(false);
    expect((await run({ height: 10, num_floors: 3, start_date: '2021' })).reused).toBe(false);
    // Names only label the progress.
    expect((await run({ height: 10, num_floors: 3, names: { primary: 'Tower' } })).reused).toBe(true);
  });

  it('are kept apart for heights only at another ranking cell', async () => {
    const heights = { ...settings, roofMode: 'heights' as const };
    const buildings: SourceFeature[] = [{ id: 'house', geometry: square(0.0105, 45.0005), props: { height: 8 } }];
    expect((await prepareLidar({ bounds, buildings, parts: [], settings: { ...heights, cellM: 0.71 } })).reused).toBe(false);
    expect((await prepareLidar({ bounds, buildings, parts: [], settings: { ...heights, cellM: 0.71 } })).reused).toBe(true);
    expect((await prepareLidar({ bounds, buildings, parts: [], settings: { ...heights, cellM: 1.5 } })).reused).toBe(false);
  });
});

describe('buildings measured for an area', () => {
  beforeEach(() => {
    stored.clear();
    vi.mocked(discover).mockResolvedValue({ candidates: [ept], failures: [] });
  });

  async function measure(area: AreaSpec, buildings: SourceFeature[]) {
    const seen: string[] = [];
    const request = lidarRequest(area, cloneSettings());
    const result = await prepareLidar({ bounds: areaGeoBounds(area, 25), area: request.area, buildings, parts: [], settings, runner: measuring(seen) });
    return { result, seen };
  }

  it('are only those in a turned area, not the rest of its bounds', async () => {
    const area: AreaSpec = { center: [0.0105, 45.0005], widthM: 200, heightM: 100, rotationDeg: 45, shape: 'rectangle', cornerRadius: 0 };
    const frame = new Projection(area.center, area.rotationDeg, 1);
    const box = areaGeoBounds(area, 25);
    // A house in the bounds' corner, well outside the turned rectangle.
    const corner = frame.toLocal(box.east - 0.0002, box.north - 0.0002);
    expect(Math.abs(corner[0]) > 120 || Math.abs(corner[1]) > 70).toBe(true);
    const buildings: SourceFeature[] = [
      { id: 'inside', geometry: local(frame, 0, 0), props: {} },
      { id: 'edge', geometry: local(frame, 96, 0), props: {} },
      { id: 'corner', geometry: local(frame, corner[0], corner[1]), props: {} },
    ];
    const { result, seen } = await measure(area, buildings);
    expect(seen.sort()).toEqual(['edge', 'inside']);
    expect(result.candidates).toBe(2);
    expect(Object.keys(result.records).sort()).toEqual(['edge', 'inside']);
  });

  it('leaves out a round area corners and a rectangle margin', async () => {
    const circle: AreaSpec = { center: [0.0105, 45.0005], widthM: 200, heightM: 200, rotationDeg: 0, shape: 'circle', cornerRadius: 0 };
    const frame = new Projection(circle.center, 0, 1);
    const round = await measure(circle, [
      { id: 'middle', geometry: local(frame, -4, -4), props: {} },
      { id: 'corner', geometry: local(frame, 85, 85), props: {} },
    ]);
    expect(round.seen).toEqual(['middle']);
    const rectangle: AreaSpec = { ...circle, shape: 'rectangle' };
    const flat = await measure(rectangle, [
      { id: 'middle', geometry: local(frame, -4, -4), props: {} },
      // Crosses the edge, so the model shows part of it.
      { id: 'across', geometry: local(frame, 0, 96), props: {} },
      // In the data's 25 m margin only.
      { id: 'margin', geometry: local(frame, 0, 112), props: {} },
    ]);
    expect(flat.seen.sort()).toEqual(['across', 'middle']);
  });
});

describe('a building over the point budget', () => {
  beforeEach(() => {
    stored.clear();
    vi.mocked(discover).mockResolvedValue({ candidates: [ept], failures: [] });
  });

  it('is rejected rather than failed, so the result is kept', async () => {
    const buildings: SourceFeature[] = [
      { id: 'house', geometry: square(0.0095, 45), props: {} },
      { id: 'hall', geometry: square(0.011, 45.0005, 0.001), props: {} },
    ];
    let reads = 0;
    const runner = {
      concurrency: 1,
      async run(job: { batch: { id: string }[] }) {
        reads++;
        if (job.batch.some((f) => f.id === 'hall')) throw new BudgetExceeded('Cropped LiDAR point budget reached');
        return { outcome: { records: Object.fromEntries(job.batch.map((f) => [f.id, { ...measured }])), rejected: {}, observations: {} }, downloaded: 0 };
      },
    } as never;
    const first = await prepareLidar({ bounds, buildings, parts: [], settings, runner });
    expect(first.failures).toEqual([]);
    expect(first.rejected).toEqual({ hall: 'point_budget_exceeded' });
    expect(Object.keys(first.records)).toEqual(['house']);
    const count = reads;
    const second = await prepareLidar({ bounds, buildings, parts: [], settings, runner });
    expect(second.reused).toBe(true);
    expect(reads).toBe(count);
  });
});

describe('saving prepared results', () => {
  beforeEach(() => {
    stored.clear();
    vi.mocked(discover).mockResolvedValue({ candidates: [ept], failures: [] });
  });

  it("doesn't fail a measured model when a result can't be written out", async () => {
    // Anything JSON.stringify throws on stands in for a result too large for a string.
    const runner = {
      concurrency: 1,
      async run(job: { batch: { id: string }[] }) {
        return { outcome: { records: Object.fromEntries(job.batch.map((f) => [f.id, { ...measured, oddity: 1n }])), rejected: {}, observations: {} }, downloaded: 0 };
      },
    } as never;
    const result = await prepareLidar({ bounds, buildings: [{ id: 'house', geometry: square(0.0105, 45.0005), props: {} }], parts: [], settings, runner });
    expect(result.failures).toEqual([]);
    expect(Object.keys(result.records)).toEqual(['house']);
  });

  it('measures a tiled survey again once its catalog has a tile it lacked', async () => {
    const tile = (name: string, bbox: [number, number, number, number]): Tile => ({ url: `https://example.com/${name}.copc.laz`, bbox });
    const copc = (tiles: Tile[]): Candidate => ({ ...ept, id: 'copc', name: 'copc', url: 'https://example.com/copc/', format: 'COPC', tiles });
    const buildings: SourceFeature[] = [{ id: 'house', geometry: square(0.0105, 45.0005), props: {} }];
    const seen: string[] = [];
    const prepare = async (tiles: Tile[]) => {
      vi.mocked(discover).mockResolvedValue({ candidates: [copc(tiles)], failures: [] });
      for (const key of [...stored.keys()]) if (key.startsWith('prepared:')) stored.delete(key);
      await prepareLidar({ bounds, buildings, parts: [], settings, runner: measuring(seen) });
    };
    await prepare([tile('a', [0, 44, 0.0106, 46])]);
    await prepare([tile('a', [0, 44, 0.0106, 46])]);
    expect(seen).toEqual(['house']);
    await prepare([tile('a', [0, 44, 0.0106, 46]), tile('b', [0.0106, 44, 1, 46])]);
    expect(seen).toEqual(['house', 'house']);
  });
});

describe('the warning when nothing was measured', () => {
  const empty = { records: {}, rejected: {}, counts: {}, surveys: [], failures: [], candidates: 2, downloadedBytes: 0, reused: false, offers: [], found: [] };
  const found = [{ url: 'u', name: 'ept', provider: 'Test', year: 2020, format: 'EPT' as const, coverage: 1, staged: false }];

  it('says why', () => {
    expect(nothingMeasured({ ...empty, rejected: { a: 'footprint_below_minimum', b: 'footprint_below_minimum' } })).toMatch(/Smallest footprint/);
    expect(nothingMeasured({ ...empty, rejected: { a: 'no_survey_coverage', b: 'no_survey_coverage' } })).toMatch(/No LiDAR survey/);
    expect(nothingMeasured({ ...empty, rejected: { a: 'roof_extends_outside_footprint', b: 'footprint_below_minimum' }, found })).toMatch(/none of them could be measured/);
  });

  it('stays quiet when something was measured, failed or offered', () => {
    expect(nothingMeasured({ ...empty, candidates: 0 })).toBeNull();
    expect(nothingMeasured({ ...empty, failures: [{ source: 'ept', reason: 'down' }] })).toBeNull();
    expect(nothingMeasured({ ...empty, records: { a: measured as never }, found })).toBeNull();
  });
});
