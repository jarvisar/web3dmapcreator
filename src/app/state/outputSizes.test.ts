import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyEdits } from '../../core/edit/types';
import { DEFAULT_AREA, DEFAULT_EXPORT, DEFAULT_PALETTE, DEFAULT_SETTINGS, cloneSettings } from '../../core/settings';
import { defaultSvgSettings } from '../svgmap/settings';
import { loadSaved, saveState } from './persist';
import { setArea, setOutput, setScaleLock, useApp } from './store';

const state = () => useApp.getState();

describe('switching between a model and an SVG map', () => {
  beforeEach(() => {
    setOutput('model');
    useApp.setState({ settings: structuredClone(DEFAULT_SETTINGS), svg: defaultSvgSettings(), areaSizes: {} });
    // 170.5 x 119.5 mm at 0.07 mm per metre.
    setArea((area) => ({ ...area, center: [-87.63, 41.88], shape: 'rectangle', widthM: 2435.71, heightM: 1707.14 }));
  });

  it('gives a model back the size it had', () => {
    setOutput('svg');
    expect(state().area.widthM).not.toBeCloseTo(2435.71, 0);
    setOutput('model');
    expect(state().area.widthM).toBeCloseTo(2435.71, 2);
    expect(state().area.heightM).toBeCloseTo(1707.14, 2);
  });

  it('keeps where the area was moved to in the other output', () => {
    setOutput('svg');
    setArea((area) => ({ ...area, center: [2.35, 48.85] }));
    setOutput('model');
    expect(state().area.center).toEqual([2.35, 48.85]);
    expect(state().area.widthM).toBeCloseTo(2435.71, 2);
  });

  it('gives an unlocked SVG map back its scale', () => {
    setOutput('svg');
    setScaleLock(false);
    setArea((area) => ({ ...area, widthM: 5000 }));
    const scale = state().svg.scale;
    setOutput('model');
    setOutput('svg');
    expect(state().svg.scale).toBeCloseTo(scale, 6);
  });

  it('fits a kept size to a shape picked in the other output', () => {
    setOutput('svg');
    setArea((area) => ({ ...area, shape: 'circle' }));
    setOutput('model');
    expect(state().area.shape).toBe('circle');
    expect(state().area.widthM).toBeCloseTo(1707.14, 2);
    expect(state().area.heightM).toBeCloseTo(1707.14, 2);
  });
});

describe('the kept sizes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('are saved, and broken ones dropped', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
    saveState(
      {
        output: 'svg',
        area: DEFAULT_AREA,
        areaSizes: { model: { widthM: 2435.71, heightM: 1707.14 } },
        settings: cloneSettings(),
        palette: DEFAULT_PALETTE,
        exportSettings: DEFAULT_EXPORT,
        edits: emptyEdits(),
        svg: defaultSvgSettings(),
        placeName: '',
        fileName: null,
        ui: { sections: {}, basemap: 'streets', showBed: true, sizeUnit: 'mm', mapHintDismissed: false, previewLook: 'material' },
      },
      '#a=1',
    );
    expect(loadSaved().areaSizes).toEqual({ model: { widthM: 2435.71, heightM: 1707.14 } });
    const raw = JSON.parse(stored.get('jarvizar-city-model:v1')!);
    raw.areaSizes = { model: { widthM: -5, heightM: 'x' }, svg: { widthM: 3000, heightM: 2000 } };
    stored.set('jarvizar-city-model:v1', JSON.stringify(raw));
    expect(loadSaved().areaSizes).toEqual({ svg: { widthM: 3000, heightM: 2000 } });
  });
});
