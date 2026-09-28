// Live checks against Overture and the elevation tiles. Run with
// NETWORK=1 npx vitest run src/core/data/network.test.ts

import { describe, expect, it } from 'vitest';
import { fetchDem } from './dem';
import type { OvertureFeature } from './features';
import { fetchOverture, getLatestIndex } from './overture';

// About 830 m x 1.1 km of the Chicago Loop.
const LOOP = { west: -87.635, south: 41.875, east: -87.625, north: 41.885 };

function meets(feature: OvertureFeature): boolean {
  const [west, south, east, north] = feature.bbox;
  return west < LOOP.east && east > LOOP.west && south < LOOP.north && north > LOOP.south;
}

describe.skipIf(process.env.NETWORK !== '1')('live data', () => {
  it('finds the latest release and its index', async () => {
    const index = await getLatestIndex();
    expect(index.release).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    for (const type of ['building', 'building_part', 'segment', 'water', 'land', 'land_use', 'land_cover', 'infrastructure']) {
      expect(index.files.some((file) => file.type === type)).toBe(true);
    }
    expect(index.files.every((file) => file.href.startsWith('https://overturemaps-us-west-2.s3.'))).toBe(true);
  });

  it('downloads buildings, roads and water for the Chicago Loop', async () => {
    const started = performance.now();
    const data = await fetchOverture({ bounds: LOOP, types: ['building', 'segment', 'water'] });
    expect(data.warnings).toEqual([]);
    const seconds = (performance.now() - started) / 1000;
    console.log(
      `Overture ${data.release}: ${(data.bytes / 1e6).toFixed(1)} MB in ${seconds.toFixed(1)} s, ` +
        (['building', 'segment', 'water'] as const)
          .map((type) => `${type} ${data.features[type].length} (${(data.stats[type].bytes / 1e6).toFixed(1)} MB, ${data.stats[type].seconds.toFixed(1)} s)`)
          .join(', '),
    );

    const { building, segment, water } = data.features;
    expect(building.length).toBeGreaterThan(200);
    expect(segment.length).toBeGreaterThan(200);
    expect(water.length).toBeGreaterThan(0);
    for (const feature of [...building, ...segment, ...water]) expect(meets(feature)).toBe(true);
    expect(building.every((f) => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')).toBe(true);
    expect(segment.every((f) => f.geometry.type === 'LineString')).toBe(true);
    expect(new Set(building.map((f) => f.id)).size).toBe(building.length);
    expect(building.some((f) => typeof f.props.height === 'number')).toBe(true);
    expect(building.some((f) => typeof (f.props.names as { primary?: unknown } | undefined)?.primary === 'string')).toBe(true);
    expect(segment.every((f) => typeof f.props.subtype === 'string')).toBe(true);
    expect(segment.some((f) => Array.isArray(f.props.road_flags))).toBe(true);
    const [lon, lat] = (building[0].geometry as { coordinates: number[][][] }).coordinates[0][0];
    expect(lon).toBeCloseTo(-87.63, 1);
    expect(lat).toBeCloseTo(41.88, 1);
  }, 180000);

  it('downloads the elevation for the Chicago Loop', async () => {
    const started = performance.now();
    const dem = await fetchDem({ bounds: LOOP, targetSpacingM: 1100 / 192 });
    const seconds = (performance.now() - started) / 1000;
    console.log(
      `Elevation: zoom ${dem.zoom}, ${dem.tilesUsed} tiles, ${dem.min.toFixed(1)} to ${dem.max.toFixed(1)} m in ${seconds.toFixed(1)} s`,
    );
    expect(dem.zoom).toBe(15);
    expect(dem.tilesUsed).toBe(4);
    expect(dem.tilesMissing).toBe(0);
    // The Loop sits about 180 m above sea level.
    expect(dem.min).toBeGreaterThan(150);
    expect(dem.max).toBeLessThan(220);
    const middle = dem.sample(-87.63, 41.88);
    expect(middle).toBeGreaterThanOrEqual(dem.min);
    expect(middle).toBeLessThanOrEqual(dem.max);
  }, 60000);
});
