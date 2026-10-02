// Gobierno de Navarra's LiDAR, on a file server with no CORS headers. Two
// surveys are read:
//
// - Comarca de Pamplona 2020, flown 3-4 September: 374 tiles of 1 km around
//   Pamplona, 56 returns per m² in the centre and 200-650 MB a tile. Names
//   mix las_ca_ and las_cam_, so they come from the folder's listing (68 KB,
//   with sizes). The classes follow the 2017 table in _leeme.txt: 8 is cars,
//   9 the river bed, 11 noise, 17 vanished points, 32 bridges. 20, 21 and 36
//   aren't in it and are dropped: 36 is synthetic (no GPS time, last returns
//   only), 20 sits 2-10 m up away from roofs and 21 is low clutter, about
//   0.3% of the points together.
// - The 2024 flight of the whole region (16 July to 15 September), 9 returns
//   per m², about 75 MB a tile with a 25 m buffer. Names are computed from
//   the grid and a missing tile is a plain 404, so a HEAD says whether it's
//   there and its size. Roads (11) and rail (10) are filed apart from the
//   ground and count as ground, or streets come out as holes. 150 and 151 are
//   ground from 2017 and a 2014 mesh, and go with the other non-ASPRS codes.
//
// Heights are on the ellipsoid. Flai's PNOA beside them is orthometric,
// about 50 m lower, so each tile goes down by the geoid at its middle. Across
// Navarra the geoid runs from 49.5 m in the north to 52.4 m in the Pyrenees,
// so one value for the 2024 flight would be up to 2.4 m off. EGM2008 alone
// left the ground 0.8 m under PNOA's in Pamplona, hence Spain's own model.

import type { GeoBounds, Polygon } from '../../types';
import { HttpError } from '../../data/http';
import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { gridSquares, overlaps, ringBox, squarePolygon, type Candidate, type Provider, type Tile } from './common';

const BASE = 'https://filescartografia.navarra.es/5_LIDAR/';
const PAMPLONA = `${BASE}5_5_2020_C_Pamplona_EPSG25830/`;
const REGION = `${BASE}5_6_2024_NAV_cam_EPSG25830/`;
// Where the 2020 tiles are (UTM 30 metres), so the listing is only read near Pamplona.
const PAMPLONA_EXTENT: [number, number, number, number] = [600000, 4727000, 622000, 4751000];
const WEEK_MS = 7 * 24 * 3600 * 1000;
const KM = 1000;
// IIS folder listings start with this. A maintenance page sent with a 200
// usually starts with a doctype, and then isn't kept as the listing.
const LISTING = [...'<html>'].map((c) => c.charCodeAt(0));

// EGM08-REDNAP, Spain's geoid model and the one PNOA's heights use, every
// 0.125° from 41.8° N and 2.6° W (sampled from PROJ's es_ign_egm08-rednap.tif,
// IGN, CC BY 4.0). Between nodes it's within 15 cm of the full model.
const GEOID_LAT0 = 41.8;
const GEOID_LON0 = -2.6;
const GEOID_STEP = 0.125;
const GEOID = [
  [53.31, 53.12, 52.91, 52.77, 52.53, 52.3, 52.09, 51.5, 50.84, 50.34, 50, 49.86, 49.92, 49.98, 49.95, 50.01, 50.15],
  [53.65, 53.39, 53.16, 52.84, 52.39, 51.92, 51.38, 50.79, 50.36, 50.01, 49.87, 49.87, 50.06, 50.19, 50.13, 50.11, 50.22],
  [53.78, 53.5, 53.1, 52.71, 52.09, 51.43, 50.8, 50.35, 50.02, 49.96, 50.01, 50.02, 50.12, 50.23, 50.23, 50.21, 50.3],
  [53.22, 52.97, 52.61, 52.07, 51.44, 50.89, 50.32, 49.98, 49.84, 49.88, 50, 50.1, 50.23, 50.35, 50.42, 50.44, 50.53],
  [52.4, 52.09, 51.78, 51.29, 50.69, 50.19, 49.88, 49.75, 49.81, 49.89, 50.06, 50.3, 50.48, 50.6, 50.68, 50.75, 50.95],
  [51.6, 51.27, 50.92, 50.52, 50.16, 49.87, 49.71, 49.69, 49.81, 49.98, 50.16, 50.5, 50.71, 50.88, 50.93, 50.97, 51.12],
  [51.25, 51.03, 50.73, 50.41, 50.13, 49.88, 49.72, 49.78, 50, 50.14, 50.2, 50.43, 50.64, 50.84, 50.95, 51.17, 51.43],
  [51.07, 50.92, 50.73, 50.5, 50.24, 49.97, 49.86, 49.9, 50.09, 50.27, 50.36, 50.63, 51.01, 51.24, 51.41, 51.74, 52.15],
  [50.87, 50.74, 50.68, 50.63, 50.47, 50.3, 50.07, 49.94, 50.05, 50.29, 50.54, 50.93, 51.27, 51.6, 51.96, 52.42, 52.81],
  [50.71, 50.59, 50.5, 50.33, 50.26, 50.2, 50.09, 50.1, 50.3, 50.64, 50.92, 51.19, 51.49, 51.79, 52.13, 52.41, 52.38],
  [50.56, 50.28, 50.14, 49.94, 49.95, 50.08, 50.23, 50.37, 50.59, 50.82, 50.95, 51.11, 51.35, 51.45, 51.42, 51.51, 51.56],
  [49.99, 49.8, 49.66, 49.51, 49.44, 49.49, 49.7, 49.98, 50.2, 50.47, 50.62, 50.66, 50.9, 50.98, 50.87, 50.75, 50.61],
  [49.28, 49.04, 48.75, 48.58, 48.58, 48.77, 49.07, 49.39, 49.65, 49.94, 50.17, 50.27, 50.29, 50.23, 50.11, 49.9, 49.76],
];

/** The geoid over the ellipsoid at a point in or near Navarra, from the table. */
export function geoidHeight(lon: number, lat: number): number {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const fy = clamp((lat - GEOID_LAT0) / GEOID_STEP, GEOID.length - 1);
  const fx = clamp((lon - GEOID_LON0) / GEOID_STEP, GEOID[0].length - 1);
  const r = Math.min(Math.floor(fy), GEOID.length - 2);
  const c = Math.min(Math.floor(fx), GEOID[0].length - 2);
  const [ty, tx] = [fy - r, fx - c];
  const lower = GEOID[r][c] * (1 - tx) + GEOID[r][c + 1] * tx;
  const upper = GEOID[r + 1][c] * (1 - tx) + GEOID[r + 1][c + 1] * tx;
  return lower * (1 - ty) + upper * ty;
}

/** Metres to add to a tile's heights to bring them onto the geoid. */
function toOrthometric(square: Polygon): number {
  const [w, s, e, n] = ringBox(square);
  return -Math.round(geoidHeight((w + e) / 2, (s + n) / 2) * 100) / 100;
}

/** The 2020 tiles from the folder's listing: name to size. */
export function pamplonaListing(html: string): Map<string, { x: number; top: number; size: number }> {
  const out = new Map<string, { x: number; top: number; size: number }>();
  for (const match of html.matchAll(/(\d+) <A HREF="[^"]*\/(las_cam?_(\d{3})_(\d{4})_C_Pamplona_EPSG25830_2020\.laz)">/gi)) {
    out.set(match[2], { x: Number(match[3]) * KM, top: Number(match[4]) * KM, size: Number(match[1]) });
  }
  if (!out.size) throw new Error('The Pamplona 2020 listing has no tiles');
  return out;
}

function utmQuery(bbox: GeoBounds): [number, number, number, number] {
  const { fromLonLat } = lonLatTransforms(crsFromEpsg(25830));
  const corners = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.east, bbox.north), fromLonLat(bbox.west, bbox.north)];
  return [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
}

async function pamplona(fetcher: Fetcher, bbox: GeoBounds): Promise<Candidate[]> {
  const [x0, y0, x1, y1] = utmQuery(bbox);
  const [ex0, ey0, ex1, ey1] = PAMPLONA_EXTENT;
  if (x1 < ex0 || x0 > ex1 || y1 < ey0 || y0 > ey1) return [];
  const html = new TextDecoder().decode(await fetcher.catalog(PAMPLONA, WEEK_MS, LISTING));
  const { toLonLat } = lonLatTransforms(crsFromEpsg(25830));
  const tiles: Tile[] = [];
  const coverage: Polygon[] = [];
  for (const [name, { x, top, size }] of pamplonaListing(html)) {
    const square = squarePolygon(toLonLat, x, top - KM, KM);
    if (!overlaps(ringBox(square), bbox)) continue;
    tiles.push({ url: `${PAMPLONA}${name}`, bbox: ringBox(square), size, horizontalCrs: 'EPSG:25830', zOffset: toOrthometric(square) });
    coverage.push(square);
  }
  if (!tiles.length) return [];
  return [
    {
      provider: 'Gobierno de Navarra',
      id: 'pamplona-2020',
      name: 'Comarca de Pamplona LiDAR 2020',
      url: `${PAMPLONA}#2020`,
      format: 'LAZ',
      coverage,
      tiles,
      verticalUnits: 'm',
      // Named as noise, or LiDAR only models keep 9 and 17 as water and bridges.
      classification: { '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '9': 'noise', '17': 'noise', '32': 'bridge' },
      acquisitionStart: '2020-09-03',
      acquisitionEnd: '2020-09-04',
      license: 'CC BY 4.0',
      attribution: '© Gobierno de Navarra',
      sourcePage: 'https://filescartografia.navarra.es/5_LIDAR/',
      authoritative: true,
      projectYearHint: 2020,
    },
  ];
}

/** A 2024 tile's size, or 0 when there's none: missing ones answer 404. */
async function sizeOf(fetcher: Fetcher, url: string): Promise<number> {
  try {
    return await fetcher.size(url);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return 0;
    throw error;
  }
}

async function region(fetcher: Fetcher, bbox: GeoBounds): Promise<Candidate[]> {
  const { toLonLat } = lonLatTransforms(crsFromEpsg(25830));
  const wanted = gridSquares(25830, bbox, KM)
    .map(({ x, y }) => ({ url: `${REGION}las_cam_${x / KM}-${y / KM + 1}_2024_NAV_EPSG25830.laz`, square: squarePolygon(toLonLat, x, y, KM) }))
    .filter(({ square }) => overlaps(ringBox(square), bbox));
  const sizes = await Promise.all(wanted.map(({ url }) => sizeOf(fetcher, url)));
  const tiles: Tile[] = [];
  const coverage: Polygon[] = [];
  wanted.forEach(({ url, square }, i) => {
    if (!sizes[i]) return;
    tiles.push({ url, bbox: ringBox(square), size: sizes[i], horizontalCrs: 'EPSG:25830', zOffset: toOrthometric(square) });
    coverage.push(square);
  });
  if (!tiles.length) return [];
  return [
    {
      provider: 'Gobierno de Navarra',
      id: 'navarra-2024',
      name: 'Navarra LiDAR 2024',
      url: `${REGION}#2024`,
      format: 'LAZ',
      coverage,
      tiles,
      verticalUnits: 'm',
      classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '9': 'water', '10': 'ground', '11': 'ground', '17': 'bridge' },
      acquisitionStart: '2024-07-16',
      acquisitionEnd: '2024-09-15',
      license: 'CC BY 4.0',
      attribution: '© Gobierno de Navarra',
      sourcePage: 'https://filescartografia.navarra.es/5_LIDAR/',
      authoritative: true,
      projectYearHint: 2024,
    },
  ];
}

export const navarra: Provider = {
  id: 'navarra',
  name: 'Gobierno de Navarra',
  areas: [[-2.55, 41.9, -0.7, 43.35]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const found = await Promise.all([region(fetcher, bbox), pamplona(fetcher, bbox)]);
    return found.flat();
  },
};
