// The Overture buildings option through the render service: one real tile,
// served by a stubbed fetch, and fetchOverture mocked.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OvertureData, OvertureFeature } from '../data/features';
import { AreaTooLargeError, fetchOverture, OvertureUnavailableError, type FetchOvertureOptions } from '../data/overture';
import { defaultRenderSettings } from './defaults';
import { areaMm2, intersectWith, toPath64, unionAll } from './fills';
import { TILE_EXTENT, worldToLonLat } from './geo/mercator';
import { computeLayout } from './layout/layout';
import { planTiles, prepareArea } from './prepare';
import { CancelledError, RenderService, type RenderProgress } from './service';
import type { RenderSettings } from './settings';
import { toSvg } from './svg/writer';

vi.mock('../data/overture', async (original) => ({ ...(await original<typeof import('../data/overture')>()), fetchOverture: vi.fn() }));
const fetchMock = vi.mocked(fetchOverture);

const tile = new Uint8Array(readFileSync(new URL('./fixtures/vancouver-14-2589-5606.pbf', import.meta.url)));
const centre = worldToLonLat(2589.5 * TILE_EXTENT, 5606.5 * TILE_EXTENT, 14);
const TILES = 'https://tiles.test/{z}/{x}/{y}.pbf';

function settings(patch: (s: RenderSettings) => void = () => {}): RenderSettings {
  const s = defaultRenderSettings('laser');
  s.area = { lon: centre.lon, lat: centre.lat, bearing: 0, widthM: 1200 };
  s.label = { ...s.label, enabled: false };
  s.source = { ...s.source, tiles: TILES, overtureBuildings: true };
  patch(s);
  return s;
}

// The tile's own buildings and the transform the service will use.
const base = settings();
const layout = computeLayout(base.product, base.border);
const plan = planTiles(base.area, layout, base.source);
const prepared = prepareArea(plan, layout, new Map([['14/2589/5606', tile.buffer.slice(0)]]));
const tileBuildings = unionAll(prepared.polygons.filter((p) => p.layer === 'buildings').flatMap((p) => p.rings));

const squareMm = (x: number, y: number, side: number): [number, number][] => [
  [x, y],
  [x + side, y],
  [x + side, y + side],
  [x, y + side],
];
const covered = (x: number, y: number, side: number) => Math.abs(areaMm2(intersectWith([toPath64(squareMm(x, y, side))], tileBuildings)));

// The first spot in the window where a square is clear of (or wholly on) tile buildings.
function findSpot(side: number, onBuilding: boolean, skip = 0): [number, number] {
  const w = layout.window;
  let found = 0;
  for (let y = w.y + 5; y < w.y + w.h - 5; y += side * 2) {
    for (let x = w.x + 5; x < w.x + w.w - 5; x += side * 2) {
      const c = covered(x, y, side);
      const hit = onBuilding ? Math.abs(c - side * side) < 1e-6 : c === 0;
      if (hit && found++ === skip) return [x, y];
    }
  }
  throw new Error('no spot');
}

function feature(id: string, [x, y]: [number, number], side: number, dataset: string): OvertureFeature {
  const ring = [...squareMm(x, y, side), [x, y] as [number, number]].map(([cx, cy]) => {
    const [wx, wy] = plan.transform.toWorld(cx, cy);
    const { lon, lat } = worldToLonLat(wx, wy, plan.zoom);
    return [lon, lat] as [number, number];
  });
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return {
    id,
    type: 'building',
    geometry: { type: 'Polygon', coordinates: [ring] },
    bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    props: { sources: [{ property: '', dataset }] },
  };
}

const SIDE = 1;
const clear = findSpot(SIDE, false);
const FEATURES = [
  feature('ml-clear', clear, SIDE, 'Microsoft ML Buildings'),
  feature('ml-on-tile-building', findSpot(0.5, true), 0.5, 'Google Open Buildings'),
  feature('osm', findSpot(SIDE, false, 3), SIDE, 'OpenStreetMap'),
];

function answer(options: FetchOvertureOptions): OvertureData {
  options.onProgress?.({ message: 'Reading', bytes: 0, bytesTotal: 1, fraction: 0.5, features: 0 });
  const building = FEATURES.filter((f) => !options.keep || options.keep('building', f.props, f.bbox));
  return {
    release: 'test',
    bounds: options.bounds,
    features: { building, building_part: [], segment: [], water: [], land: [], land_use: [], land_cover: [], infrastructure: [] },
    bytes: 1000,
    stats: {} as OvertureData['stats'],
    warnings: [],
  };
}

const service = () => new RenderService(async () => new ArrayBuffer(0));
const buildingsArea = (result: Awaited<ReturnType<RenderService['render']>>) => result.groups.find((g) => g.id === 'buildings')!.areaMm2;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (options) => answer(options));
  vi.stubGlobal('fetch', async (url: string) =>
    url.endsWith('/14/2589/5606.pbf') ? new Response(tile.slice()) : new Response(null, { status: 204 }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildings from Overture in SVG maps', () => {
  it('is off by default and leaves the map as it was', async () => {
    expect(defaultRenderSettings('laser').source.overtureBuildings).toBe(false);
    const result = await service().render({ settings: settings((s) => (s.source.overtureBuildings = false)) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stats.overtureBuildings).toBeUndefined();
    expect(result.meta.attribution).toBe('© OpenStreetMap contributors');
    expect(result.warnings).toEqual([]);
  });

  it('adds only the footprints the tiles lack', async () => {
    const progress: RenderProgress[] = [];
    const off = await service().render({ settings: settings((s) => (s.source.overtureBuildings = false)) });
    const on = await service().render({ settings: settings() }, (p) => progress.push(p));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const options = fetchMock.mock.calls[0][0];
    expect(options.types).toEqual(['building']);
    expect(options.columns?.building).toContain('sources');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.bounds.west).toBeLessThan(centre.lon);
    expect(options.bounds.east).toBeGreaterThan(centre.lon);
    expect(options.bounds.south).toBeLessThan(centre.lat);
    expect(options.bounds.north).toBeGreaterThan(centre.lat);

    // The clear ML footprint is added, the one on a tile building and the OSM one aren't.
    expect(on.stats.overtureBuildings).toBe(1);
    expect(buildingsArea(on) - buildingsArea(off)).toBeCloseTo(SIDE * SIDE, 1);
    expect(on.meta.attribution).toBe('© OpenStreetMap contributors, Overture Maps Foundation');
    expect(toSvg(on)).toContain('Overture Maps Foundation');
    expect(on.warnings).toEqual([]);
    expect(progress.filter((p) => p.stage === 'buildings').map((p) => p.fraction)).toEqual([0, 0.5]);
    // The lines are the same. Fills under the new building only lose its
    // footprint and the water's gap around it.
    const lines = (r: typeof on) => r.groups.filter((g) => g.kind === 'stroke').map((g) => [g.id, g.lengthMm, g.subpaths]);
    expect(lines(on)).toEqual(lines(off));
    for (const group of off.groups.filter((g) => g.kind === 'fill' && g.id !== 'buildings')) {
      const after = on.groups.find((g) => g.id === group.id)!;
      expect(group.areaMm2 - after.areaMm2).toBeGreaterThanOrEqual(-1e-6);
      expect(group.areaMm2 - after.areaMm2).toBeLessThan(SIDE * SIDE * 3);
    }
  });

  it('downloads once per area, and turning it off goes back to the same map', async () => {
    const svc = service();
    const fresh = await service().render({ settings: settings((s) => (s.source.overtureBuildings = false)) });
    await svc.render({ settings: settings() });
    await svc.render({ settings: settings((s) => (s.style.colors.buildings = '#123456')) });
    const off = await svc.render({ settings: settings((s) => (s.source.overtureBuildings = false)) });
    const on = await svc.render({ settings: settings() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(off.groups).toEqual(fresh.groups);
    expect(off.stats.overtureBuildings).toBeUndefined();
    expect(on.stats.overtureBuildings).toBe(1);

    // A new area is a new download.
    await svc.render({ settings: settings((s) => (s.area = { ...s.area, widthM: 1100 })) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('downloads nothing with the buildings layer off', async () => {
    const result = await service().render({ settings: settings((s) => (s.layers = { ...s.layers, buildings: false })) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.groups.find((g) => g.id === 'buildings')).toBeUndefined();
    expect(result.meta.attribution).toBe('© OpenStreetMap contributors');
  });

  it('only adds them at full detail', async () => {
    const result = await service().render({ settings: settings((s) => (s.source.maxZoom = 13)) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stats.zoom).toBe(13);
    expect(result.stats.overtureBuildings).toBe(0);
    expect(result.warnings).toEqual([expect.stringMatching(/only added at full detail \(zoom 14\)/)]);
  });

  it('draws the map without them when Overture fails, and tries again a minute later', async () => {
    fetchMock.mockRejectedValue(new OvertureUnavailableError(false));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const svc = service();
    const first = await svc.render({ settings: settings() });
    expect(first.stats.overtureBuildings).toBe(0);
    expect(first.warnings).toEqual([expect.stringMatching(/couldn't be downloaded.*busy/)]);
    expect(first.groups.find((g) => g.id === 'buildings')).toBeDefined();

    await svc.render({ settings: settings((s) => (s.style.colors.water = '#000000')) });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_061_000);
    fetchMock.mockImplementation(async (options) => answer(options));
    const later = await svc.render({ settings: settings() });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(later.stats.overtureBuildings).toBe(1);
    expect(later.warnings).toEqual([]);
  });

  it('leaves them out of a map too big for them, for good', async () => {
    fetchMock.mockRejectedValue(new AreaTooLargeError(212e6, { building: 212e6 }, 'building'));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const svc = service();
    const result = await svc.render({ settings: settings() });
    expect(result.warnings).toEqual([expect.stringMatching(/would need 212 MB of building data, over the 150 MB limit/)]);
    expect(fetchMock.mock.calls[0][0].maxTypeBytes).toBe(150e6);
    now.mockReturnValue(9_000_000);
    await svc.render({ settings: settings() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops the download when the render is cancelled', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason));
        }),
    );
    let cancelled = false;
    const svc = service();
    const render = svc.render({ settings: settings() }, () => {}, () => cancelled);
    await vi.waitFor(() => expect(signal).toBeDefined());
    cancelled = true;
    await expect(render).rejects.toBeInstanceOf(CancelledError);
    expect(signal!.aborted).toBe(true);

    // The next render downloads them again.
    fetchMock.mockImplementation(async (options) => answer(options));
    const result = await svc.render({ settings: settings() });
    expect(result.stats.overtureBuildings).toBe(1);
  });

  it("can't add them to a map across the antimeridian", async () => {
    const result = await service().render({
      settings: settings((s) => (s.area = { lon: 179.995, lat: -16.5, bearing: 0, widthM: 2000 })),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([expect.stringMatching(/180th meridian/)]);
  });
});
