// GUGiK, Maa- ja Ruumiamet, the City of Winnipeg and the Intendencia de
// Montevideo against canned catalog answers, trimmed from real ones.

import proj4 from 'proj4';
import { afterEach, describe, expect, it } from 'vitest';
import { setCorsProxy } from '../../data/corsProxy';
import type { GeoBounds } from '../../types';
import { setProjector } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { estonia, estoniaFiles, sheetNumber } from './estonia';
import { montevideo } from './montevideo';
import { gugikSheets, gugikSurveys, poland } from './poland';
import { winnipeg } from './winnipeg';

setProjector((from, to) => proj4(from, to));
setCorsProxy('direct');
afterEach(() => setCorsProxy('direct'));

function fakeFetcher(route: (url: string) => string | object | undefined) {
  const requested: string[] = [];
  const get = (url: string) => {
    requested.push(url);
    const answer = route(url);
    if (answer === undefined) throw new Error(`Download failed with HTTP 404: ${url}`);
    return answer;
  };
  const fetcher = {
    downloaded: 0,
    text: async (url: string) => get(url) as string,
    json: async (url: string) => get(url),
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

const around = (lon: number, lat: number, d = 0.002): GeoBounds => ({ west: lon - d, south: lat - d, east: lon + d, north: lat + d });

describe('GUGiK', () => {
  const capabilities = [2022, 2023, 2024, 2025, 2026].map((y) => `<FeatureType><Name>gugik:SkorowidzDanychPomiarowychLIDAR${y}</Name></FeatureType>`).join('\n');

  const member = (o: { sheet: string; date: string; batch: string; xy: string; density: number; filled?: boolean; latLon: string; order?: string; url?: string }) => `
    <wfs:member>
      <gugik:SkorowidzDanychPomiarowychLIDAR${o.date.slice(0, 4)} gml:id="x">
        <gugik:msGeometry>
          <gml:Polygon gml:id="x.1" srsName="urn:ogc:def:crs:EPSG::4326">
            <gml:exterior><gml:LinearRing><gml:posList srsDimension="2">${o.latLon} </gml:posList></gml:LinearRing></gml:exterior>
          </gml:Polygon>
        </gugik:msGeometry>
        <gugik:godlo>${o.sheet}</gugik:godlo>
        <gugik:akt_rok>${o.date.slice(0, 4)}</gugik:akt_rok>
        <gugik:format>LAZ</gugik:format>
        <gugik:char_przestrz>${o.density} p/m2</gugik:char_przestrz>
        <gugik:uklad_xy>${o.xy}</gugik:uklad_xy>
        <gugik:uklad_h>PL-EVRF2007-NH</gugik:uklad_h>
        <gugik:nr_zglosz>${o.order ?? 'DFT.7201.010.2025'}</gugik:nr_zglosz>
        <gugik:akt_data gml:id="x.akt_data"><gml:timePosition>${o.date}</gml:timePosition></gugik:akt_data>
        <gugik:czy_ark_wypelniony>${o.filled === false ? 'NIE' : 'TAK'}</gugik:czy_ark_wypelniony>
        <gugik:url_do_pobrania>${o.url ?? `https://opendata.geoportal.gov.pl/NumDaneWys/DanePomiaroweLAZ/${o.batch}/${o.batch}_1_${o.sheet}.laz`}</gugik:url_do_pobrania>
      </gugik:SkorowidzDanychPomiarowychLIDAR${o.date.slice(0, 4)}>
    </wfs:member>`;
  const collection = (members: string[]) =>
    `<?xml version='1.0' encoding="UTF-8" ?>\n<wfs:FeatureCollection xmlns:gugik="http://www.gugik.gov.pl" numberMatched="${members.length || 'unknown'}" numberReturned="${members.length}">${members.join('')}\n</wfs:FeatureCollection>`;

  // Two sheets by Wrocław's Rynek, flown in March and again in August 2025.
  const north = '51.111478 17.028894 51.115972 17.028799 51.116067 17.040224 51.111573 17.040317 51.111478 17.028894';
  const south = '51.106984 17.028988 51.111478 17.028894 51.111573 17.040317 51.107078 17.040410 51.106984 17.028988';
  const wroclaw2025 = collection([
    member({ sheet: '6.148.12.03.2', date: '2025-03-20', batch: '84048', xy: 'PL-2000:S6', density: 20, latLon: north }),
    member({ sheet: '6.148.12.03.4', date: '2025-03-20', batch: '84048', xy: 'PL-2000:S6', density: 20, latLon: south }),
    member({ sheet: '6.148.12.03.2', date: '2025-08-12', batch: '84169', xy: 'PL-2000:S6', density: 20, latLon: north }),
    member({ sheet: '6.148.12.03.4', date: '2025-08-12', batch: '84169', xy: 'PL-2000:S6', density: 20, latLon: south }),
  ]);
  const wroclaw2024 = collection([
    member({ sheet: 'M-33-35-C-a-3-1-4-2', date: '2024-04-27', batch: '79805', xy: 'PL-1992', density: 12, order: 'GK-FOTO.6201.3.2024', latLon: south }),
  ]);
  const route = (url: string) => {
    if (url.includes('REQUEST=GetCapabilities')) return capabilities;
    if (url.includes('LIDAR2025')) return wroclaw2025;
    if (url.includes('LIDAR2024')) return wroclaw2024;
    if (url.includes('LIDAR2026')) return collection([]);
    return undefined;
  };

  it('asks for the years from 2024 the WFS lists, and makes a sheet flown twice two surveys, newest first', async () => {
    const { fetcher, requested } = fakeFetcher(route);
    const surveys = await poland.discover(fetcher, around(17.032, 51.11), []);
    expect(requested.filter((u) => u.includes('GetFeature')).map((u) => /LIDAR(\d{4})/.exec(u)![1])).toEqual(['2024', '2025', '2026']);
    expect(requested[1]).toContain('BBOX=51.108,17.03,51.112,17.034,urn:ogc:def:crs:EPSG::4326');
    expect(surveys.map((s) => s.name)).toEqual(['GUGiK 2025 (2025-08-12)', 'GUGiK 2025 (2025-03-20)', 'GUGiK 2024 (2024-04-27)']);
    const [august, march, older] = surveys;
    expect(august.tiles!.map((t) => t.url.split('/').at(-1))).toEqual(['84169_1_6.148.12.03.2.laz', '84169_1_6.148.12.03.4.laz']);
    expect(march.tiles!.map((t) => t.url.split('/').at(-1))).toEqual(['84048_1_6.148.12.03.2.laz', '84048_1_6.148.12.03.4.laz']);
    expect(august.url).not.toBe(march.url);
    expect(august).toMatchObject({ format: 'LAZ', acquisitionStart: '2025-08-12', acquisitionEnd: '2025-08-12', densityM2: 20, projectYearHint: 2025, verticalUnits: 'm' });
    expect(august.tiles![0]).toMatchObject({ horizontalCrs: 'EPSG:2177', whole: true });
    expect(august.tiles![0].size).toBeUndefined();
    // Lat, lon pairs come out as lon/lat.
    expect(august.tiles![0].bbox).toEqual([17.028799, 51.111478, 17.040317, 51.116067]);
    expect(august.coverage[0][0]).toHaveLength(4);
    expect(older.tiles![0].horizontalCrs).toBe('EPSG:2180');
  });

  it('keeps two partial copies of a sheet in one survey, but not a full one', () => {
    const sheets = gugikSheets(
      collection([
        member({ sheet: 'N-33-90-C-a-3-4-2-2', date: '2024-08-28', batch: '84003', xy: 'PL-1992', density: 5, filled: false, latLon: north, order: 'DFT.7201.024.2024' }),
        member({ sheet: 'N-33-90-C-a-3-4-2-2', date: '2024-08-30', batch: '84004', xy: 'PL-1992', density: 5, filled: false, latLon: north, order: 'DFT.7201.024.2024' }),
        member({ sheet: 'N-33-90-C-a-4-3-1-3', date: '2024-08-28', batch: '84003', xy: 'PL-1992', density: 5, latLon: south, order: 'DFT.7201.024.2024' }),
        member({ sheet: 'N-33-90-C-a-4-3-1-3', date: '2024-08-30', batch: '84004', xy: 'PL-1992', density: 5, filled: false, latLon: south, order: 'DFT.7201.024.2024' }),
        member({ sheet: 'N-33-90-C-a-4-3-1-3', date: '2024-09-03', batch: '80222', xy: 'PL-1992', density: 12, latLon: south, order: 'GK-FOTO.6201.26.2024' }),
      ]),
    );
    expect(sheets[0].filled).toBe(false);
    const surveys = gugikSurveys(sheets);
    // Orders are separate surveys, and the partial copy of a full sheet goes in a second one.
    expect(surveys.map((s) => [s.id, s.tiles!.length])).toEqual([
      ['2024-DFT.7201.024.2024', 3],
      ['2024-DFT.7201.024.2024-2', 1],
      ['2024-GK-FOTO.6201.26.2024', 1],
    ]);
    expect(surveys[0].name).toBe('GUGiK 2024 (2024-08-28 to 2024-08-30)');
    expect(surveys[1].tiles![0].url).toContain('84003_1_N-33-90-C-a-4-3-1-3');
  });

  it('leaves out files off the proxied server and fails on an exception report', () => {
    const elsewhere = collection([member({ sheet: 'x', date: '2025-01-01', batch: '1', xy: 'PL-1992', density: 12, latLon: north, url: 'https://example.com/x.laz' })]);
    expect(gugikSheets(elsewhere)).toEqual([]);
    expect(() => gugikSheets('<ows:ExceptionReport><ows:ExceptionText>TYPENAME doesn\'t exist</ows:ExceptionText></ows:ExceptionReport>')).toThrow(/other than features/);
  });

  it('asks nothing without a proxy, since the files have no CORS', async () => {
    setCorsProxy(null);
    const { fetcher, requested } = fakeFetcher(route);
    expect(await poland.discover(fetcher, around(17.032, 51.11), [])).toEqual([]);
    expect(requested).toEqual([]);
  });
});

describe('Maa- ja Ruumiamet', () => {
  const link = (sheet: number, name: string, size: string) => {
    const product = name.split('_')[2].replace('.laz', '');
    return `<li><a href="index.php?lang_id=1&amp;plugin_act=otsing&amp;kaardiruut=${sheet}&amp;andmetyyp=lidar_laz_${product}&amp;dl=1&amp;f=${name}&amp;no_cache=6abee17566f7d&amp;page_id=614">${name}</a> <span class="fas fa-fw fa-file-archive fa-gradient-gy" aria-hidden="true"></span> ( ${size} )</li>`;
  };
  const listing = (items: string[]) => `<h3 class="w-100">Aerolaserskaneerimise kõrguspunktid, LAZ formaadis</h3><ul class="list-unstyled">${items.join('')}</ul>`;
  const outOfRange = '<div class="alert alert-danger alert-dismissible fade show" role="alert"> Viga: kaardilehe numbrid mõõtkavas 1:2000 jäävad vahemikku 377650 kuni 634632</div>';

  it('numbers sheets from their lower left corner in L-EST97', () => {
    // Tartu's town hall square and Tallinn's old town.
    expect(sheetNumber(659198, 6474289)).toBe(474659);
    expect(sheetNumber(542275, 6589030)).toBe(589542);
  });

  it('reads only file names of the sheet asked for', () => {
    const html = listing([link(474659, '474659_2024_madal.laz', '293.9 MB'), link(474659, '474659_2023_tava.laz', '35.7 MB'), link(474660, '474660_2024_madal.laz', '290 MB')]);
    expect(estoniaFiles(html, 474659)).toEqual([
      { name: '474659_2024_madal.laz', year: 2024, product: 'madal' },
      { name: '474659_2023_tava.laz', year: 2023, product: 'tava' },
    ]);
    expect(estoniaFiles(outOfRange, 474659)).toEqual([]);
  });

  it('makes each year and product from 2024 a survey of the sheets that have it', async () => {
    const listings: Record<number, string> = {
      474659: listing([link(474659, '474659_2025_tava.laz', '60 MB'), link(474659, '474659_2024_madal.laz', '293.9 MB'), link(474659, '474659_2023_madal.laz', '296.4 MB')]),
      474660: listing([link(474660, '474660_2024_madal.laz', '301 MB'), link(474660, '474660_2023_madal.laz', '296.4 MB')]),
    };
    const { fetcher, requested } = fakeFetcher((url) => {
      const sheet = Number(/kaardiruut=(\d+)/.exec(url)?.[1]);
      return listings[sheet] ?? listing([]);
    });
    // Across the line between the two sheets, at easting 660 km.
    const surveys = await estonia.discover(fetcher, { west: 26.7345, south: 58.381, east: 26.7375, north: 58.3822 }, []);
    expect(requested.map((u) => /kaardiruut=(\d+)/.exec(u)![1]).sort()).toEqual(['474659', '474660']);
    expect(requested[0]).toMatch(/^https:\/\/geoportaal\.maaruum\.ee\/index\.php\?lang_id=1&plugin_act=otsing&page_id=614&kaardiruut=\d+&andmetyyp=lidar_laz_madal$/);
    expect(surveys.map((s) => [s.name, s.tiles!.length])).toEqual([
      ['Estonia 2025 (tava)', 1],
      ['Estonia 2024 (madal)', 2],
    ]);
    const madal = surveys[1];
    expect(madal.tiles![0]).toEqual({
      url: 'https://geoportaal.maaruum.ee/index.php?lang_id=1&plugin_act=otsing&kaardiruut=474659&andmetyyp=lidar_laz_madal&dl=1&f=474659_2024_madal.laz&page_id=614',
      bbox: expect.any(Array),
      horizontalCrs: 'EPSG:3301',
    });
    expect(surveys[0].tiles![0].url).toContain('andmetyyp=lidar_laz_tava&dl=1&f=474659_2025_tava.laz');
    // Flai's copies are read with ASPRS meanings, and so are these.
    expect(madal.classification).toBeUndefined();
    expect(madal).toMatchObject({ format: 'LAZ', acquisitionStart: '2024-01-01', acquisitionEnd: '2024-12-31', projectYearHint: 2024 });
    const [w, s, e, n] = madal.tiles![0].bbox;
    expect(w).toBeLessThan(26.7345);
    expect(e).toBeGreaterThan(26.7345);
    expect(s).toBeLessThan(58.381);
    expect(n).toBeGreaterThan(58.3822);
  });
});

describe('City of Winnipeg', () => {
  const tile = (id: string, year: string, ring: number[][]) => ({
    id,
    year,
    season: 'Fall',
    file_type: 'Tile',
    file_size: '325 MB',
    minimum_density: year === '2020' ? '10 PPSM' : '5',
    url: { url: `https://wpgopendata.blob.core.windows.net/open-data-lidar/${id}.las` },
    boundary: { type: 'Polygon', coordinates: [ring] },
  });
  const rows = [
    tile('2011-000245', '2011', [[-97.136238713738, 49.890305600948], [-97.150153185626, 49.89052848913], [-97.149809390469, 49.899518012754], [-97.135892336205, 49.89929505405], [-97.136238713738, 49.890305600948]]),
    tile('2021-633000_5528000', '2020', [[-97.14837869801855, 49.88960065573219], [-97.14803458447933, 49.89859017179352], [-97.13411781112384, 49.898367003114764], [-97.13446450689466, 49.88937755764145], [-97.14837869801855, 49.88960065573219]]),
  ];

  it('reads the 2020 tiles from the index, with the CRS the files lack', async () => {
    const { fetcher, requested } = fakeFetcher((url) => (url.startsWith('https://data.winnipeg.ca/resource/g634-qskh.json?') ? rows : undefined));
    const [survey, ...rest] = await winnipeg.discover(fetcher, { west: -97.142, south: 49.893, east: -97.138, north: 49.897 }, []);
    expect(rest).toEqual([]);
    expect(decodeURIComponent(requested[0])).toContain("$where=file_type='Tile' AND intersects(boundary,'POLYGON((-97.142 49.893,-97.138 49.893,-97.138 49.897,-97.142 49.897,-97.142 49.893))')");
    expect(survey).toMatchObject({ name: 'City of Winnipeg 2020', format: 'LAZ', acquisitionStart: '2020-09-01', acquisitionEnd: '2020-11-30', densityM2: 10, verticalUnits: 'm', projectYearHint: 2020 });
    expect(survey.tiles).toEqual([
      { url: 'https://wpgopendata.blob.core.windows.net/open-data-lidar/2021-633000_5528000.las', bbox: [-97.14837869801855, 49.88937755764145, -97.13411781112384, 49.89859017179352], horizontalCrs: 'EPSG:26914' },
    ]);
  });

  it('lands the 2020 outlines on their UTM 14N names', () => {
    const [x, y] = proj4('EPSG:4326', '+proj=utm +zone=14 +datum=NAD83 +units=m +no_defs', [-97.14837869801855, 49.88960065573219]);
    expect(Math.round(x)).toBe(633000);
    expect(Math.round(y)).toBe(5528000);
  });

  it('fails on an error object instead of rows', async () => {
    const { fetcher } = fakeFetcher(() => ({ error: true, message: 'query.soql.no-such-column' }));
    await expect(winnipeg.discover(fetcher, around(-97.14, 49.895), [])).rejects.toThrow(/rows/);
  });
});

describe('Intendencia de Montevideo', () => {
  const sheet = (name: string, share: string, w: number) => ({
    type: 'Feature',
    id: `fa_sig_lidar2024_v4.${name}`,
    geometry: { type: 'MultiPolygon', coordinates: [[[[w, -34.905], [w + 0.01, -34.905], [w + 0.01, -34.9125], [w, -34.9125], [w, -34.905]]]] },
    properties: { HOJA: name, enlace_lid: `https://imnube.montevideo.gub.uy/share/s/${share}/content/LIDAR_MVD_2024_${name}.laz` },
  });
  const answer = (features: object[], total = features.length) => ({ type: 'FeatureCollection', features, totalFeatures: total, numberMatched: total, numberReturned: features.length });

  it('takes the share links from the WFS, only those the proxy passes', async () => {
    const odd = { ...sheet('K-29-D-6-O-4', 'abc', -56.2), properties: { HOJA: 'K-29-D-6-O-4', enlace_lid: 'https://imnube.montevideo.gub.uy/share/s/abc/content/readme.pdf' } };
    const { fetcher, requested } = fakeFetcher(() => answer([sheet('K-29-D-6-O-5', '6Q_g8cksRMCTdg8l3IyNSA', -56.21), sheet('K-29-D-6-O-6', '_hayLXfvSBSxTdLNglrjCg', -56.2), odd]));
    const [survey] = await montevideo.discover(fetcher, { west: -56.202, south: -34.909, east: -56.198, north: -34.905 }, []);
    expect(requested[0]).toContain('version=1.0.0');
    expect(requested[0]).toContain('bbox=-56.202,-34.909,-56.198,-34.905,EPSG:4326');
    expect(survey.tiles!.map((t) => t.url.split('/').at(-1))).toEqual(['LIDAR_MVD_2024_K-29-D-6-O-5.laz', 'LIDAR_MVD_2024_K-29-D-6-O-6.laz']);
    expect(survey.tiles![0]).toMatchObject({ bbox: [-56.21, -34.9125, -56.2, -34.905], horizontalCrs: 'EPSG:5382' });
    // The default classes leave out the undocumented 24 and 120.
    expect(survey.classification).toBeUndefined();
    expect(survey).toMatchObject({ format: 'LAZ', projectYearHint: 2024, verticalUnits: 'm' });
  });

  it('fails rather than return part of the sheets', async () => {
    const { fetcher } = fakeFetcher(() => answer([sheet('K-29-D-6-O-5', '6Q_g8cksRMCTdg8l3IyNSA', -56.21)], 2));
    await expect(montevideo.discover(fetcher, around(-56.2, -34.907), [])).rejects.toThrow(/too many/);
  });
});
