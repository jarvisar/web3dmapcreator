import { describe, expect, it } from 'vitest';
import { cloneSettings, type ModelSettings } from '../settings';
import { dataPlan } from './dataPlan';
import type { SourceType } from './source';

const bounds = { west: 0, south: 0, east: 0.01, north: 0.01 };
const small: [number, number, number, number] = [0.001, 0.001, 0.002, 0.002];
const regional: [number, number, number, number] = [-1, -1, 1, 1];
// A detailed land cover polygon is cut to a zoom 10 tile, far larger than the selection.
const tile: [number, number, number, number] = [-0.1, -0.1, 0.25, 0.25];
const detailed = { cartography: { min_zoom: 8, max_zoom: 15 } };
const coarse = { cartography: { min_zoom: 0, max_zoom: 7 } };

describe('dataPlan', () => {
  it('keeps what the default layers use and drops the rest', () => {
    const keep = dataPlan(cloneSettings(), bounds).keep;
    expect(keep('building', { height: 20 }, small)).toBe(true);
    expect(keep('building', { is_underground: true }, small)).toBe(false);
    expect(keep('segment', { subtype: 'road', class: 'footway' }, small)).toBe(true);
    expect(keep('segment', { subtype: 'water', class: 'canal' }, small)).toBe(false);
    expect(keep('land_use', { subtype: 'park', class: 'park' }, small)).toBe(true);
    expect(keep('land_use', { class: 'residential' }, small)).toBe(false);
    // Satellite land cover is off by default, and trees are off.
    expect(keep('land_cover', { subtype: 'forest', ...detailed }, small)).toBe(false);
    expect(dataPlan(cloneSettings(), bounds).types).not.toContain('land_cover');
    expect(keep('infrastructure', { subtype: 'airport', class: 'runway' }, small)).toBe(true);
    expect(keep('infrastructure', { subtype: 'pier', class: 'pier' }, small)).toBe(true);
    expect(keep('infrastructure', { subtype: 'power', class: 'power_line' }, small)).toBe(false);
    // Trees are off by default, so mapped tree points aren't needed.
    expect(keep('land', { subtype: 'tree', class: 'tree' }, small)).toBe(false);
  });

  it('drops regional polygons from their bbox alone', () => {
    const keep = dataPlan(cloneSettings(), bounds).keep;
    expect(keep('land', { class: 'forest', subtype: 'forest' }, small)).toBe(true);
    expect(keep('land', { class: 'forest', subtype: 'forest' }, regional)).toBe(false);
    expect(keep('land_use', { class: 'park', subtype: 'park' }, regional)).toBe(false);
    // Water is always kept: a sea polygon is much larger than any selection.
    expect(keep('water', { subtype: 'ocean', class: 'ocean' }, regional)).toBe(true);
  });

  it('reads satellite land cover when asked, by zoom level rather than size', () => {
    const settings = cloneSettings();
    settings.land.satelliteCover = true;
    const plan = dataPlan(settings, bounds);
    expect(plan.types).toContain('land_cover');
    expect(plan.keep('land_cover', { subtype: 'forest', ...detailed }, small)).toBe(true);
    expect(plan.keep('land_cover', { subtype: 'shrub', ...detailed }, tile)).toBe(true);
    expect(plan.keep('land_cover', { subtype: 'forest', ...coarse }, small)).toBe(false);
    expect(plan.keep('land_cover', { subtype: 'urban', ...detailed }, small)).toBe(false);
    // Without zoom levels, nothing wider than a zoom 10 tile is detailed.
    expect(plan.keep('land_cover', { subtype: 'forest' }, tile)).toBe(true);
    expect(plan.keep('land_cover', { subtype: 'forest' }, regional)).toBe(false);
    // The same polygons whatever the size of the selection.
    const wide = dataPlan(settings, { west: -0.2, south: -0.2, east: 0.3, north: 0.3 });
    for (const [props, bbox] of [[detailed, tile], [detailed, small], [coarse, small], [coarse, regional]] as const) {
      expect(wide.keep('land_cover', { subtype: 'forest', ...props }, bbox)).toBe(plan.keep('land_cover', { subtype: 'forest', ...props }, bbox));
    }
    settings.land.enabled = false;
    expect(dataPlan(settings, bounds).types).not.toContain('land_cover');
  });

  it('follows the layer settings', () => {
    const settings = cloneSettings();
    settings.trees.enabled = true;
    settings.roads.includePaths = false;
    settings.roads.includeRail = false;
    settings.roads.includeAirports = false;
    settings.land.enabled = false;
    const keep = dataPlan(settings, bounds).keep;
    expect(keep('land', { class: 'tree' }, small)).toBe(true);
    expect(keep('segment', { subtype: 'road', class: 'footway' }, small)).toBe(false);
    expect(keep('segment', { subtype: 'rail', class: 'standard_gauge' }, small)).toBe(false);
    expect(keep('infrastructure', { subtype: 'airport', class: 'runway' }, small)).toBe(false);
    // Land cover is still read for forest scatter, but parks are not.
    expect(keep('land_cover', { subtype: 'forest', ...detailed }, small)).toBe(true);
    expect(keep('land_cover', { subtype: 'forest', ...coarse }, small)).toBe(false);
    expect(keep('land_cover', { subtype: 'shrub', ...detailed }, small)).toBe(false);
    expect(keep('land_use', { class: 'park' }, small)).toBe(false);
  });

  it('reads forests for trees only when they are scattered', () => {
    const settings = cloneSettings();
    settings.trees.enabled = true;
    settings.trees.forestScatter = false;
    settings.land.enabled = false;
    settings.supports = false;
    const keep = dataPlan(settings, bounds).keep;
    expect(keep('land', { subtype: 'tree', class: 'tree' }, small)).toBe(true);
    for (const type of ['land', 'land_use', 'land_cover'] as const) {
      expect(keep(type, { subtype: 'forest', class: 'forest' }, small)).toBe(false);
    }
    expect(dataPlan(settings, bounds).types).toContain('land');
    expect(dataPlan(settings, bounds).types).not.toContain('land_cover');
    settings.trees.forestScatter = true;
    expect(dataPlan(settings, bounds).keep('land_use', { subtype: 'forest', class: 'forest' }, small)).toBe(true);
    expect(dataPlan(settings, bounds).types).toEqual(expect.arrayContaining(['land', 'land_use', 'land_cover']));
  });

  it('reads mapped piers for their ground with land cover off, supports or not', () => {
    const settings = cloneSettings();
    settings.land.enabled = false;
    settings.trees.enabled = false;
    for (const supports of [true, false]) {
      settings.supports = supports;
      expect(dataPlan(settings, bounds).types).toEqual(expect.arrayContaining(['land', 'land_use', 'infrastructure']));
      expect(dataPlan(settings, bounds).types).not.toContain('land_cover');
      expect(dataPlan(settings, bounds).keep('land_use', { subtype: 'pier', class: 'pier' }, small)).toBe(true);
      expect(dataPlan(settings, bounds).keep('land_use', { subtype: 'park', class: 'park' }, small)).toBe(false);
    }
  });

  it('always reads water and mapped piers, and admits mapped rock for LiDAR independently of land surfaces', () => {
    const settings = cloneSettings();
    settings.roads.enabled = false;
    settings.buildings.enabled = false;
    settings.land.enabled = false;
    settings.trees.enabled = false;
    expect(dataPlan(settings, bounds).types).toEqual(['water', 'infrastructure', 'land', 'land_use']);

    settings.buildings.enabled = true;
    settings.lidar.enabled = true;
    settings.lidar.rockSurfaces = true;
    settings.lidar.roofMode = 'envelope';
    const plan = dataPlan(settings, bounds);
    expect(plan.types).toEqual(['water', 'infrastructure', 'building', 'building_part', 'land', 'land_use']);
    expect(plan.keep('land', { class: 'bare_rock' }, regional)).toBe(true);
    settings.lidar.roofMode = 'heights';
    expect(dataPlan(settings, bounds).keep('land', { class: 'bare_rock' }, regional)).toBe(false);
    expect(dataPlan(settings, bounds).key).not.toBe(plan.key);
  });

  it('reuses downloads when only geometry settings change', () => {
    const settings = cloneSettings();
    const before = dataPlan(settings, bounds);
    settings.buildings.heightScale = 2;
    settings.roads.minWidthMm = 1;
    settings.terrain.resolution = 512;
    settings.water.enabled = false;
    settings.bridges.enabled = !settings.bridges.enabled;
    expect(dataPlan(settings, bounds).key).toBe(before.key);
  });

  it('holds the filtering inputs used to make its cache key', () => {
    const settings = cloneSettings();
    settings.roads.includeRail = false;
    const before = dataPlan(settings, bounds);
    settings.roads.includeRail = true;
    const after = dataPlan(settings, bounds);
    expect(before.keep('segment', { subtype: 'rail' }, small)).toBe(false);
    expect(after.keep('segment', { subtype: 'rail' }, small)).toBe(true);
    expect(after.key).not.toBe(before.key);
  });

  it('only shares a cache key when requested types and retained rows agree', () => {
    const flags: ((settings: ModelSettings, on: boolean) => void)[] = [
      (s, on) => { s.roads.enabled = on; },
      (s, on) => { s.roads.includeRail = on; },
      (s, on) => { s.roads.includePaths = on; },
      (s, on) => { s.roads.includeAirports = on; },
      (s, on) => { s.buildings.enabled = on; },
      (s, on) => { s.land.enabled = on; },
      (s, on) => { s.land.satelliteCover = on; },
      (s, on) => { s.trees.enabled = on; },
      (s, on) => { s.trees.mapped = on; },
      (s, on) => { s.trees.forestScatter = on; },
      (s, on) => { s.trees.landCoverScatter = on; },
      (s, on) => { s.lidar.enabled = on; },
      (s, on) => { s.lidar.rockSurfaces = on; },
      (s, on) => { s.lidar.roofMode = on ? 'envelope' : 'heights'; },
    ];
    const rows: [SourceType, Record<string, unknown>][] = [
      ['building', {}], ['building_part', { is_underground: true }],
      ['segment', { subtype: 'road', class: 'footway' }], ['segment', { subtype: 'rail' }],
      ['water', { class: 'swimming_pool' }], ['water', { class: 'fountain' }],
      ['land', { class: 'tree' }], ['land', { class: 'bare_rock' }],
      ['land', { class: 'forest' }], ['land_use', { class: 'park' }],
      ['land_use', { class: 'forest' }], ['land_cover', { subtype: 'forest' }],
      ['land_cover', { subtype: 'forest', ...detailed }], ['land_cover', { subtype: 'shrub', ...detailed }],
      ['land_cover', { subtype: 'forest', ...coarse }],
      ['infrastructure', { subtype: 'airport', class: 'runway' }],
      ...(['land', 'land_use', 'infrastructure'] as const).map((type): [SourceType, Record<string, unknown>] => [type, { class: 'pier' }]),
    ];
    const seen = new Map<string, string>();
    for (let mask = 0; mask < 2 ** flags.length; mask++) {
      const settings = cloneSettings();
      flags.forEach((set, bit) => set(settings, Boolean(mask & (1 << bit))));
      const plan = dataPlan(settings, bounds);
      const selected = JSON.stringify([plan.types, rows.map(([type, props]) => [plan.keep(type, props, small), plan.keep(type, props, regional)])]);
      if (seen.has(plan.key)) expect(selected, plan.key).toBe(seen.get(plan.key));
      else seen.set(plan.key, selected);
    }
  });
});
