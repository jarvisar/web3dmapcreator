// Berlin (SenStadt), flown in February and March 2021, about 10-12 points
// per m²: nine district ZIPs of 1 to 50 GB, each holding deflated 1 km LAS
// tiles (about 200 MB compressed, 470 inflated). A tile is fetched whole and
// read as it inflates. Each ZIP's central directory (found from its end, so
// its size comes from a HEAD request) is the tile index. There's no building
// class: roofs are filed with the vegetation, so all of it reads as
// unclassified.

import type { Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { centralMembers } from '../read/zip';
import { overlaps, ringBox, squarePolygon, type Provider, type Tile } from './common';

const BASE = 'https://gdi.berlin.de/data/a_als/atom/';
const DISTRICTS = ['Mitte', 'Nord', 'Nordost', 'Nordwest', 'Ost', 'Sued', 'Suedost', 'Suedwest', 'West'];

export const berlin: Provider = {
  id: 'berlin',
  name: 'Geoportal Berlin',
  areas: [[13.05, 52.3, 13.8, 52.7]],
  async discover(fetcher, bbox) {
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25833));
    const lists = await Promise.all(
      DISTRICTS.map(async (district) => {
        const url = `${BASE}${district}.zip`;
        const size = await fetcher.size(url);
        const read = async (start: number, end: number) => new Uint8Array(await fetcher.range(url, start, end));
        return { url, size, members: await centralMembers(read, size) };
      }),
    );
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const { url, size, members } of lists) {
      for (const member of members) {
        const match = /3dm_33_(\d{3})_(\d{4})_1_be\.las$/i.exec(member.name);
        if (!match) continue;
        const square = squarePolygon(toLonLat, Number(match[1]) * 1000, Number(match[2]) * 1000, 1000);
        const box = ringBox(square);
        if (!overlaps(box, bbox)) continue;
        tiles.push({ url, member: member.name, size, bbox: box, horizontalCrs: 'EPSG:25833' });
        coverage.push(square);
      }
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'SenStadt Berlin',
        id: 'als-2021',
        name: 'Berlin ALS 2021',
        url: `${BASE}0.atom#2021`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        classification: { '0': 'unclassified', '1': 'unclassified', '2': 'ground', '3': 'unclassified', '4': 'unclassified', '5': 'unclassified' },
        acquisitionStart: '2021-02-24',
        acquisitionEnd: '2021-03-02',
        license: 'Datenlizenz Deutschland - Zero - Version 2.0',
        attribution: 'Geoportal Berlin / Airborne Laserscanning (ALS) 2021, dl-de/zero-2-0',
        sourcePage: 'https://gdi.berlin.de/data/a_als/atom/0.atom',
        authoritative: true,
        projectYearHint: 2021,
      },
    ];
  },
};
