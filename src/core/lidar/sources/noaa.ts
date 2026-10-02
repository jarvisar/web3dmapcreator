// NOAA Digital Coast on AWS: EPT builds of the surveys it hosts, found
// through its Data Access Viewer footprints and one STAC item per survey.
// Many are city and county surveys that never went to USGS, so USGS's mirror
// lacks them: New York 2017 (23 returns per m² against 4 from 2014),
// Philadelphia 2022, Miami-Dade 2021, DC, Richmond and Charleston 2025, and
// the territories (American Samoa, Guam 2020, the 2019 Puerto Rico and
// Virgin Islands topobathy).
//
// A survey without an EPT build is still in the bucket as tiles, with a
// zipped shapefile index whose rows give each file's URL. COPC tiles
// (Connecticut 2023, 50 per m²) are read like an EPT, plain LAZ only once
// the user agrees to download it.

import type { GeoBounds, Polygon } from '../../types';
import { crsFromEpsg, crsFromWkt, lonLatTransforms, type CrsInfo } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { projectYear } from '../selection';
import { dateOnly, geoPolygons, keyPath, overlaps, pagedFeatures, ringBox, s3Keys, sphericalArea, type Candidate, type Provider, type Tile } from './common';
import { dbfRowAt, shpPolygons, zippedIndex } from './shapefile';

const FOOTPRINTS = 'https://coast.noaa.gov/arcgis/rest/services/DAV/DAV_footprints/FeatureServer/0/query';
const BUCKET = 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/';
const MIN_DENSITY = 2;
// Where tiled surveys are, by vertical datum. Almost all are in these two.
const DATUMS = ['geoid18', 'geoid12b'];
// Tiled surveys older than this aren't looked at: they're sparse as a rule,
// and their indexes would be downloaded for nothing.
const OLDEST_TILED = 2010;
const WEEK_MS = 7 * 24 * 3600 * 1000;
// Topobathy surveys file the water surface as 41 (40 and 42-45 are under or made up).
const CLASSES = { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '41': 'water' };

const common = (id: number, title: string) => ({
  provider: 'NOAA',
  id: String(id),
  name: title,
  classification: CLASSES,
  license: 'Public domain (NOAA asks for attribution)',
  attribution: 'NOAA Office for Coastal Management, Digital Coast',
  sourcePage: `https://coast.noaa.gov/dataviewer/#/lidar/search/where:ID=${id}`,
  authoritative: true,
  projectYearHint: projectYear(title),
});

/** Transforms for a CRS, or null when there's no definition for it. */
function transformsOf(crs: CrsInfo): ReturnType<typeof lonLatTransforms> | null {
  try {
    return lonLatTransforms(crs);
  } catch (error) {
    if (/^No definition/.test((error as Error).message)) return null;
    throw error;
  }
}

/** A survey's tiles under the area from its zipped index, or null when it has none. */
async function tiled(fetcher: Fetcher, id: number, title: string, bbox: GeoBounds): Promise<Candidate | null> {
  const year = projectYear(title);
  if (!year || year < OLDEST_TILED) return null;
  for (const datum of DATUMS) {
    const folder = `laz/${datum}/${id}/`;
    const keys = await s3Keys(fetcher, BUCKET, `${folder}tileindex_`, 1);
    const zip = [...keys.keys()].find((key) => key.endsWith('.zip'));
    if (!zip) continue;
    const index = await zippedIndex(fetcher, `${BUCKET}${keyPath(zip)}`, WEEK_MS);
    // Every row names its file's EPSG code. The .prj is the ESRI kind, without one.
    const srs = String(dbfRowAt(index.dbf, 0).srs ?? '');
    const epsg = Number(/^EPSG:(\d+)$/i.exec(srs)?.[1]);
    // Where the grid has no code of its own, as with NAD83(CORS96) / UTM zone
    // 10N (Olympic Peninsula 2017), the row names its geographic CRS instead
    // (6783), so the .prj is the better guide.
    const byCode = epsg ? transformsOf(crsFromEpsg(epsg)) : null;
    const crs = byCode ? null : index.prj ? crsFromWkt(index.prj) : null;
    if (!byCode && !crs) throw new Error(`The NOAA ${id} tile index has no usable coordinate system (${srs || 'none'})`);
    const { toLonLat, fromLonLat } = byCode ?? lonLatTransforms(crs!);
    const corners = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.east, bbox.north), fromLonLat(bbox.west, bbox.north)];
    const query: [number, number, number, number] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const shape of shpPolygons(index.shp, query)) {
      const url = String(dbfRowAt(index.dbf, shape.index).url ?? '');
      // Only the bucket's own files, which are known to allow cross-origin reads.
      if (!url.startsWith(BUCKET) || !/\.laz$/i.test(url)) continue;
      const [x0, y0, x1, y1] = shape.box;
      const polygon: Polygon = [[toLonLat(x0, y0), toLonLat(x1, y0), toLonLat(x1, y1), toLonLat(x0, y1)]];
      const box = ringBox(polygon);
      if (!overlaps(box, bbox)) continue;
      tiles.push({ url, bbox: box, horizontalCrs: byCode ? `EPSG:${epsg}` : undefined });
      coverage.push(polygon);
    }
    if (!tiles.length) return null;
    return {
      ...common(id, title),
      url: `${BUCKET}${folder}`,
      format: tiles.every((t) => /\.copc\.laz$/i.test(t.url)) ? 'COPC' : 'LAZ',
      coverage,
      tiles,
    };
  }
  return null;
}

interface StacItem {
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
  assets?: { ept?: { href?: string } };
}

export const noaa: Provider = {
  id: 'noaa',
  name: 'NOAA Digital Coast',
  areas: [
    [-125.0, 24.4, -66.8, 49.5], // the lower 48 and the Great Lakes
    [-180.0, 51.0, -129.9, 71.5], // Alaska
    [-178.5, 18.5, -154.5, 28.6], // Hawaii and the Northwestern Hawaiian Islands
    [-68.0, 17.5, -64.4, 18.8], // Puerto Rico and the US Virgin Islands
    [144.4, 13.1, 146.2, 20.7], // Guam and the Northern Mariana Islands
    [-171.2, -14.7, -168.0, -10.9], // American Samoa
  ],
  async discover(fetcher, bbox, failures) {
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    const rows = await pagedFeatures(
      fetcher,
      (offset, count) =>
        `${FOOTPRINTS}?where=data_type%3D%27Lidar%27&geometry=${box}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=id,title&returnGeometry=false&f=geojson&resultOffset=${offset}&resultRecordCount=${count}&orderByFields=id`,
    );
    const found = await Promise.all(
      rows.map(async (row): Promise<Candidate | null> => {
        const id = Number(row.properties.id);
        if (!Number.isInteger(id)) return null;
        const title = String(row.properties.title ?? `NOAA Digital Coast ${id}`);
        let item: StacItem;
        try {
          item = (await fetcher.json(`${BUCKET}entwine/stac/DigitalCoast_mission_${id}.json`)) as StacItem;
        } catch (error) {
          // Most surveys have no EPT build, and their item is a 404.
          if (!/HTTP 40[34]/.test((error as Error).message)) {
            failures.push({ source: `NOAA ${id}`, reason: (error as Error).message });
            return null;
          }
          return tiled(fetcher, id, title, bbox).catch((reason: Error) => {
            failures.push({ source: `NOAA ${id}`, reason: reason.message });
            return null;
          });
        }
        const url = item.assets?.ept?.href ?? '';
        // A quarter point at USGS's bucket, which the USGS source already lists.
        if (!url.startsWith(BUCKET)) return null;
        const coverage = geoPolygons(item.geometry);
        if (!coverage.some((p) => overlaps(ringBox(p), bbox))) return null;
        const p = item.properties ?? {};
        const wkt = String(p['proj:wkt2'] ?? '');
        const count = Number(p['pc:count']);
        const area = sphericalArea(coverage);
        const density = count > 0 && area > 0 ? count / area : undefined;
        // The early surveys (2000s USACE and NASA ATM) have under 2 returns
        // per m², no use for a building.
        if (density !== undefined && density < MIN_DENSITY) return null;
        return {
          ...common(id, title),
          url,
          format: 'EPT',
          coverage,
          verticalUnits: /US survey foot/i.test(wkt) ? 'us-ft' : /foot|feet/i.test(wkt) ? 'ft' : 'm',
          acquisitionStart: dateOnly(p.start_datetime),
          acquisitionEnd: dateOnly(p.end_datetime),
          densityM2: density,
        };
      }),
    );
    return found.filter((c): c is Candidate => c !== null);
  },
};
