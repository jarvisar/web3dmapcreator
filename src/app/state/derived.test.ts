import { describe, expect, it } from 'vitest';
import { MAX_SECTIONS } from '../../core/export/sections';
import { DEFAULT_AREA, DEFAULT_EXPORT, cloneSettings } from '../../core/settings';
import { bedFit, usedGroups } from './derived';

describe('bed fit', () => {
  it('counts only the sections a round model uses', () => {
    const settings = cloneSettings();
    settings.scale = { ...settings.scale, mode: 'fixed', mmPerMetre: 0.2 };
    const fit = bedFit({ ...DEFAULT_AREA, shape: 'circle', widthM: 3000, heightM: 3000 }, settings, { ...DEFAULT_EXPORT, sectionWidthMm: 50, sectionHeightMm: 50 });
    expect(fit.cols * fit.rows).toBeLessThanOrEqual(MAX_SECTIONS);
    expect(fit.plates).toBeLessThan(fit.cols * fit.rows);
  });

  it("doesn't count a grid too large to export", () => {
    // Nine million sections. Counting them took seconds on every render.
    const settings = cloneSettings();
    settings.scale = { ...settings.scale, mode: 'fixed', mmPerMetre: 2 };
    const started = performance.now();
    const fit = bedFit({ ...DEFAULT_AREA, shape: 'circle', widthM: 30000, heightM: 30000 }, settings, { ...DEFAULT_EXPORT, sectionWidthMm: 20, sectionHeightMm: 20 });
    expect(performance.now() - started).toBeLessThan(100);
    expect(fit.plates).toBe(fit.cols * fit.rows);
    expect(fit.plates).toBeGreaterThan(MAX_SECTIONS);
  });
});

describe('colour groups', () => {
  it('give a LiDAR only model the water colour only with a water layer', () => {
    const settings = cloneSettings();
    settings.modelSource = 'lidar';
    expect(usedGroups(settings)).toEqual(['terrain']);
    settings.lidarModel.waterMode = 'layer';
    settings.rim.enabled = true;
    expect(usedGroups(settings)).toEqual(['terrain', 'water', 'rim']);
  });
});
