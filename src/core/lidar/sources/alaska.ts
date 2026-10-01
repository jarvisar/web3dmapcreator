// Alaska DNR's 2023-2025 surveys of small communities, as COPC on NUVIEW's
// open data bucket: Seward, Skagway, Talkeetna, Hyder, Nenana, Galena, McGrath,
// the Copper River, Valdez Glacier and about 25 villages. USGS's EPT mirror has
// nothing at most of them, and nothing after 2011 at Talkeetna.
// About 6 to 26 returns per m². Buildings aren't classified (they're in 1),
// and 21 is snow.
//
// There's no index. Tiles are 750 m quarters of a 1500 m UTM grid named after
// its column and row (UTM6_0164_0783_2_2023: quarter 1 is north-west, 2
// north-east, 3 south-west, 4 south-east), so listing a column's prefix says
// which exist. The folders below came from a listing of the bucket in October
// 2026, each one project in one zone.

import type { Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { keyPath, overlaps, ringBox, s3Keys, squarePolygon, type Box, type Candidate, type Provider, type Tile } from './common';

const BUCKET = 'https://nuview-state-opendata.s3.amazonaws.com/';
const ROOT = 'ak_alaska_pointcloud/';
const X0 = 98500;
const Y0 = 5499250;
const TILE = 1500;

// Folder, file name prefix, UTM zone, year, lon/lat box, name.
const PROJECTS: [string, string, number, number, Box, string][] = [
  ['soa_augustine_augustine/point_cloud/tilecls/orthometric/utm_zone_5/', 'utm05_', 5, 2025, [-153.59, 59.32, -153.33, 59.43], 'Augustine Island'],
  ['soa_copper_river_copper_river/point_cloud/tilecls/Orthometric/utm_zone_06/', 'UTM6_', 6, 2024, [-146.35, 60.17, -144.52, 60.71], 'Copper River'],
  ['soa_fema_fairbanks_arctic_village/point_cloud/tilecls/orthometric/utm_zone_06/', 'UTM6_', 6, 2024, [-145.65, 68.08, -145.44, 68.15], 'Arctic Village'],
  ['soa_fema_fairbanks_beaver/point_cloud/tilecls/orthometric/utm_zone_06/', 'UTM6_', 6, 2024, [-147.48, 66.35, -147.37, 66.39], 'Beaver'],
  ['soa_fema_fairbanks_chalkyitsik/point_cloud/tilecls/orthometric/utm_zone_07/', 'UTM7_', 7, 2024, [-143.82, 66.61, -143.62, 66.69], 'Chalkyitsik'],
  ['soa_fema_fairbanks_circle/point_cloud/tilecls/orthometric/utm_zone_06/', 'UTM6_', 6, 2024, [-144.19, 65.77, -144.02, 65.85], 'Circle'],
  ['soa_fema_fairbanks_eagle_and_eagle_village/point_cloud/tilecls/orthometric/utm_zone_07/', 'UTM7_', 7, 2024, [-141.29, 64.72, -141.04, 64.81], 'Eagle'],
  ['soa_fema_fairbanks_manley_hot_springs/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-150.7, 64.96, -150.52, 65.04], 'Manley Hot Springs'],
  ['soa_fema_fairbanks_nenana/point_cloud/tilecls/orthometric/utm_zone_06/', 'UTM6_', 6, 2024, [-149.19, 64.49, -149.02, 64.63], 'Nenana'],
  ['soa_fema_fairbanks_rampart/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-150.2, 65.46, -150.04, 65.53], 'Rampart'],
  ['soa_fema_fairbanks_stevens_village/point_cloud/tilecls/orthometric/utm_zone_06/', 'UTM6_', 6, 2024, [-149.17, 65.99, -148.97, 66.06], 'Stevens Village'],
  ['soa_fema_fairbanks_tanana/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-152.29, 65.17, -151.93, 65.21], 'Tanana'],
  ['soa_fema_fairbanks_venetie/point_cloud/tilecls/orthometric/utm_zone_06/', 'UTM6_', 6, 2024, [-146.52, 66.98, -146.26, 67.06], 'Venetie'],
  ['soa_fema_hyder_hyder/point_cloud/tilecls/UTM9_orthometric/', 'UTM9_', 9, 2024, [-130.28, 55.8, -130.0, 56.12], 'Hyder'],
  ['soa_fema_kotzebue_kiana/point_cloud/tilecls/utm_zone_04/Kiana/', 'UTM4_', 4, 2023, [-160.5, 66.95, -160.31, 67.02], 'Kiana'],
  ['soa_fema_kotzebue_noatak/point_cloud/tilecls/utm_zone_03/', 'UTM3_', 3, 2023, [-163.05, 67.54, -162.92, 67.61], 'Noatak'],
  ['soa_fema_kotzebue_noorvik/point_cloud/tilecls/utm_zone_04/Noorvik/', 'UTM4_', 4, 2023, [-161.11, 66.79, -160.76, 66.85], 'Noorvik'],
  ['soa_fema_kotzebue_selawik/point_cloud/tilecls/utm_zone_04/Selawik/', 'UTM4_', 4, 2023, [-160.09, 66.58, -159.95, 66.62], 'Selawik'],
  ['soa_fema_kotzebue_shungnak/point_cloud/tilecls/utm_zone_04/Shungnak/', 'UTM4_', 4, 2023, [-157.23, 66.86, -157.05, 66.92], 'Shungnak'],
  ['soa_fema_seward_seward/point_cloud/tilecls/orthometric/utm_zone_06/', 'UTM6_', 6, 2023, [-149.79, 59.91, -149.11, 60.29], 'Seward'],
  ['soa_fema_skagway_skagway/point_cloud/tilecls/Orthometric/utm_zone_08/', 'UTM8_', 8, 2024, [-135.62, 59.19, -135.02, 59.8], 'Skagway'],
  ['soa_fema_talkeetna_talkeetna/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-150.21, 62.26, -150.0, 62.36], 'Talkeetna'],
  ['soa_fema_unalakleet_allakaket_new_allakaket_and_alatna/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-152.8, 66.49, -152.52, 66.59], 'Allakaket and Alatna'],
  ['soa_fema_unalakleet_anvik/point_cloud/tilecls/orthometric/utm_zone_04/', 'UTM4_', 4, 2024, [-160.25, 62.62, -160.16, 62.67], 'Anvik'],
  ['soa_fema_unalakleet_evansville_and_bettles/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-151.62, 66.86, -151.39, 66.95], 'Evansville and Bettles'],
  ['soa_fema_unalakleet_galena/point_cloud/tilecls/orthometric/utm_zone_04/', 'UTM4_', 4, 2024, [-157.02, 64.67, -156.52, 64.82], 'Galena'],
  ['soa_fema_unalakleet_grayling/point_cloud/tilecls/orthometric/utm_zone_04/', 'UTM4_', 4, 2024, [-160.13, 62.86, -160.04, 62.95], 'Grayling'],
  ['soa_fema_unalakleet_hughes/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-154.28, 66.0, -154.06, 66.06], 'Hughes'],
  ['soa_fema_unalakleet_huslia/point_cloud/tilecls/orthometric/utm_zone_04/', 'UTM4_', 4, 2024, [-156.44, 65.66, -156.24, 65.73], 'Huslia'],
  ['soa_fema_unalakleet_kaltag_fault_north/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-155.66, 64.76, -154.06, 65.04], 'Kaltag Fault north'],
  ['soa_fema_unalakleet_kaltag_fault_south/point_cloud/tilecls/orthometric/utm_zone_04/', 'UTM4_', 4, 2024, [-157.67, 64.44, -156.75, 64.61], 'Kaltag Fault south'],
  ['soa_fema_unalakleet_koyukuk/point_cloud/tilecls/orthometric/utm_zone_04/', 'UTM4_', 4, 2024, [-157.93, 64.86, -157.59, 64.94], 'Koyukuk'],
  ['soa_fema_unalakleet_nikolai/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-154.43, 62.99, -154.29, 63.05], 'Nikolai'],
  ['soa_fema_unalakleet_nulato/point_cloud/tilecls/orthometric/utm_zone_04/', 'UTM4_', 4, 2024, [-158.23, 64.7, -158.01, 64.78], 'Nulato'],
  ['soa_fema_unalakleet_ruby/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-155.63, 64.68, -155.37, 64.76], 'Ruby'],
  ['soa_fema_unalakleet_shageluk/point_cloud/tilecls/orthometric/utm_zone_04/', 'UTM4_', 4, 2024, [-159.59, 62.62, -159.46, 62.7], 'Shageluk'],
  ['soa_fema_unalakleet_takotna_and_mcgrath/point_cloud/tilecls/orthometric/utm_zone_05/', 'UTM5_', 5, 2024, [-156.22, 62.82, -155.36, 63.03], 'Takotna and McGrath'],
  ['soa_valdez_glacier_valdez/point_cloud/tilecls/orthometric/utm_zone_06/', 'UTM6_', 6, 2024, [-146.33, 61.15, -145.9, 61.34], 'Valdez Glacier'],
];

const pad = (n: number) => String(n).padStart(4, '0');

export const alaska: Provider = {
  id: 'alaska',
  name: 'Alaska DNR',
  areas: PROJECTS.map((p) => p[4]),
  async discover(fetcher, bbox) {
    const out: Candidate[] = [];
    for (const [folder, prefix, zone, year, box, name] of PROJECTS) {
      if (!overlaps(box, bbox)) continue;
      // NAD83(2011) UTM, NAVD88 metres.
      const epsg = 6329 + zone;
      const { toLonLat, fromLonLat } = lonLatTransforms(crsFromEpsg(epsg));
      const corners = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.west, bbox.north), fromLonLat(bbox.east, bbox.north)];
      const columns: number[] = [];
      const xs = corners.map((c) => Math.floor((c[0] - X0) / TILE));
      for (let c = Math.min(...xs); c <= Math.max(...xs); c++) columns.push(c);
      if (columns.length > 20) throw new Error('The area covers too many tiles of this survey');
      const listed = new Map<string, number>();
      await Promise.all(
        columns.map(async (column) => {
          for (const [key, { size }] of await s3Keys(fetcher, BUCKET, `${ROOT}${folder}${prefix}${pad(column)}_`, 2)) listed.set(key, size);
        }),
      );
      const tiles: Tile[] = [];
      const coverage: Polygon[] = [];
      for (const [key, size] of listed) {
        const match = /_(\d{4})_(\d{4})_([1-4])_\d{4}\.copc\.laz$/.exec(key);
        if (!match) continue;
        const q = Number(match[3]);
        const x = X0 + Number(match[1]) * TILE + (q === 2 || q === 4 ? TILE / 2 : 0);
        const y = Y0 + Number(match[2]) * TILE + (q <= 2 ? TILE / 2 : 0);
        const square = squarePolygon(toLonLat, x, y, TILE / 2);
        const tileBox = ringBox(square);
        if (!overlaps(tileBox, bbox)) continue;
        tiles.push({ url: `${BUCKET}${keyPath(key)}`, bbox: tileBox, horizontalCrs: `EPSG:${epsg}`, size });
        coverage.push(square);
      }
      if (!tiles.length) continue;
      out.push({
        provider: 'Alaska DNR',
        id: folder.split('/')[0],
        name: `Alaska ${name} ${year}`,
        url: `${BUCKET}${ROOT}${folder}`,
        format: 'COPC',
        coverage,
        tiles,
        verticalUnits: 'm',
        acquisitionStart: `${year}-01-01`,
        acquisitionEnd: `${year}-12-31`,
        license: 'Public, no licence named',
        attribution: 'Alaska Department of Natural Resources, Division of Geological & Geophysical Surveys',
        sourcePage: 'https://elevation.alaska.gov/',
        authoritative: true,
        projectYearHint: year,
      });
    }
    return out;
  },
};
