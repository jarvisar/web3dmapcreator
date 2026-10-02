// Saarland's 2025 survey, the only open point cloud there (Saarbrücken was
// flown on 8 February 2025). Six district ZIPs of 12-26 GB on LVGL's
// Nextcloud, each holding a deflated LAZ per km of 26-46 MB, and their central
// directories are the index. The open copy is thinned to one point per 0.5 m
// square, about 4 per m², but buildings are classified. Tiles on a district
// border are in both districts' ZIPs.

import type { Polygon } from '../../types';
import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { centralMembers } from '../read/zip';
import { overlaps, ringBox, squarePolygon, type Provider, type Tile } from './common';

const SHARE = 'https://www.shop.lvgl.saarland.de/cloud/public.php/dav/files/NK8ndP55qAqGEZD/OD_LIDAR_Punktwolke_2025_laz_LK/';
const DISTRICTS = ['MZG', 'NK', 'SB', 'SLS', 'SPK', 'WND'];

export const saarland: Provider = {
  id: 'saarland',
  name: 'LVGL Saarland',
  areas: [[6.3, 49.1, 7.45, 49.65]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25832));
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    const seen = new Set<string>();
    const districts = await Promise.all(
      DISTRICTS.map(async (district) => {
        const url = `${SHARE}LIDAR_laz_${district}_EPSG-25832_Entstehung-2025.zip`;
        const size = await fetcher.size(url);
        return { url, size, members: await centralMembers(async (start, end) => new Uint8Array(await fetcher.range(url, start, end)), size) };
      }),
    );
    for (const { url, size, members } of districts) {
      for (const member of members) {
        const match = /3dm_32_(\d{3})_(\d{4})_1_SL_2025_050\.laz$/i.exec(member.name);
        if (!match || seen.has(match[0])) continue;
        const square = squarePolygon(toLonLat, Number(match[1]) * 1000, Number(match[2]) * 1000, 1000);
        const box = ringBox(square);
        if (!overlaps(box, bbox)) continue;
        seen.add(match[0]);
        tiles.push({ url, member: member.name, size, bytes: member.compressedSize, bbox: box, horizontalCrs: 'EPSG:25832' });
        coverage.push(square);
      }
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'LVGL Saarland',
        id: 'saarland-2025',
        name: 'Saarland LiDAR 2025',
        url: `${SHARE}#2025`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        // 20 is everything above ground that isn't a building, 24 synthetic ground.
        classification: { '1': 'unclassified', '2': 'ground', '6': 'building', '17': 'bridge', '20': 'unclassified' },
        acquisitionStart: '2025-01-01',
        acquisitionEnd: '2025-12-31',
        license: 'Datenlizenz Deutschland - Namensnennung - Version 2.0',
        attribution: '© GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0',
        sourcePage: 'https://geoportal.saarland.de/',
        authoritative: true,
        projectYearHint: 2025,
      },
    ];
  },
};
