// Bavaria, Saxony, Thuringia, Salzburg and Vorarlberg against canned files
// and catalog answers: tile names from the grids, dates from headers, WMS
// answers and ZIP members, and what each does where a tile is missing.

import { zipSync } from 'fflate';
import proj4 from 'proj4';
import { afterEach, describe, expect, it } from 'vitest';
import type { GeoBounds } from '../../types';
import { setCorsProxy } from '../../data/corsProxy';
import { HttpError } from '../../data/http';
import { crsFromEpsg, lonLatTransforms, setProjector } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { bavaria } from './bavaria';
import { lasStart, localMember } from './common';
import { ringBox } from './common';
import { salzburg, sheetName as salzburgSheet } from './salzburg';
import { saxony } from './saxony';
import { metaMonth, thuringia } from './thuringia';
import { sheetName as vorarlbergSheet, sheets as vorarlbergSheets, vorarlberg } from './vorarlberg';

setProjector((from, to) => proj4(from, to));
afterEach(() => setCorsProxy(null));

/** Files by URL; anything else is a 404, as the servers answer. */
function fakeFetcher(files: Record<string, Uint8Array>, json: (url: string) => object = () => ({ type: 'FeatureCollection', features: [] })) {
  const requested: string[] = [];
  const file = (url: string) => {
    requested.push(url);
    const bytes = files[url];
    if (!bytes) throw new HttpError(404, url);
    return bytes;
  };
  const fetcher = {
    downloaded: 0,
    json: async (url: string) => {
      requested.push(url);
      return json(url);
    },
    size: async (url: string) => file(url).length,
    range: async (url: string, start: number, end: number) => {
      const bytes = file(url);
      if (end > bytes.length) throw new Error(`Range past the end of ${url}`);
      return bytes.slice(start, end).buffer;
    },
    tail: async (url: string, start: number) => file(url).slice(start).buffer,
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

/** Adjusted standard GPS time at noon on a day. */
const gps = (date: string) => (Date.parse(`${date}T12:00:00Z`) - Date.UTC(1980, 0, 6)) / 1000 - 1e9;

/** A LAS/LAZ file's start: header without VLRs, then (for LAZ) the chunk table offset and a raw first point. */
function lasFile(o: { box: [number, number, number, number]; minor?: number; format?: number; encoding?: number; made?: number; flown?: string; count?: number; compressed?: boolean }): Uint8Array {
  const minor = o.minor ?? 2;
  const format = o.format ?? 1;
  const compressed = o.compressed ?? true;
  const headerSize = minor >= 4 ? 375 : 227;
  const bytes = new Uint8Array(Math.max(headerSize + 8 + 40, 400));
  const view = new DataView(bytes.buffer);
  bytes.set([76, 65, 83, 70]);
  view.setUint16(6, o.encoding ?? 1, true);
  bytes[24] = 1;
  bytes[25] = minor;
  view.setUint16(90, 150, true);
  view.setUint16(92, o.made ?? 2022, true);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  bytes[104] = format | (compressed ? 0x80 : 0);
  view.setUint16(105, format >= 6 ? 30 : 28, true);
  const count = o.count ?? 1000;
  view.setUint32(107, minor >= 4 ? 0 : count, true);
  for (const at of [131, 139, 147]) view.setFloat64(at, 0.01, true);
  const [w, s, e, n] = o.box;
  view.setFloat64(179, e, true);
  view.setFloat64(187, w, true);
  view.setFloat64(195, n, true);
  view.setFloat64(203, s, true);
  if (minor >= 4) view.setBigUint64(247, BigInt(count), true);
  if (o.flown) view.setFloat64(headerSize + (compressed ? 8 : 0) + (format >= 6 ? 22 : 20), gps(o.flown), true);
  return bytes;
}

const lonLatBox = (epsg: number, [w, s, e, n]: [number, number, number, number]): GeoBounds => {
  const { toLonLat } = lonLatTransforms(crsFromEpsg(epsg));
  const corners = [toLonLat(w, s), toLonLat(e, s), toLonLat(e, n), toLonLat(w, n)];
  return { west: Math.max(...[corners[0][0], corners[3][0]]), south: Math.max(corners[0][1], corners[1][1]), east: Math.min(corners[1][0], corners[2][0]), north: Math.min(corners[2][1], corners[3][1]) };
};

describe('Bavaria', () => {
  const FILES = 'https://geodaten.bayern.de/odd_data/laser/';

  it('needs the proxy', async () => {
    expect(await bavaria.discover(fakeFetcher({}).fetcher, lonLatBox(25832, [691200, 5334200, 691800, 5334800]), [])).toEqual([]);
  });

  it('names tiles by their UTM32 corner and groups them by the year their first point was flown', async () => {
    setCorsProxy('direct');
    // Nuremberg-style December flight: the header was written the next year.
    const december = lasFile({ box: [690000, 5334000, 691000, 5335000], made: 2022, flown: '2021-12-20' });
    const february = lasFile({ box: [691000, 5334000, 692000, 5335000], made: 2022, flown: '2022-02-27' });
    const { fetcher, requested } = fakeFetcher({ [`${FILES}690_5334.laz`]: december, [`${FILES}691_5334.laz`]: february });
    const surveys = await bavaria.discover(fetcher, lonLatBox(25832, [690500, 5334200, 691500, 5334800]), []);
    expect(surveys.map((c) => [c.id, c.projectYearHint, c.acquisitionStart, c.acquisitionEnd, c.tiles!.map((t) => t.url.split('/').pop())])).toEqual([
      ['bavaria-2022', 2022, '2022-02-27', '2022-02-27', ['691_5334.laz']],
      ['bavaria-2021', 2021, '2021-12-20', '2021-12-20', ['690_5334.laz']],
    ]);
    expect(surveys[0].tiles![0]).toMatchObject({ horizontalCrs: 'EPSG:25832' });
    // Offers ask for the size: the server gzips HEAD answers and leaves out the length.
    expect(surveys[0].tiles![0].size).toBeUndefined();
    expect(surveys[0]).toMatchObject({ format: 'LAZ', classification: { '2': 'ground', '6': 'building', '20': 'unclassified' } });
    expect(surveys[0].classification!['22']).toBeUndefined();
    // The header and the first point, per tile.
    expect(requested.filter((u) => u.endsWith('691_5334.laz'))).toHaveLength(2);
  });

  it("skips tiles the server doesn't have, and dates a tile without GPS dates by its header", async () => {
    setCorsProxy('direct');
    const { fetcher } = fakeFetcher({ [`${FILES}691_5334.laz`]: lasFile({ box: [691000, 5334000, 692000, 5335000], encoding: 0, made: 2023, flown: '2022-02-27' }) });
    const [survey, more] = await bavaria.discover(fetcher, lonLatBox(25832, [690500, 5334200, 691500, 5334800]), []);
    expect(more).toBeUndefined();
    expect(survey).toMatchObject({ id: 'bavaria-2023', acquisitionStart: '2023-01-01', acquisitionEnd: '2023-12-31' });
    expect(survey.tiles!.map((t) => t.url)).toEqual([`${FILES}691_5334.laz`]);
  });

  it("covers only the part of a tile on the state's edge that has points", async () => {
    setCorsProxy('direct');
    const edge = lasFile({ box: [691000, 5334000, 691300, 5335000], flown: '2022-02-27' });
    const { fetcher } = fakeFetcher({ [`${FILES}691_5334.laz`]: edge });
    expect(await bavaria.discover(fetcher, lonLatBox(25832, [691500, 5334200, 691800, 5334800]), [])).toEqual([]);
    const [survey] = await bavaria.discover(fetcher, lonLatBox(25832, [691100, 5334200, 691800, 5334800]), []);
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25832));
    // The grid's north isn't true north, so the furthest east is a corner.
    const east = Math.max(toLonLat(691300, 5334000)[0], toLonLat(691300, 5335000)[0]);
    expect(ringBox(survey.coverage[0])[2]).toBeCloseTo(east, 6);
  });

  it('reads class 22 as bridges in tiles flown up to 2020', async () => {
    setCorsProxy('direct');
    const { fetcher } = fakeFetcher({ [`${FILES}691_5334.laz`]: lasFile({ box: [691000, 5334000, 692000, 5335000], made: 2020, flown: '2020-01-12' }) });
    const [survey] = await bavaria.discover(fetcher, lonLatBox(25832, [691200, 5334200, 691800, 5334800]), []);
    expect(survey).toMatchObject({ id: 'bavaria-2020', classification: { '22': 'bridge' } });
  });

  it('reads the GPS date of LAS 1.4 point formats and leaves empty files undated', async () => {
    const url = 'https://example.com/a.laz';
    const { fetcher } = fakeFetcher({ [url]: lasFile({ box: [0, 0, 1, 1], minor: 4, format: 6, flown: '2022-03-03', made: 2023 }), [`${url}.empty`]: new Uint8Array(200) });
    expect(await lasStart(fetcher, url)).toMatchObject({ points: 1000, date: '2022-03-03', year: 2022, box: [0, 0, 1, 1] });
    expect((await lasStart(fetcher, `${url}.empty`, 200)).points).toBe(0);
  });
});

describe('Saxony', () => {
  const SHARE = 'https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/EpkzyJHScGb5ndd/';
  // What the currency WMS lists: tile corner (UTM33 km) to its dates.
  const listed: Record<string, string> = { '410_5656': '2024-11-30', '412_5656': '2022-12-18, 2023-01-09' };

  const wms = (url: string) => {
    const [x, y] = /BBOX=(\d+),(\d+),/.exec(url)!.slice(1).map(Number);
    const key = `${x / 1000}_${y / 1000}`;
    if (!listed[key]) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: null, properties: { Kachelbezeichnung_AdV: `33${key}_2_sn`, Ausdehnung_ETRS89_UTM33: `${x} ${y} ${x + 2000} ${y + 2000}`, 'Aktualität_Digitale_Höhenmodelle': listed[key] } }],
    };
  };

  /** A ZIP's first 375 bytes: the LAZ member's local header with its sizes, as GeoSN's have. */
  const zipStart = (name: string, compressed: number) => {
    const bytes = new Uint8Array(375);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, 8, true);
    view.setUint32(18, compressed, true);
    view.setUint32(22, compressed - 1000, true);
    view.setUint16(26, name.length, true);
    bytes.set(new TextEncoder().encode(name), 30);
    return bytes;
  };

  it('takes tiles and dates from the WMS, and the member and its size from the local header', async () => {
    setCorsProxy('direct');
    const { fetcher, requested } = fakeFetcher(
      {
        [`${SHARE}lsc_33410_5656_2_sn_laz.zip`]: zipStart('lsc_33410_5656_2_sn.laz', 363974370),
        [`${SHARE}lsc_33412_5656_2_sn_laz.zip`]: zipStart('lsc_33412_5656_2_sn.laz', 244363000),
      },
      wms,
    );
    // Over tiles 410 and 412 east, 5656 and 5658 north. Only the first row is listed.
    const surveys = await saxony.discover(fetcher, lonLatBox(25833, [411500, 5657500, 412500, 5658500]), []);
    expect(surveys.map((c) => [c.id, c.projectYearHint, c.acquisitionStart, c.acquisitionEnd])).toEqual([
      ['saxony-2024', 2024, '2024-11-30', '2024-11-30'],
      ['saxony-2023', 2023, '2022-12-18', '2023-01-09'],
    ]);
    expect(surveys[0].tiles).toEqual([
      expect.objectContaining({ url: `${SHARE}lsc_33410_5656_2_sn_laz.zip`, member: 'lsc_33410_5656_2_sn.laz', bytes: 363974370, horizontalCrs: 'EPSG:25833' }),
    ]);
    expect(surveys[0].tiles![0].size).toBeUndefined();
    expect(surveys[0].classification).toEqual({ '1': 'unclassified', '2': 'ground', '20': 'unclassified' });
    // Nothing the WMS didn't list was asked of the share, and nothing but the first bytes.
    expect(requested.filter((u) => u.startsWith(SHARE)).sort()).toEqual([`${SHARE}lsc_33410_5656_2_sn_laz.zip`, `${SHARE}lsc_33412_5656_2_sn_laz.zip`]);
  });

  it('falls back to the expected member name when the first member is something else', async () => {
    setCorsProxy('direct');
    const { fetcher } = fakeFetcher({ [`${SHARE}lsc_33410_5656_2_sn_laz.zip`]: zipStart('readme.txt', 10) }, wms);
    const [survey] = await saxony.discover(fetcher, lonLatBox(25833, [410500, 5656500, 411500, 5657500]), []);
    expect(survey.tiles![0]).toMatchObject({ member: 'lsc_33410_5656_2_sn.laz', bytes: undefined });
  });

  it('reads a local header with its sizes after the data as having none', () => {
    const bytes = zipStart('a.laz', 500);
    new DataView(bytes.buffer).setUint16(6, 8, true);
    expect(localMember(bytes)).toMatchObject({ name: 'a.laz', dataAt: 35, compressedSize: undefined });
  });
});

describe('Thuringia', () => {
  const FILES = 'https://geoportal.geoportal-th.de/hoehendaten/LAS/';
  const meta = (month: string) => new TextEncoder().encode(`Datei: x.laz\nErfassungsdatum: ${month}\nErfassungsmethode: Airborne Laserscanning\n(c) GDI-Th, Freistaat Thueringen\n`);
  const tile = (base: string, month?: string) =>
    zipSync({ [`${base}.laz`]: [new Uint8Array(3000).fill(7), { level: 0 }], ...(month ? { [`${base}.meta`]: [meta(month), { level: 6 }] } : {}) });

  it('reads the flight month from the .meta member and groups by year', async () => {
    setCorsProxy('direct');
    const erfurt = tile('las_32_642_5649_1_th_2020-2025', '2019-12');
    const { fetcher, requested } = fakeFetcher({ [`${FILES}las_2020-2025/las_32_642_5649_1_th_2020-2025.zip`]: erfurt });
    const [survey] = await thuringia.discover(fetcher, lonLatBox(25832, [642200, 5649200, 642800, 5649800]), []);
    expect(survey).toMatchObject({ id: 'thuringia-2020-2025-2019', projectYearHint: 2019, acquisitionStart: '2019-12-01', acquisitionEnd: '2019-12-31' });
    expect(survey.tiles).toEqual([
      expect.objectContaining({ url: `${FILES}las_2020-2025/las_32_642_5649_1_th_2020-2025.zip`, member: 'las_32_642_5649_1_th_2020-2025.laz', bytes: 3000, horizontalCrs: 'EPSG:25832' }),
    ]);
    // The first bytes and the rest after the LAZ, nothing else.
    expect(requested).toHaveLength(2);
  });

  it('falls back to 2014-2019 for a tile the current campaign lacks, and to the campaign year without a .meta', async () => {
    setCorsProxy('direct');
    const { fetcher } = fakeFetcher({
      [`${FILES}las_2014-2019/las_642_5649_1_th_2014-2019.zip`]: tile('las_642_5649_1_th_2014-2019', '2014-01'),
      [`${FILES}las_2020-2025/las_32_643_5649_1_th_2020-2025.zip`]: tile('las_32_643_5649_1_th_2020-2025'),
    });
    const surveys = await thuringia.discover(fetcher, lonLatBox(25832, [642500, 5649200, 643500, 5649800]), []);
    expect(surveys.map((c) => [c.id, c.acquisitionStart, c.tiles!.map((t) => t.url.split('/').pop())])).toEqual([
      ['thuringia-2020-2025-2020', '2020-01-01', ['las_32_643_5649_1_th_2020-2025.zip']],
      ['thuringia-2014-2019-2014', '2014-01-01', ['las_642_5649_1_th_2014-2019.zip']],
    ]);
  });

  it('reads the month from either campaign\'s .meta text', () => {
    expect(metaMonth('Datei: a.laz\nErfassungsdatum: 2020-02\n')).toBe('2020-02');
    expect(metaMonth('Erfassungsmethode: Airborne Laserscanning')).toBeUndefined();
  });
});

describe('Salzburg', () => {
  const FILES = 'https://service.salzburg.gv.at/sagisogd/archiv/raster/hoehen/laserscan/Originalpunkte/ungefiltert/DOM/';

  it('numbers sheets as the Land does', () => {
    // Lower-left corners from real files' headers, and points from the index.
    const boxes: [string, number, number][] = [
      ['4330392', 428125, 295500],
      ['4124213', 405000, 237000],
      ['3625713', 357500, 241000],
      ['4532663', 441250, 311000],
      ['4429282', 434375, 286500],
      ['3923521', 383750, 223500],
      ['4126121', 403750, 258500],
      ['4626154', 458125, 258000],
      ['4923063', 486250, 229000],
      ['5022253', 490000, 216000],
    ];
    for (const [name, x, y] of boxes) expect(salzburgSheet(x + 312.5, y + 250)).toBe(name);
    expect(salzburgSheet(432237, 282731)).toBe('4429582');
    expect(salzburgSheet(486221, 221107)).toBe('4923694');
  });

  it("reads epoch 3 where it's there, dated by its first point", async () => {
    setCorsProxy('direct');
    const file = lasFile({ box: [428125, 295500, 428750, 296000], minor: 4, format: 6, made: 2023, flown: '2022-03-03' });
    const { fetcher } = fakeFetcher({ [`${FILES}4330392_dom_op_3_m.laz`]: file, [`${FILES}4330392_dom_op_2_m.laz`]: lasFile({ box: [428125, 295500, 428750, 296000], made: 2016 }) });
    const surveys = await salzburg.discover(fetcher, lonLatBox(31258, [428300, 295600, 428600, 295900]), []);
    expect(surveys.map((c) => [c.id, c.projectYearHint, c.acquisitionStart])).toEqual([['salzburg-3-2022', 2022, '2022-03-03']]);
    expect(surveys[0].tiles![0]).toMatchObject({ url: `${FILES}4330392_dom_op_3_m.laz`, size: file.length, horizontalCrs: 'EPSG:31258' });
    expect(surveys[0].name).toBe('Salzburg ALS 2022 (epoch 3)');
  });

  it('falls back to epoch 2 where epoch 3 is missing, empty, or leaves part of the sheet', async () => {
    setCorsProxy('direct');
    const sheet: [number, number, number, number] = [409375, 242500, 410000, 243000];
    const epoch2 = lasFile({ box: sheet, encoding: 0, made: 2017, flown: '2016-06-01' });
    const name = salzburgSheet(409375 + 312.5, 242500 + 250);
    const area = lonLatBox(31258, [409500, 242600, 409900, 242900]);

    const missing = fakeFetcher({ [`${FILES}${name}_dom_op_2_m.laz`]: epoch2 });
    expect((await salzburg.discover(missing.fetcher, area, [])).map((c) => [c.id, c.acquisitionStart])).toEqual([['salzburg-2-2017', '2017-01-01']]);

    const empty = fakeFetcher({ [`${FILES}${name}_dom_op_3_m.laz`]: lasFile({ box: sheet, minor: 4, format: 6, count: 0 }), [`${FILES}${name}_dom_op_2_m.laz`]: epoch2 });
    expect((await salzburg.discover(empty.fetcher, area, [])).map((c) => c.id)).toEqual(['salzburg-2-2017']);

    // Zell am See's epoch 3 sheet stops 123 m short of its east edge.
    const part = fakeFetcher({ [`${FILES}${name}_dom_op_3_m.laz`]: lasFile({ box: [409375, 242500, 409877, 243000], minor: 4, format: 6, flown: '2024-04-08' }), [`${FILES}${name}_dom_op_2_m.laz`]: epoch2 });
    const surveys = await salzburg.discover(part.fetcher, area, []);
    expect(surveys.map((c) => c.id)).toEqual(['salzburg-3-2024', 'salzburg-2-2017']);
    const { toLonLat } = lonLatTransforms(crsFromEpsg(31258));
    const east = Math.max(toLonLat(409877, 242500)[0], toLonLat(409877, 243000)[0]);
    expect(ringBox(surveys[0].coverage[0])[2]).toBeCloseTo(east, 6);
  });
});

describe('Vorarlberg', () => {
  it('lists the 2023 sheets and names them on the 1:5000 grid', () => {
    expect(vorarlbergSheets().size).toBe(503);
    expect(vorarlbergSheet(-62500, 237500)).toBe('09245101');
    expect(vorarlbergSheet(-55000, 215000)).toBe('10225102');
    expect(vorarlbergSheet(-52500, 212500)).toBe('10225301');
    expect(vorarlbergSheet(-45000, 262500)).toBe('11275300');
    expect(vorarlbergSheets().get('-57500,262500')).toEqual([-57500, 262500, -57320, 262850]);
  });

  it('finds sheets without asking anything of the server', async () => {
    setCorsProxy('direct');
    const { fetcher, requested } = fakeFetcher({});
    // Dornbirn.
    const [survey] = await vorarlberg.discover(fetcher, { west: 9.74, south: 47.412, east: 9.744, north: 47.416 }, []);
    expect(requested).toEqual([]);
    expect(survey).toMatchObject({ id: 'vorarlberg-2023', format: 'COPC', projectYearHint: 2023, acquisitionStart: '2023-03-18' });
    expect(survey.tiles!.map((t) => [t.url.split('/').pop(), t.horizontalCrs])).toEqual([['pc2023_11265300.copc.laz', 'EPSG:31254']]);
    expect(survey.classification).toMatchObject({ '6': 'building', '17': 'bridge', '64': 'ground' });
    expect(survey.classification!['34']).toBeUndefined();
  });

  it('leaves out sheets whose points stop short of the area, and anything outside the list', async () => {
    setCorsProxy('direct');
    const { fetcher } = fakeFetcher({});
    expect(await vorarlberg.discover(fetcher, lonLatBox(31254, [-57000, 263500, -56000, 264500]), [])).toEqual([]);
    expect(await vorarlberg.discover(fetcher, lonLatBox(31254, [-70000, 263500, -69000, 264500]), [])).toEqual([]);
    setCorsProxy(null);
    expect(await vorarlberg.discover(fetcher, { west: 9.74, south: 47.412, east: 9.744, north: 47.416 }, [])).toEqual([]);
  });
});
