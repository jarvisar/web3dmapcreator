import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyEdits } from '../../core/edit/types';
import { DEFAULT_AREA, DEFAULT_EXPORT, DEFAULT_PALETTE, cloneSettings } from '../../core/settings';
import { defaultSvgSettings } from '../svgmap/settings';
import { EDITS_KEY, PICKS_KEY, STORAGE_KEY, clearSavedState, isSaved, loadSaved, markSaved, readStoredEdits, readStoredPicks, saveState } from './persist';

afterEach(() => vi.unstubAllGlobals());

function storage(refuse: (key: string) => boolean = () => false) {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refuse(key)) throw new DOMException('Full', 'QuotaExceededError');
      stored.set(key, value);
    },
    removeItem: (key: string) => void stored.delete(key),
  });
  return stored;
}

function sample() {
  const svg = defaultSvgSettings();
  svg.routes = [{ id: 'r', name: 'Home', color: '#E4002B', width: 0.6, lines: [[[-87.63, 41.88], [-87.62, 41.88]]] }];
  return {
    output: 'model' as const,
    area: DEFAULT_AREA,
    settings: cloneSettings(),
    palette: DEFAULT_PALETTE,
    exportSettings: DEFAULT_EXPORT,
    edits: { ...emptyEdits(), objects: { 'b:1': { heightM: 42 } } },
    svg,
    placeName: 'Somewhere',
    fileName: null,
    ui: { sections: {}, basemap: 'light', showBed: false, sizeUnit: 'mm', mapHintDismissed: false, previewLook: 'material' },
  };
}

describe('saved edits and picked roads', () => {
  it('have keys of their own, and come back together', () => {
    const stored = storage();
    expect(saveState(sample(), '#a=1')).toBe(true);
    const main = JSON.parse(stored.get(STORAGE_KEY)!);
    expect(main.edits).toBeUndefined();
    expect(main.svg.routes).toBeUndefined();
    expect(JSON.parse(stored.get(EDITS_KEY)!).objects['b:1'].heightM).toBe(42);
    expect(JSON.parse(stored.get(PICKS_KEY)!).routes).toHaveLength(1);
    const loaded = loadSaved();
    expect(loaded.edits.objects['b:1']).toEqual({ heightM: 42 });
    expect(loaded.picks.routes[0].name).toBe('Home');
    expect(loaded.svg?.routes).toEqual([]);
    expect(loaded.placeName).toBe('Somewhere');
  });

  it('are read even when the saved settings are broken or gone', () => {
    const stored = storage();
    saveState(sample(), '#a=1');
    stored.set(STORAGE_KEY, '{not json');
    let loaded = loadSaved();
    expect(loaded.edits.objects['b:1']).toEqual({ heightM: 42 });
    expect(loaded.picks.routes[0].name).toBe('Home');
    stored.delete(STORAGE_KEY);
    loaded = loadSaved();
    expect(loaded.edits.objects['b:1']).toEqual({ heightM: 42 });
    expect(loaded.area).toBeUndefined();
  });

  it("aren't written by a tab that didn't change them, so an idle tab can't put an old copy back", () => {
    const stored = storage();
    saveState(sample(), '#a=1');
    const loaded = loadSaved();
    const state = { ...sample(), edits: loaded.edits, svg: { ...sample().svg, routes: loaded.picks.routes, hiddenLines: loaded.picks.hiddenLines } };
    // Another tab saves while this one sits there.
    stored.set(EDITS_KEY, JSON.stringify({ ...emptyEdits(), objects: { 'b:2': { removed: true } } }));
    stored.set(PICKS_KEY, JSON.stringify({ routes: [], hiddenLines: [] }));
    saveState(state, '#a=1');
    expect(JSON.parse(stored.get(EDITS_KEY)!).objects).toEqual({ 'b:2': { removed: true } });
    expect(JSON.parse(stored.get(PICKS_KEY)!).routes).toEqual([]);
    // A change of its own is written.
    saveState({ ...state, edits: { ...emptyEdits(), objects: { 'b:3': { removed: true } } } }, '#a=1');
    expect(JSON.parse(stored.get(EDITS_KEY)!).objects).toEqual({ 'b:3': { removed: true } });
  });

  it("tell a change of this tab's own from what another tab saved", () => {
    storage();
    const loaded = loadSaved();
    expect(isSaved(EDITS_KEY, [loaded.edits])).toBe(true);
    const mine = emptyEdits();
    expect(isSaved(EDITS_KEY, [mine])).toBe(false);
    markSaved(EDITS_KEY, [mine]);
    expect(isSaved(EDITS_KEY, [mine])).toBe(true);
    expect(readStoredEdits(JSON.stringify({ objects: { 'b:1': { removed: true } } }))?.objects).toEqual({ 'b:1': { removed: true } });
    expect(readStoredEdits('nonsense')).toBeNull();
    expect(readStoredPicks(null)).toBeNull();
  });

  it("don't stop the settings saving when they don't fit", () => {
    const stored = storage((key) => key === EDITS_KEY);
    expect(saveState(sample(), '#a=1')).toBe(false);
    expect(JSON.parse(stored.get(STORAGE_KEY)!).placeName).toBe('Somewhere');
    expect(stored.has(PICKS_KEY)).toBe(true);
  });
});

describe('route editor preferences', () => {
  it('come back after a reload, and a snap distance out of range is dropped', () => {
    const stored = storage();
    const state = sample();
    saveState({ ...state, ui: { ...state.ui, routeFollow: false, routeSnapM: 55 } }, '#a=1');
    expect(loadSaved()).toMatchObject({ routeFollow: false, routeSnapM: 55 });
    const main = JSON.parse(stored.get(STORAGE_KEY)!);
    stored.set(STORAGE_KEY, JSON.stringify({ ...main, ui: { ...main.ui, routeSnapM: 5000 } }));
    expect(loadSaved().routeSnapM).toBeUndefined();
  });
});

describe('saved settings', () => {
  it('stay cleared after the crash screen resets them', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
    const state = {
      output: 'model' as const,
      area: DEFAULT_AREA,
      settings: cloneSettings(),
      palette: DEFAULT_PALETTE,
      exportSettings: DEFAULT_EXPORT,
      edits: emptyEdits(),
      svg: defaultSvgSettings(),
      placeName: '',
      fileName: null,
      ui: { sections: {}, basemap: 'light', showBed: false, sizeUnit: 'mm', mapHintDismissed: false, previewLook: 'plain' },
    };
    saveState(state, '#a=1');
    expect(stored.has(STORAGE_KEY)).toBe(true);
    clearSavedState();
    expect(stored.has(STORAGE_KEY)).toBe(false);
    // What the sync still has waiting, and the save on pagehide.
    saveState(state, '#a=1');
    expect(stored.has(STORAGE_KEY)).toBe(false);
  });
});

