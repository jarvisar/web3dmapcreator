// NRCan CanElevation: project COPC tiles found through its ArcGIS tile index.

import { projectYear } from '../selection';
import { geoPolygons, pagedFeatures, ringBox, Surveys, type Provider } from './common';

const NRCAN = 'https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/lidar_point_cloud_canelevation_en/MapServer/1/query';

/** The collection end in NRCan's documented file names; never a start date. */
function collectionEnd(url: string): string | undefined {
  const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
  const match = /^[A-Z]{2}_.+_(\d{4})(\d{2})(\d{2})_NAD83CSRS_UTMZ?\d{1,2}_\d+(?:km|m)_E\d+_N\d+_.+\.copc\.laz$/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

export const nrcan: Provider = {
  id: 'nrcan',
  name: 'NRCan',
  areas: [[-141.1, 41.6, -52.5, 83.2]],
  // Its tile index has taken up to two minutes to answer a small query.
  timeoutMs: 180_000,
  async discover(fetcher, bbox) {
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    const rows = await pagedFeatures(
      fetcher,
      (offset, count) =>
        `${NRCAN}?f=geojson&where=1%3D1&geometry=${box}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&resultOffset=${offset}&resultRecordCount=${count}&orderByFields=OBJECTID`,
    );
    const surveys = new Surveys();
    for (const row of rows) {
      const p = row.properties;
      const url = String(p.url ?? '');
      if (!url.includes('.copc.')) continue;
      const coverage = geoPolygons(row.geometry);
      if (!coverage.length) continue;
      const key = `${p.provider}/${p.project}`;
      surveys.add(
        key,
        () => ({
          provider: 'NRCan',
          id: key,
          name: `CanElevation ${p.project}`,
          url: `https://open.canada.ca/data/en/dataset/7069387e-9986-4297-9f55-0288e9676947#survey=${key}`,
          format: 'COPC',
          verticalUnits: 'm',
          acquisitionEnd: collectionEnd(url),
          license: 'Open Government Licence - Canada',
          attribution: 'NRCan and the tile source organization',
          sourcePage: 'https://open.canada.ca/data/en/dataset/7069387e-9986-4297-9f55-0288e9676947',
          authoritative: true,
          projectYearHint: projectYear(String(p.project)),
        }),
        { url, bbox: ringBox(coverage.flat()) },
        coverage,
      );
    }
    return surveys.list();
  },
};
