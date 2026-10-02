// Saarland's district ZIPs as the index: tiles from the members' names, and
// border tiles that two districts both hold.

import { zipSync } from 'fflate';
import proj4 from 'proj4';
import { afterEach, describe, expect, it } from 'vitest';
import { setCorsProxy } from '../../data/corsProxy';
import { setProjector } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { saarland } from './saarland';

setProjector((from, to) => proj4(from, to));
afterEach(() => setCorsProxy(null));

const tile = (district: string, e: number, n: number) => `LIDAR_laz_${district}/3dm_32_${e}_${n}_1_SL_2025_050.laz`;

describe('Saarland', () => {
  const zips: Record<string, Uint8Array> = {
    SB: zipSync({ [tile('SB', 354, 5455)]: new Uint8Array(30), [tile('SB', 360, 5460)]: new Uint8Array(10) }),
    NK: zipSync({ [tile('NK', 354, 5455)]: new Uint8Array(20) }),
  };
  const fetcher = {
    size: async (url: string) => (zips[/LIDAR_laz_(\w+?)_EPSG/.exec(url)![1]] ?? zipSync({})).length,
    range: async (url: string, start: number, end: number) => (zips[/LIDAR_laz_(\w+?)_EPSG/.exec(url)![1]] ?? zipSync({})).slice(start, end).buffer,
  } as unknown as Fetcher;
  const [lon, lat] = proj4('+proj=utm +zone=32 +ellps=GRS80 +units=m', 'EPSG:4326', [354500, 5455500]);
  const bbox = { west: lon - 0.001, south: lat - 0.001, east: lon + 0.001, north: lat + 0.001 };

  it('needs the proxy', async () => {
    expect(await saarland.discover(fetcher, bbox, [])).toEqual([]);
  });

  it("reads each km from whichever district's ZIP lists it first", async () => {
    setCorsProxy('direct');
    const [survey] = await saarland.discover(fetcher, bbox, []);
    expect(survey.projectYearHint).toBe(2025);
    expect(survey.tiles).toEqual([expect.objectContaining({ member: tile('NK', 354, 5455), horizontalCrs: 'EPSG:25832' })]);
  });
});
