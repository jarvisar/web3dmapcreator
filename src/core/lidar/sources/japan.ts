// Japanese prefectures' open point clouds on the G-Spatial Information
// Center's buckets: Tokyo (the 23 wards and Tama), Kanagawa (Yokohama,
// Kawasaki) and Yamanashi. Each survey's index is a set of vector tiles whose
// polygons carry the tile's file URL. Files are mostly a ZIP holding one
// deflated LAS, read as it inflates. Kanagawa's 2024 survey is plain LAZ.
// They're heavy: about 0.5 GB per km² compressed in Tokyo's wards and
// Yamanashi, up to 1.2 GB in Tama. Shizuoka's full-density files (1.4-3 GB
// per km²) are left out. No file has a CRS: the plane zone comes from here.

import { VectorTile } from '@mapbox/vector-tile';
import { gunzipSync } from 'fflate';
import { PbfReader } from 'pbf';
import { tileRange } from '../../data/dem';
import type { GeoBounds, Polygon } from '../../types';
import type { Fetcher } from '../read/fetcher';
import { geoPolygons, overlaps, ringBox, type Box, type Candidate, type Provider, type Tile } from './common';

interface Survey {
  id: string;
  name: string;
  /** Vector tile index, {z}/{x}/{y}. */
  index: string;
  epsg: number;
  start: string;
  end: string;
  area: Box;
  publisher: string;
  attribution: string;
  sourcePage: string;
}

const SURVEYS: Survey[] = [
  {
    id: 'tokyo-23ku-2023',
    name: 'Tokyo 23 wards point cloud 2023',
    index: 'https://gic-tokyo.s3.ap-northeast-1.amazonaws.com/2024/dig/Vectortile/23ku/lp/{z}/{x}/{y}.pbf',
    epsg: 6677,
    start: '2023-03-01',
    end: '2023-04-30',
    area: [139.55, 35.5, 139.95, 35.83],
    publisher: 'Tokyo Metropolitan Government',
    attribution: 'Tokyo Metropolitan Government, Digital Twin 23-ku point cloud, CC BY 4.0',
    sourcePage: 'https://www.geospatial.jp/ckan/dataset/tokyopc-23ku-2024',
  },
  {
    id: 'tokyo-tama-2022',
    name: 'Tokyo Tama point cloud 2022-2023',
    index: 'https://gic-tokyo.s3.ap-northeast-1.amazonaws.com/2023/dig/Vectortile/tama/lp/{z}/{x}/{y}.pbf',
    epsg: 6677,
    start: '2022-07-01',
    end: '2023-01-31',
    area: [138.9, 35.5, 139.7, 35.9],
    publisher: 'Tokyo Metropolitan Government',
    attribution: 'Tokyo Metropolitan Government, Digital Twin Tama point cloud, CC BY 4.0',
    sourcePage: 'https://www.geospatial.jp/ckan/dataset/tokyopc-tama-2023',
  },
  {
    id: 'kanagawa-2024',
    name: 'Kanagawa point cloud 2024',
    index: 'https://gic-kanagawa.s3.ap-northeast-1.amazonaws.com/div/2024/Vectortile/orglaz/{z}/{x}/{y}.pbf',
    epsg: 6677,
    start: '2024-04-01',
    end: '2025-03-31',
    area: [138.9, 35.1, 139.8, 35.67],
    publisher: 'Kanagawa Prefecture',
    attribution: 'Kanagawa Prefecture point cloud 2024, CC BY 4.0',
    sourcePage: 'https://www.geospatial.jp/ckan/dataset/kanagawa-2024-pointcloud',
  },
  {
    id: 'kanagawa-2022',
    name: 'Kanagawa point cloud 2022',
    index: 'https://gic-kanagawa.s3.ap-northeast-1.amazonaws.com/div/2022/Vectortile2025/orglas/{z}/{x}/{y}.pbf',
    epsg: 6677,
    start: '2022-04-01',
    end: '2023-03-31',
    area: [138.9, 35.1, 139.8, 35.67],
    publisher: 'Kanagawa Prefecture',
    attribution: 'Kanagawa Prefecture point cloud 2022, CC BY 4.0',
    sourcePage: 'https://www.geospatial.jp/ckan/dataset/kanagawa-2022-pointcloud',
  },
  {
    id: 'kanagawa-2021',
    name: 'Kanagawa point cloud 2021',
    index: 'https://gic-kanagawa.s3.ap-northeast-1.amazonaws.com/div/2021/Vectortile2025/orglas/{z}/{x}/{y}.pbf',
    epsg: 6677,
    start: '2021-04-01',
    end: '2022-03-31',
    area: [138.9, 35.1, 139.8, 35.67],
    publisher: 'Kanagawa Prefecture',
    attribution: 'Kanagawa Prefecture point cloud 2021, CC BY 4.0',
    sourcePage: 'https://www.geospatial.jp/ckan/dataset/kanagawa-2021-pointcloud',
  },
  {
    id: 'yamanashi-2019',
    name: 'Yamanashi point cloud 2019-2022',
    index: 'https://gic-yamanashi.s3.ap-northeast-1.amazonaws.com/2024/Vectortile2026/lp/{z}/{x}/{y}.pbf',
    epsg: 6676,
    start: '2019-04-01',
    end: '2023-03-31',
    area: [138.1, 35.1, 139.2, 36.0],
    publisher: 'Yamanashi Prefecture',
    attribution: 'Yamanashi Prefecture point cloud, CC BY 4.0',
    sourcePage: 'https://www.geospatial.jp/ckan/dataset/yamanashi-pointcloud-2024',
  },
];

// Index tiles are a few KB at zoom 14, and exist from about 6 to 18.
const ZOOM = 14;
const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Each tile's file URL and outline from one index tile; nothing where the index has no tile. */
async function indexTile(fetcher: Fetcher, survey: Survey, x: number, y: number): Promise<{ url: string; outline: Polygon[] }[]> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fetcher.catalog(survey.index.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y)), WEEK_MS));
  } catch (error) {
    // Outside the survey the bucket answers 403.
    if (/HTTP 40[34]/.test((error as Error).message)) return [];
    throw error;
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const out: { url: string; outline: Polygon[] }[] = [];
  const tile = new VectorTile(new PbfReader(bytes));
  for (const layer of Object.values(tile.layers)) {
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const url = String(feature.properties.URL ?? '');
      if (!/^https:\/\/.+\.(zip|laz|las)$/i.test(url)) continue;
      out.push({ url, outline: geoPolygons(feature.toGeoJSON(x, y, ZOOM).geometry as { type: string; coordinates: unknown }) });
    }
  }
  return out;
}

async function survey(fetcher: Fetcher, survey: Survey, bbox: GeoBounds): Promise<Candidate | null> {
  const range = tileRange(bbox, ZOOM);
  const cells: [number, number][] = [];
  for (let x = range.x0; x <= range.x1; x++) for (let y = range.y0; y <= range.y1; y++) cells.push([x, y]);
  if (cells.length > 64) throw new Error('The area covers too many index tiles');
  const found = (await Promise.all(cells.map(([x, y]) => indexTile(fetcher, survey, x, y)))).flat();
  // Index polygons are cut at the vector tiles' edges, so a sheet across
  // two index tiles comes in pieces: its outline is all of them.
  const pieces = new Map<string, Polygon[]>();
  for (const { url, outline } of found) pieces.set(url, [...(pieces.get(url) ?? []), ...outline]);
  const tiles: Tile[] = [];
  const coverage: Polygon[] = [];
  for (const [url, outline] of pieces) {
    if (!outline.length) continue;
    const box = ringBox(outline.flat());
    if (!overlaps(box, bbox)) continue;
    tiles.push({ url, bbox: box, horizontalCrs: `EPSG:${survey.epsg}` });
    coverage.push(...outline);
  }
  if (!tiles.length) return null;
  return {
    provider: survey.publisher,
    id: survey.id,
    name: survey.name,
    url: survey.index,
    format: 'LAZ',
    coverage,
    tiles: tiles.sort((a, b) => (a.url < b.url ? -1 : 1)),
    // T.P. heights in metres.
    verticalUnits: 'm',
    acquisitionStart: survey.start,
    acquisitionEnd: survey.end,
    license: 'CC BY 4.0',
    attribution: survey.attribution,
    sourcePage: survey.sourcePage,
    authoritative: true,
    projectYearHint: Number(survey.end.slice(0, 4)),
  };
}

export const japan: Provider = {
  id: 'japan',
  name: 'G-Spatial Information Center (Japan)',
  areas: [[138.1, 35.1, 139.95, 36.0]],
  async discover(fetcher, bbox, failures) {
    const nearby = SURVEYS.filter((s) => overlaps(s.area, bbox));
    const found = await Promise.all(
      nearby.map((s) =>
        survey(fetcher, s, bbox).catch((error: Error) => {
          failures.push({ source: s.name, reason: error.message });
          return null;
        }),
      ),
    );
    return found.filter((c): c is Candidate => c !== null);
  },
};
