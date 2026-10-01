// IGN LiDAR HD: classified COPC tiles found through IGN's metadata WFS.

import { projectYear } from '../selection';
import { dateOnly, geoPolygons, pagedFeatures, ringBox, Surveys, type Provider } from './common';

const IGN_WFS = 'https://data.geopf.fr/wfs';

export const ign: Provider = {
  id: 'ign',
  name: 'IGN France',
  areas: [
    [-5.5, 41.2, 10.0, 51.3],
    [-63.2, 14.3, -60.7, 18.2],
    [-54.7, 2.0, -51.5, 6.0],
    [44.9, -21.5, 56.0, -12.5],
  ],
  async discover(fetcher, bbox) {
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    const rows = await pagedFeatures(
      fetcher,
      (offset, count) =>
        `${IGN_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=IGNF_LIDAR-HD_METADONNEE:metadata&outputFormat=application/json&srsName=CRS:84&bbox=${box},CRS:84&count=${count}&startIndex=${offset}`,
    );
    const surveys = new Surveys();
    for (const row of rows) {
      const p = row.properties;
      let url = typeof p.url_npl === 'string' ? p.url_npl : '';
      if (!url.includes('.copc.')) continue;
      // IGN publishes a range-enabled endpoint for the same file.
      url = url.replace('https://data.geopf.fr/telechargement/download/', 'https://data.geopf.fr/chunk/telechargement/download/');
      const coverage = geoPolygons(row.geometry);
      if (!coverage.length) continue;
      const project = String(p.code_mission ?? url.split('/').slice(-2, -1)[0]);
      surveys.add(
        project,
        () => ({
          provider: 'IGN France',
          id: project,
          name: `IGN LiDAR HD ${project}`,
          url: `https://geoservices.ign.fr/lidarhd#survey=${project}`,
          format: 'COPC',
          verticalUnits: 'm',
          // IGN's class 67 is an unconfirmed building: it is read as unclassified.
          classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '67': 'unclassified' },
          acquisitionStart: dateOnly(p.date_debut_acquisition),
          acquisitionEnd: dateOnly(p.date_fin_acquisition),
          classificationQuality: String(p.procede_classement ?? '').includes('MANUEL') ? 1 : 0.5,
          license: 'Licence Ouverte 2.0',
          attribution: 'IGN - LiDAR HD',
          sourcePage: 'https://geoservices.ign.fr/lidarhd',
          authoritative: true,
          projectYearHint: projectYear(project),
        }),
        { url, bbox: ringBox(coverage.flat()), horizontalCrs: p.systeme_planimetrique === 'LAMB93' ? 'EPSG:2154' : undefined },
        coverage,
      );
    }
    return surveys.list();
  },
};
