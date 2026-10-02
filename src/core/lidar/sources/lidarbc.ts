// LidarBC (GeoBC): the province's 2023-2025 programme and the older NDMP,
// EMBC and BCTS surveys, as plain LAZ of BCGS 1:2,500 sheets (about 1.8 x 1.4
// km, 300 MB in the cities). Found through its ArcGIS layer, which answers
// cross-origin. The object store doesn't, so the files go through the proxy.
// About 23 returns per m² in Vancouver, Surrey and Victoria from 2023 on,
// where NRCan's copies of the older surveys have 12 to 17. Classes are 1, 2, 7
// and 12 (overlap): no buildings, so they measure from unclassified returns.
//
// NRCan republishes some NDMP surveys as COPC under the same tile names, and
// those are far cheaper to read. A tile of those is looked for on NRCan's
// bucket and left out when it's there, so the same flight isn't offered as a
// download next to its own COPC. Not every tile was copied (NRCan has 1,712
// of Fraser 2016's 2,008), so it's per tile.

import { proxyAvailable } from '../../data/corsProxy';
import type { Polygon } from '../../types';
import type { Fetcher } from '../read/fetcher';
import { geoPolygons, overlaps, pagedFeatures, ringBox, s3Keys, type Box, type Candidate, type Provider } from './common';

const LAYER = 'https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services/LiDAR_BC_S3_Public/FeatureServer/4/query';
const FILES = 'https://nrs.objectstore.gov.bc.ca/gdwuts/';
const NRCAN_BUCKET = 'https://canelevation-lidar-point-clouds.s3.ca-central-1.amazonaws.com/';
const NRCAN = 'pointclouds_nuagespoints/BC/';
// NAD83(CSRS) UTM zones by the index's `projection`.
const ZONES: Record<string, string> = { utm7: 'EPSG:3154', utm8: 'EPSG:3155', utm9: 'EPSG:3156', utm10: 'EPSG:3157', utm11: 'EPSG:2955' };

/** NRCan's folder holding copies of a LidarBC operation's tiles. Checked in October 2026. */
function nrcanFolder(operation: string, projection: string): string | null {
  if (operation === 'NDMP Fraser 2016') return 'Lower_Mainland_2016';
  if (operation === 'NDMP VI 2018' || operation === 'NDMP VI 2019') return 'Vancouver_Island_Sunshine_Coast_2018';
  if (operation === 'NDMP Floodplains 2019' && /^utm1[01]$/.test(projection)) return `Riverine_Floodplain_${projection.toUpperCase()}_2019`;
  return null;
}

/** NRCan's file names under a prefix, or none when NRCan can't be asked, and then its copies can't be read either. */
async function nrcanFiles(fetcher: Fetcher, prefix: string): Promise<Set<string>> {
  try {
    const keys = await s3Keys(fetcher, NRCAN_BUCKET, prefix, 2);
    return new Set([...keys.keys()].map((key) => key.slice(key.lastIndexOf('/') + 1)));
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    return new Set();
  }
}

const copcName = (filename: string) => filename.replace(/\.laz$/i, '.copc.laz');
// A tile's name without its dates: bc_092g025_3_4_2_xyes_8_utm10.
const stem = (filename: string) => filename.replace(/(_\d{4,8})*(\.copc)?\.laz$/i, '');

/**
 * Flight dates from a file name. The programme's end in a start and an end
 * date (`..._utm10_20250826_20250826.laz`). Older names have a delivery
 * date (`20170713` on 2016 flights) or just the year, so only dates in the
 * survey's own year count.
 */
export function flightDates(filename: string, year: number): { start: string; end: string } {
  const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const pair = /_(\d{8})_(\d{8})\.laz$/i.exec(filename);
  if (pair && Number(pair[1].slice(0, 4)) === year) return { start: iso(pair[1]), end: iso(pair[2]) };
  const one = /_(\d{8})\.laz$/i.exec(filename);
  if (one && Number(one[1].slice(0, 4)) === year) return { start: iso(one[1]), end: iso(one[1]) };
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

interface Found {
  url: string;
  filename: string;
  year: number;
  operation: string;
  projection: string;
  coverage: Polygon[];
  box: Box;
}

export const lidarbc: Provider = {
  id: 'lidarbc',
  name: 'LidarBC',
  areas: [[-139.1, 48.2, -114, 60.1]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    const rows = await pagedFeatures(
      fetcher,
      (offset, count) =>
        `${LAYER}?f=geojson&where=1%3D1&geometry=${box}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=filename,year,oper_name,projection,s3Url&returnGeometry=true&resultOffset=${offset}&resultRecordCount=${count}&orderByFields=OBJECTID`,
    );
    const found: Found[] = rows.flatMap((row) => {
      const p = row.properties;
      const url = String(p.s3Url ?? '');
      const year = Number(p.year);
      const coverage = geoPolygons(row.geometry);
      if (!url.startsWith(FILES) || !/\.laz$/i.test(url) || !Number.isInteger(year) || !coverage.length) return [];
      const tileBox = ringBox(coverage.flat());
      if (!overlaps(tileBox, bbox)) return [];
      const filename = url.slice(url.lastIndexOf('/') + 1);
      return [{ url, filename, year, operation: String(p.oper_name ?? '').trim(), projection: String(p.projection ?? '').trim().toLowerCase(), coverage, box: tileBox }];
    });
    // One listing per 1:20,000 sheet (bc_092g025_), up to 64 tiles.
    const listings = new Map<string, Promise<Set<string>>>();
    const nrcan = await Promise.all(
      found.map(({ filename, operation, projection }) => {
        const folder = nrcanFolder(operation, projection);
        if (!folder) return null;
        const prefix = `${NRCAN}${folder}/${/^[^_]+_[^_]+_/.exec(filename)?.[0] ?? stem(filename)}`;
        if (!listings.has(prefix)) listings.set(prefix, nrcanFiles(fetcher, prefix));
        return listings.get(prefix)!;
      }),
    );
    // NRCan renamed some copies (139 of its Fraser 2016 tiles end in _2018,
    // not LidarBC's _20170713 or _20170714), so a copy of the same tile left
    // over after the exact names counts too. VI 2018 and 2019 share 79 tiles
    // in one NRCan folder, and there the left over copy is the other year's
    // flight, which has its own tile here.
    const exact = new Set(found.map((t) => copcName(t.filename)));
    const copied = found.map(({ filename }, i) => {
      const names = nrcan[i];
      if (!names) return false;
      if (names.has(copcName(filename))) return true;
      return [...names].some((name) => !exact.has(name) && stem(name) === stem(filename));
    });

    const groups = new Map<string, Found[]>();
    found.forEach((tile, i) => {
      if (copied[i]) return;
      const key = `${tile.operation} ${tile.year}`;
      groups.set(key, [...(groups.get(key) ?? []), tile]);
    });
    return [...groups].map(([key, tiles]): Candidate => {
      const { operation, year } = tiles[0];
      const spans = tiles.map((t) => flightDates(t.filename, year));
      return {
        provider: 'LidarBC',
        id: key.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: operation === 'LidarBC Program' ? `LidarBC ${year}` : `LidarBC ${operation}${operation.includes(String(year)) ? '' : ` ${year}`}`,
        url: `${FILES}#${encodeURIComponent(key)}`,
        format: 'LAZ',
        coverage: tiles.flatMap((t) => t.coverage),
        tiles: tiles.map((t) => ({ url: t.url, bbox: t.box, horizontalCrs: ZONES[t.projection] })),
        verticalUnits: 'm',
        acquisitionStart: spans.map((s) => s.start).sort()[0],
        acquisitionEnd: spans.map((s) => s.end).sort().at(-1),
        license: 'Open Government Licence - British Columbia',
        attribution: 'Contains information licensed under the Open Government Licence - British Columbia',
        sourcePage: 'https://lidar.gov.bc.ca/',
        authoritative: true,
        projectYearHint: year,
      };
    });
  },
};
