import { PbfWriter } from 'pbf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lonLatToWorld, TILE_EXTENT, worldToLonLat } from '../svgmap/geo/mercator';
import type { GeoBounds } from '../types';
import type { OvertureData } from './features';
import { configureHttp, setByteCache } from './http';
import { fetchRaceways, racewayFeatures, tileRaceways, withRaceways } from './raceways';
import { mockServer } from './testdata/serve';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const tileUrl = (z: number, x: number, y: number) => `https://tiles.test/${z}/${x}/${y}.pbf`;

interface TileLine {
  props: Record<string, string>;
  /** Lon/lat. */
  line: [number, number][];
}

// A transportation layer of line features, projected into tile z/x/y. Lines
// can run past the tile, as they do in the margin of real tiles.
function encodeTile(z: number, x: number, y: number, lines: TileLine[]): Uint8Array {
  const zigzag = (n: number) => (n << 1) ^ (n >> 31);
  const keys: string[] = [];
  const values: string[] = [];
  const index = (list: string[], value: string) => (list.includes(value) ? list.indexOf(value) : list.push(value) - 1);
  const features = lines.map(({ props, line }) => {
    const tags = Object.entries(props).flatMap(([k, v]) => [index(keys, k), index(values, v)]);
    const geometry: number[] = [];
    let [cx, cy] = [0, 0];
    line.forEach(([lon, lat], i) => {
      const [wx, wy] = lonLatToWorld(lon, lat, z);
      const [px, py] = [Math.round(wx - x * TILE_EXTENT), Math.round(wy - y * TILE_EXTENT)];
      if (i === 0) geometry.push(1 | (1 << 3));
      if (i === 1) geometry.push(2 | ((line.length - 1) << 3));
      geometry.push(zigzag(px - cx), zigzag(py - cy));
      [cx, cy] = [px, py];
    });
    return { tags, geometry };
  });
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_: unknown, layer: PbfWriter) => {
    layer.writeVarintField(15, 2);
    layer.writeStringField(1, 'transportation');
    for (const f of features) {
      layer.writeMessage(2, (_f: unknown, w: PbfWriter) => {
        w.writePackedVarint(2, f.tags);
        w.writeVarintField(3, 2);
        w.writePackedVarint(4, f.geometry);
      }, null);
    }
    for (const key of keys) layer.writeStringField(3, key);
    for (const value of values) layer.writeMessage(4, (_v: unknown, w: PbfWriter) => w.writeStringField(1, value), null);
    layer.writeVarintField(5, TILE_EXTENT);
  }, null);
  return pbf.finish();
}

const bytes = (tile: Uint8Array) => tile.slice().buffer;

// Lon/lat of a fractional zoom 14 tile position.
function at(x: number, y: number): [number, number] {
  const p = worldToLonLat(x * TILE_EXTENT, y * TILE_EXTENT, 14);
  return [p.lon, p.lat];
}

// Inside zoom 12 tile 1050/1522, over zoom 14 tiles 4201 and 4202 of row 6089.
const [west, north] = at(4201.5, 6089.2);
const [east, south] = at(4202.5, 6089.8);
const bounds: GeoBounds = { west, south, east, north };
const track = [at(4201.7, 6089.5), at(4202.3, 6089.5)];
const street = [at(4201.6, 6089.3), at(4202.4, 6089.3)];

beforeEach(() => {
  configureHttp({ maxInFlight: 6, retries: 1, retryDelayMs: 1 });
  setByteCache(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading raceways from tiles', () => {
  it('keeps raceway lines only, cut at the tile edge', () => {
    const tile = encodeTile(14, 4201, 6089, [
      { props: { class: 'raceway' }, line: track },
      { props: { class: 'primary' }, line: street },
      { props: { class: 'raceway', brunnel: 'bridge' }, line: [at(4201.2, 6089.6), at(4201.4, 6089.6)] },
    ]);
    const lines = tileRaceways(bytes(tile), 4201, 6089);
    expect(lines.map((l) => l.key)).toEqual(['', 'bridge']);
    expect(lines[0].path.at(-1)![0]).toBe(4202 * TILE_EXTENT);
  });

  it('joins pieces cut at tile edges into one segment', () => {
    const pieces = [4201, 4202].flatMap((x) => tileRaceways(bytes(encodeTile(14, x, 6089, [{ props: { class: 'raceway' }, line: track }])), x, 6089));
    expect(pieces).toHaveLength(2);
    const [feature, ...rest] = racewayFeatures(pieces, 14, bounds);
    expect(rest).toHaveLength(0);
    expect(feature).toMatchObject({ type: 'segment', props: { subtype: 'road', class: 'raceway' } });
    const coordinates = (feature.geometry as { coordinates: [number, number][] }).coordinates;
    expect(coordinates[0][0]).toBeCloseTo(track[0][0], 5);
    expect(coordinates.at(-1)![0]).toBeCloseTo(track[1][0], 5);
  });

  it('gives bridges their flag and every line its own id', () => {
    // Same ends and length, but a bridge never joins the ground line.
    const line = [at(4201.6, 6089.6), at(4201.8, 6089.6)];
    const tile = encodeTile(14, 4201, 6089, [
      { props: { class: 'raceway' }, line },
      { props: { class: 'raceway', brunnel: 'bridge' }, line },
    ]);
    const features = racewayFeatures(tileRaceways(bytes(tile), 4201, 6089), 14, bounds);
    expect(features.map((f) => f.props.road_flags)).toEqual([undefined, [{ values: ['is_bridge'] }]]);
    expect(features[1].id).toBe(`${features[0].id}-2`);
  });
});

describe('fetchRaceways (offline)', () => {
  const tileJson = JSON.stringify({ tiles: ['https://tiles.test/{z}/{x}/{y}.pbf'] });

  it('finds tracks at zoom 12 and reads them at zoom 14', async () => {
    const server = mockServer({
      [TILEJSON]: tileJson,
      [tileUrl(12, 1050, 1522)]: encodeTile(12, 1050, 1522, [{ props: { class: 'raceway' }, line: track }, { props: { class: 'primary' }, line: street }]),
      [tileUrl(14, 4201, 6089)]: encodeTile(14, 4201, 6089, [{ props: { class: 'raceway' }, line: track }]),
      [tileUrl(14, 4202, 6089)]: encodeTile(14, 4202, 6089, [{ props: { class: 'raceway' }, line: track }]),
    });
    vi.stubGlobal('fetch', server.fetch);
    const found = await fetchRaceways(bounds);
    expect(found.warning).toBeUndefined();
    expect(found.features).toHaveLength(1);
    expect(found.downloaded).toBeGreaterThan(0);
    expect(server.requests.map((r) => r.url).filter((u) => u.includes('/14/')).sort()).toEqual([tileUrl(14, 4201, 6089), tileUrl(14, 4202, 6089)]);
  });

  it('reads nothing more where zoom 12 has no tracks', async () => {
    const server = mockServer({
      [TILEJSON]: tileJson,
      [tileUrl(12, 1050, 1522)]: encodeTile(12, 1050, 1522, [{ props: { class: 'primary' }, line: street }]),
    });
    vi.stubGlobal('fetch', server.fetch);
    expect(await fetchRaceways(bounds)).toEqual({ features: [], downloaded: expect.any(Number) });
    expect(server.requests.map((r) => r.url)).toEqual([TILEJSON, tileUrl(12, 1050, 1522)]);
  });

  it('warns instead of failing the model when the tiles are down', async () => {
    const server = mockServer({ [TILEJSON]: tileJson });
    server.failNext((url) => url.includes('/12/'), 503, 2);
    vi.stubGlobal('fetch', server.fetch);
    const found = await fetchRaceways(bounds);
    expect(found.features).toEqual([]);
    expect(found.warning).toMatch(/Racetracks couldn't be downloaded/);
  });

  it('still stops when cancelled', async () => {
    vi.stubGlobal('fetch', mockServer({ [TILEJSON]: tileJson }).fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchRaceways(bounds, controller.signal)).rejects.toThrow();
  });
});

describe('withRaceways', () => {
  const data = { features: { segment: [{ id: 'a' }] }, warnings: ['old'] } as unknown as OvertureData;

  it('adds the tracks to the segments and passes a warning on', () => {
    const feature = { id: 'raceway-1' } as OvertureData['features']['segment'][number];
    const added = withRaceways(data, { features: [feature], downloaded: 0, warning: 'new' });
    expect(added.features.segment.map((f) => f.id)).toEqual(['a', 'raceway-1']);
    expect(added.warnings).toEqual(['old', 'new']);
    expect(data.features.segment).toHaveLength(1);
    expect(withRaceways(data, null)).toBe(data);
  });
});
