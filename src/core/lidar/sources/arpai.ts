// US DOT's ARPA-I INSIGHTS flights of June 2025 (MIT Lincoln Lab), on AWS:
// Geiger-mode lidar over Salt Lake City and Denver, about 135 and 75 returns
// per m². Downtown Salt Lake is 2013 in USGS's EPT mirror and its 2023 survey
// isn't readable, so this is the newest there by 12 years.
//
// Every return is class 0 and a single return, with no filtering of sensor
// noise ("version 0"). So it's only read for LiDAR only models, whose ground
// comes from the surface, never for measuring buildings.
//
// Each flight area is one COPC (70 GB for Salt Lake, 319 GB for Denver), read
// by range like an EPT. Their tiles fill these boxes, checked against the
// flights' tile indexes in October 2026. The highway corridors (I-15, I-25,
// I-70, I-80) fill 11-50% of theirs and are left out: a box would claim the
// ground beside the road.

import { overlaps, type Box, type Candidate, type Provider } from './common';

const DATA = 'https://arpa-i-insights.s3.amazonaws.com/lidar/v1/data/';
const AREAS: { id: string; name: string; box: Box; day: string }[] = [
  { id: 'SLC', name: 'Salt Lake City', box: [-111.9562, 40.7006, -111.8354, 40.7763], day: '2025-06-16' },
  { id: 'DRCOG', name: 'Denver', box: [-105.1716, 39.671, -104.9346, 39.9893], day: '2025-06-13' },
  { id: 'FrontRange', name: 'Front Range near Boulder', box: [-105.317, 39.874, -105.272, 39.992], day: '2025-06-13' },
];

const polygon = ([w, s, e, n]: Box) => [[[w, s], [e, s], [e, n], [w, n]] as [number, number][]];

export const arpai: Provider = {
  id: 'arpa-i',
  name: 'ARPA-I INSIGHTS',
  areas: AREAS.map((a) => a.box),
  async discover(_fetcher, bbox) {
    const out: Candidate[] = [];
    for (const area of AREAS) {
      if (!overlaps(area.box, bbox)) continue;
      const url = `${DATA}${area.id}/Dissemination/L3_unified_copc/${area.id}.copc.laz`;
      out.push({
        provider: 'ARPA-I INSIGHTS',
        id: area.id,
        name: `ARPA-I INSIGHTS ${area.name} 2025`,
        url,
        format: 'COPC',
        coverage: [polygon(area.box)],
        tiles: [{ url, bbox: area.box }],
        unclassified: true,
        verticalUnits: 'us-ft',
        acquisitionStart: area.day,
        acquisitionEnd: area.day,
        license: 'CC BY 4.0',
        attribution: 'US DOT ARPA-I INSIGHTS, MIT Lincoln Laboratory, CC BY 4.0',
        sourcePage: 'https://registry.opendata.aws/arpa-i-insights/',
        authoritative: true,
        projectYearHint: 2025,
      });
    }
    return out;
  },
};
