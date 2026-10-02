// ICGC's LiDAR Territorial v3.1, all of Catalonia flown 2021-2023 (central
// Barcelona in June 2022): LAZ of 1 km, 22 returns per m² in the Eixample
// and 270-370 MB a tile there. The host sends no CORS headers and didn't
// answer from US addresses at all in October 2026, so US users may only get
// a failed search, which is why discovery has a short deadline.
//
// The index is the folder listing of each 10 km square (about 10 KB, with
// sizes). Folders are named by x / 10 km and (y - 4000 km) / 10 km, and files
// by their south-west corner in km, without y's leading 4. The files under
// vigent/ are the same ones without version or years in their names, so
// they'd change under their URL with the next version.
//
// Classes beyond ASPRS: 8 is model key points (about half the ground) and 77
// whatever stands on roofs, so those are ground and building. 75 is possible
// ground, between 5 m under and 15 cm over the terrain, and sat at the same
// height as 2 and 8 in the Eixample, so it's ground too. 76 is under
// buildings (mostly facades) and is dropped, like 12 (overlap) and 18 (air).
//
// LiDAR Litoral, the coast flown about once a year, is laid out the same way
// under lidar-litoral/ but isn't read yet.

import type { GeoBounds, Polygon } from '../../types';
import { HttpError } from '../../data/http';
import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { gridSquares, overlaps, ringBox, squarePolygon, Surveys, type Provider } from './common';

const BASE = 'https://datacloud.icgc.cat/datacloud/lidar-territorial/laz_unzip/';
const WEEK_MS = 7 * 24 * 3600 * 1000;
const KM = 1000;
// IIS folder listings start with this. A maintenance page sent with a 200
// usually starts with a doctype, and then isn't kept as the listing.
const LISTING = [...'<html>'].map((c) => c.charCodeAt(0));

interface Listed {
  name: string;
  version: string;
  rank: number;
  size: number;
  start: number;
  end: number;
}

/** A 10 km folder's tiles by their 1 km id (`430582`), the newest version of each. */
export function icgcListing(html: string): Map<string, Listed> {
  const out = new Map<string, Listed>();
  for (const match of html.matchAll(/(\d+) <A HREF="[^"]*\/(lidar-territorial-v(\d+)r(\d+)-full1km(\d{6})-(\d{4})(?:-(\d{4}))?\.laz)">/gi)) {
    const [, size, name, major, minor, id, start, end] = match;
    const rank = Number(major) * 1000 + Number(minor);
    if ((out.get(id)?.rank ?? -1) >= rank) continue;
    out.set(id, { name, version: `${major}.${minor}`, rank, size: Number(size), start: Number(start), end: Number(end ?? start) });
  }
  return out;
}

async function folder(fetcher: Fetcher, id: string): Promise<Map<string, Listed>> {
  try {
    return icgcListing(new TextDecoder().decode(await fetcher.catalog(`${BASE}full10km${id}/`, WEEK_MS, LISTING)));
  } catch (error) {
    // Squares off the coast or outside Catalonia have no folder.
    if (error instanceof HttpError && error.status === 404) return new Map();
    throw error;
  }
}

export const icgc: Provider = {
  id: 'icgc',
  name: 'ICGC Catalunya',
  areas: [[0.1, 40.5, 3.35, 42.9]],
  timeoutMs: 20_000,
  async discover(fetcher, bbox: GeoBounds) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25831));
    const squares = gridSquares(25831, bbox, KM).map(({ x, y }) => ({ x, y, folder: `${Math.floor(x / 10_000)}${Math.floor((y - 4_000_000) / 10_000)}` }));
    const folders = [...new Set(squares.map((s) => s.folder))];
    const listings = new Map(await Promise.all(folders.map(async (id) => [id, await folder(fetcher, id)] as const)));
    const surveys = new Surveys();
    for (const { x, y, folder: id } of squares) {
      const tile = listings.get(id)?.get(`${x / KM}${String(y / KM - 4000).padStart(3, '0')}`);
      if (!tile) continue;
      const square: Polygon = squarePolygon(toLonLat, x, y, KM);
      const box = ringBox(square);
      if (!overlaps(box, bbox)) continue;
      surveys.add(
        `${tile.version}-${tile.start}-${tile.end}`,
        () => ({
          provider: 'ICGC',
          id: `territorial-v${tile.version}-${tile.start}-${tile.end}`,
          name: `LiDAR Territorial v${tile.version} (${tile.start}-${tile.end})`,
          url: `${BASE}#v${tile.version}-${tile.start}-${tile.end}`,
          format: 'LAZ',
          verticalUnits: 'm',
          classification: {
            '1': 'unclassified',
            '2': 'ground',
            '3': 'low vegetation',
            '4': 'medium vegetation',
            '5': 'high vegetation',
            '6': 'building',
            '8': 'ground',
            '9': 'water',
            '17': 'bridge',
            '75': 'ground',
            '77': 'building',
          },
          acquisitionStart: `${tile.start}-01-01`,
          acquisitionEnd: `${tile.end}-12-31`,
          license: 'CC BY 4.0',
          attribution: 'Institut Cartogràfic i Geològic de Catalunya (ICGC)',
          sourcePage: 'https://visors.icgc.cat/appdownloads/index.html?c=dlfxlidarterri',
          authoritative: true,
          projectYearHint: tile.start,
        }),
        { url: `${BASE}full10km${id}/${tile.name}`, bbox: box, size: tile.size, horizontalCrs: 'EPSG:25831' },
        [square],
      );
    }
    return surveys.list();
  },
};
