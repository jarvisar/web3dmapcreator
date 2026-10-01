// OpenTopography's own point clouds: its catalog API for datasets over an
// area, and each dataset's zipped tile index in its public bucket. Most of
// it is research surveys, but it's also the only browser-readable copy of
// New Zealand's LINZ surveys, and has Sao Paulo 2017 and Montreal 2015.
// Tiles are the publisher's plain LAZ.

import { unzipSync } from 'fflate';
import type { GeoBounds, Polygon } from '../../types';
import { crsFromEpsg, crsFromWkt, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { projectYear } from '../selection';
import { dateOnly, geoPolygons, overlaps, ringBox, type Candidate, type Provider, type Tile } from './common';
import { readDbf } from './shapefile';

const CATALOG = 'https://portal.opentopography.org/API/otCatalog';
const BULK = 'https://opentopography.s3.sdsc.edu/pc-bulk/';
const WEEK_MS = 7 * 24 * 3600 * 1000;

interface Dataset {
  name: string;
  identifier?: { value?: string };
  alternateName?: string;
  url?: string;
  citation?: string;
  temporalCoverage?: string;
  spatialCoverage?: { geo?: { geojson?: { type: string; coordinates: unknown } }; additionalProperty?: { name?: string; value?: string }[] };
}

/** HTML entities in the catalog's text, as in "Toit&#363; Te Whenua". */
function plain(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

async function tiles(fetcher: Fetcher, folder: string, epsg: number, bbox: GeoBounds): Promise<{ tiles: Tile[]; coverage: Polygon[] }> {
  // Tile indexes hardly change, so a week is fine.
  const zip = new Uint8Array(await fetcher.catalog(`${BULK}${folder}/${folder}_TileIndex.zip`, WEEK_MS, [0x50, 0x4b, 0x03, 0x04]));
  const files = unzipSync(zip, { filter: (file) => /\.(dbf|prj)$/i.test(file.name) });
  const dbf = Object.entries(files).find(([name]) => /\.dbf$/i.test(name))?.[1];
  const prj = Object.entries(files).find(([name]) => /\.prj$/i.test(name))?.[1];
  if (!dbf) throw new Error(`${folder} tile index has no attribute table`);
  let crs = prj ? crsFromWkt(new TextDecoder().decode(prj)) : crsFromEpsg(epsg);
  // ESRI-style .prj files name no EPSG code. The catalog's code goes with the WKT, which is the fallback.
  if (crs.epsg === null && epsg) crs = { ...crs, epsg, key: `EPSG:${epsg}` };
  const { toLonLat, fromLonLat } = lonLatTransforms(crs);
  const corners = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.east, bbox.north), fromLonLat(bbox.west, bbox.north)];
  const [qx0, qy0, qx1, qy1] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
  const out: Tile[] = [];
  const coverage: Polygon[] = [];
  for (const row of readDbf(dbf)) {
    // Older indexes name these MinX and so on.
    const [x0, x1, y0, y1] = [Number(row.min_x ?? row.minx), Number(row.max_x ?? row.maxx), Number(row.min_y ?? row.miny), Number(row.max_y ?? row.maxy)];
    if (!(x0 <= qx1 && x1 >= qx0 && y0 <= qy1 && y1 >= qy0)) continue;
    const url = String(row.url ?? '');
    if (!/^https:\/\/.+\.la[sz]$/i.test(url)) continue;
    const polygon: Polygon = [[toLonLat(x0, y0), toLonLat(x1, y0), toLonLat(x1, y1), toLonLat(x0, y1)]];
    const box = ringBox(polygon);
    if (!overlaps(box, bbox)) continue;
    out.push({ url, bbox: box, horizontalCrs: epsg ? `EPSG:${epsg}` : undefined });
    coverage.push(polygon);
  }
  return { tiles: out, coverage };
}

export const opentopography: Provider = {
  id: 'opentopography',
  name: 'OpenTopography',
  async discover(fetcher, bbox, failures) {
    const query = `${CATALOG}?productFormat=PointCloud&minx=${bbox.west}&miny=${bbox.south}&maxx=${bbox.east}&maxy=${bbox.north}&detail=true&outputFormat=json&include_federated=false`;
    const answer = (await fetcher.json(query)) as { Datasets?: { Dataset: Dataset }[] };
    if (!Array.isArray(answer.Datasets)) throw new Error('OpenTopography catalog answered without datasets');
    const found = await Promise.all(
      answer.Datasets.map(async ({ Dataset: d }): Promise<Candidate | null> => {
        const folder = d.alternateName ?? '';
        // Only its own bulk-hosted surveys (OTLAS). Community uploads (OTDS) are mostly photogrammetry.
        if (!/^OTLAS\./.test(d.identifier?.value ?? '') || !/^[\w.-]+$/.test(folder)) return null;
        if (d.spatialCoverage?.geo?.geojson && !geoPolygons(d.spatialCoverage.geo.geojson).some((p) => overlaps(ringBox(p), bbox))) return null;
        const property = (name: string) => d.spatialCoverage?.additionalProperty?.find((p) => p.name === name)?.value;
        const epsg = Number(property('EPSG (Horizontal)')) || Number(d.identifier?.value?.split('.')[2]) || 0;
        try {
          const { tiles: list, coverage } = await tiles(fetcher, folder, epsg, bbox);
          if (!list.length) return null;
          const [start, end] = (d.temporalCoverage ?? '').split('/').map((s) => dateOnly(s.trim()));
          return {
            provider: 'OpenTopography',
            id: folder,
            name: plain(d.name),
            url: `${BULK}${folder}/`,
            format: 'LAZ',
            coverage,
            tiles: list,
            acquisitionStart: start,
            acquisitionEnd: end ?? start,
            attribution: d.citation ? `${plain(d.citation)}; via OpenTopography` : `${plain(d.name)}, distributed by OpenTopography`,
            sourcePage: d.url ?? 'https://opentopography.org/',
            projectYearHint: projectYear(end ?? start ?? d.name),
          };
        } catch (error) {
          failures.push({ source: `OpenTopography ${folder}`, reason: (error as Error).message });
          return null;
        }
      }),
    );
    return found.filter((c): c is Candidate => c !== null);
  },
};
