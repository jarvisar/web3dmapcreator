// GeoNB (New Brunswick): plain LAZ tiles of 1 km, one ArcGIS index layer per
// survey year. NRCan mirrors many of these as COPC, which ranks ahead on a
// tie. GeoNB adds the 2025 survey of the south (Moncton, Saint John) and the
// places NRCan never got.

import { projectYear } from '../selection';
import { geoPolygons, pagedFeatures, ringBox, Surveys, type Provider } from './common';

const INDEX = 'https://geonb.snb.ca/arcgis/rest/services/GeoNB_SNB_LidarIndex/MapServer';
// Index layers by survey: the ones under CGVD2013, then the older CGVD28 ones.
const LAYERS = [12, 11, 1, 2, 3, 4, 6, 7, 8, 9, 10];

/** A property whatever its case: field names differ between the layers. */
function field(properties: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(properties).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : properties[key];
}

export const geonb: Provider = {
  id: 'geonb',
  name: 'GeoNB',
  areas: [[-69.1, 44.5, -63.7, 48.1]],
  async discover(fetcher, bbox) {
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    const layers = await Promise.all(
      LAYERS.map((layer) =>
        pagedFeatures(
          fetcher,
          (offset, count) =>
            `${INDEX}/${layer}/query?f=geojson&where=1%3D1&geometry=${box}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&resultOffset=${offset}&resultRecordCount=${count}&orderByFields=OBJECTID`,
        ).then((rows) => ({ layer, rows })),
      ),
    );
    const surveys = new Surveys();
    for (const { layer, rows } of layers) {
      for (const row of rows) {
        const p = row.properties;
        const url = String(field(p, 'file_url') ?? '');
        if (!/^https:\/\/.+\.laz$/i.test(url)) continue;
        const coverage = geoPolygons(row.geometry);
        if (!coverage.length) continue;
        const year = Number(field(p, 'year')) || projectYear(url);
        surveys.add(
          String(layer),
          () => ({
            provider: 'GeoNB',
            id: `layer-${layer}`,
            name: `GeoNB LiDAR ${year ?? ''}`.trim(),
            url: `${INDEX}/${layer}#survey`,
            format: 'LAZ',
            verticalUnits: 'm',
            // No density: the index has the specification, which tiles beat, and
            // it would rank these whole-tile downloads ahead of NRCan's COPC of
            // the same survey.
            license: 'Open Government Licence - New Brunswick',
            attribution: 'Contains information licensed under the Open Government Licence - New Brunswick',
            sourcePage: 'https://geonb.snb.ca/',
            authoritative: true,
            projectYearHint: year,
          }),
          { url, bbox: ringBox(coverage.flat()), horizontalCrs: 'EPSG:2953' },
          coverage,
        );
      }
    }
    return surveys.list();
  },
};
