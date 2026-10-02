// USGS 3DEP through Hobu's EPT mirror: one boundaries catalog for every
// survey, each an ept.json on the public S3 bucket.

import { projectYear } from '../selection';
import type { Fetcher } from '../read/fetcher';
import { geoPolygons, overlaps, ringBox, sphericalArea, type Candidate, type Provider } from './common';

export const USGS_CATALOG = 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson';

// The catalog has no densities. An EPT's ept.json has its point count, so
// points over the outline's area stands in for one. It's an average over the
// whole outline: San Francisco's 2023 survey comes to 62 per m², and has 143
// downtown.
async function eptDensity(fetcher: Fetcher, candidate: Candidate): Promise<number | undefined> {
  try {
    const meta = (await fetcher.json(candidate.url)) as { points?: unknown };
    const area = sphericalArea(candidate.coverage);
    return typeof meta.points === 'number' && meta.points > 0 && area > 0 ? meta.points / area : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The year in a 3DEP work unit's name (CA_SanFrancisco_1_B23), which names
 * since 2020 carry instead of a year written out. Without it they ranked as
 * undated, behind every older survey. Their points were flown within a year
 * or two of it: B20 over Hawaii in 2023, C23 in North Dakota in 2021.
 */
export function workUnitYear(name: string): number | null {
  const match = /_[A-F](\d{2})$/.exec(name);
  return match ? 2000 + Number(match[1]) : null;
}

export const usgs: Provider = {
  id: 'usgs',
  name: 'USGS 3DEP',
  // NOAA's boxes, which held every outline in the catalog in October 2026
  // apart from UT_Ogden-FEMA_2011's, filed at 0° N 85° E. Without them the
  // 9 MB catalog was downloaded for areas anywhere.
  areas: [
    [-125.0, 24.4, -66.8, 49.5],
    [-180.0, 51.0, -129.9, 71.5],
    [-178.5, 18.5, -154.5, 28.6],
    [-68.0, 17.5, -64.4, 18.8],
    [144.4, 13.1, 146.2, 20.7],
    [-171.2, -14.7, -168.0, -10.9],
  ],
  async discover(fetcher, bbox) {
    const catalog = (await fetcher.json(USGS_CATALOG)) as { features: { properties: { name: string; url: string }; geometry: { type: string; coordinates: unknown } }[] };
    const out: Candidate[] = [];
    for (const feature of catalog.features) {
      const coverage = geoPolygons(feature.geometry);
      if (!coverage.length || !overlaps(ringBox(coverage.flat()), bbox)) continue;
      const { name, url } = feature.properties;
      if (!/^https:\/\//.test(url)) continue;
      out.push({
        provider: 'USGS',
        id: name,
        name,
        url,
        format: 'EPT',
        coverage,
        attribution: 'USGS 3DEP; EPT mirror by Hobu',
        license: 'Public domain',
        sourcePage: USGS_CATALOG,
        projectYearHint: projectYear(name) ?? workUnitYear(name),
      });
    }
    await Promise.all(out.map(async (candidate) => (candidate.densityM2 = await eptDensity(fetcher, candidate))));
    return out;
  },
};
