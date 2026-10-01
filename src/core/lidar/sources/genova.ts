// Comune di Genova's survey of 3-4 October 2018: uncompressed LAS 1.2 per
// 1:2000 sheet (about 1.7 x 1.4 km), 0.5 to 1.7 GB each, about 10 to 15
// returns per m² on land. There's no other open point cloud for Genoa. The
// files only carry GeoTIFF keys (RDN2008 / UTM 32N). 22 is undocumented and
// left out.

import { geoPolygons, overlaps, ringBox, Surveys, type Feature, type Provider } from './common';

const WFS = 'https://mappe.comune.genova.it/geoserver/wfs';
const FILES = 'https://mappe.comune.genova.it/gis/rilievo/LAS/';

export const genova: Provider = {
  id: 'genova',
  name: 'Comune di Genova',
  areas: [[8.6, 44.35, 9.15, 44.55]],
  async discover(fetcher, bbox) {
    // WFS 2.0 in EPSG:4326 takes its box as lat, lon. The layer can't page
    // (no primary key), but it's only 157 sheets.
    const box = [bbox.south, bbox.west, bbox.north, bbox.east].join(',');
    const answer = (await fetcher.json(
      `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=MEDIATORE:V_QU_LAS_DSM_DTM_1M_BUFFER10M&outputFormat=application/json&srsName=EPSG:4326&bbox=${box},urn:ogc:def:crs:EPSG::4326`,
    )) as { type?: string; features?: Feature[] };
    if (answer.type !== 'FeatureCollection') throw new Error('Catalog returned no FeatureCollection');
    const surveys = new Surveys();
    for (const row of answer.features ?? []) {
      const file = String(row.properties.LINK_LAS ?? '');
      if (!/^LAS\d+\.las$/i.test(file)) continue;
      const outline = geoPolygons(row.geometry);
      if (!outline.length) continue;
      const tileBox = ringBox(outline.flat());
      if (!overlaps(tileBox, bbox)) continue;
      surveys.add(
        '2018',
        () => ({
          provider: 'Comune di Genova',
          id: 'las-2018',
          name: 'Genova LAS aereo 2018',
          url: `${FILES}#2018`,
          format: 'LAZ',
          verticalUnits: 'm',
          classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building' },
          acquisitionStart: '2018-10-03',
          acquisitionEnd: '2018-10-04',
          license: 'CC BY 4.0',
          attribution: 'Comune di Genova',
          sourcePage: 'https://mappe.comune.genova.it/MapStore2/',
          authoritative: true,
          projectYearHint: 2018,
        }),
        { url: `${FILES}${file}`, bbox: tileBox, horizontalCrs: 'EPSG:7791' },
        outline,
      );
    }
    return surveys.list();
  },
};
