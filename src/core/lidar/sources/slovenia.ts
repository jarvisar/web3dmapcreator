// Slovenia's cyclic survey (CLSS, GURS), 2023-2025, 16-30 points per m²: the
// EPT builds behind the official viewer at clss.si, one per batch of flights.
// A root's name isn't when it was flown (2024/ce holds 2023 flights too), and
// some tiles are in two roots. Each root's manifest has its 1 km source tiles,
// which give its outline and density. Flai mirrors 2023 and 2024 as COPC, but
// the 2025 roots (Koper, Nova Gorica, Postojna, Jesenice) are only here.
//
// The host is the contractor's (Flycom) and undocumented, so it may move.

import type { Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { overlaps, type Box, type Candidate, type Provider } from './common';

const BASE = 'https://assets.flycom.si/slovenia/lidar/clss/';
const ROOTS = ['2025/kp', '2025/ng', '2025/postojna', '2025/jesenice', '2024/ce', '2024/mb', '2024/ms', '2024/sg', '2023'];
const WEEK_MS = 7 * 24 * 3600 * 1000;

interface Source {
  bounds?: number[];
  points?: number;
}

export const slovenia: Provider = {
  id: 'slovenia',
  name: 'CLSS Slovenia',
  areas: [[13.3, 45.4, 16.7, 46.9]],
  async discover(fetcher, bbox, failures) {
    const { toLonLat, fromLonLat } = lonLatTransforms(crsFromEpsg(3794));
    const corners = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.east, bbox.north), fromLonLat(bbox.west, bbox.north)];
    const query: Box = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
    const touches = (b: number[]) => b[0] <= query[2] && b[3] >= query[0] && b[1] <= query[3] && b[4] >= query[1];
    const found = await Promise.all(
      ROOTS.map(async (root): Promise<Candidate | null> => {
        const url = `${BASE}${root}/ept.json`;
        try {
          const meta = (await fetcher.json(url, WEEK_MS)) as { boundsConforming?: number[] };
          if (!meta.boundsConforming || !touches(meta.boundsConforming)) return null;
          const manifest = (await fetcher.json(`${BASE}${root}/ept-sources/manifest.json`, WEEK_MS)) as Source[];
          const coverage: Polygon[] = [];
          let points = 0;
          let area = 0;
          for (const source of manifest) {
            const b = source.bounds;
            if (!b || b.length !== 6 || !touches(b)) continue;
            coverage.push([[toLonLat(b[0], b[1]), toLonLat(b[3], b[1]), toLonLat(b[3], b[4]), toLonLat(b[0], b[4])]]);
            points += source.points ?? 0;
            area += (b[3] - b[0]) * (b[4] - b[1]);
          }
          if (!coverage.length || !coverage.some((p) => overlaps([Math.min(...p[0].map((c) => c[0])), Math.min(...p[0].map((c) => c[1])), Math.max(...p[0].map((c) => c[0])), Math.max(...p[0].map((c) => c[1]))], bbox))) return null;
          const year = Number(root.slice(0, 4));
          return {
            provider: 'GURS',
            id: root,
            name: `Slovenia CLSS ${root}`,
            url,
            format: 'EPT',
            coverage,
            verticalUnits: 'm',
            // 7 is low points (ramps, stairs), not noise, and 8 smaller buildings.
            classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '7': 'unclassified', '8': 'building', '9': 'water', '17': 'bridge' },
            densityM2: points > 0 && area > 0 ? points / area : undefined,
            license: 'CC BY 4.0',
            attribution: 'Geodetska uprava Republike Slovenije, CLSS LiDAR',
            sourcePage: 'https://clss.si/',
            authoritative: true,
            projectYearHint: year,
          };
        } catch (error) {
          failures.push({ source: `Slovenia CLSS ${root}`, reason: (error as Error).message });
          return null;
        }
      }),
    );
    return found.filter((c): c is Candidate => c !== null);
  },
};
