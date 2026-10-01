// AIST's 3DDB: COPC copies of Japanese prefectures' open point clouds, found
// through its feature API by area. Three sets are read:
//
// - Tokyo's 23 wards (2023), the same points as the city's deflated LAS ZIPs
//   in `japan.ts`, in about 63% of the bytes and read by range. Those ZIPs
//   stay as the fallback.
// - Open Nagasaki, the whole prefecture (flown 2012-2021). Only class 1.
// - Hyogo's high-precision survey of the hills and mountains, which reaches
//   into Kobe's Kitano but stops along a line above Sannomiya: the port and
//   the coastal plain come out flat. Ground and buildings classified. Hyogo
//   says it's open for any use.
//
// 3DDB converted the heights to the ellipsoid, about 36-38 m over the T.P.
// heights everything else in Japan uses. In Tokyo the API's minz is still the
// original's, so each tile goes back by its own difference, or a model across
// the wards' edge stepped 37 m against Tama's or Kanagawa's tiles. Nagasaki and
// Hyogo have nothing readable beside them and stay as they are.
//
// It's a research service (`3ddb_demo`, 60 requests a minute), so URLs may
// change. Files on the old host redirect without CORS.

import type { Polygon } from '../../types';
import { readHeader } from '../read/las';
import { geoPolygons, overlaps, ringBox, type Box, type Candidate, type Provider, type Tile } from './common';

const API = 'https://gsvrg.ipri.aist.go.jp/3ddb_demo/api/v1/services/POINTCLOUD/features';
const FILES = 'https://gsvrg.ipri.aist.go.jp/3ddb-pds/copc/';
const PAGE = 400;
const MAX_PAGES = 5;

interface Collection {
  group: string;
  id: string;
  name: string;
  epsg: number;
  start: string;
  end: string;
  year: number;
  area: Box;
  /** The API's minz is on the original datum, so tiles go back to it. */
  restoreDatum?: boolean;
  unclassified?: boolean;
  attribution: string;
  sourcePage: string;
}

const COLLECTIONS: Collection[] = [
  {
    group: '92',
    id: 'tokyo-23ku-2023',
    name: 'Tokyo 23 wards point cloud 2023 (COPC)',
    epsg: 6677,
    start: '2023-03-01',
    end: '2023-04-30',
    year: 2023,
    area: [139.55, 35.5, 139.95, 35.83],
    restoreDatum: true,
    attribution: 'Tokyo Metropolitan Government, Digital Twin 23-ku point cloud, CC BY 4.0, through AIST 3DDB',
    sourcePage: 'https://www.geospatial.jp/ckan/dataset/tokyopc-23ku-2024',
  },
  {
    group: '86',
    id: 'open-nagasaki',
    name: 'Open Nagasaki point cloud (COPC)',
    epsg: 6669,
    start: '2012-01-01',
    end: '2021-12-31',
    year: 2012,
    area: [128.55, 32.5, 130.45, 34.75],
    unclassified: true,
    attribution: 'Nagasaki Prefecture, Open Nagasaki, CC BY 4.0, through AIST 3DDB',
    sourcePage: 'https://opennagasaki.nerc.or.jp/',
  },
  {
    group: '80',
    id: 'hyogo',
    name: 'Hyogo high-precision point cloud (COPC)',
    epsg: 6673,
    start: '2020-04-01',
    end: '2023-03-31',
    year: 2020,
    area: [134.2, 34.15, 135.5, 35.7],
    attribution: 'Hyogo Prefecture high-precision 3D point cloud, CC BY 4.0, through AIST 3DDB',
    sourcePage: 'https://web.pref.hyogo.lg.jp/kk26/hyogo-geo.html',
  },
];

interface Record3ddb {
  geometries?: { type: string; coordinates: unknown; properties?: { minz?: number } }[];
  properties: { reg_id: number; group: string; external_links?: { external_link: string; external_link_type: string }[] };
}

/** Every record under the box, a page at a time. */
async function records(fetcher: Parameters<Provider['discover']>[0], area: string): Promise<Record3ddb[]> {
  const out: Record3ddb[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = (await fetcher.json(`${API}?area=${encodeURIComponent(area)}&limit=${PAGE}&offset=${page * PAGE}`)) as { features?: Record3ddb[]; properties?: { all?: number } };
    const rows = answer.features ?? [];
    out.push(...rows);
    if (rows.length < PAGE || out.length >= (answer.properties?.all ?? 0)) return out;
  }
  throw new Error('The 3DDB catalog has too many records here');
}

export const aist3ddb: Provider = {
  id: '3ddb',
  name: 'AIST 3DDB',
  areas: COLLECTIONS.map((c) => c.area),
  async discover(fetcher, bbox) {
    const { west: w, south: s, east: e, north: n } = bbox;
    const found = await records(fetcher, `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`);
    const out: Candidate[] = [];
    for (const collection of COLLECTIONS) {
      let kept: { tile: Tile; outline: Polygon[] }[] = [];
      for (const record of found) {
        if (record.properties.group !== collection.group) continue;
        if (!record.properties.external_links?.some((l) => l.external_link_type === 'copc')) continue;
        const footprint = record.geometries?.[0];
        const outline = geoPolygons(footprint as { type: string; coordinates: unknown } | undefined);
        if (!outline.length) continue;
        const box = ringBox(outline.flat());
        if (!overlaps(box, bbox)) continue;
        const tile: Tile = { url: `${FILES}${record.properties.reg_id}.copc.laz`, bbox: box, horizontalCrs: `EPSG:${collection.epsg}` };
        if (collection.restoreDatum) tile.zOffset = footprint?.properties?.minz;
        kept.push({ tile, outline });
      }
      if (collection.restoreDatum) {
        // minz is the original's lowest height, the header's the copy's. A
        // tile without one is left to the original's ZIPs.
        kept = kept.filter(({ tile }) => Number.isFinite(tile.zOffset));
        await Promise.all(
          kept.map(async ({ tile }) => {
            const header = readHeader(new Uint8Array(await fetcher.range(tile.url, 0, 375)));
            tile.zOffset = (tile.zOffset as number) - header.min[2];
          }),
        );
      }
      if (!kept.length) continue;
      const tiles = kept.map((f) => f.tile);
      const coverage = kept.flatMap((f) => f.outline);
      out.push({
        provider: 'AIST 3DDB',
        id: collection.id,
        name: collection.name,
        url: `${API}#${collection.group}`,
        format: 'COPC',
        coverage,
        tiles,
        verticalUnits: 'm',
        acquisitionStart: collection.start,
        acquisitionEnd: collection.end,
        license: 'CC BY 4.0',
        attribution: collection.attribution,
        sourcePage: collection.sourcePage,
        projectYearHint: collection.year,
        unclassified: collection.unclassified,
      });
    }
    return out;
  },
};
