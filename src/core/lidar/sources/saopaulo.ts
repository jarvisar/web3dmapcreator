// Sao Paulo's 2017 survey of the whole municipality, as the city publishes
// it on AWS: one EPT, so there's no catalog to ask. OpenTopography has the
// same flight as LAZ tiles, which this beats on format.

import type { Provider } from './common';

const EPT = 'https://ept-m3dc-pmsp.s3.sa-east-1.amazonaws.com/ept.json';
const AREA: [number, number, number, number] = [-46.83, -24.01, -46.36, -23.36];

export const saoPaulo: Provider = {
  id: 'pmsp',
  name: 'Sao Paulo (PMSP)',
  areas: [AREA],
  async discover() {
    const [w, s, e, n] = AREA;
    return [
      {
        provider: 'PMSP',
        id: 'm3dc-2017',
        name: 'Sao Paulo M3DC 2017',
        url: EPT,
        format: 'EPT',
        coverage: [[[[w, s], [e, s], [e, n], [w, n]]]],
        verticalUnits: 'm',
        // 19 and 20 aren't documented. Measured over the centre, 20 lies on
        // the ground and 19 is low clutter above it. 3 and 4 never occur.
        classification: { '1': 'unclassified', '2': 'ground', '5': 'high vegetation', '6': 'building', '19': 'unclassified', '20': 'ground' },
        acquisitionStart: '2017-05-01',
        acquisitionEnd: '2017-07-01',
        license: 'GNU GPL v3.0, as the city lists it',
        attribution: 'Prefeitura Municipal de Sao Paulo (PMSP) / GeoSampa',
        sourcePage: 'https://registry.opendata.aws/pmsp-lidar/',
        authoritative: true,
        projectYearHint: 2017,
      },
    ];
  },
};
