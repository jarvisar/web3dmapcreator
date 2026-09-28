// Finding streamed surveys over an area: USGS 3DEP's EPT mirror, Open LiDAR
// Data (Flai) COPC, and the official COPC of IGN France, NRCan and
// swisstopo. Ported from the add-on's provider adapters. Only providers whose
// catalogs and point files a browser may read (CORS) are here; staged LAZ
// tiles (TNM, EA, Scotland, NRW, Bavaria, PNOA) are not downloaded.
//
// Everything returned is in lon/lat. Spatial tests against buildings happen
// later, in the metric frame.

import type { GeoBounds, Polygon, Ring } from '../../types';
import { crsFromEpsg, crsFromWkt, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { projectYear } from '../selection';
import { RemoteDbf, shpBounds, shpPolygons } from './shapefile';

export type Format = 'EPT' | 'COPC';

export interface Tile {
  url: string;
  /** West, south, east, north. */
  bbox: [number, number, number, number];
  horizontalCrs?: string;
}

export interface Candidate {
  provider: string;
  /** Survey identity within its provider. */
  id: string;
  name: string;
  /** EPT: its ept.json. COPC: a stable survey key; points come from `tiles`. */
  url: string;
  format: Format;
  /** Where the survey has points, as lon/lat polygons. */
  coverage: Polygon[];
  tiles?: Tile[];
  verticalUnits?: string;
  /** Class code to meaning, where the provider declares its own. */
  classification?: Record<string, string>;
  acquisitionStart?: string;
  acquisitionEnd?: string;
  densityM2?: number;
  classificationQuality?: number;
  license?: string;
  attribution: string;
  sourcePage: string;
  /** The original publisher, not a mirror. Breaks quality ties. */
  authoritative?: boolean;
  projectYearHint: number | null;
}

export interface Failure {
  source: string;
  reason: string;
}

type Discover = (fetcher: Fetcher, bbox: GeoBounds, failures: Failure[]) => Promise<Candidate[]>;

// Generous boxes around each national service's territory. Outside them the
// service is not asked: some answer slowly or with errors elsewhere.
const SERVICE_AREAS: Record<string, [number, number, number, number][]> = {
  ign: [
    [-5.5, 41.2, 10.0, 51.3],
    [-63.2, 14.3, -60.7, 18.2],
    [-54.7, 2.0, -51.5, 6.0],
    [44.9, -21.5, 56.0, -12.5],
  ],
  nrcan: [[-141.1, 41.6, -52.5, 83.2]],
  swisstopo: [[5.9, 45.8, 10.6, 47.9]],
};

const overlaps = (a: [number, number, number, number], b: GeoBounds) => a[0] <= b.east && a[2] >= b.west && a[1] <= b.north && a[3] >= b.south;

function ringBox(rings: Ring[]): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      w = Math.min(w, x);
      s = Math.min(s, y);
      e = Math.max(e, x);
      n = Math.max(n, y);
    }
  }
  return [w, s, e, n];
}

/** GeoJSON Polygon/MultiPolygon to polygons with open rings. */
export function geoPolygons(geometry: { type: string; coordinates: unknown } | null | undefined): Polygon[] {
  if (!geometry) return [];
  const open = (ring: number[][]): Ring => {
    const out = ring.map((p) => [p[0], p[1]] as [number, number]);
    if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    return out;
  };
  if (geometry.type === 'Polygon') return [(geometry.coordinates as number[][][]).map(open)];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).map((p) => p.map(open));
  return [];
}

function dateOnly(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value.trim());
  return match ? match[0] : undefined;
}

// ------------------------------------------------------------------- USGS

export const USGS_CATALOG = 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson';

/** Area of lon/lat polygons on the sphere, in m². */
export function sphericalArea(polygons: Polygon[]): number {
  const R = 6378137;
  const rad = Math.PI / 180;
  let total = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, r) => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        a += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
      }
      total += (r === 0 ? 1 : -1) * Math.abs((a * R * R) / 2);
    });
  }
  return total;
}

// The catalog has no densities, and names alone put a sparse 2018 wildfire
// survey ahead of a 2023 one with ten times the returns over San Francisco.
// An EPT's ept.json has its point count, so points over the outline's area
// is its density, near enough.
async function eptDensity(fetcher: Fetcher, candidate: Candidate): Promise<number | undefined> {
  try {
    const meta = (await fetcher.json(candidate.url)) as { points?: unknown };
    const area = sphericalArea(candidate.coverage);
    return typeof meta.points === 'number' && meta.points > 0 && area > 0 ? meta.points / area : undefined;
  } catch {
    return undefined;
  }
}

const discoverUsgs: Discover = async (fetcher, bbox) => {
  const catalog = (await fetcher.json(USGS_CATALOG)) as { features: { properties: { name: string; url: string }; geometry: { type: string; coordinates: unknown } }[] };
  const out: Candidate[] = [];
  for (const feature of catalog.features) {
    const coverage = geoPolygons(feature.geometry);
    if (!coverage.length || !overlaps(ringBox(coverage.flat()), bbox)) continue;
    const { name, url } = feature.properties;
    if (!/^https:\/\//.test(url)) continue;
    out.push({
      provider: 'USGS',
      id: name,
      name,
      url,
      format: 'EPT',
      coverage,
      attribution: 'USGS 3DEP; EPT mirror by Hobu',
      license: 'Public domain',
      sourcePage: USGS_CATALOG,
      projectYearHint: projectYear(name),
    });
  }
  await Promise.all(out.map(async (candidate) => (candidate.densityM2 = await eptDensity(fetcher, candidate))));
  return out;
};

// ----------------------------------------------------- paged spatial services

const PAGE = 500;
const MAX_FEATURES = 10000;

async function pagedFeatures(fetcher: Fetcher, page: (offset: number) => string): Promise<{ properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[]> {
  const out: { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] = [];
  for (let offset = 0; offset < MAX_FEATURES; ) {
    const document = (await fetcher.json(page(offset))) as Record<string, unknown>;
    if (document.error && typeof document.error === 'object') throw new Error(`Catalog error: ${String((document.error as { message?: string }).message ?? 'unknown')}`);
    const rows = document.features;
    if (document.type !== 'FeatureCollection' || !Array.isArray(rows)) throw new Error('Catalog returned no FeatureCollection');
    out.push(...(rows as typeof out));
    offset += rows.length;
    const total = Number(document.numberMatched ?? document.totalFeatures ?? NaN);
    const more = Boolean(document.exceededTransferLimit || (document.properties as Record<string, unknown> | undefined)?.exceededTransferLimit);
    if (!rows.length || (Number.isFinite(total) && offset >= total) || (!Number.isFinite(total) && rows.length < PAGE && !more)) return out;
  }
  throw new Error('Catalog feature budget reached; discovery is partial');
}

// --------------------------------------------------------------------- IGN

const IGN_WFS = 'https://data.geopf.fr/wfs';

const discoverIgn: Discover = async (fetcher, bbox) => {
  const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
  const rows = await pagedFeatures(
    fetcher,
    (offset) =>
      `${IGN_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=IGNF_LIDAR-HD_METADONNEE:metadata&outputFormat=application/json&srsName=CRS:84&bbox=${box},CRS:84&count=${PAGE}&startIndex=${offset}`,
  );
  const surveys = new Map<string, Candidate>();
  for (const row of rows) {
    const p = row.properties;
    let url = typeof p.url_npl === 'string' ? p.url_npl : '';
    if (!url.includes('.copc.')) continue;
    // IGN publishes a range-enabled endpoint for the same file.
    url = url.replace('https://data.geopf.fr/telechargement/download/', 'https://data.geopf.fr/chunk/telechargement/download/');
    const coverage = geoPolygons(row.geometry);
    if (!coverage.length) continue;
    const project = String(p.code_mission ?? url.split('/').slice(-2, -1)[0]);
    let survey = surveys.get(project);
    if (!survey) {
      survey = {
        provider: 'IGN France',
        id: project,
        name: `IGN LiDAR HD ${project}`,
        url: `https://geoservices.ign.fr/lidarhd#survey=${project}`,
        format: 'COPC',
        coverage: [],
        tiles: [],
        verticalUnits: 'm',
        // IGN's class 67 is an unconfirmed building: it is read as unclassified.
        classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '67': 'unclassified' },
        acquisitionStart: dateOnly(p.date_debut_acquisition),
        acquisitionEnd: dateOnly(p.date_fin_acquisition),
        classificationQuality: String(p.procede_classement ?? '').includes('MANUEL') ? 1 : 0.5,
        license: 'Licence Ouverte 2.0',
        attribution: 'IGN - LiDAR HD',
        sourcePage: 'https://geoservices.ign.fr/lidarhd',
        authoritative: true,
        projectYearHint: projectYear(project),
      };
      surveys.set(project, survey);
    }
    survey.coverage.push(...coverage);
    survey.tiles!.push({ url, bbox: ringBox(coverage.flat()), horizontalCrs: p.systeme_planimetrique === 'LAMB93' ? 'EPSG:2154' : undefined });
  }
  return [...surveys.values()];
};

// ------------------------------------------------------------------- NRCan

const NRCAN = 'https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/lidar_point_cloud_canelevation_en/MapServer/1/query';

/** The collection end in NRCan's documented file names; never a start date. */
function collectionEnd(url: string): string | undefined {
  const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
  const match = /^[A-Z]{2}_.+_(\d{4})(\d{2})(\d{2})_NAD83CSRS_UTMZ?\d{1,2}_\d+(?:km|m)_E\d+_N\d+_.+\.copc\.laz$/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

const discoverNrcan: Discover = async (fetcher, bbox) => {
  const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
  const rows = await pagedFeatures(
    fetcher,
    (offset) =>
      `${NRCAN}?f=geojson&where=1%3D1&geometry=${box}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&resultOffset=${offset}&resultRecordCount=${PAGE}&orderByFields=OBJECTID`,
  );
  const surveys = new Map<string, Candidate>();
  for (const row of rows) {
    const p = row.properties;
    const url = String(p.url ?? '');
    if (!url.includes('.copc.')) continue;
    const coverage = geoPolygons(row.geometry);
    if (!coverage.length) continue;
    const key = `${p.provider}/${p.project}`;
    let survey = surveys.get(key);
    if (!survey) {
      survey = {
        provider: 'NRCan',
        id: key,
        name: `CanElevation ${p.project}`,
        url: `https://open.canada.ca/data/en/dataset/7069387e-9986-4297-9f55-0288e9676947#survey=${key}`,
        format: 'COPC',
        coverage: [],
        tiles: [],
        verticalUnits: 'm',
        acquisitionEnd: collectionEnd(url),
        license: 'Open Government Licence - Canada',
        attribution: 'NRCan and the tile source organization',
        sourcePage: 'https://open.canada.ca/data/en/dataset/7069387e-9986-4297-9f55-0288e9676947',
        authoritative: true,
        projectYearHint: projectYear(String(p.project)),
      };
      surveys.set(key, survey);
    }
    survey.coverage.push(...coverage);
    survey.tiles!.push({ url, bbox: ringBox(coverage.flat()) });
  }
  return [...surveys.values()];
};

// --------------------------------------------------------------- swisstopo

const SWISSTOPO = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d';

const discoverSwisstopo: Discover = async (fetcher, bbox) => {
  const surveys = new Map<string, Candidate>();
  let next: string | null = `${SWISSTOPO}/items?bbox=${[bbox.west, bbox.south, bbox.east, bbox.north].join(',')}&limit=100`;
  for (let pages = 0; next && pages < 64; pages++) {
    const document = (await fetcher.json(next)) as { features?: { properties?: Record<string, unknown>; geometry: { type: string; coordinates: unknown }; assets?: Record<string, { href: string }> }[]; links?: { rel: string; href: string }[] };
    for (const item of document.features ?? []) {
      // Only the COPC editions (from 2024); older ones are ZIPs of one plain LAS.
      const asset = Object.values(item.assets ?? {}).find((a) => /\.copc\.laz$/i.test(a.href));
      if (!asset) continue;
      const coverage = geoPolygons(item.geometry);
      const date = dateOnly(item.properties?.datetime) ?? dateOnly(item.properties?.start_datetime);
      const year = date?.slice(0, 4) ?? projectYear(asset.href)?.toString() ?? 'unknown';
      let survey = surveys.get(year);
      if (!survey) {
        survey = {
          provider: 'swisstopo',
          id: year,
          name: `swisstopo swissSURFACE3D ${year}`,
          url: `${SWISSTOPO}#edition=${year}`,
          format: 'COPC',
          coverage: [],
          tiles: [],
          // Headers carry only EPSG:2056; LN02 heights are metres (EPSG:5728).
          verticalUnits: 'm',
          acquisitionStart: dateOnly(item.properties?.start_datetime) ?? date,
          acquisitionEnd: dateOnly(item.properties?.end_datetime) ?? date,
          license: 'swisstopo open government data terms',
          attribution: 'swisstopo',
          sourcePage: SWISSTOPO,
          authoritative: true,
          projectYearHint: Number(year) || null,
        };
        surveys.set(year, survey);
      }
      survey.coverage.push(...coverage);
      survey.tiles!.push({ url: asset.href, bbox: ringBox(coverage.flat()), horizontalCrs: 'EPSG:2056' });
    }
    next = document.links?.find((l) => l.rel === 'next')?.href ?? null;
  }
  return [...surveys.values()];
};

// -------------------------------------------------------------------- Flai

const FLAI_INVENTORY = 'https://raw.githubusercontent.com/flai-ai/open-lidar-data/main/README.md';
const FLAI_BUCKET = 'https://open-lidar-data.s3.eu-central-1.amazonaws.com/';

// EPSG areas of use for the grids in Flai's inventory, from pyproj. A dataset
// whose area is nowhere near the selection is not listed. Unknown codes are
// checked through their index instead.
const AREAS: Record<number, [number, number, number, number]> = {
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

/** Keys and ETags from an S3 ListObjectsV2 answer; no DOMParser in a worker. */
function s3Listing(xml: string): { keys: Map<string, string>; truncated: boolean } {
  const keys = new Map<string, string>();
  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([^<]*)<\/Key>/.exec(block[1])?.[1];
    const etag = /<ETag>([^<]*)<\/ETag>/.exec(block[1])?.[1] ?? '';
    if (key) keys.set(key.replace(/&amp;/g, '&'), etag);
  }
  return { keys, truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml) };
}

async function flaiDataset(fetcher: Fetcher, dataset: FlaiDataset, bbox: GeoBounds): Promise<Candidate | null> {
  const prefix = `${dataset.path.slice(0, dataset.path.lastIndexOf('/'))}/shp/`;
  const listing = s3Listing(await fetcher.text(`${FLAI_BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=100`));
  if (listing.truncated) throw new Error('Flai spatial index listing is incomplete');
  const tiles: Tile[] = [];
  const coverage: Polygon[] = [];
  for (const key of [...listing.keys.keys()].filter((k) => k.endsWith('.shp')).sort()) {
    const url = FLAI_BUCKET + key.split('/').map(encodeURIComponent).join('/');
    const prj = key.slice(0, -4) + '.prj';
    const crs = listing.keys.has(prj) ? crsFromWkt(await fetcher.text(url.slice(0, -4) + '.prj')) : crsFromEpsg(dataset.epsg);
    const { toLonLat, fromLonLat } = lonLatTransforms(crs);
    const [x0, y0, x1, y1] = shpBounds(new Uint8Array(await fetcher.range(url, 0, 100)));
    const corners = [toLonLat(x0, y0), toLonLat(x1, y0), toLonLat(x1, y1), toLonLat(x0, y1)];
    const extent: [number, number, number, number] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
    if (!overlaps(extent, bbox)) continue;
    const local = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.east, bbox.north), fromLonLat(bbox.west, bbox.north)];
    const query: [number, number, number, number] = [Math.min(...local.map((c) => c[0])), Math.min(...local.map((c) => c[1])), Math.max(...local.map((c) => c[0])), Math.max(...local.map((c) => c[1]))];
    const shapes = shpPolygons(new Uint8Array(await fetcher.bytes(url)), query);
    if (!shapes.length) continue;
    const dbf = await RemoteDbf.open(fetcher, url.slice(0, -4) + '.dbf');
    for (const shape of shapes) {
      const polygon: Polygon = shape.rings.map((ring) => ring.map(([x, y]) => toLonLat(x, y)));
      const box = ringBox(polygon);
      if (!overlaps(box, bbox)) continue;
      const row = await dbf.row(shape.index);
      const name = String(row.fname ?? '');
      if (!name.toLowerCase().endsWith('.copc.laz') || name.includes('/') || name.includes('\\')) throw new Error('Flai tile index lacks a COPC file name');
      const epsg = Number(row.epsg);
      tiles.push({ url: FLAI_BUCKET + `${dataset.path}/${name}`.split('/').map(encodeURIComponent).join('/'), bbox: box, horizontalCrs: `EPSG:${epsg > 0 ? epsg : dataset.epsg}` });
      coverage.push(polygon);
    }
  }
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

const discoverFlai: Discover = async (fetcher, bbox, failures) => {
  const datasets = flaiInventory(await fetcher.text(FLAI_INVENTORY));
  if (!datasets.length) throw new Error('Flai inventory schema changed or lists no datasets');
  const nearby = datasets.filter((d) => {
    const area = AREAS[d.epsg];
    return !area || overlaps([area[0] - AREA_MARGIN, area[1] - AREA_MARGIN / 2, area[2] + AREA_MARGIN, area[3] + AREA_MARGIN / 2], bbox);
  });
  const found = await Promise.all(
    nearby.map((dataset) =>
      flaiDataset(fetcher, dataset, bbox).catch((error: Error) => {
        failures.push({ source: `Flai ${dataset.name}`, reason: error.message });
        return null;
      }),
    ),
  );
  return found.filter((c): c is Candidate => c !== null);
};

// ------------------------------------------------------------------- all

export const PROVIDERS: Record<string, Discover> = {
  usgs: discoverUsgs,
  flai: discoverFlai,
  ign: discoverIgn,
  nrcan: discoverNrcan,
  swisstopo: discoverSwisstopo,
};

/** Every provider's candidates. One provider failing never stops the others. */
export async function discover(fetcher: Fetcher, bbox: GeoBounds, progress?: (message: string) => void): Promise<{ candidates: Candidate[]; failures: Failure[] }> {
  const failures: Failure[] = [];
  const names = Object.keys(PROVIDERS).filter((name) => !SERVICE_AREAS[name] || SERVICE_AREAS[name].some((area) => overlaps(area, bbox)));
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        const found = await PROVIDERS[name](fetcher, bbox, failures);
        progress?.(`${name}: ${found.length} surveys`);
        return found;
      } catch (error) {
        failures.push({ source: name, reason: (error as Error).message });
        return [];
      }
    }),
  );
  // Registry order, so ranking sees the same input however the requests finish.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const list of results) {
    for (const candidate of list) {
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      candidates.push(candidate);
    }
  }
  return { candidates, failures };
}
