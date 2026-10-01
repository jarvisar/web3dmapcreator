import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, cloneSettings, modelFieldRange, sanitizeSettings } from './settings';

describe('model field ranges', () => {
  it('keeps percentage inputs in displayed units and stored values in range', () => {
    expect(modelFieldRange('bridges', 'maxGrade', 100)).toEqual({ min: 1, max: 50 });
    expect(modelFieldRange('trees', 'variation', 100)).toEqual({ min: 0, max: 80 });
    const settings = cloneSettings();
    settings.bridges.maxGrade = modelFieldRange('bridges', 'maxGrade', 100).max / 100;
    settings.trees.variation = modelFieldRange('trees', 'variation', 100).max / 100;
    expect(sanitizeSettings(settings)).toEqual(settings);
  });

  it('preserves zero and fractional bounds used for printability', () => {
    expect(modelFieldRange('buildings', 'minWidthMm')).toEqual({ min: 0, max: 2 });
    expect(modelFieldRange('lidarModel', 'detailMm')).toEqual({ min: 0.02, max: 0.3 });
    expect(modelFieldRange('scale', 'mmPerMetre')).toEqual({ min: 0.001, max: 2 });
  });
});

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

describe('water settings', () => {
  it('keep the mode and drop the old pond recess', () => {
    const through = sanitizeSettings({ water: { mode: 'through', thicknessMm: 0.6 } });
    expect(through.water).toEqual({ ...DEFAULT_SETTINGS.water, mode: 'through', thicknessMm: 0.6 });
    // Saved before the thin layer: the pond settings go, and the new default takes over.
    const old = sanitizeSettings({ water: { enabled: true, cutMinAreaM2: 8000, recessPonds: false, skipPonds: false, pondDepthMm: 2, pondWaterMm: 1.5 } });
    expect(old.water).toEqual({ ...DEFAULT_SETTINGS.water, cutMinAreaM2: 8000 });
    expect(sanitizeSettings({ water: { mode: 'hole', thicknessMm: 0 } }).water).toEqual({ ...DEFAULT_SETTINGS.water, thicknessMm: 0.1 });
  });
});

describe('LiDAR survey choice', () => {
  it('keeps a picked survey and drops anything that is not one', () => {
    const url = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23/ept.json';
    expect(sanitizeSettings({ lidar: { survey: url } }).lidar.survey).toBe(url);
    expect(sanitizeSettings({ lidar: { survey: 42 } }).lidar.survey).toBe('');
    expect(sanitizeSettings({ lidar: { survey: 'x'.repeat(2000) } }).lidar.survey).toBe('');
    expect(sanitizeSettings({}).lidar.survey).toBe('');
  });
});

describe('LiDAR only settings', () => {
  it('keep the model source and clamp its numbers', () => {
    const lidar = sanitizeSettings({ ...cloneSettings(), modelSource: 'lidar', lidarModel: { detailMm: 0, keepClutter: 'no', waterDepthMm: 9, heightScale: 2 } });
    expect(lidar.modelSource).toBe('lidar');
    expect(lidar.lidarModel).toEqual({ ...DEFAULT_SETTINGS.lidarModel, detailMm: 0.02, waterDepthMm: 3, heightScale: 2 });
    expect(sanitizeSettings({ modelSource: 'point cloud' }).modelSource).toBe('map');
  });

  it('keep the tree style, and take trees left out from before the styles', () => {
    expect(sanitizeSettings({ lidarModel: { trees: 'rounded', keepClutter: false } }).lidarModel).toEqual({ ...DEFAULT_SETTINGS.lidarModel, trees: 'rounded', keepClutter: false });
    expect(sanitizeSettings({ lidarModel: { keepTrees: false } }).lidarModel.trees).toBe('off');
    expect(sanitizeSettings({ lidarModel: { keepTrees: true, removeClutter: true } }).lidarModel).toEqual(DEFAULT_SETTINGS.lidarModel);
    expect(sanitizeSettings({ lidarModel: { trees: 'domes' } }).lidarModel.trees).toBe('natural');
  });

  it('keep the water mode, and take a saved cut from before the modes', () => {
    const layer = sanitizeSettings({ lidarModel: { waterMode: 'layer', mapWater: false } });
    expect(layer.lidarModel).toEqual({ ...DEFAULT_SETTINGS.lidarModel, waterMode: 'layer', mapWater: false });
    expect(sanitizeSettings({ lidarModel: { cutWater: true } }).lidarModel).toEqual({ ...DEFAULT_SETTINGS.lidarModel, waterMode: 'cut' });
    expect(sanitizeSettings({ lidarModel: { cutWater: false } }).lidarModel.waterMode).toBe('recess');
    expect(sanitizeSettings({ lidarModel: { waterMode: 'sheet', cutWater: true } }).lidarModel.waterMode).toBe('cut');
  });
});
