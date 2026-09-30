import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { multiArea } from '../geometry/polygon';
import { cloneSettings, type ModelSettings } from '../settings';
import { HeightField } from '../terrain/heightfield';
import type { Ring } from '../types';
import { Progress, type Context } from './context';
import { buildLand } from './land';
import type { SourceData, SourceFeature } from './source';

const HALF = 35;
const CROP: Ring = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]];
const CENTER: [number, number] = [0.01, 45];

function context(patch?: (settings: ModelSettings) => void): Context {
  const settings = cloneSettings();
  patch?.(settings);
  return {
    settings,
    projection: new Projection(CENTER, 0, settings.scale.mmPerMetre),
    crop: [CROP],
    cropSet: [[CROP]],
    cropBox: [-HALF, -HALF, HALF, HALF],
    bounds: { west: 0, south: 44.99, east: 0.02, north: 45.01 },
    heightfield: HeightField.flat([-HALF - 2, -HALF - 2, HALF + 2, HALF + 2], 64, 0),
    stats: {},
    warnings: [],
    progress: new Progress(),
  };
}

/** A square around the model's centre, `half` degrees each way. */
function square(half: number, props: Record<string, unknown>): SourceFeature {
  const [lon, lat] = CENTER;
  const ring = [[lon - half, lat - half], [lon + half, lat - half], [lon + half, lat + half], [lon - half, lat + half], [lon - half, lat - half]];
  return { id: `square ${half}`, props, geometry: { type: 'Polygon', coordinates: [ring] } };
}

const detailed = { cartography: { min_zoom: 8, max_zoom: 15 } };
const coarse = { cartography: { min_zoom: 0, max_zoom: 7 } };
const cropArea = (2 * HALF) ** 2;

async function land(features: SourceData['features'], patch?: (settings: ModelSettings) => void) {
  return buildLand({ release: 'test', features }, context(patch), { water: [], roads: [], buildings: [], bridgeLines: [] });
}

describe('buildLand', () => {
  it('leaves satellite land cover out unless asked for', async () => {
    const cover = { land_cover: [square(0.008, { subtype: 'forest', ...detailed })] };
    expect((await land(cover)).forest).toEqual([]);
    const on = await land(cover, (s) => (s.land.satelliteCover = true));
    expect(multiArea(on.forest)).toBeGreaterThan(0.99 * cropArea);
  });

  it('takes detailed land cover by zoom whatever its size, and never the coarse level', async () => {
    const on = (s: ModelSettings) => (s.land.satelliteCover = true);
    // A zoom 10 tile is nearly 300 times the selection here.
    const tile = await land({ land_cover: [square(0.17, { subtype: 'shrub', ...detailed })] }, on);
    expect(multiArea(tile.green)).toBeGreaterThan(0.99 * cropArea);
    const small = await land({ land_cover: [square(0.008, { subtype: 'forest', ...coarse })] }, on);
    expect(small.forest).toEqual([]);
    // With no zoom levels, only its size can tell.
    const unzoned = await land({ land_cover: [square(0.17, { subtype: 'forest' })] }, on);
    expect(multiArea(unzoned.forest)).toBeGreaterThan(0.99 * cropArea);
    expect((await land({ land_cover: [square(1, { subtype: 'forest' })] }, on)).forest).toEqual([]);
  });

  it('still skips mapped polygons far larger than the selection', async () => {
    const mapped = await land({ land: [square(0.008, { subtype: 'forest', class: 'forest' })] });
    expect(multiArea(mapped.forest)).toBeGreaterThan(0.99 * cropArea);
    const regional = await land({ land_use: [square(0.17, { subtype: 'park', class: 'park' })] });
    expect(regional.green).toEqual([]);
  });
});
