import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceFeature } from '../pipeline/source';
import type { Candidate, Tile } from './sources';

vi.mock('./sources', () => ({ discover: vi.fn(async () => ({ candidates: [], failures: [] })) }));
vi.mock('./read/laz', async (importOriginal) => ({ ...(await importOriginal<typeof import('./read/laz')>()), lazDecoder: async () => undefined }));
// Headers aren't fetched: a tile is readable unless a test says otherwise.
vi.mock('./read/tiles', async (importOriginal) => ({ ...(await importOriginal<typeof import('./read/tiles')>()), checkTile: vi.fn(async () => undefined) }));
const { checkTile } = await import('./read/tiles');
const { discover } = await import('./sources');
const { findSurveys, prepareLidar, setCheckpointStore } = await import('./prepare');
const { advantage, approves, describeOffer, makeOffer, reopened, staged, tileKey, tilesIn } = await import('./offers');
const { Fetcher } = await import('./read/fetcher');

let stored = new Map<string, ArrayBuffer>();
setCheckpointStore({ get: async (key) => stored.get(key), put: async (key, value) => void stored.set(key, value) });

const world: [number, number][][][] = [[[[-180, -80], [180, -80], [180, 80], [-180, 80]]]];

function candidate(name: string, format: Candidate['format'], patch: Partial<Candidate> = {}): Candidate {
  return { provider: 'Test', id: name, name, url: `https://example.com/${name}/`, format, coverage: world, attribution: name, sourcePage: 'https://example.com', projectYearHint: null, ...patch };
}

const tiles: Tile[] = [
  { url: 'https://example.com/a.laz', bbox: [0, 44, 0.0105, 46], size: 300e6 },
  { url: 'https://example.com/b.laz', bbox: [0.0105, 44, 1, 46], size: 200e6 },
  { url: 'https://example.com/far.laz', bbox: [10, 10, 11, 11], size: 1e9 },
];

describe('whole-file survey rules', () => {
  it('treats only whole-file formats as staged and keys ZIP members apart', () => {
    expect(staged(candidate('x', 'LAZ'))).toBe(true);
    expect(staged(candidate('x', 'COPC'))).toBe(false);
    expect(staged(candidate('x', 'EPT'))).toBe(false);
    expect(tileKey({ url: 'https://e/z.zip', member: 'a.laz', bbox: [0, 0, 1, 1] })).toBe('https://e/z.zip#a.laz');
    expect(tilesIn(candidate('x', 'LAZ', { tiles }), [0.009, 44.9, 0.012, 45.1]).map((t) => t.url)).toEqual(['https://example.com/a.laz', 'https://example.com/b.laz']);
  });

  it('approves tiles one by one, or all of them', () => {
    expect(approves(undefined, tiles)).toBe(false);
    expect(approves('all', tiles)).toBe(true);
    expect(approves(new Set(['https://example.com/a.laz']), tiles.slice(0, 1))).toBe(true);
    expect(approves(new Set(['https://example.com/a.laz']), tiles.slice(0, 2))).toBe(false);
    const offer = { tiles: ['https://example.com/b.laz'] } as Parameters<typeof reopened>[0] extends (infer T)[] | undefined ? T : never;
    expect(reopened([offer], new Set(['https://example.com/a.laz']))).toBe(false);
    expect(reopened([offer], new Set(['https://example.com/b.laz']))).toBe(true);
    expect(reopened([], 'all')).toBe(false);
  });

  it('only pays for a download five years newer, or twice as dense and two returns more', () => {
    const at = (year: number, densityM2?: number) => candidate(`s${year}`, 'EPT', { acquisitionStart: `${year}-03-01`, acquisitionEnd: `${year}-04-01`, densityM2 });
    expect(advantage(at(2024), at(2019))).toBe('newer');
    expect(advantage(at(2023), at(2019))).toBe(null);
    expect(advantage(at(2020, 9), at(2019, 4))).toBe('denser');
    expect(advantage(at(2020, 3), at(2019, 1.4))).toBe(null);
    // Unknown densities and years never count.
    expect(advantage(at(2020), at(2019, 1))).toBe(null);
    expect(advantage(candidate('undated', 'LAZ'), at(2000))).toBe(null);
    // A project year from the name stands in for dates.
    expect(advantage(candidate('KY_2024', 'LAZ', { projectYearHint: 2024 }), candidate('KY_FullState', 'EPT'))).toBe(null);
    expect(advantage(candidate('KY_2024', 'LAZ', { projectYearHint: 2024 }), candidate('KY_2012', 'EPT', { projectYearHint: 2012 }))).toBe('newer');
  });

  it('sizes an offer from the catalog, and a ZIP member by its own bytes', async () => {
    const survey = candidate('x', 'LAZ', { projectYearHint: 2021, name: 'Geobasis NRW' });
    const zipped: Tile = { url: 'https://example.com/d.zip', member: 'a.las', size: 9e9, bytes: 150e6, bbox: [0, 0, 1, 1] };
    const offer = (await makeOffer(new Fetcher(), survey, [tiles[0], tiles[0], zipped], 'gap', [], 12))!;
    expect(offer.tiles).toEqual(['https://example.com/a.laz', 'https://example.com/d.zip#a.las']);
    expect(offer.bytes).toBe(450e6);
    expect(offer.unsized).toBe(0);
    expect(describeOffer(offer)).toBe('2 tiles, about 450 MB, from Geobasis NRW (2021)');
  });
});

const square = (x: number, y: number, size = 0.0003): SourceFeature['geometry'] => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
});
const bounds = { west: 0.009, south: 44.999, east: 0.012, north: 45.002 };
const settings = { roofMode: 'envelope' as const, preferLidar: true, minFootprintMm2: 0, rockSurfaces: false, xyScale: 0.07, zScale: 0.077 };
const buildings: SourceFeature[] = [
  { id: 'west', geometry: square(0.0095, 45), props: { height: 10 } },
  { id: 'east', geometry: square(0.011, 45.0005), props: { height: 8 } },
];

/** A runner that rejects every building it's given, and notes which survey it read. */
function rejecting(reason: string, read: string[]) {
  return {
    concurrency: 1,
    async run(job: { survey: Candidate; batch: { id: string }[] }) {
      read.push(job.survey.name);
      return { outcome: { records: {}, rejected: Object.fromEntries(job.batch.map((f) => [f.id, reason])), observations: {} }, downloaded: 0 };
    },
  };
}

describe('prepareLidar with a whole-file survey', () => {
  beforeEach(() => {
    stored = new Map();
  });

  it('offers it instead of reading it, and reads it once its tiles are approved', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [candidate('tiled', 'LAZ', { tiles, projectYearHint: 2022 })], failures: [] });
    const read: string[] = [];
    const first = await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('insufficient_roof_points', read) });
    expect(read).toEqual([]);
    expect(first.offers).toHaveLength(1);
    expect(first.offers[0]).toMatchObject({ name: 'tiled', reason: 'gap', buildings: 2, bytes: 500e6, unsized: 0 });
    expect(first.offers[0].tiles.sort()).toEqual(['https://example.com/a.laz', 'https://example.com/b.laz']);
    expect(first.rejected).toEqual({ west: 'tiles_not_downloaded', east: 'tiles_not_downloaded' });
    // The saved result stands until one of its tiles is approved.
    expect((await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('insufficient_roof_points', read) })).reused).toBe(true);
    const approved = new Set(first.offers[0].tiles);
    const second = await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('insufficient_roof_points', read), approved });
    expect(second.reused).toBe(false);
    expect(read.length).toBeGreaterThan(0);
    expect(second.offers).toEqual([]);
    // What was read is checkpointed, so it's used again without approval and nothing is offered.
    stored.forEach((_, key) => key.startsWith('prepared:') && stored.delete(key));
    const count = read.length;
    const third = await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('insufficient_roof_points', read) });
    expect(read.length).toBe(count);
    expect(third.offers).toEqual([]);
  });

  it('offers it where a streamed survey found too little, but not for a rejection no survey would change', async () => {
    const ept = candidate('ept', 'EPT', { projectYearHint: 2015 });
    const tiled = candidate('tiled', 'LAZ', { tiles, projectYearHint: 2012 });
    vi.mocked(discover).mockResolvedValue({ candidates: [ept, tiled], failures: [] });
    const read: string[] = [];
    const sparse = await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('insufficient_roof_points', read) });
    expect([...new Set(read)]).toEqual(['ept']);
    expect(sparse.offers.map((o) => [o.name, o.reason, o.buildings])).toEqual([['tiled', 'gap', 2]]);
    expect(sparse.rejected.west).toBe('insufficient_roof_points');
    stored = new Map();
    const hopeless = await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('elevated_or_underground', []) });
    expect(hopeless.offers).toEqual([]);
  });

  it("doesn't offer a survey whose header shows it couldn't be read", async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [candidate('tiled', 'LAZ', { tiles })], failures: [] });
    vi.mocked(checkTile).mockRejectedValueOnce(new Error('Unknown LAS vertical units; a vertical CRS or unit key is required'));
    const result = await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('insufficient_ground', []) });
    expect(result.offers).toEqual([]);
    expect(result.failures).toEqual([{ source: 'tiled', reason: 'Unknown LAS vertical units; a vertical CRS or unit key is required' }]);
  });

  it('reads a survey picked by hand first, and keeps the rest behind it', async () => {
    const newer = candidate('newer', 'EPT', { projectYearHint: 2022 });
    const older = candidate('older', 'EPT', { projectYearHint: 2015 });
    vi.mocked(discover).mockResolvedValue({ candidates: [older, newer], failures: [] });
    const read: string[] = [];
    const automatic = await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('insufficient_roof_points', read) });
    expect(read[0]).toBe('newer');
    expect(automatic.found.map((s) => s.name)).toEqual(['newer', 'older']);
    read.length = 0;
    const picked = await prepareLidar({ bounds, buildings, parts: [], settings: { ...settings, survey: older.url }, runner: rejecting('insufficient_roof_points', read) });
    // Not the result kept from without a pick, though its batches come from checkpoints.
    expect(picked.reused).toBe(false);
    expect(read).toEqual([]);
    expect(picked.found.map((s) => s.name)).toEqual(['newer', 'older']);
    stored = new Map();
    await prepareLidar({ bounds, buildings, parts: [], settings: { ...settings, survey: older.url }, runner: rejecting('insufficient_roof_points', read) });
    expect(read[0]).toBe('older');
    expect(new Set(read)).toEqual(new Set(['older', 'newer']));
    // By name too, for the CLI.
    read.length = 0;
    stored = new Map();
    await prepareLidar({ bounds, buildings, parts: [], settings: { ...settings, survey: 'older' }, runner: rejecting('insufficient_roof_points', read) });
    expect(read[0]).toBe('older');
  });

  it('offers a whole-file survey picked by hand even where nothing else calls for it', async () => {
    const ept = candidate('ept', 'EPT', { projectYearHint: 2022 });
    const tiled = candidate('tiled', 'LAZ', { tiles, projectYearHint: 2015 });
    vi.mocked(discover).mockResolvedValue({ candidates: [ept, tiled], failures: [] });
    // A rejection no survey would change: without the pick, nothing is offered.
    expect((await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('elevated_or_underground', []) })).offers).toEqual([]);
    const picked = await prepareLidar({ bounds, buildings, parts: [], settings: { ...settings, survey: tiled.url }, runner: rejecting('elevated_or_underground', []) });
    expect(picked.offers.map((o) => [o.name, o.reason, o.buildings])).toEqual([['tiled', 'chosen', 2]]);
  });

  it('finds the surveys under an area without reading points, whole ones first', async () => {
    const partial = candidate('partial', 'EPT', { projectYearHint: 2024, coverage: [[[[0.0105, 44], [1, 44], [1, 46], [0.0105, 46]]]] });
    const whole = candidate('whole', 'EPT', { projectYearHint: 2015, densityM2: 8 });
    const far = candidate('far', 'EPT', { coverage: [[[[10, 10], [11, 10], [11, 11], [10, 11]]]] });
    vi.mocked(discover).mockResolvedValue({ candidates: [partial, whole, far], failures: [{ source: 'Somewhere', reason: 'down', search: true }] });
    const { surveys, failures } = await findSurveys({ center: [0.0105, 45.0005], widthM: 200, heightM: 200, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0 });
    expect(surveys.map((s) => [s.name, s.year, s.densityM2, Math.round(s.coverage * 100)])).toEqual([
      ['whole', 2015, 8, 100],
      ['partial', 2024, undefined, 50],
    ]);
    expect(failures).toHaveLength(1);
  });

  it('reads everything with approval for all, as the CLI does', async () => {
    vi.mocked(discover).mockResolvedValue({ candidates: [candidate('tiled', 'LAZ', { tiles })], failures: [] });
    const read: string[] = [];
    const result = await prepareLidar({ bounds, buildings, parts: [], settings, runner: rejecting('insufficient_ground', read), approved: 'all' });
    expect([...new Set(read)]).toEqual(['tiled']);
    expect(result.offers).toEqual([]);
  });
});
