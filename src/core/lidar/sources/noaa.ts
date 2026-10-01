// NOAA Digital Coast on AWS: EPT builds of NOAA's coastal surveys, found
// through its Data Access Viewer footprints and one STAC item per survey.
// Only asked about Hawaii and the territories: it adds American Samoa, Guam
// 2020, the Marianas and the 2019 Puerto Rico and Virgin Islands topobathy,
// which USGS's mirror lacks. On the mainland USGS already covers the coast.

import { projectYear } from '../selection';
import { dateOnly, geoPolygons, overlaps, pagedFeatures, ringBox, sphericalArea, type Candidate, type Provider } from './common';

const FOOTPRINTS = 'https://coast.noaa.gov/arcgis/rest/services/DAV/DAV_footprints/FeatureServer/0/query';
const BUCKET = 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/';
const MIN_DENSITY = 2;

interface StacItem {
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
  assets?: { ept?: { href?: string } };
}

export const noaa: Provider = {
  id: 'noaa',
  name: 'NOAA Digital Coast',
  areas: [
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
        let item: StacItem;
        try {
          item = (await fetcher.json(`${BUCKET}entwine/stac/DigitalCoast_mission_${id}.json`)) as StacItem;
        } catch (error) {
          // Most surveys have no EPT build, and their item is a 404.
          if (/HTTP 40[34]/.test((error as Error).message)) return null;
          failures.push({ source: `NOAA ${id}`, reason: (error as Error).message });
          return null;
        }
        const url = item.assets?.ept?.href ?? '';
        // A quarter point at USGS's bucket, which the USGS source already lists.
        if (!url.startsWith(BUCKET)) return null;
        const coverage = geoPolygons(item.geometry);
        if (!coverage.some((p) => overlaps(ringBox(p), bbox))) return null;
        const p = item.properties ?? {};
        const title = String(row.properties.title ?? `NOAA Digital Coast ${id}`);
        const wkt = String(p['proj:wkt2'] ?? '');
        const count = Number(p['pc:count']);
        const area = sphericalArea(coverage);
        const density = count > 0 && area > 0 ? count / area : undefined;
        // The early surveys (2000s USACE and NASA ATM) have under 2 returns
        // per m², no use for a building.
        if (density !== undefined && density < MIN_DENSITY) return null;
        return {
          provider: 'NOAA',
          id: String(id),
          name: title,
          url,
          format: 'EPT',
          coverage,
          verticalUnits: /US survey foot/i.test(wkt) ? 'us-ft' : /foot|feet/i.test(wkt) ? 'ft' : 'm',
          // Topobathy surveys file the water surface as 41 (40 and 42-45 are under or made up).
          classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '41': 'water' },
          acquisitionStart: dateOnly(p.start_datetime),
          acquisitionEnd: dateOnly(p.end_datetime),
          densityM2: density,
          license: 'Public domain (NOAA asks for attribution)',
          attribution: 'NOAA Office for Coastal Management, Digital Coast',
          sourcePage: `https://coast.noaa.gov/dataviewer/#/lidar/search/where:ID=${id}`,
          authoritative: true,
          projectYearHint: projectYear(title),
        };
      }),
    );
    return found.filter((c): c is Candidate => c !== null);
  },
};
