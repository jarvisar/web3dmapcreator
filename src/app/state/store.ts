// App state. Heavy mesh arrays never go in here: see model.ts.

import { create } from 'zustand';
import type { LidarSummary, ProgressEvent } from '../../core/engine/protocol';
import {
  DEFAULT_AREA,
  DEFAULT_EXPORT,
  DEFAULT_PALETTE,
  DEFAULT_SETTINGS,
  MIN_SECTION_MM,
  cloneSettings,
  printerByKey,
} from '../../core/settings';
import type {
  AreaSpec,
  ExportFormat,
  ExportSettings,
  ModelSettings,
  Palette,
  PaletteEntry,
} from '../../core/settings';
import type { ColourGroup, MaterialRole, ModelStats } from '../../core/types';
import { normalizeArea } from '../lib/area';
import { loadSaved } from './persist';
import { readHashArea } from './shareLink';

export type View = 'map' | 'model';
export type SectionKey = 'area' | 'print' | 'layers' | 'colours' | 'export';
export type LayerKey = 'terrain' | 'water' | 'land' | 'roads' | 'bridges' | 'buildings' | 'lidar' | 'trees' | 'rim';
export type BasemapKey = 'streets' | 'light' | 'satellite';
/** 'mm' is the printed size. */
export type SizeUnit = 'km' | 'm' | 'mm';

export interface PartInfo {
  id: string;
  name: string;
  role: MaterialRole;
  triangles: number;
}

export interface ResultMeta {
  /** Bumped for every new model, so the viewer knows to reload. */
  version: number;
  /** Area and settings the model was made from, to tell when it is stale. */
  key: string;
  bounds: [number, number, number, number, number, number];
  mmPerMetre: number;
  release: string;
  stats: ModelStats;
  warnings: string[];
  timings: Record<string, number>;
  parts: PartInfo[];
  triangles: number;
  lidar?: LidarSummary;
  /** False once the worker holding this model was replaced, so it cannot be exported. */
  exportable: boolean;
}

export type GenerationStatus = 'idle' | 'running' | 'done' | 'error';

export interface GenerationState {
  status: GenerationStatus;
  progress: ProgressEvent | null;
  startedAt: number;
  cancelling: boolean;
  error: string | null;
  result: ResultMeta | null;
  stale: boolean;
}

export interface ExportState {
  status: 'idle' | 'running';
  progress: ProgressEvent | null;
  error: string | null;
  last: { fileName: string; format: ExportFormat; plates: number; warnings: string[]; bytes: number } | null;
}

export interface MapFocus {
  seq: number;
  mode: 'always' | 'if-needed';
}

export interface UiState {
  view: View;
  sections: Record<SectionKey, boolean>;
  layers: Partial<Record<LayerKey, boolean>>;
  drawerOpen: boolean;
  helpOpen: boolean;
  basemap: BasemapKey;
  showBed: boolean;
  hiddenParts: string[];
  mapFocus: MapFocus;
  sizeUnit: SizeUnit;
  mapHintDismissed: boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
}

export interface AppState {
  area: AreaSpec;
  settings: ModelSettings;
  palette: Palette;
  exportSettings: ExportSettings;
  /** Name of the searched place or preset, used for file names. */
  placeName: string;
  /** File name typed by the user, or null to follow the place name. */
  fileName: string | null;
  ui: UiState;
  generation: GenerationState;
  exporting: ExportState;
  toasts: Toast[];
}

export const DEFAULT_SECTIONS: Record<SectionKey, boolean> = {
  area: true,
  print: true,
  layers: false,
  colours: false,
  export: false,
};

function initialState(): AppState {
  const saved = loadSaved();
  // The app keeps its own area in the hash too. Only a different hash is a share link.
  const hashArea = typeof location !== 'undefined' && location.hash !== saved.hash ? readHashArea() : null;
  return {
    area: normalizeArea(hashArea ?? saved.area ?? DEFAULT_AREA),
    settings: saved.settings ?? cloneSettings(DEFAULT_SETTINGS),
    palette: saved.palette ?? structuredClone(DEFAULT_PALETTE),
    exportSettings: saved.exportSettings ?? { ...DEFAULT_EXPORT },
    // A first visit starts on the default area, so name files after it.
    placeName: hashArea ? '' : (saved.placeName ?? (saved.area ? '' : 'Chicago Loop')),
    fileName: saved.fileName ?? null,
    ui: {
      view: 'map',
      sections: { ...DEFAULT_SECTIONS, ...saved.sections },
      layers: {},
      drawerOpen: false,
      helpOpen: false,
      basemap: saved.basemap ?? 'streets',
      showBed: saved.showBed ?? true,
      hiddenParts: [],
      mapFocus: { seq: 0, mode: 'always' },
      sizeUnit: saved.sizeUnit ?? 'km',
      mapHintDismissed: saved.mapHintDismissed ?? false,
    },
    generation: {
      status: 'idle',
      progress: null,
      startedAt: 0,
      cancelling: false,
      error: null,
      result: null,
      stale: false,
    },
    exporting: { status: 'idle', progress: null, error: null, last: null },
    toasts: [],
  };
}

export const useApp = create<AppState>()(() => initialState());

const set = useApp.setState;
const get = useApp.getState;

export function snapshotKey(area: AreaSpec, settings: ModelSettings): string {
  return JSON.stringify([area, settings]);
}

function withStale(generation: GenerationState, area: AreaSpec, settings: ModelSettings): GenerationState {
  if (!generation.result) return generation;
  const stale = generation.result.key !== snapshotKey(area, settings);
  return stale === generation.stale ? generation : { ...generation, stale };
}

// ------------------------------------------------------------------ area

export interface SetAreaOptions {
  /** Ask the map to frame the area. */
  focus?: MapFocus['mode'];
  /** Replace the place name. '' clears it. */
  placeName?: string;
}

export function setArea(next: AreaSpec | ((area: AreaSpec) => AreaSpec), options: SetAreaOptions = {}): void {
  set((state) => {
    const area = normalizeArea(typeof next === 'function' ? next(state.area) : next);
    const patch: Partial<AppState> = { area, generation: withStale(state.generation, area, state.settings) };
    if (options.placeName !== undefined) patch.placeName = options.placeName;
    if (options.focus) {
      patch.ui = { ...state.ui, mapFocus: { seq: state.ui.mapFocus.seq + 1, mode: options.focus } };
    }
    return patch;
  });
}

// -------------------------------------------------------------- settings

export type SettingsSection = { [K in keyof ModelSettings]: ModelSettings[K] extends object ? K : never }[keyof ModelSettings];

export function patchSettings<K extends SettingsSection>(key: K, patch: Partial<ModelSettings[K]>): void {
  set((state) => {
    const settings = { ...state.settings, [key]: { ...state.settings[key], ...patch } } as ModelSettings;
    return { settings, generation: withStale(state.generation, state.area, settings) };
  });
}

export function setSupports(supports: boolean): void {
  set((state) => {
    const settings = { ...state.settings, supports };
    return { settings, generation: withStale(state.generation, state.area, settings) };
  });
}

export function resetSettingsSection(key: SettingsSection): void {
  set((state) => {
    const settings = { ...state.settings, [key]: structuredClone(DEFAULT_SETTINGS[key]) } as ModelSettings;
    return { settings, generation: withStale(state.generation, state.area, settings) };
  });
}

/** Settings, colours and export options back to their defaults. The area is kept. */
export function resetAllSettings(): void {
  set((state) => {
    const settings = cloneSettings(DEFAULT_SETTINGS);
    return {
      settings,
      palette: structuredClone(DEFAULT_PALETTE),
      exportSettings: { ...DEFAULT_EXPORT },
      fileName: null,
      generation: withStale(state.generation, state.area, settings),
    };
  });
}

// --------------------------------------------------------------- palette

export function setPaletteEntry(group: ColourGroup, entry: PaletteEntry): void {
  set((state) => ({ palette: { ...state.palette, [group]: { hex: entry.hex.toUpperCase(), line: entry.line } } }));
}

export function setPalette(palette: Palette): void {
  set({ palette: structuredClone(palette) });
}

// ---------------------------------------------------------------- export

export function patchExport(patch: Partial<ExportSettings>): void {
  set((state) => {
    const next = { ...state.exportSettings, ...patch };
    const bed = printerByKey(next.printer);
    next.printer = bed.key;
    next.sectionWidthMm = Math.min(bed.width, Math.max(MIN_SECTION_MM, next.sectionWidthMm));
    next.sectionHeightMm = Math.min(bed.depth, Math.max(MIN_SECTION_MM, next.sectionHeightMm));
    return { exportSettings: next };
  });
}

export function setFileName(fileName: string | null): void {
  set({ fileName });
}

// -------------------------------------------------------------------- ui

function patchUi(patch: Partial<UiState>): void {
  set((state) => ({ ui: { ...state.ui, ...patch } }));
}

export function setView(view: View): void {
  if (view === 'model' && !get().generation.result) return;
  patchUi({ view });
}

export function toggleSection(key: SectionKey): void {
  const sections = get().ui.sections;
  patchUi({ sections: { ...sections, [key]: !sections[key] } });
}

export function toggleLayer(key: LayerKey): void {
  const layers = get().ui.layers;
  patchUi({ layers: { ...layers, [key]: !layers[key] } });
}

export function setDrawerOpen(drawerOpen: boolean): void {
  patchUi({ drawerOpen });
}

export function setHelpOpen(helpOpen: boolean): void {
  patchUi({ helpOpen });
}

export function setBasemap(basemap: BasemapKey): void {
  patchUi({ basemap });
}

export function setShowBed(showBed: boolean): void {
  patchUi({ showBed });
}

export function setSizeUnit(sizeUnit: SizeUnit): void {
  patchUi({ sizeUnit });
}

export function dismissMapHint(): void {
  patchUi({ mapHintDismissed: true });
}

export function togglePartHidden(id: string): void {
  const hidden = get().ui.hiddenParts;
  patchUi({ hiddenParts: hidden.includes(id) ? hidden.filter((item) => item !== id) : [...hidden, id] });
}

export function setHiddenParts(hiddenParts: string[]): void {
  patchUi({ hiddenParts });
}

// ------------------------------------------------------------ generation

export function patchGeneration(patch: Partial<GenerationState>): void {
  set((state) => ({ generation: { ...state.generation, ...patch } }));
}

export function patchExporting(patch: Partial<ExportState>): void {
  set((state) => ({ exporting: { ...state.exporting, ...patch } }));
}

export function dismissExportError(): void {
  patchExporting({ error: null });
}

export function dismissGenerationError(): void {
  const generation = get().generation;
  if (generation.status !== 'error') return;
  patchGeneration({ status: generation.result ? 'done' : 'idle', error: null });
}

// ---------------------------------------------------------------- toasts

let nextToast = 1;

export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  const id = nextToast++;
  set((state) => ({ toasts: [...state.toasts.slice(-2), { id, text, tone }] }));
  setTimeout(() => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })), tone === 'error' ? 5000 : 2800);
}
