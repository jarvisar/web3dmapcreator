import { afterEach, describe, expect, it } from 'vitest';
import { emptyEdits } from '../../core/edit/types';
import { DEFAULT_AREA, DEFAULT_EXPORT, DEFAULT_PALETTE, MIN_SECTION_MM, cloneSettings, modelFieldRange, printerByKey, type ModelSettings } from '../../core/settings';
import { limitFor } from '../../core/svgmap/limits';
import { defaultSvgSettings } from '../svgmap/settings';
import { fitAreaToPiece } from '../svgmap/piece';
import { undoEdit } from './editActions';
import { decodeOptions, encodeOptions, MAX_OPTIONS_BYTES, type Options } from './options';
import { applyOptions, modelKey, patchSettings, resetAllSettings, resetSettingsSection, useApp, type ResultMeta } from './store';

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

  it.each(['min', 'max'] as const)('round-trips every option at its %s', (end) => {
    const flip = (value: unknown, path: string[], number: (path: string[]) => number): unknown => {
      if (Array.isArray(value) || value === null) return value;
      if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, flip(v, [...path, key], number)]));
      if (typeof value === 'number') return number(path);
      if (typeof value === 'boolean') return !value;
      return value;
    };
    const source = options();
    source.settings = flip(source.settings, [], ([group, field]) => modelFieldRange(group as never, field as never)[end]) as ModelSettings;
    Object.assign(source.settings, { modelSource: 'lidar' });
    Object.assign(source.settings.scale, { mode: 'fit' });
    Object.assign(source.settings.water, { mode: 'through' });
    Object.assign(source.settings.lidar, { roofMode: 'heights', surveyPreference: 'detail', survey: 'https://example.com/survey/ept.json' });
    Object.assign(source.settings.lidarModel, { cellMode: 'metres', waterMode: 'cut', trees: 'rounded' });
    source.settings.land.priority.reverse();
    const { routes, hiddenLines, ...rest } = source.svg;
    source.svg = {
      ...(flip(rest, [], (path) => {
        const limit = limitFor(path)!;
        return 'min' in limit ? limit[end] : limit.choices[end === 'min' ? 0 : limit.choices.length - 1];
      }) as typeof rest),
      routes,
      hiddenLines,
    };
    const printer = printerByKey(source.exportSettings.printer);
    source.exportSettings = { ...source.exportSettings, multiPlate: true, sectionWidthMm: end === 'min' ? MIN_SECTION_MM : printer.width, sectionHeightMm: end === 'min' ? MIN_SECTION_MM : printer.depth };
    const map = { area: { ...DEFAULT_AREA, center: [-122.42, 37.77] as [number, number], rotationDeg: end === 'min' ? -179.9 : 180, shape: 'rounded' as const, cornerRadius: end === 'min' ? 0 : 0.5 }, placeName: 'San Francisco', fileName: null };
    expect(decodeOptions(encodeOptions(source, map))).toEqual({ ...source, map });
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
    const result = { key: modelKey(initial.area, initial.settings, initial.tracks) } as ResultMeta;
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

  const road = (lat: number): [number, number][] => [[0, lat], [0.001, lat], [0.002, lat]];
  const myRoute = { id: 'mine', name: 'Mine', color: '#E4002B', width: 0.6, lines: [road(0)] };

  it("adds a file's edits and picked roads to the ones here, and only with its map area", () => {
    const mine = { ...emptyEdits(), objects: { 'b:mine': { removed: true } } };
    useApp.setState({ edits: mine, svg: { ...initial.svg, routes: [myRoute], hiddenLines: [] } });
    const source = options();
    source.svg.hiddenLines = [road(0.01)];
    const file = decodeOptions(encodeOptions(source, { ...savedMap, edits: { ...emptyEdits(), objects: { 'b:theirs': { heightM: 40 } } } }));
    // Without the area, they stay out: they belong to that area.
    expect(applyOptions(file, false)).toBeNull();
    expect(useApp.getState().edits).toBe(mine);
    expect(useApp.getState().svg.routes).toEqual([myRoute]);
    expect(useApp.getState().svg.hiddenLines).toEqual([]);
    const brought = applyOptions(file)!;
    expect(Object.keys(useApp.getState().edits.objects).sort()).toEqual(['b:mine', 'b:theirs']);
    expect(useApp.getState().svg.routes).toEqual([myRoute]);
    expect(useApp.getState().svg.hiddenLines).toHaveLength(1);
    expect([brought.edits, brought.picks]).toEqual([1, 1]);
    // Undo takes the file's edits back out.
    undoEdit();
    expect(useApp.getState().edits).toEqual(mine);
  });

  it('leaves edits and picked roads out both ways unless asked for', () => {
    const mine = { ...emptyEdits(), objects: { 'b:mine': { removed: true } } };
    useApp.setState({ edits: mine, svg: { ...initial.svg, routes: [myRoute], hiddenLines: [road(0.02)] } });
    // Saved without them, the file has the area and no edits or picks.
    const saved = JSON.parse(encodeOptions(useApp.getState(), savedMap, false));
    expect(saved.map.area).toEqual(savedMap.area);
    expect(saved.map.edits).toBeUndefined();
    expect(saved.svg.hiddenLines).toEqual([]);
    expect(saved.svg.routes.every((route: { lines: unknown[] }) => route.lines.length === 0)).toBe(true);
    // Read without them, the file's area comes in and ours stay as they were.
    const source = options();
    source.svg.hiddenLines = [road(0.01)];
    const file = decodeOptions(encodeOptions(source, { ...savedMap, edits: { ...emptyEdits(), objects: { 'b:theirs': { heightM: 40 } } } }));
    expect(applyOptions(file, true, false)).toBeNull();
    expect(useApp.getState().area.center).toEqual(savedMap.area.center);
    expect(useApp.getState().edits).toBe(mine);
    expect(useApp.getState().svg.routes).toEqual([myRoute]);
    expect(useApp.getState().svg.hiddenLines).toEqual([road(0.02)]);
  });

  it('keeps the picked roads here for a file saved without an area', () => {
    useApp.setState({ svg: { ...initial.svg, routes: [myRoute], hiddenLines: [road(0.02)] } });
    const withRoutes = options();
    withRoutes.svg.routes = [{ ...myRoute, id: 'theirs', lines: [road(0.03)] }];
    applyOptions(decodeOptions(encodeOptions(withRoutes)));
    expect(useApp.getState().svg.routes).toEqual([myRoute]);
    expect(useApp.getState().svg.hiddenLines).toHaveLength(1);
  });
});

describe('resetting all settings', () => {
  it('keeps the edits and picked roads, which are work, not settings', () => {
    const edits = { ...emptyEdits(), objects: { 'b:1': { removed: true } } };
    useApp.setState({ edits, svg: { ...initial.svg, routes: [{ id: 'r', name: 'Route', color: '#E4002B', width: 0.6, lines: [[[0, 0], [0.001, 0]]] }], hiddenLines: [[[0, 1], [0.001, 1]]] } });
    const { routes, hiddenLines } = useApp.getState().svg;
    resetAllSettings();
    expect(useApp.getState().edits).toBe(edits);
    expect(useApp.getState().svg.routes).toBe(routes);
    expect(useApp.getState().svg.hiddenLines).toBe(hiddenLines);
  });

  it("puts a layer's options back but leaves it on or off", () => {
    patchSettings('lidar', { enabled: true, roofMode: 'heights', minFootprintMm2: 3 });
    resetSettingsSection('lidar', ['enabled']);
    expect(useApp.getState().settings.lidar).toEqual({ ...cloneSettings().lidar, enabled: true });
    patchSettings('terrain', { elevation: false, exaggeration: 3 });
    resetSettingsSection('terrain', ['elevation']);
    expect(useApp.getState().settings.terrain).toEqual({ ...cloneSettings().terrain, elevation: false });
    patchSettings('lidarModel', { waterMode: 'cut' });
    resetSettingsSection('lidarModel');
    expect(useApp.getState().settings.lidarModel).toEqual(cloneSettings().lidarModel);
  });
});
