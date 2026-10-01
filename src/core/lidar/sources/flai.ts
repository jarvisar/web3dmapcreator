// Open LiDAR Data by Flai: COPC mirrors of national surveys on one S3
// bucket. Datasets come from its Markdown inventory, which has their grids,
// dates and densities, and from the bucket itself, which holds some the
// inventory doesn't list (Spain's second coverage in UTM 30, Riga 2022, the
// 2022-2025 PNOA). Most have a shapefile tile index. The PNOA third coverage
// only has tile names on a 1 km grid.

import type { GeoBounds, Polygon } from '../../types';
import { crsFromEpsg, crsFromWkt, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { projectYear } from '../selection';
import { dateOnly, gridSquares, keyPath, overlaps, ringBox, s3Listing, squarePolygon, type Box, type Candidate, type Failure, type Provider, type Tile } from './common';
import { RemoteDbf, shpBounds, shpPolygons } from './shapefile';

export const FLAI_INVENTORY = 'https://raw.githubusercontent.com/flai-ai/open-lidar-data/main/README.md';
const FLAI_BUCKET = 'https://open-lidar-data.s3.eu-central-1.amazonaws.com/';

// EPSG areas of use for the grids in Flai's inventory, from pyproj. A dataset
// whose area is nowhere near the selection is not listed. Unknown codes are
// checked through their index instead.
const AREAS: Record<number, Box> = {
  2056: [5.96, 45.82, 10.49, 47.81], 2154: [-9.86, 41.15, 10.38, 51.56], 2169: [5.73, 49.44, 6.53, 50.19], 2177: [16.5, 49.39, 19.5, 55.93],
  2180: [14.14, 49.0, 24.15, 55.93], 25829: [-12.0, 34.91, -6.0, 74.13], 25830: [-6.0, 35.26, 0.01, 80.49], 25831: [0.0, 37.0, 6.01, 82.45],
  25832: [6.0, 36.53, 12.01, 84.01], 25833: [12.0, 34.79, 18.01, 84.01], 27700: [-9.01, 49.75, 2.01, 61.01], 28992: [3.2, 50.75, 7.22, 53.7],
  29902: [-10.56, 51.39, -5.93, 55.43], 3059: [19.06, 55.67, 28.24, 58.09], 3067: [19.08, 58.84, 31.59, 70.09], 31370: [2.5, 49.5, 6.4, 51.51],
  32617: [-84.0, 0.0, -78.0, 84.0], 32618: [-78.0, 0.0, -72.0, 84.0], 3301: [20.37, 57.52, 28.2, 60.0], 3794: [13.38, 45.42, 16.61, 46.88],
  3812: [2.5, 49.5, 6.4, 51.51], 4083: [-18.0, 25.25, -11.75, 32.76],
};
// National grids stretch a UTM zone well past its area of use: Denmark keeps
// zone 32 (6-12 E) out to Copenhagen and Bornholm (15 E).
const AREA_MARGIN = 6;

// Generous boxes around the countries in the bucket (data/<country>/...), so
// a listing of a far country's folders isn't made. Countries not here are listed.
const COUNTRIES: Record<string, Box> = {
  BE: [2.3, 49.3, 6.6, 51.7], CH: [5.8, 45.7, 10.6, 47.9], DE: [5.7, 47.2, 15.2, 55.2], DK: [7.9, 54.4, 15.3, 57.9], EE: [21.6, 57.4, 28.3, 59.8],
  ES: [-18.5, 27.4, 4.5, 44.0], FI: [19.0, 59.6, 31.7, 70.2], FR: [-5.3, 41.2, 9.7, 51.2], IE: [-10.7, 51.3, -5.9, 55.5], LU: [5.7, 49.4, 6.6, 50.2],
  LV: [20.9, 55.6, 28.3, 58.1], NL: [3.2, 50.7, 7.3, 53.6], PL: [14.0, 48.9, 24.2, 55.0], SE: [10.9, 55.2, 24.2, 69.1], SI: [13.3, 45.4, 16.7, 46.9],
  UK: [-8.7, 49.8, 2.0, 60.9], US: [-125, 24.4, -66.9, 49.5],
};

// Mirrors of surveys a provider here reads from the publisher: IGN's own
// service has the same tiles, and its France-wide index cost tens of MB for
// any area near France.
const SKIP = new Set(['data/FR/IGN/Lidar_2021']);

interface FlaiDataset {
  name: string;
  epsg: number;
  path: string;
  start: string;
  end: string;
  density: number;
  license: string;
}

export function flaiInventory(text: string): FlaiDataset[] {
  const out: FlaiDataset[] = [];
  const row = /\|\s*([^|]+)\|\s*(\d+)\s*\|\s*(data\/[^|]+\/copc)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/g;
  for (const match of text.matchAll(row)) {
    const [name, epsg, path, start, end, density, license] = match.slice(1).map((v) => v.trim().replace(/\\/g, ''));
    out.push({ name: `${name} / ${path.split('/').slice(-2, -1)[0]}`, epsg: Number(epsg), path, start, end, density: Number(density), license });
  }
  return out;
}

/** A dataset the inventory doesn't list, from its folder: data/ES/CNIG/Lidar_2015-2021_epsg25830. */
export function unlistedDataset(folder: string): FlaiDataset {
  const [, country, agency, name] = folder.split('/');
  const years = [...name.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((m) => m[1]);
  return {
    name: `${country} ${agency.replace(/_/g, ' ')} / ${name}`,
    epsg: Number(/_epsg(\d+)$/i.exec(name)?.[1]) || 0,
    path: `${folder}/copc`,
    start: years.length ? `${years[0]}-01-01` : '',
    end: years.length ? `${years.at(-1)}-12-31` : '',
    density: 0,
    license: 'see the dataset folder',
  };
}

/** Folders one level under `prefix` (each ending in /). */
async function folders(fetcher: Fetcher, prefix: string): Promise<string[]> {
  const xml = await fetcher.text(`${FLAI_BUCKET}?list-type=2&delimiter=/&prefix=${encodeURIComponent(prefix)}`);
  if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) throw new Error(`The listing of ${prefix} is incomplete`);
  return [...xml.matchAll(/<CommonPrefixes><Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}

/** Dataset folders in the bucket for countries near the area. */
async function bucketDatasets(fetcher: Fetcher, bbox: GeoBounds): Promise<string[]> {
  const countries = (await folders(fetcher, 'data/')).filter((c) => {
    const box = COUNTRIES[c.split('/')[1]];
    return !box || overlaps(box, bbox);
  });
  const agencies = (await Promise.all(countries.map((c) => folders(fetcher, c)))).flat();
  const datasets = (await Promise.all(agencies.map((a) => folders(fetcher, a)))).flat();
  return datasets.map((d) => d.replace(/\/$/, ''));
}

// Navarra's 2017 flight, inside Spain's second coverage, keeps its own codes:
// 17 is stray points (most of the cloud), 8 cars, 9 water bottom, 10, 11, 18
// and 28 overlap and noise.
const NAVARRA_2017: Record<string, string> = { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '9': 'noise', '17': 'noise' };
const tileClasses = (name: string) => (/^PNOA_2017_NAV_/.test(name) ? NAVARRA_2017 : undefined);

async function indexedTiles(fetcher: Fetcher, dataset: FlaiDataset, bbox: GeoBounds): Promise<{ tiles: Tile[]; coverage: Polygon[] }> {
  const prefix = `${dataset.path.slice(0, dataset.path.lastIndexOf('/'))}/shp/`;
  const listing = s3Listing(await fetcher.text(`${FLAI_BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=100`));
  if (listing.truncated) throw new Error('Flai spatial index listing is incomplete');
  const tiles: Tile[] = [];
  const coverage: Polygon[] = [];
  for (const key of [...listing.keys.keys()].filter((k) => k.endsWith('.shp')).sort()) {
    const url = FLAI_BUCKET + keyPath(key);
    const prj = key.slice(0, -4) + '.prj';
    let epsg = dataset.epsg;
    let opened: RemoteDbf | null = null;
    const table = async () => (opened ??= await RemoteDbf.open(fetcher, url.slice(0, -4) + '.dbf'));
    // Without a .prj or a code in the inventory or name, the rows carry it.
    if (!listing.keys.has(prj) && !epsg && (await table()).count) epsg = Number((await (await table()).row(0)).epsg) || 0;
    if (!listing.keys.has(prj) && !epsg) throw new Error('Flai tile index has no coordinate system');
    const crs = listing.keys.has(prj) ? crsFromWkt(await fetcher.text(url.slice(0, -4) + '.prj')) : crsFromEpsg(epsg);
    const { toLonLat, fromLonLat } = lonLatTransforms(crs);
    const [x0, y0, x1, y1] = shpBounds(new Uint8Array(await fetcher.range(url, 0, 100)));
    const corners = [toLonLat(x0, y0), toLonLat(x1, y0), toLonLat(x1, y1), toLonLat(x0, y1)];
    const extent: Box = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
    if (!overlaps(extent, bbox)) continue;
    const local = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.east, bbox.north), fromLonLat(bbox.west, bbox.north)];
    const query: Box = [Math.min(...local.map((c) => c[0])), Math.min(...local.map((c) => c[1])), Math.max(...local.map((c) => c[0])), Math.max(...local.map((c) => c[1]))];
    const shapes = shpPolygons(new Uint8Array(await fetcher.bytes(url)), query);
    for (const shape of shapes) {
      const polygon: Polygon = shape.rings.map((ring) => ring.map(([x, y]) => toLonLat(x, y)));
      const box = ringBox(polygon);
      if (!overlaps(box, bbox)) continue;
      const row = await (await table()).row(shape.index);
      const name = String(row.fname ?? '');
      if (!name.toLowerCase().endsWith('.copc.laz') || name.includes('/') || name.includes('\\')) throw new Error('Flai tile index lacks a COPC file name');
      const code = Number(row.epsg);
      tiles.push({ url: FLAI_BUCKET + keyPath(`${dataset.path}/${name}`), bbox: box, horizontalCrs: `EPSG:${code > 0 ? code : epsg}`, classification: tileClasses(name) });
      coverage.push(polygon);
    }
  }
  return { tiles, coverage };
}

// The PNOA third coverage has no index: PNOA_<year>_<region>_<x>-<y>_<...>.copc.laz,
// x and y the upper left corner in km, and no CRS in the files or names. The
// zone is whichever UTM zone the tiles turn up in (Canaries: REGCAN95 UTM 28).
const PNOA_ZONES: [number, number][] = [
  [4083, -15],
  [25829, -9],
  [25830, -3],
  [25831, 3],
];

async function gridTiles(fetcher: Fetcher, dataset: FlaiDataset, bbox: GeoBounds): Promise<{ tiles: Tile[]; coverage: Polygon[] }> {
  const copc = `${dataset.path}/`;
  const listed = async (prefix: string) => [...s3Listing(await fetcher.text(`${FLAI_BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`)).keys.keys()];
  const blocks = (await Promise.all((await folders2(fetcher, `${copc}PNOA_`)).map((year) => folders2(fetcher, year)))).flat();
  const tiles: Tile[] = [];
  const coverage: Polygon[] = [];
  const lon = (bbox.west + bbox.east) / 2;
  for (const block of blocks) {
    for (const [epsg, meridian] of PNOA_ZONES) {
      // A region keeps one zone even where it runs a few degrees past it.
      if (Math.abs(lon - meridian) > 7) continue;
      const squares = gridSquares(epsg, bbox, 1000);
      const columns = [...new Set(squares.map((s) => s.x / 1000))];
      const keys = new Set((await Promise.all(columns.map((x) => listed(`${block}${x}-`)))).flat());
      const { toLonLat } = lonLatTransforms(crsFromEpsg(epsg));
      for (const { x, y } of squares) {
        const key = [...keys].find((k) => k.startsWith(`${block}${x / 1000}-${y / 1000 + 1}_`) && k.endsWith('.copc.laz'));
        if (!key) continue;
        const square = squarePolygon(toLonLat, x, y, 1000);
        tiles.push({ url: FLAI_BUCKET + keyPath(key), bbox: ringBox(square), horizontalCrs: `EPSG:${epsg}` });
        coverage.push(square);
      }
      if (tiles.length) break;
    }
  }
  return { tiles, coverage };
}

/** Prefixes one level under `prefix`, split at the next underscore (PNOA_2023_, then PNOA_2023_ARA_). */
async function folders2(fetcher: Fetcher, prefix: string): Promise<string[]> {
  const xml = await fetcher.text(`${FLAI_BUCKET}?list-type=2&delimiter=_&prefix=${encodeURIComponent(prefix)}`);
  return [...xml.matchAll(/<CommonPrefixes><Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)].map((m) => m[1]);
}

async function flaiDataset(fetcher: Fetcher, dataset: FlaiDataset, bbox: GeoBounds, indexed: boolean): Promise<Candidate | null> {
  const { tiles, coverage } = indexed ? await indexedTiles(fetcher, dataset, bbox) : await gridTiles(fetcher, dataset, bbox);
  if (!tiles.length) return null;
  return {
    provider: 'Flai',
    id: dataset.path.slice(0, dataset.path.lastIndexOf('/')),
    name: dataset.name,
    url: FLAI_BUCKET + dataset.path + '/',
    format: 'COPC',
    coverage,
    tiles: tiles.sort((a, b) => (a.url < b.url ? -1 : 1)),
    acquisitionStart: dateOnly(dataset.start),
    acquisitionEnd: dateOnly(dataset.end),
    densityM2: dataset.density > 0 ? dataset.density : undefined,
    license: dataset.license,
    attribution: `Open LiDAR Data / Flai; ${dataset.license}`,
    sourcePage: FLAI_INVENTORY,
    projectYearHint: projectYear(dataset.path),
  };
}

export const flai: Provider = {
  id: 'flai',
  name: 'Open LiDAR Data (Flai)',
  async discover(fetcher, bbox, failures) {
    const datasets = flaiInventory(await fetcher.text(FLAI_INVENTORY));
    if (!datasets.length) throw new Error('Flai inventory schema changed or lists no datasets');
    const nearby = datasets.filter((d) => {
      const area = AREAS[d.epsg];
      return !SKIP.has(d.path.slice(0, d.path.lastIndexOf('/'))) && (!area || overlaps([area[0] - AREA_MARGIN, area[1] - AREA_MARGIN / 2, area[2] + AREA_MARGIN, area[3] + AREA_MARGIN / 2], bbox));
    });
    // The bucket's own folders, for what the inventory hasn't caught up with.
    // A failed listing loses only those.
    const listed = new Set(datasets.map((d) => d.path.slice(0, d.path.lastIndexOf('/'))));
    const extra = await bucketDatasets(fetcher, bbox).catch((error: Error) => {
      failures.push({ source: 'Flai bucket listing', reason: error.message });
      return [] as string[];
    });
    const unlisted = extra.filter((folder) => !listed.has(folder) && !SKIP.has(folder)).map(unlistedDataset);
    const found = await Promise.all(
      [...nearby.map((d) => [d, true] as const), ...unlisted.map((d) => [d, false] as const)].map(async ([dataset, inInventory]) => {
        try {
          // Listed or not, a folder with a shp/ index is read through it. The PNOA third coverage goes by its grid.
          if (inInventory) return await flaiDataset(fetcher, dataset, bbox, true);
          const hasIndex = (await folders(fetcher, `${dataset.path.slice(0, dataset.path.lastIndexOf('/'))}/`)).some((f) => f.endsWith('/shp/'));
          if (hasIndex) return await flaiDataset(fetcher, dataset, bbox, true);
          return /\/ES\/CNIG\//.test(dataset.path) ? await flaiDataset(fetcher, dataset, bbox, false) : null;
        } catch (error) {
          failures.push({ source: `Flai ${dataset.name}`, reason: (error as Error).message } satisfies Failure);
          return null;
        }
      }),
    );
    return found.filter((c): c is Candidate => c !== null);
  },
};
