// Illinois State Geological Survey's clearinghouse (Illinois Height
// Modernization): every county by year, 2006 to 2024, as plain LAS (LAZ from
// 2023), found through its ArcGIS tile layer. Most of it is the same flights
// USGS's EPT mirror holds. What it adds is Cook 2022 (about 100 returns per
// m², buildings classified, against 32 in 2017), Will 2021, McHenry 2022,
// Champaign-Urbana 2019 and the 2023-2024 counties.
//
// Cook 2022 tiles are uncompressed LAS of 1.7 to 2 GB per 2500 ft square, so a
// model of the Loop is offered as several GB.

import { geoPolygons, pagedFeatures, ringBox, Surveys, type Provider } from './common';

const LAYER = 'https://maps.isgs.illinois.edu/arcgis/rest/services/ILHMP/Lidar_Collections/MapServer/2/query';
// Before this they're QL3 (about 1 return per m²), and USGS has newer
// flights over the same counties.
const OLDEST = 2012;
// Files from before LAS 1.4 have GeoTIFF keys, some with a user-defined
// projection, so the index's zone stands in for them. Everything is in US feet.
const ZONES: Record<string, string> = { East: 'EPSG:3435', West: 'EPSG:3436' };
// Road surface (11) counts as ground, or downtown Chicago has almost none.
const CLASSES = { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '9': 'water', '11': 'ground', '17': 'bridge' };

export const illinois: Provider = {
  id: 'illinois',
  name: 'Illinois State Geological Survey',
  areas: [[-91.6, 36.9, -87.0, 42.6]],
  async discover(fetcher, bbox) {
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    const rows = await pagedFeatures(
      fetcher,
      (offset, count) =>
        `${LAYER}?f=geojson&where=1%3D1&geometry=${box}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=CollectionName,CollectionYear,TileURL,SPCS_Zone&returnGeometry=true&resultOffset=${offset}&resultRecordCount=${count}&orderByFields=OBJECTID`,
    );
    const surveys = new Surveys();
    for (const row of rows) {
      const p = row.properties;
      const url = String(p.TileURL ?? '');
      if (!/^https:\/\/.+\.la[sz]$/i.test(url)) continue;
      const years = String(p.CollectionYear ?? '').match(/(?:19|20)\d\d/g)?.map(Number) ?? [];
      if (!years.length || Math.max(...years) < OLDEST) continue;
      const coverage = geoPolygons(row.geometry);
      if (!coverage.length) continue;
      const name = String(p.CollectionName ?? '').replace(/^Champaign-city_cu$/, 'Champaign-Urbana');
      const first = Math.min(...years);
      const last = Math.max(...years);
      surveys.add(
        `${name} ${p.CollectionYear}`,
        () => ({
          provider: 'Illinois State Geological Survey',
          id: `${name} ${p.CollectionYear}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          name: `Illinois ${name} ${p.CollectionYear}`,
          url: `${LAYER}#${encodeURIComponent(`${name} ${p.CollectionYear}`)}`,
          format: 'LAZ',
          verticalUnits: 'us-ft',
          classification: CLASSES,
          acquisitionStart: `${first}-01-01`,
          acquisitionEnd: `${last}-12-31`,
          license: 'No restrictions',
          attribution: 'Illinois State Geological Survey, Illinois Height Modernization Program',
          sourcePage: 'https://clearinghouse.isgs.illinois.edu/data/elevation/illinois-height-modernization-ilhmp',
          authoritative: true,
          projectYearHint: first,
        }),
        { url, bbox: ringBox(coverage.flat()), horizontalCrs: ZONES[String(p.SPCS_Zone)] },
        coverage,
      );
    }
    return surveys.list();
  },
};
