// Routes on LiDAR only models: what they rest on along the way, and the
// model they're built into.

import { describe, expect, it } from 'vitest';
import { pointInPolygon } from '../geometry/polygon';
import type { PrismSolid } from '../geometry/solid';
import { edgeReport } from '../geometry/validate';
import { Projection } from '../geo/projection';
import { meshLayers } from '../pipeline/mesh';
import { cloneSettings, type AreaSpec } from '../settings';
import type { TrackLines } from '../tracks/track';
import type { LonLat, Polygon, Vec2 } from '../types';
import { compose } from './compose';
import { gridSpec } from './grid';
import { emptyLayers } from './layers';
import { surfaceModel } from './model';
import { ProfileIndex, routeProfile, type ProfileGrids } from './route';

const CELL = 0.5;
const NX = 240;
const NY = 21;
const GROUND = 2;

/** A strip of model, with the surface and bare ground given per column. */
function grids(surface: (i: number) => number, ground: (i: number) => number = () => GROUND, water: (i: number) => boolean = () => false): ProfileGrids {
  const values = (fn: (i: number) => number) => Float32Array.from({ length: NX * NY }, (_, k) => fn(k % NX));
  const grid = { minX: 0, minY: 0, step: CELL, cols: NX, rows: NY };
  return {
    surface: { ...grid, values: values(surface) },
    ground: { ...grid, values: values(ground) },
    water: Uint8Array.from({ length: NX * NY }, (_, k) => (water(k % NX) ? 1 : 0)),
    waterTop: null,
    through: null,
    building: new Uint8Array(NX * NY),
    // 2.5 m over the ground is 0.25 mm at this scale.
    mmPerMetre: 0.1,
    heightScale: 1,
    exaggeration: 1,
  };
}

const along: Vec2[] = [
  [0, 5],
  [(NX - 1) * CELL, 5],
];
const zAt = (profile: ReturnType<typeof routeProfile>, x: number) => {
  let best = 0;
  for (let k = 0; k < profile.x.length; k++) if (Math.abs(profile.x[k] - x) < Math.abs(profile.x[best] - x)) best = k;
  return profile.z[best];
};

describe('what a route rests on', () => {
  it('stays on the ground through a building it drifts into', () => {
    const block = (i: number) => i >= 40 && i < 60;
    const g = grids((i) => (block(i) ? GROUND + 5 : GROUND));
    g.building = Uint8Array.from({ length: NX * NY }, (_, k) => (block(k % NX) ? 1 : 0));
    const profile = routeProfile(along, g);
    expect(zAt(profile, 25)).toBeCloseTo(GROUND, 4);
    expect(zAt(profile, 15)).toBeCloseTo(GROUND, 4);
  });

  it('goes up a deck with ramps, and back down', () => {
    // Up 3 mm over 20 mm, along 10 mm, down again: a bridge's ramps and deck.
    const deck = (i: number) => (i < 100 ? 0 : i < 140 ? ((i - 100) / 40) * 3 : i < 160 ? 3 : i < 200 ? ((200 - i) / 40) * 3 : 0);
    const profile = routeProfile(along, grids((i) => GROUND + deck(i)));
    expect(zAt(profile, 75)).toBeCloseTo(GROUND + 3, 3);
    expect(zAt(profile, 65)).toBeCloseTo(GROUND + 2.25, 2);
    expect(zAt(profile, 30)).toBeCloseTo(GROUND, 4);
  });

  it('goes under an overpass rather than over it', () => {
    // A deck 30 m across and 3 mm up with sheer sides: the route passes under it.
    const profile = routeProfile(along, grids((i) => (i >= 120 && i < 126 ? GROUND + 3 : GROUND)));
    expect(zAt(profile, 61.5)).toBeCloseTo(GROUND, 4);
  });

  it('rests on water, on a water layer, or on nothing where it is cut through', () => {
    const wet = (i: number) => i >= 60 && i < 100;
    const recessed = routeProfile(along, grids((i) => (wet(i) ? GROUND - 0.6 : GROUND), undefined, wet));
    expect(zAt(recessed, 40)).toBeCloseTo(GROUND - 0.6, 4);
    const layer = grids((i) => (wet(i) ? GROUND - 1.5 : GROUND), undefined, wet);
    layer.waterTop = Float32Array.from({ length: NX * NY }, (_, k) => (wet(k % NX) ? GROUND - 0.25 : NaN));
    expect(zAt(routeProfile(along, layer), 40)).toBeCloseTo(GROUND - 0.25, 4);
    const cut = grids(() => GROUND, undefined, wet);
    cut.through = cut.water;
    expect(zAt(routeProfile(along, cut), 40)).toBeNaN();
  });

  it('keeps to a bridge deck when it drifts off the side over the water', () => {
    // A river under a deck, and a few cells where the recording is beside the deck, on the water.
    const deck = (i: number) => (i < 60 ? 0 : i < 100 ? ((i - 60) / 40) * 2 : i < 180 ? 2 : i < 220 ? ((220 - i) / 40) * 2 : 0);
    const off = (i: number) => i >= 130 && i < 134;
    const g = grids((i) => (off(i) ? GROUND - 0.6 : GROUND + deck(i)), () => GROUND, off);
    const profile = routeProfile(along, g);
    expect(zAt(profile, 66)).toBeCloseTo(GROUND + 2, 3);
  });

  it('rides on top of a long structure over the street that is not a building', () => {
    // An elevated railway 7 m up along 60 m of the route, with a station 12 m up in the middle of it.
    const railway = (i: number) => (i >= 60 && i < 180 ? (i >= 110 && i < 112 ? 1.2 : 0.7) : 0);
    const covered = grids((i) => GROUND + railway(i));
    const profile = routeProfile(along, covered);
    expect(zAt(profile, 50)).toBeCloseTo(GROUND + 0.7, 3);
    expect(zAt(profile, 56)).toBeCloseTo(GROUND + 0.7, 3);
    expect(zAt(profile, 20)).toBeCloseTo(GROUND, 3);
    // Filed as building, or in a survey that files none, it stays under.
    const filed = grids((i) => GROUND + railway(i));
    filed.building = Uint8Array.from({ length: NX * NY }, (_, k) => (railway(k % NX) ? 1 : 0));
    expect(zAt(routeProfile(along, filed), 50)).toBeCloseTo(GROUND, 4);
    const unfiled = grids((i) => GROUND + railway(i));
    unfiled.building = null;
    expect(zAt(routeProfile(along, unfiled), 50)).toBeCloseTo(GROUND, 4);
    // A short one, like an overpass, keeps it under.
    expect(zAt(routeProfile(along, grids((i) => (i >= 120 && i < 126 ? GROUND + 0.7 : GROUND))), 61.5)).toBeCloseTo(GROUND, 4);
  });

  it('ramps up to a deck rather than stepping', () => {
    const profile = routeProfile(along, grids((i) => GROUND + (i >= 100 && i < 140 ? 0.2 * ((i - 100) / 40) : 0) + (i >= 140 ? 2 : 0)));
    for (let k = 1; k < profile.z.length; k++) expect(Math.abs(profile.z[k] - profile.z[k - 1])).toBeLessThanOrEqual(CELL / 2 + 1e-6);
  });

  it('finds the nearest line and interpolates along it', () => {
    const index = new ProfileIndex([{ x: Float64Array.of(0, 10), y: Float64Array.of(0, 0), z: Float64Array.of(1, 3) }], 0.6);
    expect(index.at(5, 0.2)).toBeCloseTo(2, 6);
    expect(index.at(-0.5, 0.5)).toBeCloseTo(1, 6);
    expect(index.at(5, 50)).toBeNaN();
  });
});

describe('compose along a route', () => {
  it('clears clutter there and leaves buildings, and gives the bare ground', () => {
    const grid = gridSpec(60, 20, 1);
    const layers = emptyLayers(grid.nx, grid.ny);
    for (let k = 0; k < grid.nx * grid.ny; k++) {
      const i = k % grid.nx;
      // A parked van at 10 to 13 m, a building at 30 to 40 m.
      const z = 100 + (i >= 10 && i < 13 ? 1.6 : 0) + (i >= 30 && i < 40 ? 12 : 0);
      layers.top[k] = layers.solid[k] = z;
      layers.count[k] = 6;
      if (i >= 30 && i < 40) layers.building[k] = 6;
      else if (i < 10 || i >= 13) layers.ground[k] = 100;
    }
    const settings = { removeClutter: false, trees: 'natural' as const };
    const clear = new Uint8Array(grid.nx * grid.ny).fill(1);
    const plain = compose(layers, 1, 1, 1, 1, settings);
    const along = compose(layers, 1, 1, 1, 1, settings, undefined, undefined, undefined, undefined, clear);
    const at = (heights: Float32Array, i: number) => heights[10 * grid.nx + i];
    expect(at(plain.heights, 11) - at(plain.heights, 5)).toBeGreaterThan(1);
    expect(at(along.heights, 11)).toBeCloseTo(at(along.heights, 5), 3);
    expect(at(along.heights, 35) - at(along.heights, 5)).toBeGreaterThan(10);
    expect(plain.ground).toBeUndefined();
    expect(along.ground![10 * grid.nx + 35]).toBeCloseTo(at(along.heights, 5), 3);
    expect(along.counts.route_cleared_cells).toBeGreaterThan(0);
  });
});

describe('routes on a LiDAR only model', () => {
  const area: AreaSpec = { center: [-87.63, 41.88], widthM: 160, heightM: 120, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
  const projection = new Projection(area.center, 0, 1);
  const geo = (x: number, y: number): LonLat => projection.localToGeo(x, y);

  /** 1 m cells: ground at 100 m, a 30 m tower the route runs past, and a river to the south. */
  function prepared() {
    const grid = gridSpec(area.widthM, area.heightM, 1);
    const layers = emptyLayers(grid.nx, grid.ny);
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const k = j * grid.nx + i;
        const x = grid.x0 + i * grid.dx;
        const y = grid.y0 + j * grid.dy;
        layers.count[k] = 6;
        if (y < -45) {
          layers.top[k] = layers.solid[k] = layers.waterZ[k] = 98;
          layers.water[k] = 6;
          continue;
        }
        const tower = x >= 10 && x < 40 && y >= 5 && y < 35;
        const z = tower ? 130 : 100;
        layers.top[k] = layers.solid[k] = z;
        if (tower) layers.building[k] = 6;
        else layers.ground[k] = z;
      }
    }
    return { layers, checkpoints: [], grid, requestedCellM: 1, densityM2: 10, coverage: 1, points: 0, noise: 0, surveys: [], failures: [], downloadedBytes: 0, blocks: 1, reusedBlocks: 0, offers: [], found: [] };
  }

  // Along y 0, then clipping the tower's corner, as GPS drifts into it.
  const track: TrackLines = { id: 'r', name: 'Run', lines: [[geo(-70, 0), geo(5, 0), geo(15, 8), geo(70, 8)]] };

  it('is a closed part on the ground, and selectable', async () => {
    const settings = cloneSettings();
    settings.modelSource = 'lidar';
    settings.scale.mmPerMetre = 0.5;
    const spec = await surfaceModel({ area, settings, surface: prepared(), tracks: [track] });
    const routes = spec.layers.find((layer) => layer.id === 'routes')!;
    expect(routes.role).toBe('route');
    // Listed before the city, so the city keeps what's under a roof.
    expect(spec.layers.findIndex((layer) => layer.id === 'routes')).toBeLessThan(spec.layers.findIndex((layer) => layer.id === 'city'));
    expect(spec.edit!.objects.get('rt:r')).toMatchObject({ kind: 'route', name: 'Run' });
    const { parts, failed } = await meshLayers(spec.layers, { zShift: -spec.baseZ });
    expect(failed).toBe(0);
    for (const part of parts) {
      const report = edgeReport(part.indices, part.positions.length / 3);
      expect(report.open, part.name).toBe(0);
    }
    const solids = routes.solids as PrismSolid[];
    const top = (x: number, y: number) => {
      const [mx, my] = [x * 0.5, y * 0.5];
      const solid = solids.find((s) => pointInPolygon(mx, my, s.polygon as Polygon))!;
      return typeof solid.top === 'number' ? solid.top : solid.top(mx, my);
    };
    const ground = spec.edit!.heightAt(-50 * 0.5, 0);
    expect(top(-50, 0)).toBeCloseTo(ground + settings.tracks.heightMm, 2);
    // Inside the tower's corner it stays down at the street, under the roof.
    expect(top(25, 8)).toBeCloseTo(ground + settings.tracks.heightMm, 2);
    expect(spec.edit!.heightAt(25 * 0.5, 8 * 0.5)).toBeGreaterThan(top(25, 8) + 10);
  });

  it('leaves the model alone without routes', async () => {
    const settings = cloneSettings();
    settings.modelSource = 'lidar';
    settings.scale.mmPerMetre = 0.5;
    const without = await surfaceModel({ area, settings, surface: prepared() });
    const off = await surfaceModel({ area, settings: { ...settings, tracks: { ...settings.tracks, enabled: false } }, surface: prepared(), tracks: [track] });
    expect(off.layers.map((layer) => layer.id)).toEqual(without.layers.map((layer) => layer.id));
    const city = (spec: typeof without) => spec.layers.find((layer) => layer.id === 'city')!.solids[0];
    expect(city(off)).toEqual(city(without));
  });
});
