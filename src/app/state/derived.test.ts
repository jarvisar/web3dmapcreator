import { describe, expect, it } from 'vitest';
import { MAX_SECTIONS } from '../../core/export/sections';
import { DEFAULT_AREA, DEFAULT_EXPORT, cloneSettings } from '../../core/settings';
import { emptyEdits, type AddedShape, type ModelEdits } from '../../core/edit/types';
import { bedFit, hiddenDownloadParts, modelSize, usedGroups } from './derived';
import type { RoadLines } from '../../core/engine/protocol';
import type { ResultMeta } from './store';

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

describe('hidden parts and the download', () => {
  const result = { parts: [{ id: 'terrain', name: 'Terrain', role: 'terrain', triangles: 10 }, { id: 'buildings', name: 'Buildings', role: 'building', triangles: 10 }] } as ResultMeta;
  const shape = (id: string, layer: string) => ({ id, kind: 'box', layer, at: [0, 0], points: [], rotationDeg: 0, sizeMm: 5, depthMm: 5, heightMm: 2, liftMm: 0, followGround: true, text: '', font: '' }) as AddedShape;
  const layer = (id: string) => ({ id, name: id, hex: '#FF0000', line: 'PLA Basic' as const });
  const edits: ModelEdits = { ...emptyEdits(), layers: [layer('A'), layer('B')], objects: { 'b:1': { layer: 'A' } }, shapes: [shape('s', 'roads')] };
  // What the editor knows this model has: building 1, and the road r:1.
  const data = { editable: true, objects: { 'b:1': { kind: 'building' } }, roads: { keys: ['r:1'] } as RoadLines };

  it("count custom layers and added shapes, which export as parts of their own", () => {
    // Hiding every part the model had used to read as nothing to download.
    expect(hiddenDownloadParts(result, edits, data, ['terrain', 'buildings'])).toEqual({ hidden: 2, all: false });
    expect(hiddenDownloadParts(result, edits, data, ['terrain', 'buildings', 'layer:A'])).toEqual({ hidden: 3, all: false });
    expect(hiddenDownloadParts(result, edits, data, ['terrain', 'buildings', 'layer:A', 'shapes'])).toEqual({ hidden: 4, all: true });
  });

  it("don't count a layer nothing is in, or shapes all in custom layers", () => {
    const inLayers: ModelEdits = { ...edits, shapes: [shape('s', 'A')] };
    expect(hiddenDownloadParts(result, inLayers, data, ['terrain', 'buildings', 'layer:A'])).toEqual({ hidden: 3, all: true });
    expect(hiddenDownloadParts(result, inLayers, data, ['layer:B'])).toEqual({ hidden: 0, all: false });
    expect(hiddenDownloadParts(result, emptyEdits(), data, ['terrain', 'buildings'])).toEqual({ hidden: 2, all: true });
  });

  it("don't count a layer that only holds what this model doesn't have, or what was removed", () => {
    // Edits are kept for every area, so a layer can come from somewhere else.
    const elsewhere: ModelEdits = { ...emptyEdits(), layers: [layer('A')], objects: { 'b:9': { layer: 'A' }, 'r:9': { layer: 'A' }, 'b:1': { layer: 'A', removed: true } } };
    expect(hiddenDownloadParts(result, elsewhere, data, ['terrain', 'buildings'])).toEqual({ hidden: 2, all: true });
    const road: ModelEdits = { ...elsewhere, objects: { 'r:1': { layer: 'A' } } };
    expect(hiddenDownloadParts(result, road, data, ['terrain', 'buildings'])).toEqual({ hidden: 2, all: false });
    // Trees have no facts, so a tree in a layer counts when the model has trees.
    const tree: ModelEdits = { ...elsewhere, objects: { 't:1': { layer: 'A' } } };
    expect(hiddenDownloadParts(result, tree, data, ['terrain', 'buildings'])).toEqual({ hidden: 2, all: true });
    const withTrees = { ...result, parts: [...result.parts, { id: 'trees', name: 'Trees', role: 'tree', triangles: 10 }] } as ResultMeta;
    expect(hiddenDownloadParts(withTrees, tree, data, ['terrain', 'buildings', 'trees'])).toEqual({ hidden: 3, all: false });
  });

  it('count only the model for one that could not be edited, which downloads without the edits', () => {
    expect(hiddenDownloadParts(result, edits, { ...data, editable: false }, ['terrain', 'buildings'])).toEqual({ hidden: 2, all: true });
  });
});

describe('model size', () => {
  it('uses what the view shows for this model, and the generated box otherwise', () => {
    const result = { version: 3, bounds: [0, 0, 0, 100, 80, 20] } as ResultMeta;
    expect(modelSize(result, null)).toEqual({ w: 100, d: 80, h: 20 });
    expect(modelSize(result, { version: 3, bounds: [0, 0, 0, 100, 80, 250] })).toEqual({ w: 100, d: 80, h: 250 });
    // From the model before, while the view catches up.
    expect(modelSize(result, { version: 2, bounds: [0, 0, 0, 10, 10, 10] })).toEqual({ w: 100, d: 80, h: 20 });
  });
});
