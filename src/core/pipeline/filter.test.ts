import { describe, expect, it } from 'vitest';
import { cloneSettings } from '../settings';
import { rowFilter } from './filter';

const bounds = { west: 0, south: 0, east: 0.01, north: 0.01 };
const small: [number, number, number, number] = [0.001, 0.001, 0.002, 0.002];
const regional: [number, number, number, number] = [-1, -1, 1, 1];

describe('rowFilter', () => {
  it('keeps what the default layers use and drops the rest', () => {
    const keep = rowFilter(cloneSettings(), bounds);
    expect(keep('building', { height: 20 }, small)).toBe(true);
    expect(keep('building', { is_underground: true }, small)).toBe(false);
    expect(keep('segment', { subtype: 'road', class: 'footway' }, small)).toBe(true);
    expect(keep('segment', { subtype: 'water', class: 'canal' }, small)).toBe(false);
    expect(keep('land_use', { subtype: 'park', class: 'park' }, small)).toBe(true);
    expect(keep('land_use', { class: 'residential' }, small)).toBe(false);
    expect(keep('land_cover', { subtype: 'forest' }, small)).toBe(true);
    expect(keep('land_cover', { subtype: 'urban' }, small)).toBe(false);
    expect(keep('infrastructure', { subtype: 'airport', class: 'runway' }, small)).toBe(true);
    expect(keep('infrastructure', { subtype: 'pier', class: 'pier' }, small)).toBe(true);
    expect(keep('infrastructure', { subtype: 'power', class: 'power_line' }, small)).toBe(false);
    // Trees are off by default, so mapped tree points aren't needed.
    expect(keep('land', { subtype: 'tree', class: 'tree' }, small)).toBe(false);
  });

  it('drops regional polygons from their bbox alone', () => {
    const keep = rowFilter(cloneSettings(), bounds);
    expect(keep('land_cover', { subtype: 'forest' }, regional)).toBe(false);
    expect(keep('land', { class: 'land', subtype: 'land' }, regional)).toBe(false);
    // Water is always kept: a sea polygon is much larger than any selection.
    expect(keep('water', { subtype: 'ocean', class: 'ocean' }, regional)).toBe(true);
  });

  it('follows the layer settings', () => {
    const settings = cloneSettings();
    settings.trees.enabled = true;
    settings.roads.includePaths = false;
    settings.roads.includeRail = false;
    settings.roads.includeAirports = false;
    settings.land.enabled = false;
    const keep = rowFilter(settings, bounds);
    expect(keep('land', { class: 'tree' }, small)).toBe(true);
    expect(keep('segment', { subtype: 'road', class: 'footway' }, small)).toBe(false);
    expect(keep('segment', { subtype: 'rail', class: 'standard_gauge' }, small)).toBe(false);
    expect(keep('infrastructure', { subtype: 'airport', class: 'runway' }, small)).toBe(false);
    // Land cover is still read for forest scatter, but parks are not.
    expect(keep('land_cover', { subtype: 'forest' }, small)).toBe(true);
    expect(keep('land_use', { class: 'park' }, small)).toBe(false);
  });
});
