import { describe, expect, it, vi } from 'vitest';
import type { SourceFeature } from '../pipeline/source';

// No survey to read: enough to see what the prepared result is kept under.
vi.mock('./sources', () => ({ discover: vi.fn(async () => ({ candidates: [], failures: [] })) }));
vi.mock('./read/laz', async (importOriginal) => ({ ...(await importOriginal<typeof import('./read/laz')>()), lazDecoder: async () => undefined }));
const { prepareLidar, setCheckpointStore } = await import('./prepare');

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

describe('prepared LiDAR results', () => {
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
});
