// The Municipality of Anchorage's 2025 survey (Dewberry), about 30 returns per
// m² against 5 in USGS's 2015 one. Plain LAZ of 2500 ft squares, 75 to 80 MB
// each, found through the city's ArcGIS layer, which answers cross-origin.
// The files don't, so they go through the proxy.
//
// The tiles carry an Esri WKT (Alaska zone 4, US feet) with NAVD88 heights in
// US feet, which reads as is. No building class, at least downtown: buildings
// are in 1 with everything else that isn't ground or vegetation.

import { proxyAvailable } from '../../data/corsProxy';
import { geoPolygons, overlaps, pagedFeatures, ringBox, Surveys, type Provider } from './common';

const LAYER = 'https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/LiDAR_Product_Links_2025_Hosted/FeatureServer/0/query';
const FILES = 'https://cdn.ancgis.com/datapublicstatic/Elevation2025/LiDAR_PointCloud/';

export const anchorage: Provider = {
  id: 'anchorage',
  name: 'Municipality of Anchorage',
  areas: [[-150.5, 60.7, -148.7, 61.5]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    const rows = await pagedFeatures(
      fetcher,
      (offset, count) =>
        `${LAYER}?f=geojson&where=1%3D1&geometry=${box}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=GRID_ID,URL_LiDAR_LAZ&returnGeometry=true&resultOffset=${offset}&resultRecordCount=${count}&orderByFields=OBJECTID`,
    );
    const surveys = new Surveys();
    for (const row of rows) {
      // The links are written with Windows separators after the host.
      const url = String(row.properties.URL_LiDAR_LAZ ?? '').replace(/\\/g, '/');
      const coverage = geoPolygons(row.geometry);
      if (!url.startsWith(FILES) || !/\.laz$/i.test(url) || !coverage.length) continue;
      const tileBox = ringBox(coverage.flat());
      if (!overlaps(tileBox, bbox)) continue;
      surveys.add(
        '2025',
        () => ({
          provider: 'Municipality of Anchorage',
          id: 'anchorage-2025',
          name: 'Anchorage 2025 (Municipality of Anchorage)',
          url: `${FILES}#2025`,
          format: 'LAZ',
          acquisitionStart: '2025-01-01',
          acquisitionEnd: '2025-12-31',
          license: 'MOA GIS Terms and Conditions of Use',
          attribution: 'Data provided courtesy of MOA',
          sourcePage: 'https://experience.arcgis.com/experience/6de90532ca314223b7a6d9bd286ee1d0',
          authoritative: true,
          projectYearHint: 2025,
        }),
        { url, bbox: tileBox },
        coverage,
      );
    }
    return surveys.list();
  },
};
