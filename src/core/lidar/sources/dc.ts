// DC's 2024 QL1 survey (Office of the Chief Technology Officer), served from
// a LAS mosaic dataset on its ArcGIS ImageServer: about 15 returns per m²,
// buildings classified, against 8 in NOAA's 2020 and 2022 copies of the
// earlier city surveys. Tiles are 800 m squares of uncompressed LAS, 160 to
// 440 MB, and the file endpoint ignores Range, so each is downloaded whole.
//
// Around the White House (about 500 m across, Treasury and the Eisenhower
// building included) only ground and water are left, so it comes out flat.
// NOAA's copies of the 2020 and 2022 surveys are cut the same way.

import type { Polygon, Ring } from '../../types';
import { overlaps, ringBox, sphericalArea, type Provider, type Tile } from './common';

const SERVER = 'https://imagery.dcgis.dc.gov/dcgis/rest/services/Lidar/Classified_LAS_2024/ImageServer';

interface Raster {
  attributes: { OBJECTID: number; Name: string; PointCount?: number };
  geometry?: { rings?: number[][][] };
}

export const dc: Provider = {
  id: 'dc',
  name: 'DC Office of the Chief Technology Officer',
  areas: [[-77.13, 38.78, -76.9, 39.0]],
  async discover(fetcher, bbox) {
    const box = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    // Category 1 are the tiles, the rest overviews. The whole city is 328 tiles,
    // under the server's 1000, and the service only answers Esri JSON.
    const answer = (await fetcher.json(
      `${SERVER}/query?where=Category%3D1&geometry=${box}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=OBJECTID,Name,PointCount&returnGeometry=true&outSR=4326&f=json`,
    )) as { features?: Raster[]; error?: { message?: string } };
    if (answer.error) throw new Error(`Catalog error: ${answer.error.message ?? 'unknown'}`);
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    let points = 0;
    for (const { attributes, geometry } of answer.features ?? []) {
      const rings = (geometry?.rings ?? []).map((ring) => ring.slice(0, -1).map(([x, y]) => [x, y] as [number, number]) as Ring);
      if (!rings.length || !/^\d+$/.test(attributes.Name)) continue;
      const tileBox = ringBox(rings);
      if (!overlaps(tileBox, bbox)) continue;
      const id = `.\\Lidar_2024\\LAS_Point_Cloud\\${attributes.Name}.las`;
      tiles.push({
        url: `${SERVER}/file?id=${encodeURIComponent(id)}&rasterId=${attributes.OBJECTID}`,
        bbox: tileBox,
        // 30-byte records (format 6) and a header of under 2 KB.
        size: attributes.PointCount ? attributes.PointCount * 30 : undefined,
        whole: true,
      });
      coverage.push([rings[0]]);
      points += attributes.PointCount ?? 0;
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'DC OCTO',
        id: 'classified-las-2024',
        name: 'District of Columbia 2024 (QL1)',
        url: `${SERVER}#2024`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        // Its tiles' headers can't be read by range, so their point counts stand in.
        densityM2: points ? points / sphericalArea(coverage) : undefined,
        acquisitionStart: '2024-03-01',
        acquisitionEnd: '2024-03-01',
        license: 'CC0 1.0',
        attribution: 'Office of the Chief Technology Officer, District of Columbia',
        sourcePage: 'https://opendata.dc.gov/datasets/8035c633024e49c29a3ee1206a474e7a',
        authoritative: true,
        projectYearHint: 2024,
      },
    ];
  },
};
