// Scotland: the Scottish Remote Sensing Portal's search API over its public
// bucket of 1 km LAZ tiles. Phases 1 and 3 to 6 (2011-2022) only separate
// ground from the rest at 2 to 4 points per m². The national programme
// (from 2025, classified buildings, about 20 per m²) is replacing them.
// Phase 2 and Historic Environment Scotland's sets are non-commercial and
// left out.

import { projectYear } from '../selection';
import { dateOnly, geoPolygons, ringBox, Surveys, type Provider } from './common';

const SEARCH = 'https://api.remotesensing.data.gov.scot/search/product';
const PAGE = 1000;

// Collection, name and when it was flown, newest first.
const COLLECTIONS: [string, string][] = [
  ['scotland-gov/lidar/coastal/coastal-2025-2026/laz', 'Scotland Coastal LiDAR 2025-2026'],
  ['scotland-gov/lidar/national-lidar-programme/laz', 'Scotland National LiDAR Programme'],
  ['scotland-gov/lidar/orkney-islands-council-23/laz', 'Orkney LiDAR 2023'],
  ['scotland-gov/lidar/outerheb-2019/laz/16ppm', 'Outer Hebrides LiDAR 2019 (16 ppm)'],
  ['scotland-gov/lidar/outerheb-2019/laz/4ppm', 'Outer Hebrides LiDAR 2019 (4 ppm)'],
  ['scotland-gov/lidar/phase-6/laz', 'Scotland LiDAR Phase 6'],
  ['scotland-gov/lidar/phase-5/laz', 'Scotland LiDAR Phase 5'],
  ['scotland-gov/lidar/phase-4/laz', 'Scotland LiDAR Phase 4'],
  ['scotland-gov/lidar/phase-3/laz', 'Scotland LiDAR Phase 3'],
  ['scotland-gov/lidar/phase-1/laz', 'Scotland LiDAR Phase 1'],
];

interface Product {
  collectionName?: string;
  metadata?: { temporalExtent?: { begin?: string; end?: string }; useConstraints?: string };
  data?: { product?: { http?: { url?: string; size?: number } } };
  footprint?: { type: string; coordinates: unknown };
}

/** The credit a collection asks for, out of its usage text. */
function credit(constraints: string): string {
  const asked = /attribution statement must be used[^:]*:\s*(.+?)(?:\.\s|$)/i.exec(constraints)?.[1]?.trim();
  return asked ? asked.replace(/\s+/g, ' ') : 'Scottish Government, Open Government Licence v3';
}

export const scotland: Provider = {
  id: 'scotland',
  name: 'Scottish Remote Sensing Portal',
  areas: [[-8.8, 54.5, -0.6, 61.0]],
  async discover(fetcher, bbox) {
    const { west: w, south: s, east: e, north: n } = bbox;
    const footprint = `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
    const products: Product[] = [];
    for (let offset = 0; offset < 10 * PAGE; offset += PAGE) {
      // "intersects": the portal's own default, "overlaps", drops tiles wholly inside the polygon.
      const body = JSON.stringify({ collections: COLLECTIONS.map(([id]) => id), footprint, spatialop: 'intersects', limit: PAGE, offset });
      const answer = (await fetcher.post(SEARCH, body)) as { result?: Product[] };
      if (!Array.isArray(answer.result)) throw new Error('The Scottish portal answered without results');
      products.push(...answer.result);
      if (answer.result.length < PAGE) break;
    }
    const surveys = new Surveys();
    for (const product of products) {
      const collection = COLLECTIONS.find(([id]) => id === product.collectionName);
      const url = product.data?.product?.http?.url ?? '';
      if (!collection || !/^https:\/\/.+\.laz$/i.test(url)) continue;
      const coverage = geoPolygons(product.footprint);
      if (!coverage.length) continue;
      // Some collections give begin and end the wrong way round.
      const dates = [dateOnly(product.metadata?.temporalExtent?.begin), dateOnly(product.metadata?.temporalExtent?.end)].filter((d): d is string => !!d).sort();
      const [id, name] = collection;
      surveys.add(
        id,
        () => ({
          provider: 'Scottish Government',
          id,
          name,
          url: `https://remotesensingdata.gov.scot/#${id}`,
          format: 'LAZ',
          // ODN metres. The phase 1-6 files have no CRS records at all.
          verticalUnits: 'm',
          acquisitionStart: dates[0],
          acquisitionEnd: dates.at(-1),
          license: 'Open Government Licence v3',
          attribution: credit(product.metadata?.useConstraints ?? ''),
          sourcePage: 'https://remotesensingdata.gov.scot/',
          authoritative: true,
          projectYearHint: projectYear(dates.at(-1) ?? name),
        }),
        { url, bbox: ringBox(coverage.flat()), horizontalCrs: 'EPSG:27700', size: product.data?.product?.http?.size },
        coverage,
      );
    }
    return surveys.list();
  },
};
