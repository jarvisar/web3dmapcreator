import { describe, expect, it, vi } from 'vitest';
import type { SourceFeature } from '../pipeline/source';
import type { Candidate, Tile } from './sources';

vi.mock('./sources', async (original) => ({ ...(await original<typeof import('./sources')>()), discover: vi.fn(async () => ({ candidates: [], failures: [] })) }));
vi.mock('./read/density', () => ({ localDensity: vi.fn(async () => null) }));
vi.mock('./read/laz', async (importOriginal) => ({ ...(await importOriginal<typeof import('./read/laz')>()), lazDecoder: async () => undefined }));
vi.mock('./read/tiles', async (importOriginal) => ({ ...(await importOriginal<typeof import('./read/tiles')>()), checkTile: vi.fn(async () => undefined) }));
const { discover } = await import('./sources');
const { prepareLidar, setCheckpointStore, SURVEYS_FOUND } = await import('./prepare');

const stored = new Map<string, ArrayBuffer>();
setCheckpointStore({ get: async (key) => stored.get(key), put: async (key, value) => void stored.set(key, value) });

const world: [number, number][][][] = [[[[-180, -80], [180, -80], [180, 80], [-180, 80]]]];
const candidate = (name: string, format: Candidate['format'], patch: Partial<Candidate> = {}): Candidate => ({
  provider: 'Test', id: name, name, url: `https://example.com/${name}/`, format, coverage: world, attribution: name, sourcePage: 'https://example.com', projectYearHint: null, ...patch,
});
const tiles: Tile[] = [{ url: 'https://example.com/a.laz', bbox: [0, 44, 1, 46], size: 300e6 }];
const square = (x: number, y: number, size = 0.0003): SourceFeature['geometry'] => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
});
const bounds = { west: 0.004, south: 44.996, east: 0.016, north: 45.004 };
const settings = { roofMode: 'envelope' as const, preferLidar: true, minFootprintMm2: 0, rockSurfaces: false, xyScale: 0.07, zScale: 0.077 };
// Far enough apart to fall in separate batches.
const buildings: SourceFeature[] = [0.005, 0.0095, 0.011, 0.015].map((x, i) => ({ id: `b${i}`, geometry: square(x, 45), props: { height: 10 } }));

describe('LiDAR reading progress', () => {
  it("gives a whole-file survey that's only offered none of the bar", async () => {
    // The newer survey is offered rather than read, so every building goes on to the older one.
    vi.mocked(discover).mockResolvedValue({ candidates: [candidate('tiled', 'LAZ', { tiles, projectYearHint: 2022 }), candidate('streamed', 'EPT', { projectYearHint: 2015 })], failures: [] });
    const fractions: number[] = [];
    let before = -1;
    const runner = {
      concurrency: 1,
      async run(job: { batch: { id: string }[] }) {
        if (before < 0) before = Math.max(...fractions);
        return { outcome: { records: {}, rejected: Object.fromEntries(job.batch.map((f) => [f.id, 'insufficient_roof_points'])), observations: {} }, downloaded: 0 };
      },
    };
    const result = await prepareLidar({ bounds, buildings, parts: [], settings, runner, progress: (_label, fraction) => void fractions.push(fraction) });
    expect(result.offers).toHaveLength(1);
    // Nothing had moved past the search when the streamed survey started.
    expect(before).toBeLessThanOrEqual(SURVEYS_FOUND);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
  });
});
