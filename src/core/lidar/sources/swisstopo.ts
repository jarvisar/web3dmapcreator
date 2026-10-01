// swisstopo swissSURFACE3D: COPC tiles from its STAC collection, one survey per edition.

import { projectYear } from '../selection';
import { dateOnly, geoPolygons, ringBox, Surveys, type Provider } from './common';

const SWISSTOPO = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d';

export const swisstopo: Provider = {
  id: 'swisstopo',
  name: 'swisstopo',
  areas: [[5.9, 45.8, 10.6, 47.9]],
  async discover(fetcher, bbox) {
    const surveys = new Surveys();
    let next: string | null = `${SWISSTOPO}/items?bbox=${[bbox.west, bbox.south, bbox.east, bbox.north].join(',')}&limit=100`;
    for (let pages = 0; next && pages < 64; pages++) {
      const document = (await fetcher.json(next)) as { features?: { properties?: Record<string, unknown>; geometry: { type: string; coordinates: unknown }; assets?: Record<string, { href: string }> }[]; links?: { rel: string; href: string }[] };
      for (const item of document.features ?? []) {
        // Only the COPC editions (from 2024); older ones are ZIPs of one plain LAS.
        const asset = Object.values(item.assets ?? {}).find((a) => /\.copc\.laz$/i.test(a.href));
        if (!asset) continue;
        const coverage = geoPolygons(item.geometry);
        const date = dateOnly(item.properties?.datetime) ?? dateOnly(item.properties?.start_datetime);
        const year = date?.slice(0, 4) ?? projectYear(asset.href)?.toString() ?? 'unknown';
        surveys.add(
          year,
          () => ({
            provider: 'swisstopo',
            id: year,
            name: `swisstopo swissSURFACE3D ${year}`,
            url: `${SWISSTOPO}#edition=${year}`,
            format: 'COPC',
            // Headers carry only EPSG:2056; LN02 heights are metres (EPSG:5728).
            verticalUnits: 'm',
            acquisitionStart: dateOnly(item.properties?.start_datetime) ?? date,
            acquisitionEnd: dateOnly(item.properties?.end_datetime) ?? date,
            license: 'swisstopo open government data terms',
            attribution: 'swisstopo',
            sourcePage: SWISSTOPO,
            authoritative: true,
            projectYearHint: Number(year) || null,
          }),
          { url: asset.href, bbox: ringBox(coverage.flat()), horizontalCrs: 'EPSG:2056' },
          coverage,
        );
      }
      next = document.links?.find((l) => l.rel === 'next')?.href ?? null;
    }
    return surveys.list();
  },
};
