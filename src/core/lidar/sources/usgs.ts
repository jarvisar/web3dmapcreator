// USGS 3DEP through Hobu's EPT mirror: one boundaries catalog for every
// survey, each an ept.json on the public S3 bucket.

import { projectYear } from '../selection';
import type { Fetcher } from '../read/fetcher';
import { geoPolygons, overlaps, ringBox, sphericalArea, type Candidate, type Provider } from './common';

export const USGS_CATALOG = 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson';

// The catalog has no densities, and names alone put a sparse 2018 wildfire
// survey ahead of a 2023 one with ten times the returns over San Francisco.
// An EPT's ept.json has its point count, so points over the outline's area
// is its density, near enough.
async function eptDensity(fetcher: Fetcher, candidate: Candidate): Promise<number | undefined> {
  try {
    const meta = (await fetcher.json(candidate.url)) as { points?: unknown };
    const area = sphericalArea(candidate.coverage);
    return typeof meta.points === 'number' && meta.points > 0 && area > 0 ? meta.points / area : undefined;
  } catch {
    return undefined;
  }
}

export const usgs: Provider = {
  id: 'usgs',
  name: 'USGS 3DEP',
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
        projectYearHint: projectYear(name),
      });
    }
    await Promise.all(out.map(async (candidate) => (candidate.densityM2 = await eptDensity(fetcher, candidate))));
    return out;
  },
};
