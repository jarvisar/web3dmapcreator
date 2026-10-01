// Saxony-Anhalt's survey of Halle (Saale), 2017 with one 2021 tile: the only
// part of the state's 3D-Messdaten that's open. Deflated LAZ of 2 km tiles, 210
// to 610 MB each, inside one 17 GB ZIP whose central directory (found from its
// end) is the tile index. About 12 to 14 returns per m², classified like NRW's:
// ground (2) and everything else (20), no buildings.

import type { Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { centralMembers } from '../read/zip';
import { overlaps, ringBox, Surveys, squarePolygon, type Provider } from './common';

const ZIP = 'https://www.geodatenportal.sachsen-anhalt.de/gfds_webshare/download/LVermGeo/Geodatenportal/externedaten/Gemeinde_HalleSaale.zip';

export const halle: Provider = {
  id: 'halle',
  name: 'LVermGeo Sachsen-Anhalt',
  areas: [[11.8, 51.38, 12.15, 51.58]],
  async discover(fetcher, bbox) {
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25832));
    const size = await fetcher.size(ZIP);
    const members = await centralMembers(async (start, end) => new Uint8Array(await fetcher.range(ZIP, start, end)), size);
    const surveys = new Surveys();
    for (const member of members) {
      const match = /3dm_32_(\d{3})_(\d{4})_2_st_(\d{4})\.laz$/i.exec(member.name);
      if (!match) continue;
      const square: Polygon = squarePolygon(toLonLat, Number(match[1]) * 1000, Number(match[2]) * 1000, 2000);
      const box = ringBox(square);
      if (!overlaps(box, bbox)) continue;
      const year = Number(match[3]);
      surveys.add(
        String(year),
        () => ({
          provider: 'LVermGeo Sachsen-Anhalt',
          id: `halle-${year}`,
          name: `Halle (Saale) 3D-Messdaten ${year}`,
          url: `${ZIP}#${year}`,
          format: 'LAZ',
          verticalUnits: 'm',
          classification: { '1': 'unclassified', '2': 'ground', '20': 'unclassified' },
          acquisitionStart: `${year}-01-01`,
          acquisitionEnd: `${year}-12-31`,
          license: 'Datenlizenz Deutschland - Namensnennung - Version 2.0',
          attribution: '© GeoBasis-DE / LVermGeo ST, dl-de/by-2-0',
          sourcePage: 'https://www.lvermgeo.sachsen-anhalt.de/de/gdp-open-data.html',
          authoritative: true,
          projectYearHint: year,
        }),
        { url: ZIP, member: member.name, size, bytes: member.compressedSize, bbox: box, horizontalCrs: 'EPSG:25832' },
        [square],
      );
    }
    return surveys.list();
  },
};
