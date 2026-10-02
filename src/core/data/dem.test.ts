import { encode } from 'fast-png';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeoBounds } from '../types';
import {
  bilinear,
  chooseZoom,
  createDemMosaic,
  DecodeError,
  decodeTerrarium,
  fetchDem,
  groundResolutionM,
  repairElevation,
  tileCount,
  tileFraction,
  tileRange,
  tileUrl,
  VOID_M,
  type DemProgress,
} from './dem';
import { configureHttp, HttpError, setByteCache } from './http';
import { mockServer } from './testdata/serve';

// WGS84 position of a global pixel coordinate at a zoom.
function lonLat(pixelX: number, pixelY: number, zoom: number): [number, number] {
  const size = 256 * 2 ** zoom;
  return [(pixelX / size) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * pixelY) / size))) * 180) / Math.PI];
}

function bbox(west: number, south: number, east: number, north: number): GeoBounds {
  return { west, south, east, north };
}

// RGB bytes for a height in metres, the inverse of the Terrarium encoding.
function rgb(metres: number): [number, number, number] {
  const v = metres + 32768;
  return [Math.floor(v / 256), Math.floor(v % 256), Math.round((v - Math.floor(v)) * 256)];
}

function tile(height: (i: number) => number, channels = 3): Uint8Array {
  const data = new Uint8Array(256 * 256 * channels);
  for (let i = 0; i < 256 * 256; i++) {
    data.set(rgb(height(i)), i * channels);
    if (channels === 4) data[i * channels + 3] = 255;
  }
  return encode({ width: 256, height: 256, data, channels, depth: 8 });
}

beforeEach(() => {
  configureHttp({ maxInFlight: 6, retries: 1, retryDelayMs: 1 });
  setByteCache(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Expected values from jarvizar_city_model/external/download_dem.py with its
// zoom limit raised to 15.
describe('tile maths', () => {
  it('matches the Python tile fractions and resolutions', () => {
    expect(tileFraction(-87.63, 41.88, 12)[0]).toBeCloseTo(1050.9653333333333, 9);
    expect(tileFraction(-87.63, 41.88, 12)[1]).toBeCloseTo(1522.3404865366267, 9);
    expect(tileFraction(0, 0, 1)).toEqual([1, 1]);
    expect(tileFraction(139.6917, 35.6895, 15)[1]).toBeCloseTo(12902.391652163205, 7);
    expect(groundResolutionM(41.88, 12)).toBeCloseTo(28.455389028844653, 9);
    expect(groundResolutionM(0, 0)).toBeCloseTo(156543.03392804097, 6);
  });

  it('picks the same zooms and tiles as the Python code', () => {
    const cases: [GeoBounds, number, number, [number, number, number, number]][] = [
      [bbox(-87.635, 41.875, -87.625, 41.885), 5, 15, [8407, 12178, 8408, 12179]],
      [bbox(-87.635, 41.875, -87.625, 41.885), 30, 12, [1050, 1522, 1051, 1522]],
      [bbox(-87.64, 41.87, -87.61, 41.89), 13, 14, [4203, 6088, 4204, 6089]],
      [bbox(-88.2, 41.6, -87.5, 42.1), 5, 12, [1044, 1518, 1052, 1526]],
      [bbox(-122.52, 37.7, -122.35, 37.83), 20, 13, [1307, 3164, 1311, 3168]],
      [bbox(-88.2, 41.6, -87.5, 42.1), 100, 11, [522, 759, 526, 763]],
      [bbox(10, 45, 12, 47), 50, 11, [1080, 720, 1092, 736]],
    ];
    for (const [bounds, spacing, zoom, [x0, y0, x1, y1]] of cases) {
      expect(chooseZoom(bounds, spacing)).toBe(zoom);
      expect(tileRange(bounds, zoom)).toEqual({ x0, y0, x1, y1 });
    }
    expect(tileCount(bbox(10, 45, 12, 47), 11)).toBe(221);
  });

  it('keeps tile numbers inside the world', () => {
    expect(tileRange(bbox(-180, -89, 180, 89), 8)).toEqual({ x0: 0, y0: 0, x1: 255, y1: 255 });
  });
});

describe('decodeTerrarium', () => {
  const heights = [0, 10.5, -1, -32768, 8848.25];

  it('turns RGB and RGBA pixels into metres', () => {
    for (const channels of [3, 4]) {
      const decoded = decodeTerrarium(tile((i) => heights[i] ?? 100, channels));
      expect(Array.from(decoded.slice(0, 5))).toEqual(heights);
      expect(decoded[256 * 256 - 1]).toBe(100);
    }
  });

  it('refuses tiles it cannot read', () => {
    const small = encode({ width: 255, height: 256, data: new Uint8Array(255 * 256 * 3), channels: 3, depth: 8 });
    expect(() => decodeTerrarium(small)).toThrow(DecodeError);
    const deep = encode({ width: 256, height: 256, data: new Uint16Array(256 * 256 * 3), channels: 3, depth: 16 });
    expect(() => decodeTerrarium(deep)).toThrow(/16-bit/);
    const grey = encode({ width: 256, height: 256, data: new Uint8Array(256 * 256), channels: 1, depth: 8 });
    expect(() => decodeTerrarium(grey)).toThrow(/channels/);
    expect(() => decodeTerrarium(new Uint8Array([1, 2, 3]))).toThrow(DecodeError);
  });
});

describe('repairElevation', () => {
  const PIXEL_M = 4;
  function grid(columns: number, rows: number, height: (c: number, r: number) => number) {
    const values = new Float32Array(columns * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) values[r * columns + c] = height(c, r);
    return { zoom: 15, tileX0: 0, tileY0: 0, columns, rows, values };
  }

  it('fills voids from the pixels around them', () => {
    const g = grid(8, 8, (c, r) => (c >= 3 && c <= 5 && r >= 2 && r <= 4 ? VOID_M : 100));
    expect(repairElevation(g, PIXEL_M)).toBe(9);
    expect(Array.from(g.values).every((v) => v === 100)).toBe(true);
  });

  it('fills a lone garbage pixel, a band and a wide blob alike', () => {
    // On ground at 10 m: one pixel at -900 m, a band six pixels tall right
    // across the grid, and a 12 x 12 blob, wider than the reach.
    const g = grid(40, 50, (c, r) => {
      if (c === 5 && r === 5) return -900;
      if (r >= 20 && r <= 25) return -5000 - 1000 * c;
      if (c >= 14 && c <= 25 && r >= 32 && r <= 43) return -500;
      return 10;
    });
    expect(repairElevation(g, PIXEL_M)).toBe(1 + 6 * 40 + 144);
    expect(Math.min(...g.values)).toBe(10);
  });

  it('leaves real ground, polders, seabed and islands alone', () => {
    // A gorge 300 m deep and one pixel wide above sea level.
    const gorge = grid(20, 20, (c) => (c === 10 ? 200 : 500));
    // Polder fields at -5 m beside a dyke at +3 m.
    const polder = grid(20, 20, (c) => (c === 10 ? 3 : -5));
    // Seabed falling 2 m a pixel from the shore.
    const seabed = grid(60, 20, (c) => 5 - 2 * c);
    for (const g of [gorge, polder, seabed]) {
      const before = Float32Array.from(g.values);
      expect(repairElevation(g, PIXEL_M)).toBe(0);
      expect(g.values).toEqual(before);
    }
    // An island at +30 m ringed by seabed at -60 m. The steep seabed around
    // it is evened out, which the water covers, but the island stays.
    const island = grid(20, 20, (c, r) => (c >= 9 && c <= 11 && r >= 9 && r <= 11 ? 30 : -60));
    repairElevation(island, PIXEL_M);
    for (let r = 9; r <= 11; r++) for (let c = 9; c <= 11; c++) expect(island.values[r * 20 + c]).toBe(30);
  });

  it("doesn't judge or fill seabed from a missing tile's sea level", () => {
    // Columns 0-9 are a tile the server didn't have, the rest seabed at -40 m
    // with one garbage pixel right beside the missing tile.
    const g = grid(20, 8, (c, r) => (c < 10 ? 0 : c === 10 && r === 4 ? -900 : -40));
    const missing = new Uint8Array(20 * 8);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 10; c++) missing[r * 20 + c] = 1;
    expect(repairElevation(g, PIXEL_M, missing)).toBe(1);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 20; c++) expect(g.values[r * 20 + c]).toBe(c < 10 ? 0 : -40);
    }
  });
});

describe('mosaic sampling', () => {
  // Two tiles side by side at zoom 10, heights rising 2 m per column and 3 m per row.
  const zoom = 10;
  const tileX0 = 262;
  const tileY0 = 380;
  const columns = 512;
  const rows = 256;
  const values = new Float32Array(columns * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) values[r * columns + c] = 2 * c + 3 * r;
  const at = (x: number, y: number) => lonLat(tileX0 * 256 + x, tileY0 * 256 + y, zoom);
  const [west, north] = at(10.6, 5.6);
  const [east, south] = at(20.4, 8.4);
  const mosaic = createDemMosaic({ zoom, tileX0, tileY0, columns, rows, values }, bbox(west, south, east, north), 2, 0);

  it('reads pixel centres exactly and interpolates between them', () => {
    expect(mosaic.sample(...at(40.5, 7.5))).toBeCloseTo(80 + 21, 4);
    expect(mosaic.sample(...at(41, 7.5))).toBeCloseTo(81 + 21, 4);
    expect(mosaic.sample(...at(300.25, 100.75))).toBeCloseTo(2 * 299.75 + 3 * 100.25, 3);
  });

  it('clamps to the mosaic edges', () => {
    expect(mosaic.sample(...at(-50, 7.5))).toBeCloseTo(21, 4);
    expect(mosaic.sample(...at(40.5, 1000))).toBeCloseTo(80 + 3 * 255, 4);
  });

  it('reports the range the bounds can sample', () => {
    expect(mosaic.min).toBe(2 * 10 + 3 * 5);
    expect(mosaic.max).toBe(2 * 20 + 3 * 8);
    expect(mosaic.groundResolutionM).toBeCloseTo(groundResolutionM((south + north) / 2, zoom), 9);
  });

  it('bilinear matches hand arithmetic', () => {
    const grid = [0, 10, 20, 30];
    expect(bilinear(grid, 2, 2, 0.5, 0.5)).toBe(15);
    expect(bilinear(grid, 2, 2, 0.25, 0)).toBe(2.5);
    expect(bilinear(grid, 2, 2, 5, 5)).toBe(30);
  });
});

describe('fetchDem (offline)', () => {
  // Spans tiles 262 and 263 of row 380 at zoom 10.
  const [west, north] = lonLat(262.5 * 256, 380.2 * 256, 10);
  const [east, south] = lonLat(263.5 * 256, 380.8 * 256, 10);
  const bounds = bbox(west, south, east, north);

  it('stitches tiles and reads missing ones as sea level', async () => {
    const server = mockServer({ [tileUrl(10, 262, 380)]: tile(() => 100) });
    vi.stubGlobal('fetch', server.fetch);
    const progress: DemProgress[] = [];
    const dem = await fetchDem({ bounds, targetSpacingM: 1, zoom: 10, onProgress: (p) => progress.push(p) });
    expect(dem).toMatchObject({ zoom: 10, tileX0: 262, tileY0: 380, columns: 512, rows: 256, tilesUsed: 1, tilesMissing: 1, min: 0, max: 100 });
    expect(dem.sample(...lonLat(262.3 * 256, 380.5 * 256, 10))).toBe(100);
    expect(dem.sample(...lonLat(263.7 * 256, 380.5 * 256, 10))).toBe(0);
    expect(progress.at(-1)).toMatchObject({ tilesDone: 2, tilesTotal: 2 });
  });

  it('leaves seabed beside a missing tile as it is', async () => {
    // Zoom 15 at the equator, about 4.8 m pixels: 40 m of seabed beside a
    // missing tile's 0 m is steeper than ground can be, but it isn't garbage.
    const [w, n] = lonLat(16384.5 * 256, 16384.2 * 256, 15);
    const [e, s] = lonLat(16385.5 * 256, 16384.8 * 256, 15);
    vi.stubGlobal('fetch', mockServer({ [tileUrl(15, 16385, 16384)]: tile(() => -40) }).fetch);
    const dem = await fetchDem({ bounds: bbox(w, s, e, n), targetSpacingM: 1, zoom: 15 });
    expect(dem).toMatchObject({ columns: 512, rows: 256, tilesMissing: 1 });
    expect(dem.values.every((v, i) => v === (i % 512 < 256 ? 0 : -40))).toBe(true);
  });

  it('fills void pixels, cached tiles included', async () => {
    // A block of voids in the middle of each tile, as Terrarium has along some coasts.
    const holed = tile((i) => (i % 256 > 100 && i % 256 < 120 && i >> 8 > 100 && i >> 8 < 120 ? VOID_M : 12));
    const store = new Map<string, ArrayBuffer>([[tileUrl(10, 262, 380), holed.buffer.slice(holed.byteOffset, holed.byteOffset + holed.byteLength) as ArrayBuffer]]);
    setByteCache({ get: async (key) => store.get(key), put: async (key, value) => void store.set(key, value) });
    vi.stubGlobal('fetch', mockServer({ [tileUrl(10, 263, 380)]: holed }).fetch);
    const dem = await fetchDem({ bounds, targetSpacingM: 1, zoom: 10 });
    expect(dem.tilesUsed).toBe(2);
    expect(dem.values.reduce((a, b) => Math.min(a, b))).toBe(12);
    expect(dem.min).toBe(12);
  });

  it('fails on other errors and on an area with no tiles', async () => {
    const server = mockServer({ [tileUrl(10, 262, 380)]: tile(() => 100) });
    vi.stubGlobal('fetch', server.fetch);
    server.failNext((url) => url.endsWith('/263/380.png'), 500, 2);
    const error = await fetchDem({ bounds, targetSpacingM: 1, zoom: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(500);

    vi.stubGlobal('fetch', mockServer({}).fetch);
    await expect(fetchDem({ bounds, targetSpacingM: 1, zoom: 10 })).rejects.toThrow(/No elevation tiles/);
  });

  it('downloads a damaged cached tile again', async () => {
    const store = new Map<string, ArrayBuffer>([[tileUrl(10, 262, 380), new Uint8Array([137, 80, 78, 71]).buffer]]);
    setByteCache({ get: async (key) => store.get(key), put: async (key, value) => void store.set(key, value) });
    const server = mockServer({ [tileUrl(10, 262, 380)]: tile(() => 42), [tileUrl(10, 263, 380)]: tile(() => 43) });
    vi.stubGlobal('fetch', server.fetch);
    const dem = await fetchDem({ bounds, targetSpacingM: 1, zoom: 10 });
    expect(dem.tilesUsed).toBe(2);
    expect(dem.min).toBe(42);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get(tileUrl(10, 262, 380))!.byteLength).toBeGreaterThan(4);
  });
});
