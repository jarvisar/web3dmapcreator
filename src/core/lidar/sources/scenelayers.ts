// Surveys only published as Esri I3S point cloud scene layers, read with
// `read/i3s.ts`. Each is checked by hand: most public scene layers are demos,
// copies of surveys read elsewhere, split by class, or have no licence.
//
// - Northern Ireland's 2021 coastal survey (DAERA): the coast and about 200 m
//   inland, 28-31 returns per m². Reaches Belfast's harbour and the Titanic
//   Quarter, Holywood, Bangor, Carrickfergus and the north coast towns, not
//   Belfast's centre. 20 isn't ASPRS and is left out.
// - Christchurch 2020-21, about 84 per m² in the centre. OpenTopography has
//   the same flight as whole LAZ tiles, which this goes ahead of.
//
// A layer's outline comes from its nodes under the area, so the coastal one
// only claims the coast.

import type { Polygon } from '../../types';
import { sceneOutline } from '../read/i3s';
import { overlaps, type Box, type Candidate, type Provider } from './common';

interface Layer {
  id: string;
  name: string;
  url: string;
  area: Box;
  start: string;
  end: string;
  density: number;
  classification?: Record<string, string>;
  license: string;
  attribution: string;
  sourcePage: string;
}

const LAYERS: Layer[] = [
  {
    id: 'ni-coastal-2021',
    name: 'Northern Ireland 3D Coastal Survey 2021',
    url: 'https://tiles-eu1.arcgis.com/kswen6BYexuc1SUk/arcgis/rest/services/3D_Coastal_Survey_Full_NI_LAS/SceneServer/layers/0',
    area: [-8.2, 54.0, -5.4, 55.35],
    start: '2021-01-01',
    end: '2021-12-31',
    density: 30,
    // Road surface (11) counts as ground.
    classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '9': 'water', '11': 'ground', '17': 'bridge' },
    license: 'Open Government Licence v3.0',
    attribution: 'Contains public sector information licensed under the Open Government Licence v3.0. DAERA, Bluesky',
    sourcePage: 'https://www.arcgis.com/home/item.html?id=a8cc7cc1603443139e41b9c6ef5b67f1',
  },
  {
    id: 'christchurch-2021',
    name: 'Christchurch High Density LiDAR 2020-2021',
    url: 'https://tiles.arcgis.com/tiles/RNxkQaMWQcgbiF98/arcgis/rest/services/Christchurch_Topographic_Survey_LiDAR_High_Density_Scene_Layer/SceneServer/layers/0',
    area: [172.3, -43.8, 173.0, -43.35],
    start: '2020-12-18',
    end: '2021-02-17',
    density: 84,
    license: 'CC BY 4.0',
    attribution: 'Sourced from Canterbury Maps and partners and licensed for reuse under the CC BY 4.0 licence',
    sourcePage: 'https://www.arcgis.com/home/item.html?id=db87e0e10f8849f4ac97f32b8bc05097',
  },
];

const square = ([w, s, e, n]: Box): Polygon => [[[w, s], [e, s], [e, n], [w, n]]];

export const sceneLayers: Provider = {
  id: 'scene-layers',
  name: 'ArcGIS scene layers',
  areas: LAYERS.map((l) => l.area),
  async discover(fetcher, bbox, failures) {
    const out: Candidate[] = [];
    for (const layer of LAYERS) {
      if (!overlaps(layer.area, bbox)) continue;
      let boxes: Box[];
      try {
        boxes = await sceneOutline(fetcher, layer.url, bbox);
      } catch (error) {
        failures.push({ source: layer.name, reason: (error as Error).message, search: true });
        continue;
      }
      if (!boxes.length) continue;
      out.push({
        provider: 'ArcGIS scene layer',
        id: layer.id,
        name: layer.name,
        url: layer.url,
        format: 'I3S',
        coverage: boxes.map(square),
        verticalUnits: 'm',
        classification: layer.classification,
        acquisitionStart: layer.start,
        acquisitionEnd: layer.end,
        densityM2: layer.density,
        license: layer.license,
        attribution: layer.attribution,
        sourcePage: layer.sourcePage,
        authoritative: true,
        projectYearHint: Number(layer.end.slice(0, 4)),
      });
    }
    return out;
  },
};
