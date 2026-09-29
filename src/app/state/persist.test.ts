import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AREA, DEFAULT_EXPORT, DEFAULT_PALETTE, cloneSettings } from '../../core/settings';
import { defaultSvgSettings } from '../svgmap/settings';
import { STORAGE_KEY, clearSavedState, saveState } from './persist';

afterEach(() => vi.unstubAllGlobals());

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
