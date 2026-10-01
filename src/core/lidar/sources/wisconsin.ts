// WisconsinView (State Cartographer's Office) on UW-Madison's S3: county and
// city deliveries as plain LAS or LAZ, each with a GeoJSON tile index. There's
// no search by area, so only the datasets USGS's EPT mirror doesn't have yet
// are listed, with their boxes: the 2024 3DEP counties (Dane and Madison
// among them), the City of Madison's 2022 survey, Milwaukee's MMSD survey
// (about 80 returns per m², buildings classified, where NOAA's copy of the
// same flight has none) and three 2019 FEMA counties. The rest of the host is
// 2006-2023 data that USGS has too.
//
// Made in October 2026 by comparing every point cloud index on the host
// against USGS's catalog at nine tiles each. Add new deliveries here.

import type { Polygon } from '../../types';
import { geoPolygons, overlaps, ringBox, type Box, type Candidate, type Feature, type Provider, type Tile } from './common';

const INDEXES = 'https://web.s3.wisc.edu/rml-gisdata/indexes/';
const DATASETS: { index: string; name: string; year: number; box: Box }[] = [
  { index: 'Dane_Classified_LAS_USGS_2024', name: 'Dane County 2024', year: 2024, box: [-89.84, 42.84, -88.99, 43.3] },
  { index: 'CityofMadison_classified_LAS_City_2022', name: 'City of Madison 2022', year: 2022, box: [-89.59, 42.98, -89.2, 43.19] },
  { index: 'Milwaukee_MMSD_Classified_LAS_2020', name: 'Milwaukee MMSD 2020', year: 2020, box: [-88.08, 42.84, -87.82, 43.2] },
  { index: 'LaCrosse_Classified_LAS_USGS_2024', name: 'La Crosse County 2024', year: 2024, box: [-91.44, 43.7, -90.9, 44.1] },
  { index: 'Portage_Classified_LAS_USGS_2024', name: 'Portage County 2024', year: 2024, box: [-89.85, 44.24, -89.22, 44.69] },
  { index: 'Taylor_Classified_LAS_USGS_2024', name: 'Taylor County 2024', year: 2024, box: [-90.93, 45.03, -90.04, 45.39] },
  { index: 'Waushara_Classified_LAS_USGS_2024', name: 'Waushara County 2024', year: 2024, box: [-89.6, 43.98, -88.88, 44.25] },
  { index: 'Oconto_FEMA_LAS_2019', name: 'Oconto County 2019', year: 2019, box: [-88.72, 44.65, -87.72, 45.4] },
  { index: 'sheboygan-2019-ClassifiedPoints', name: 'Sheboygan County 2019', year: 2019, box: [-88.19, 43.52, -87.67, 43.92] },
  { index: 'barron_dunn-2019-ClassifiedPoints', name: 'Barron and Dunn Counties 2019', year: 2019, box: [-92.19, 44.66, -91.5, 45.66] },
  { index: 'forest-2017-ClassifiedPointsUSGS', name: 'Forest County 2017', year: 2017, box: [-89.05, 45.37, -88.42, 46.08] },
];

export const wisconsin: Provider = {
  id: 'wisconsin',
  name: 'WisconsinView',
  areas: DATASETS.map((d) => d.box),
  async discover(fetcher, bbox) {
    const out: Candidate[] = [];
    for (const dataset of DATASETS.filter((d) => overlaps(d.box, bbox))) {
      const index = (await fetcher.json(`${INDEXES}${dataset.index}.geojson`)) as { features?: Feature[] };
      const tiles: Tile[] = [];
      const coverage: Polygon[] = [];
      for (const feature of index.features ?? []) {
        const url = String(feature.properties.downloadUrl ?? '');
        if (!/^https:\/\/.+\.la[sz]$/i.test(url)) continue;
        const outline = geoPolygons(feature.geometry);
        if (!outline.length) continue;
        const box = ringBox(outline.flat());
        if (!overlaps(box, bbox)) continue;
        // Every file carries its CRS (state plane or a county WISCRS grid), most in an EVLR.
        tiles.push({ url, bbox: box });
        coverage.push(...outline);
      }
      if (!tiles.length) continue;
      out.push({
        provider: 'WisconsinView',
        id: dataset.index,
        name: `Wisconsin ${dataset.name}`,
        url: `${INDEXES}${dataset.index}.geojson`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'us-ft',
        acquisitionStart: `${dataset.year}-01-01`,
        acquisitionEnd: `${dataset.year}-12-31`,
        license: 'Public',
        attribution: "WisconsinView, Wisconsin State Cartographer's Office",
        sourcePage: 'https://www.sco.wisc.edu/data/elevationlidar/',
        authoritative: true,
        projectYearHint: dataset.year,
      });
    }
    return out;
  },
};
