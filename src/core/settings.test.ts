import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, cloneSettings, sanitizeSettings } from './settings';

describe('sanitizeSettings', () => {
  it('keeps valid settings as they are, in a copy', () => {
    const out = sanitizeSettings(DEFAULT_SETTINGS);
    expect(out).toEqual(DEFAULT_SETTINGS);
    expect(out).not.toBe(DEFAULT_SETTINGS);
    expect(out.land.priority).not.toBe(DEFAULT_SETTINGS.land.priority);

    const edited = cloneSettings();
    edited.scale = { mode: 'fit', mmPerMetre: 0.001, fitMm: 2000 };
    edited.terrain.exaggeration = 0;
    edited.terrain.resolution = 1024;
    edited.bridges.maxGrade = 0.5;
    edited.trees.variation = 0.8;
    edited.buildings.minWidthMm = 0;
    edited.supports = false;
    edited.land.priority = ['forest', 'green', 'rock', 'sand', 'paved'];
    expect(sanitizeSettings(edited)).toEqual(edited);
  });

  it('clamps numbers that would break generation', () => {
    const bad = cloneSettings();
    bad.terrain.resolution = 0;
    bad.terrain.smoothing = 2.6;
    bad.buildings.floorHeightM = -3;
    bad.buildings.defaultHeightM = 0;
    bad.scale.mmPerMetre = NaN;
    bad.scale.fitMm = Infinity;
    bad.trees.maxTrees = 1e9;
    bad.roads.thicknessMm = 0;
    const out = sanitizeSettings(bad);
    expect(out.terrain.resolution).toBe(16);
    expect(out.terrain.smoothing).toBe(3);
    expect(out.buildings.floorHeightM).toBe(1);
    expect(out.buildings.defaultHeightM).toBe(1);
    expect(out.scale.mmPerMetre).toBe(DEFAULT_SETTINGS.scale.mmPerMetre);
    expect(out.scale.fitMm).toBe(DEFAULT_SETTINGS.scale.fitMm);
    expect(out.trees.maxTrees).toBe(500000);
    expect(out.roads.thicknessMm).toBe(0.05);
  });

  it('fills in anything missing or of the wrong type and drops unknown keys', () => {
    const out = sanitizeSettings({
      scale: { mode: 'huge', mmPerMetre: '0.5' },
      terrain: { elevation: 'no', resolution: 300.4 },
      land: { priority: ['paved', 'paved', 'rock', 'green', 'forest'] },
      buildings: null,
      supports: 1,
      colour: 'red',
    });
    expect(out.scale).toEqual(DEFAULT_SETTINGS.scale);
    expect(out.terrain).toEqual({ ...DEFAULT_SETTINGS.terrain, resolution: 300 });
    expect(out.land.priority).toEqual(DEFAULT_SETTINGS.land.priority);
    expect(out.buildings).toEqual(DEFAULT_SETTINGS.buildings);
    expect(out.supports).toBe(DEFAULT_SETTINGS.supports);
    expect(out).not.toHaveProperty('colour');
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(out)).toEqual(out);
    expect(out.modelSource).toBe('map');
  });
});

describe('LiDAR only settings', () => {
  it('keep the model source and clamp its numbers', () => {
    const lidar = sanitizeSettings({ ...cloneSettings(), modelSource: 'lidar', lidarModel: { detailMm: 0, keepTrees: false, removeClutter: 'no', waterDepthMm: 9, heightScale: 2 } });
    expect(lidar.modelSource).toBe('lidar');
    expect(lidar.lidarModel).toEqual({ ...DEFAULT_SETTINGS.lidarModel, detailMm: 0.02, keepTrees: false, waterDepthMm: 3, heightScale: 2 });
    expect(sanitizeSettings({ modelSource: 'point cloud' }).modelSource).toBe('map');
  });
});
