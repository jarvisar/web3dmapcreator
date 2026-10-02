// The Intendencia de Montevideo's 2024 survey of the whole department: 870
// sheets of about 0.9 x 0.8 km as LAZ, 118-182 MB each, about 22 returns per
// m² with buildings classified. Heights are on EGM2008.
//
// The GeoServer WFS has CORS. The files are Alfresco share links without
// it, so they go through the proxy, which only lets this survey's names
// through. The server refuses HEAD, which the proxy rule knows about.
//
// Class 9 is water made up at 0 m, points with no returns, which is fine
// for a LiDAR only model's water. 24 (about 5%, single weak returns around
// sea level, so probably the real returns off the water) and 120 (a few
// dozen noise points) aren't documented, and the default classes leave
// both out.

import { needsProxy, proxyAvailable } from '../../data/corsProxy';
import { geoPolygons, overlaps, ringBox, Surveys, type Feature, type Provider } from './common';

const WFS = 'https://montevideo.gub.uy/app/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=mapstore-tematicas:fa_sig_lidar2024_v4&outputFormat=application/json&srsName=EPSG:4326';
const MAX_SHEETS = 1000;

export const montevideo: Provider = {
  id: 'montevideo',
  name: 'Intendencia de Montevideo',
  areas: [[-56.45, -34.95, -56, -34.7]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    // WFS 1.1 with a lat/lon box found nothing, so 1.0 and lon, lat.
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    const answer = (await fetcher.json(`${WFS}&maxFeatures=${MAX_SHEETS}&bbox=${box},EPSG:4326`)) as { type?: string; features?: Feature[]; totalFeatures?: number };
    if (answer.type !== 'FeatureCollection' || !Array.isArray(answer.features)) throw new Error('Catalog returned no FeatureCollection');
    if (answer.features.length < (answer.totalFeatures ?? 0)) throw new Error('The area covers too many Montevideo sheets');
    const surveys = new Surveys();
    for (const feature of answer.features) {
      const url = String(feature.properties.enlace_lid ?? '').trim();
      const coverage = geoPolygons(feature.geometry);
      // A link the proxy wouldn't pass can't be read in a browser.
      if (!needsProxy(url) || !coverage.length) continue;
      const tileBox = ringBox(coverage.flat());
      if (!overlaps(tileBox, bbox)) continue;
      surveys.add(
        '2024',
        () => ({
          provider: 'Intendencia de Montevideo',
          id: 'lidar-2024',
          name: 'Montevideo 2024',
          url: 'https://montevideo.gub.uy/app/geoserver/mapstore-tematicas/fa_sig_lidar2024_v4#2024',
          format: 'LAZ',
          verticalUnits: 'm',
          acquisitionStart: '2024-01-01',
          acquisitionEnd: '2024-12-31',
          license: 'Licencia de Datos Abiertos de Uruguay',
          attribution: 'Intendencia de Montevideo',
          sourcePage: 'https://catalogodatos.gub.uy/dataset/grilla-de-desacarga-de-lidar-2024',
          authoritative: true,
          projectYearHint: 2024,
        }),
        { url, bbox: tileBox, horizontalCrs: 'EPSG:5382' },
        coverage,
      );
    }
    return surveys.list();
  },
};
