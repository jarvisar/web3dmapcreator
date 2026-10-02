import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AREA } from '../../core/settings';
import { normalizeArea } from '../lib/area';
import { STORAGE_KEY } from './persist';
import { formatAreaHash } from './shareLink';
import { CUSTOM_FONT_ID } from '../../core/svgmap/text/fonts';
import { DEFAULT_LABEL } from '../../core/svgmap/text/label';
import { defaultSvgSettings } from '../svgmap/settings';
import { encodeSvgSettings } from '../svgmap/share';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A page with storage, an address bar and event listeners, before the app's modules load.
async function page(saved: Record<string, string>, hash: string) {
  const stored = new Map(Object.entries(saved));
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const on = (type: string, listener: (event: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  const off = (type: string, listener: (event: unknown) => void) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener));
  const location = { hash, href: `http://localhost/${hash}` };
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { state: null, replaceState: (_state: unknown, _title: string, url: string) => (location.hash = url) });
  vi.stubGlobal('window', { addEventListener: on, removeEventListener: off, setTimeout: (run: () => void, ms: number) => setTimeout(run, ms) });
  vi.stubGlobal('document', { addEventListener: on, visibilityState: 'visible' });
  vi.useFakeTimers();
  vi.resetModules();
  const store = await import('./store');
  const sync = await import('./sync');
  sync.startSync();
  const fire = (type: string, event: object = {}) => listeners.get(type)?.forEach((listener) => listener(event));
  // Another tab saving its settings.
  const saveElsewhere = (value: string) => {
    stored.set(STORAGE_KEY, value);
    fire('storage', { storageArea: localStorage, key: STORAGE_KEY, newValue: value });
  };
  const settings = () => JSON.parse(stored.get(STORAGE_KEY) ?? '{}').settings;
  const asks = () => (listeners.get('beforeunload') ?? []).length > 0;
  return { stored, store, fire, saveElsewhere, settings, asks };
}

const area = normalizeArea(DEFAULT_AREA);
const hash = formatAreaHash(area);
const savedWith = (trees: boolean) => JSON.stringify({ hash, output: 'model', area, settings: { trees: { enabled: trees } } });

describe('saving the settings', () => {
  it("leaves another tab's settings alone when this tab changed nothing", async () => {
    const { stored, fire, settings } = await page({ [STORAGE_KEY]: savedWith(false) }, hash);
    // The other tab turns trees on and saves.
    stored.set(STORAGE_KEY, savedWith(true));
    fire('pagehide');
    expect(settings().trees.enabled).toBe(true);
  });

  it('saves a change on pagehide, before its timer runs', async () => {
    const { store, fire, settings } = await page({ [STORAGE_KEY]: savedWith(false) }, hash);
    store.patchSettings('rim', { enabled: true });
    fire('pagehide');
    expect(settings().rim.enabled).toBe(true);
  });

  it("doesn't write a saved change again once it's idle", async () => {
    const { stored, store, fire, settings } = await page({ [STORAGE_KEY]: savedWith(false) }, hash);
    store.patchSettings('rim', { enabled: true });
    vi.advanceTimersByTime(1000);
    expect(settings().rim.enabled).toBe(true);
    stored.set(STORAGE_KEY, savedWith(true));
    fire('pagehide');
    expect(settings().trees.enabled).toBe(true);
  });

  it('saves a first visit and a share link, which differ from what is stored', async () => {
    let tab = await page({}, '');
    tab.fire('pagehide');
    expect(tab.settings()).toBeDefined();
    const linked = formatAreaHash({ ...area, center: [2.35, 48.85] });
    tab = await page({ [STORAGE_KEY]: savedWith(false) }, linked);
    tab.stored.set(STORAGE_KEY, savedWith(true));
    tab.fire('pagehide');
    expect(JSON.parse(tab.stored.get(STORAGE_KEY)!).hash).toBe(linked);
  });

  it("lets another tab's save stand over a first visit nobody changed", async () => {
    let tab = await page({}, '');
    tab.saveElsewhere(savedWith(true));
    tab.fire('pagehide');
    expect(tab.settings().trees.enabled).toBe(true);
    // A change of its own still goes in.
    tab = await page({}, '');
    tab.store.patchSettings('rim', { enabled: true });
    tab.saveElsewhere(savedWith(true));
    tab.fire('pagehide');
    expect(tab.settings().rim.enabled).toBe(true);
  });
});

describe('leaving the page', () => {
  it('asks while a model is made, and until it has been downloaded', async () => {
    const { store, asks } = await page({ [STORAGE_KEY]: savedWith(false) }, hash);
    expect(asks()).toBe(false);
    store.patchGeneration({ status: 'running' });
    expect(asks()).toBe(true);
    const result = { version: 3, exportable: true } as never;
    store.patchGeneration({ status: 'done', result });
    expect(asks()).toBe(true);
    store.patchExporting({ last: { fileName: 'city-model.3mf', format: 'bambu', plates: 1, warnings: [], bytes: 1, version: 3 } });
    expect(asks()).toBe(false);
    // A model of new settings, not downloaded yet.
    store.patchGeneration({ result: { version: 4, exportable: true } as never });
    expect(asks()).toBe(true);
    // Once the worker that held it is gone it can't be downloaded anyway.
    store.patchGeneration({ result: { version: 4, exportable: false } as never });
    expect(asks()).toBe(false);
  });
});

describe('share links', () => {
  it('say when the edits in one could not be read', async () => {
    const { store } = await page({ [STORAGE_KEY]: savedWith(false) }, `${hash}&e=cut-short`);
    expect(store.useApp.getState().toasts.map((t) => t.text).join(' ')).toMatch(/couldn't be read/);
  });

  it('pasted into an open tab drop a custom title font this browser lacks', async () => {
    const tab = await page({ [STORAGE_KEY]: savedWith(false) }, hash);
    const svg = defaultSvgSettings();
    svg.label = { ...svg.label, font: CUSTOM_FONT_ID, subtitleFont: CUSTOM_FONT_ID };
    location.hash = `${formatAreaHash(area, 'svg')}&s=${encodeSvgSettings(svg)}`;
    tab.fire('hashchange');
    const label = tab.store.useApp.getState().svg.label;
    expect(label.font).toBe(DEFAULT_LABEL.font);
    expect(label.subtitleFont).toBe('');
  });
});
