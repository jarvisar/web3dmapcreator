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

import type { Polygon } from '../../types';
import { proxyAvailable } from '../../data/corsProxy';
import type { Fetcher } from '../read/fetcher';
import { projectYear } from '../selection';
import { overlaps, type Box, type Candidate, type Provider, type Tile } from './common';
import { USGS_CATALOG, workUnitYear } from './usgs';

const SEARCH = 'https://tnmaccess.nationalmap.gov/api/v1/products';
const STAGED = 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/';
const PAGE = 1000;
const MAX_ITEMS = 5000;

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
    for (const item of items) {
      const url = item.downloadURL ?? '';
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
