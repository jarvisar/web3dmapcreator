import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AREA, DEFAULT_EXPORT, DEFAULT_PALETTE, cloneSettings } from '../../core/settings';
import { defaultSvgSettings } from '../svgmap/settings';
import { fitAreaToPiece } from '../svgmap/piece';
import { decodeOptions, encodeOptions, MAX_OPTIONS_BYTES, type Options } from './options';
import { applyOptions, snapshotKey, useApp, type ResultMeta } from './store';

function options(): Options {
  return {
    output: 'model', settings: cloneSettings(), palette: structuredClone(DEFAULT_PALETTE),
    exportSettings: { ...DEFAULT_EXPORT }, svg: defaultSvgSettings(),
  };
}

const savedMap = { area: { ...DEFAULT_AREA, center: [12.49, 41.89] as [number, number], rotationDeg: 25 }, placeName: 'Rome', fileName: 'my-map' };
const initial = useApp.getState();
afterEach(() => useApp.setState(initial, true));

describe('options files', () => {
  it('round-trips custom 3D and SVG options, colours and printer settings', () => {
    const source = options();
    source.settings.modelSource = 'lidar';
    source.settings.scale.mmPerMetre = 0.09;
    source.settings.land.priority.reverse();
    source.palette.buildings = { hex: '#123ABC', line: 'PLA Matte' };
    source.exportSettings = { format: 'stl', printer: 'A1M', multiPlate: true, sectionWidthMm: 160, sectionHeightMm: 170 };
    source.svg.mode = 'plotter';
    source.svg.label.text = 'SÃO PAULO 東京';
    source.svg.styles.print.background = null;
    source.svg.styles.plotter.hatch.water.angle = -45;
    expect(decodeOptions(encodeOptions(source))).toEqual(source);
    expect(decodeOptions('\uFEFF' + encodeOptions(source, savedMap))).toEqual({ ...source, map: savedMap });
  });

  it('only exports intended options and optionally the map', () => {
    const raw = JSON.parse(encodeOptions(useApp.getState()));
    expect(Object.keys(raw).sort()).toEqual(['format', 'version', 'output', 'settings', 'palette', 'exportSettings', 'svg'].sort());
    expect(JSON.parse(encodeOptions(useApp.getState(), savedMap)).map).toEqual(savedMap);
  });

  it('fills in missing nested settings from defaults and ignores unknown keys', () => {
    const raw = JSON.parse(encodeOptions(options()));
    raw.settings = { terrain: { elevation: false }, unknown: true };
    raw.svg = { label: { text: 'Saved title' }, extra: 42 };
    raw.palette = { buildings: { hex: '#abcdef', line: 'PLA Basic' } };
    const result = decodeOptions(JSON.stringify(raw));
    expect(result.settings.terrain.elevation).toBe(false);
    expect(result.settings.roads).toEqual(cloneSettings().roads);
    expect(result.svg.label.text).toBe('Saved title');
    expect(result.svg.cleanup).toEqual(defaultSvgSettings().cleanup);
    expect(result.palette.buildings.hex).toBe('#ABCDEF');
    expect(result).not.toHaveProperty('settings.unknown');
    expect(result).not.toHaveProperty('svg.extra');
  });

  it.each(['not json', '{}', 'null', '[]', '{"format":"something-else"}'])('rejects unrelated or malformed files: %s', (text) => {
    expect(() => decodeOptions(text)).toThrow();
  });

  it('rejects unsupported versions, missing sections and oversized files', () => {
    const raw = JSON.parse(encodeOptions(options()));
    expect(() => decodeOptions(JSON.stringify({ ...raw, version: 2 }))).toThrow(/version/);
    expect(() => decodeOptions(JSON.stringify({ ...raw, settings: null }))).toThrow(/settings/);
    expect(() => decodeOptions(' '.repeat(MAX_OPTIONS_BYTES + 1))).toThrow(/8 MB/);
  });

  it.each([
    ['settings', { scale: { mmPerMetre: 0 } }],
    ['settings', { buildings: { enabled: 'yes' } }],
    ['settings', { land: { priority: ['sand', 'sand'] } }],
    ['palette', { buildings: { hex: 'red', line: 'PLA Basic' } }],
    ['exportSettings', { printer: 'missing' }],
    ['svg', { mode: 'bad' }],
    ['svg', { product: { width: 'wide' } }],
    ['svg', { label: { style: 'bad' } }],
    ['svg', { styles: { print: { background: 'url(x)' } } }],
    ['svg', { styles: { plotter: { fillModes: { water: 'bad' } } } }],
  ])('rejects invalid known values in %s', (key, value) => {
    const raw = JSON.parse(encodeOptions(options()));
    raw[key] = value;
    expect(() => decodeOptions(JSON.stringify(raw))).toThrow(/Invalid option/);
  });

  it('rejects invalid coordinates and area dimensions', () => {
    for (const patch of [{ center: ['west', 20] }, { widthM: -1 }, { shape: 'triangle' }, { center: [0, 100] }]) {
      const raw = JSON.parse(encodeOptions(options(), savedMap));
      Object.assign(raw.map.area, patch);
      expect(() => decodeOptions(JSON.stringify(raw))).toThrow();
    }
  });
});

describe('applying options', () => {
  it('keeps the current area and names for an options-only import', () => {
    const source = options();
    source.settings.buildings.heightScale = 1.7;
    useApp.setState({ placeName: 'Current place', fileName: 'current-file' });
    const before = useApp.getState();
    applyOptions(source);
    const state = useApp.getState();
    expect(state.area).toEqual(before.area);
    expect(state.placeName).toBe('Current place');
    expect(state.fileName).toBe('current-file');
    expect(state.settings).toEqual(source.settings);
    expect(state.settings).not.toBe(source.settings);
  });

  it('restores a saved area and names, or ignores them when unchecked', () => {
    const source = decodeOptions(encodeOptions(options(), savedMap));
    applyOptions(source, false);
    expect(useApp.getState().area).toEqual(initial.area);
    applyOptions(source);
    expect(useApp.getState().area).toEqual(savedMap.area);
    expect(useApp.getState().placeName).toBe(savedMap.placeName);
    expect(useApp.getState().fileName).toBe(savedMap.fileName);
    expect(useApp.getState().ui.mapFocus.seq).toBe(initial.ui.mapFocus.seq + 1);
    expect(useApp.getState()).not.toHaveProperty('map');
  });

  it('marks an existing model stale and recognises restoring its original options', () => {
    const result = { key: snapshotKey(initial.area, initial.settings) } as ResultMeta;
    useApp.setState({ generation: { ...initial.generation, result } });
    const changed = options();
    changed.settings.terrain.elevation = false;
    applyOptions(changed);
    expect(useApp.getState().generation.stale).toBe(true);
    expect(useApp.getState().generation.result).toBe(result);
    applyOptions(options());
    expect(useApp.getState().generation.stale).toBe(false);
  });

  it('fits SVG options to the piece and returns to the map if there is no SVG preview', () => {
    useApp.setState({ ui: { ...initial.ui, view: 'result' } });
    const source = options();
    source.output = 'svg';
    source.svg.scaleLocked = true;
    source.svg.scale = 5000;
    applyOptions(source);
    expect(useApp.getState().area).toEqual(fitAreaToPiece(initial.area, source.svg).area);
    expect(useApp.getState().area.center).toEqual(initial.area.center);
    expect(useApp.getState().ui.view).toBe('map');
  });

  it('leaves everything untouched when the SVG piece is invalid', () => {
    const source = options();
    source.svg.product.width = 0;
    expect(() => applyOptions(source)).toThrow(/Invalid SVG options/);
    expect(useApp.getState()).toBe(initial);
  });
});
