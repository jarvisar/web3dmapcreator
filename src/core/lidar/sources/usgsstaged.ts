// USGS 3DEP work units that Hobu's EPT mirror hasn't built, as the LAZ tiles
// USGS stages on rockyweb. That host sends no CORS headers, so the browser
// reads them through the site's proxy (data/corsProxy.ts) and this provider is
// left out of builds without one. The tiles are found with USGS's product
// search, which does answer cross-origin requests.
//
// In October 2026 that was 179 work units from 2023 on, among them the
// centres of Houston, Portland, Pittsburgh, Baltimore, Salt Lake City, San
// Diego, Philadelphia and Miami, and Cincinnati's 2021-22 survey (about 33
// returns per m²). Tiles are plain LAZ, so they're offered before they're
// read, like any other whole-file survey.
//
// rockyweb gives each connection about 0.1 MB/s. Pennsylvania's 2024 work
// units (Philadelphia, Pittsburgh, Harrisburg) are read from PASDA's copy
// instead, the same points in 2,500 ft State Plane tiles at about 7 MB/s, and
// New York's 2024 ones from the state's copy (COPIES), as long as the copy has
// every tile over the area.

import type { GeoBounds, Polygon } from '../../types';
import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { projectYear } from '../selection';
import { gridSquares, overlaps, ringBox, squarePolygon, type Box, type Candidate, type Provider, type Tile } from './common';
import { USGS_CATALOG, workUnitYear } from './usgs';

const SEARCH = 'https://tnmaccess.nationalmap.gov/api/v1/products';
const STAGED = 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/';
const PAGE = 1000;
const MAX_ITEMS = 5000;
const PASDA = 'https://www.pasda.psu.edu/download/usgs/PA_17County_2024/PA_State_Plane_South/point_cloud/tilecls/';
const PASDA_UNIT = /^PA_17Co_\d+_D24$/;
const PASDA_FT = 2500;

interface Item {
  downloadURL?: string;
  sizeInBytes?: number;
  boundingBox?: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Work units Hobu's mirror has, under their own names and as old `USGS_LPC_<project>_LAS_<year>` builds. */
async function mirrored(fetcher: Fetcher): Promise<Set<string>> {
  const catalog = (await fetcher.json(USGS_CATALOG)) as { features: { properties: { name: string } }[] };
  const names = new Set<string>();
  for (const { properties } of catalog.features) {
    names.add(properties.name);
    names.add(properties.name.replace(/^USGS_LPC_/, '').replace(/_LAS_\d{4}$/, ''));
  }
  return names;
}

const square = ([w, s, e, n]: Box): Polygon => [[[w, s], [e, s], [e, n], [w, n]]];

/**
 * PASDA's name for the 2,500 ft tile at x, y (PA South, US feet): the 10,000 ft
 * tile's north edge / 100 and west edge / 1000, then its quarter and the
 * quarter of that. City Hall, x 2,692,500 y 235,000, is 24002690PAS_NW_SE.
 */
export function pasdaName(x: number, y: number): string {
  const west = Math.floor(x / 10000) * 10000;
  const south = Math.floor(y / 10000) * 10000;
  const quarter = (dx: number, dy: number, half: number) => `${dy >= half ? 'N' : 'S'}${dx >= half ? 'E' : 'W'}`;
  const x5 = west + (x - west >= 5000 ? 5000 : 0);
  const y5 = south + (y - south >= 5000 ? 5000 : 0);
  const north = String((south + 10000) / 100).padStart(4, '0');
  return `${north}${String(west / 1000).padStart(4, '0')}PAS_${quarter(x - west, y - south, 5000)}_${quarter(x - x5, y - y5, 2500)}.laz`;
}

// Other copies of work units, the same tiles under other names. New York
// State's Long Island copy is uncompressed LAS, about 2.7 times the bytes,
// but it comes at 4 MB/s or more.
const COPIES: { unit: RegExp; tile: RegExp; url: (id: string) => string }[] = [
  { unit: /^NY_LongIsland_\d+_A24$/, tile: /_(u_\d+)\.laz$/i, url: (id) => `https://gisdata.ny.gov/elevation/LIDAR/NYS_LongIsland2024/${id}.las` },
  { unit: /^NY_NHGaps_\d+_D24$/, tile: /_(w\d+n\d+)\.laz$/i, url: (id) => `https://gisdata.ny.gov/elevation/LIDAR/USGS_2024/${id}.laz` },
];

/** A work unit's tiles from a faster copy, or null unless the copy has every one. */
async function copied(fetcher: Fetcher, unit: string, tiles: Tile[]): Promise<Tile[] | null> {
  const copy = COPIES.find((c) => c.unit.test(unit));
  const urls = copy ? tiles.map((t) => copy.tile.exec(t.url)?.[1]).map((id) => (id ? copy.url(id) : null)) : [];
  if (!copy || urls.some((url) => !url)) return null;
  const sizes = await Promise.all(urls.map((url) => fetcher.size(url!).catch(() => 0)));
  if (sizes.some((size) => !size)) return null;
  return tiles.map((t, i) => ({ ...t, url: urls[i]!, size: sizes[i] }));
}

/** PASDA's tiles over the area, or null unless it has every one of them. */
async function pasdaCopy(fetcher: Fetcher, bbox: GeoBounds): Promise<{ tiles: Tile[]; coverage: Polygon[] } | null> {
  const { toLonLat } = lonLatTransforms(crsFromEpsg(6565));
  let squares: { x: number; y: number }[];
  try {
    squares = gridSquares(6565, bbox, PASDA_FT, 64);
  } catch {
    return null;
  }
  const wanted = squares.map(({ x, y }) => ({ url: `${PASDA}${pasdaName(x, y)}`, polygon: squarePolygon(toLonLat, x, y, PASDA_FT) })).filter((t) => overlaps(ringBox(t.polygon), bbox));
  // A missing tile (404) or a failed HEAD leaves the work units on rockyweb.
  const sizes = await Promise.all(wanted.map((t) => fetcher.size(t.url).catch(() => 0)));
  if (!wanted.length || sizes.some((size) => !size)) return null;
  return { tiles: wanted.map((t, i) => ({ url: t.url, bbox: ringBox(t.polygon), size: sizes[i] })), coverage: wanted.map((t) => t.polygon) };
}

export const usgsStaged: Provider = {
  id: 'usgs-staged',
  name: 'USGS 3DEP (staged LAZ)',
  // The states, Alaska, Hawaii, Puerto Rico and the Virgin Islands, Guam and the Marianas, American Samoa.
  areas: [
    [-125, 24, -66.5, 49.5],
    [-180, 51, -129, 71.5],
    [-160.5, 18.8, -154.7, 22.3],
    [-67.5, 17.6, -64.5, 18.6],
    [144.5, 13.2, 146.1, 20.6],
    [-171, -14.6, -168.1, -11],
  ],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    const items: Item[] = [];
    for (let offset = 0; offset < MAX_ITEMS; offset += PAGE) {
      const page = (await fetcher.json(`${SEARCH}?datasets=${encodeURIComponent('Lidar Point Cloud (LPC)')}&bbox=${box}&prodFormats=LAZ&max=${PAGE}&offset=${offset}&outputFormat=JSON`)) as { total?: number; items?: Item[] };
      items.push(...(page.items ?? []));
      if (!page.items?.length || items.length >= (page.total ?? 0)) break;
    }
    const known = await mirrored(fetcher);
    const units = new Map<string, { project: string; tiles: Tile[]; coverage: Polygon[] }>();
    // TNM can list one tile many times: a 0.8 km box at Lake George came back
    // with one 430 MB tile 20 times.
    const seen = new Set<string>();
    for (const item of items) {
      const url = item.downloadURL ?? '';
      if (seen.has(url)) continue;
      seen.add(url);
      // Projects/<project>/<work unit>/LAZ/<tile>.laz. Legacy projects (before about 2012) are all in the mirror.
      const match = /^https:\/\/rockyweb\.usgs\.gov\/vdelivery\/Datasets\/Staged\/Elevation\/LPC\/Projects\/([^/]+)\/([^/]+)\/LAZ\/[^/]+\.laz$/i.exec(url);
      const b = item.boundingBox;
      if (!match || match[1] === 'legacy' || !b || known.has(match[2])) continue;
      const tileBox: Box = [b.minX, b.minY, b.maxX, b.maxY];
      if (!overlaps(tileBox, bbox)) continue;
      const [, project, unit] = match;
      let entry = units.get(unit);
      if (!entry) units.set(unit, (entry = { project, tiles: [], coverage: [] }));
      entry.tiles.push({ url, bbox: tileBox, size: item.sizeInBytes || undefined });
      entry.coverage.push(square(tileBox));
    }
    const pennsylvania = [...units.keys()].filter((unit) => PASDA_UNIT.test(unit));
    const copy = pennsylvania.length ? await pasdaCopy(fetcher, bbox) : null;
    if (copy) {
      // One flight, split into work units by county: PASDA's tiles stand for all of them.
      Object.assign(units.get(pennsylvania[0])!, copy);
      for (const unit of pennsylvania.slice(1)) units.delete(unit);
    }
    await Promise.all(
      [...units].map(async ([unit, entry]) => {
        const tiles = await copied(fetcher, unit, entry.tiles);
        if (tiles) entry.tiles = tiles;
      }),
    );
    return [...units].map(
      ([unit, { project, tiles, coverage }]): Candidate => ({
        provider: 'USGS',
        id: unit,
        name: unit,
        url: `${STAGED}${project}/${unit}/`,
        format: 'LAZ',
        coverage,
        tiles,
        license: 'Public domain',
        attribution: 'USGS 3DEP',
        sourcePage: `https://prd-tnm.s3.amazonaws.com/index.html?prefix=StagedProducts/Elevation/LPC/Projects/${project}/${unit}/`,
        authoritative: true,
        projectYearHint: projectYear(unit) ?? workUnitYear(unit),
      }),
    );
  },
};
