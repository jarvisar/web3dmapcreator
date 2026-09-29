// App state. Heavy mesh arrays never go in here: see model.ts. Neither does
// a rendered SVG map: see svgmap/render.ts.

import { create } from 'zustand';
import type { LidarSummary, ProgressEvent, SurfaceSummary } from '../../core/engine/protocol';
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
  ModelSource,
  Palette,
  PaletteEntry,
} from '../../core/settings';
import type { BorderSettings } from '../../core/svgmap/layout/layout';
import type { CleanupSettings } from '../../core/svgmap/lines/cleanup';
import { PRODUCT_PRESETS } from '../../core/svgmap/presets';
import { LASER_PALETTES, type ModeStyle, type OutputMode, PRINT_THEMES, type PlotterSettings, printStyle } from '../../core/svgmap/settings';
import type { LabelSettings } from '../../core/svgmap/text/label';
import type { FeatureFilters } from '../../core/svgmap/tiles/schema';
import type { ColourGroup, MaterialRole, ModelStats } from '../../core/types';
import { normalizeArea } from '../lib/area';
import { type PieceFit, areaShapeOf, fitAreaToPiece, pieceLayout } from '../svgmap/piece';
import { useSvgRender } from '../svgmap/render';
import { type CleanupPreset, type LaserPalette, type PieceSize, type SvgSettings, cleanupForPreset, defaultSvgSettings } from '../svgmap/settings';
import { loadSaved } from './persist';
import type { Options } from './options';
import { type Output, readHash } from './shareLink';

export type { Output };
/** The map, or what was made from it: the 3D model or the SVG preview. */
export type View = 'map' | 'result';
export type SectionKey =
  | 'area'
  | 'print'
  | 'layers'
  | 'colours'
  | 'export'
  | 'piece'
  | 'output'
  | 'svgLayers'
  | 'title'
  | 'cleanup'
  | 'data';
export type LayerKey = 'terrain' | 'water' | 'land' | 'roads' | 'bridges' | 'buildings' | 'lidar' | 'trees' | 'rim';
export type BasemapKey = 'streets' | 'light' | 'satellite';
/** 'mm' is the printed size. */
export type SizeUnit = 'km' | 'm' | 'mm';
/** How the SVG preview shows a laser file: burnt into wood, or in its layer colours. */
export type PreviewLook = 'material' | 'colors';

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
  surface?: SurfaceSummary;
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
  /** Open layer rows. SVG map rows are keyed `svg:<layer>`. */
  layers: Partial<Record<string, boolean>>;
  drawerOpen: boolean;
  helpOpen: boolean;
  basemap: BasemapKey;
  showBed: boolean;
  hiddenParts: string[];
  mapFocus: MapFocus;
  sizeUnit: SizeUnit;
  mapHintDismissed: boolean;
  previewLook: PreviewLook;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
}

export interface AppState {
  /** What to make: a 3D model or an SVG map. */
  output: Output;
  area: AreaSpec;
  settings: ModelSettings;
  palette: Palette;
  exportSettings: ExportSettings;
  svg: SvgSettings;
  /** Name of the title font the user loaded, set once the file is read back from IndexedDB. */
  customFontName: string | null;
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
  piece: true,
  output: true,
  svgLayers: false,
  title: false,
  cleanup: false,
  data: false,
};

function initialState(): AppState {
  const saved = loadSaved();
  // The app keeps its own area in the hash too. Only a different hash is a share link.
  const shared = typeof location !== 'undefined' && location.hash !== saved.hash ? readHash() : null;
  const output = shared?.output ?? saved.output ?? 'model';
  let svg = shared?.svg?.svg ?? saved.svg ?? defaultSvgSettings();
  let area = normalizeArea({
    ...(shared?.area ?? saved.area ?? DEFAULT_AREA),
    ...shared?.svg?.area,
    ...(shared?.svg?.shape ? { shape: shared.svg.shape } : {}),
  });
  if (output === 'svg') {
    const fitted = fitAreaToPiece(area, svg);
    area = fitted.area;
    svg = { ...svg, scale: fitted.scale };
  }
  const linked = Boolean(shared?.area || shared?.svg);
  return {
    output,
    area,
    settings: saved.settings ?? cloneSettings(DEFAULT_SETTINGS),
    palette: saved.palette ?? structuredClone(DEFAULT_PALETTE),
    exportSettings: saved.exportSettings ?? { ...DEFAULT_EXPORT },
    svg,
    customFontName: null,
    // A first visit starts on the default area, so name files after it.
    placeName: linked ? '' : (saved.placeName ?? (saved.area ? '' : 'Chicago Loop')),
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
      sizeUnit: saved.sizeUnit ?? 'mm',
      mapHintDismissed: saved.mapHintDismissed ?? false,
      previewLook: saved.previewLook ?? 'material',
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

/** Whether the current output has something to show in the result view. */
export function hasResult(state: Pick<AppState, 'output' | 'generation'>): boolean {
  return state.output === 'model' ? state.generation.result !== null : useSvgRender.getState().result !== null;
}

// A tidy area. In SVG mode it's the piece's map window, so it's fitted again
// whenever the area or the piece changes.
function fitForOutput(
  output: Output,
  area: AreaSpec,
  svg: SvgSettings,
  fit: PieceFit = 'width',
): { area: AreaSpec; svg: SvgSettings } {
  if (output !== 'svg') return { area: normalizeArea(area), svg };
  const fitted = fitAreaToPiece(area, svg, fit);
  return { area: fitted.area, svg: fitted.scale === svg.scale ? svg : { ...svg, scale: fitted.scale } };
}

// ------------------------------------------------------------------ area

export interface SetAreaOptions {
  /** Ask the map to frame the area. */
  focus?: MapFocus['mode'];
  /** Replace the place name. '' clears it. */
  placeName?: string;
  /** Replace the SVG map's title. */
  title?: string;
  /** How an SVG map's window takes this area's size: see PieceFit. */
  fit?: PieceFit;
}

export function setArea(next: AreaSpec | ((area: AreaSpec) => AreaSpec), options: SetAreaOptions = {}): void {
  set((state) => {
    // Not normalised yet: a round SVG piece has to see the whole box to cover it.
    const requested = typeof next === 'function' ? next(state.area) : next;
    let svg = state.svg;
    if (requested.shape !== state.area.shape) {
      // The shape is shared, so a new one is a custom piece.
      const preset = PRODUCT_PRESETS.find((item) => item.id === svg.productPreset);
      const productPreset = preset && areaShapeOf(preset.product.shape) === requested.shape ? svg.productPreset : 'custom';
      const cornerRadius = requested.shape === 'rounded' && svg.product.cornerRadius === 0 ? 6 : svg.product.cornerRadius;
      svg = { ...svg, productPreset, product: { ...svg.product, cornerRadius } };
    }
    if (options.title !== undefined) svg = { ...svg, label: { ...svg.label, text: options.title } };
    const fitted = fitForOutput(state.output, requested, svg, options.fit);
    const area = fitted.area;
    const patch: Partial<AppState> = { area, svg: fitted.svg, generation: withStale(state.generation, area, state.settings) };
    if (options.placeName !== undefined) patch.placeName = options.placeName;
    if (options.focus) {
      patch.ui = { ...state.ui, mapFocus: { seq: state.ui.mapFocus.seq + 1, mode: options.focus } };
    }
    return patch;
  });
}

// ---------------------------------------------------------------- output

export function setOutput(output: Output): void {
  set((state) => {
    if (state.output === output) return {};
    const { area, svg } = fitForOutput(output, state.area, state.svg);
    const view = state.ui.view === 'result' && !hasResult({ output, generation: state.generation }) ? 'map' : state.ui.view;
    return {
      output,
      area,
      svg,
      generation: withStale(state.generation, area, state.settings),
      ui: { ...state.ui, view },
    };
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

export function setModelSource(modelSource: ModelSource): void {
  set((state) => {
    const settings = { ...state.settings, modelSource };
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

/** Settings, colours and export options of both outputs back to their defaults. The area, SVG title and scale lock are kept. */
export function resetAllSettings(): void {
  set((state) => {
    const settings = cloneSettings(DEFAULT_SETTINGS);
    const defaults = defaultSvgSettings();
    const reset: SvgSettings = {
      ...defaults,
      label: { ...defaults.label, text: state.svg.label.text },
      scale: state.svg.scale,
      scaleLocked: state.svg.scaleLocked,
    };
    const { area, svg } = fitForOutput(state.output, state.area, reset);
    return {
      area,
      settings,
      svg,
      palette: structuredClone(DEFAULT_PALETTE),
      exportSettings: { ...DEFAULT_EXPORT },
      fileName: null,
      generation: withStale(state.generation, area, settings),
    };
  });
}

export function applyOptions(options: Options, includeArea = true): void {
  set((state) => {
    const { map, ...imported } = structuredClone(options);
    const savedMap = includeArea ? map : undefined;
    const requestedArea = savedMap?.area ?? state.area;
    // A piece preset also names a shape, which an options-only import keeps.
    const preset = PRODUCT_PRESETS.find((item) => item.id === imported.svg.productPreset);
    if (preset && areaShapeOf(preset.product.shape) !== requestedArea.shape) imported.svg.productPreset = 'custom';
    const { error } = pieceLayout(imported.svg.product, requestedArea.shape, imported.svg.border);
    if (error) throw new Error(`Invalid SVG options: ${error}`);
    const { area, svg } = fitForOutput(imported.output, requestedArea, imported.svg);
    const view = state.ui.view === 'result' && !hasResult({ output: imported.output, generation: state.generation }) ? 'map' : state.ui.view;
    return {
      ...imported,
      area,
      svg,
      ...(savedMap ? { placeName: savedMap.placeName, fileName: savedMap.fileName } : {}),
      generation: withStale(state.generation, area, imported.settings),
      ui: { ...state.ui, view, ...(savedMap ? { mapFocus: { seq: state.ui.mapFocus.seq + 1, mode: 'always' as const } } : {}) },
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

// --------------------------------------------------------------- SVG map

type SvgPatch = Partial<SvgSettings> | ((svg: SvgSettings) => Partial<SvgSettings>);

// Changes that affect the piece fit the area again, so a locked scale holds
// and an unlocked one follows the new map window.
function updateSvg(patch: SvgPatch, extra: (state: AppState) => Partial<AppState> = () => ({})): void {
  set((state) => {
    const changed = { ...state.svg, ...(typeof patch === 'function' ? patch(state.svg) : patch) };
    const more = extra(state);
    const { area, svg } = fitForOutput(state.output, more.area ?? state.area, changed);
    return { ...more, area, svg, generation: withStale(state.generation, area, state.settings) };
  });
}

export function patchSvg(patch: SvgPatch): void {
  updateSvg(patch);
}

export function setPieceSize(patch: Partial<PieceSize>): void {
  updateSvg((svg) => ({ product: { ...svg.product, ...patch }, productPreset: 'custom' }));
}

export function setBorder(patch: Partial<BorderSettings>): void {
  updateSvg((svg) => ({ border: { ...svg.border, ...patch } }));
}

export function applyPiecePreset(id: string): void {
  const preset = PRODUCT_PRESETS.find((item) => item.id === id);
  if (!preset) {
    updateSvg({ productPreset: 'custom' });
    return;
  }
  const { shape, ...size } = structuredClone(preset.product);
  updateSvg(
    (svg) => ({
      productPreset: id,
      product: size,
      border: { ...svg.border, style: preset.border },
      label: { ...svg.label, style: preset.labelStyle },
    }),
    (state) => ({ area: { ...state.area, shape: areaShapeOf(shape) } }),
  );
}

export function setSvgMode(mode: OutputMode): void {
  updateSvg((svg) => ({
    mode,
    cleanup:
      svg.cleanupPreset === 'custom' || svg.cleanupPreset === 'off'
        ? svg.cleanup
        : cleanupForPreset(svg.cleanupPreset, mode, svg.plotter.penWidth, svg.cleanup),
  }));
}

export function setSvgStyle(patch: Partial<ModeStyle>): void {
  updateSvg((svg) => ({ styles: { ...svg.styles, [svg.mode]: { ...svg.styles[svg.mode], ...patch } } }));
}

export function setLaserPalette(laserPalette: LaserPalette): void {
  updateSvg((svg) => ({
    laserPalette,
    styles: { ...svg.styles, laser: { ...svg.styles.laser, colors: { ...LASER_PALETTES[laserPalette].colors } } },
  }));
}

export function setPrintTheme(printTheme: string): void {
  updateSvg((svg) => {
    const theme = printStyle(printTheme as keyof typeof PRINT_THEMES);
    return { printTheme, styles: { ...svg.styles, print: { ...svg.styles.print, colors: theme.colors, background: theme.background } } };
  });
}

export function setLabel(patch: Partial<LabelSettings>): void {
  updateSvg((svg) => ({ label: { ...svg.label, ...patch } }));
}

export function setCleanupPreset(preset: CleanupPreset): void {
  updateSvg((svg) => ({ cleanupPreset: preset, cleanup: cleanupForPreset(preset, svg.mode, svg.plotter.penWidth, svg.cleanup) }));
}

export function setCleanup(patch: Partial<CleanupSettings>): void {
  updateSvg((svg) => ({ cleanup: { ...svg.cleanup, ...patch, enabled: true }, cleanupPreset: 'custom' }));
}

export function setFilters(update: (filters: FeatureFilters) => FeatureFilters): void {
  updateSvg((svg) => ({ filters: update(svg.filters) }));
}

export function setPlotter(patch: Partial<PlotterSettings>): void {
  updateSvg((svg) => {
    const plotter = { ...svg.plotter, ...patch };
    const followSpacing = svg.mode === 'plotter' && svg.cleanupPreset !== 'custom' && svg.cleanupPreset !== 'off';
    return { plotter, cleanup: followSpacing ? cleanupForPreset(svg.cleanupPreset, 'plotter', plotter.penWidth, svg.cleanup) : svg.cleanup };
  });
}

export function setScaleLocked(scaleLocked: boolean): void {
  updateSvg({ scaleLocked });
}

/** 1:scale. Sets the map window's width, locked or not. */
export function setSvgScale(scale: number): void {
  const state = get();
  const { layout } = pieceLayout(state.svg.product, state.area.shape, state.svg.border);
  if (!layout || !(scale > 0)) return;
  set({ svg: { ...state.svg, scale } });
  setArea((area) => ({ ...area, widthM: (scale * layout.window.w) / 1000 }));
}

export function setCustomFontName(customFontName: string | null): void {
  set({ customFontName });
}

// -------------------------------------------------------------------- ui

function patchUi(patch: Partial<UiState>): void {
  set((state) => ({ ui: { ...state.ui, ...patch } }));
}

export function setView(view: View): void {
  if (view === 'result' && !hasResult(get())) return;
  patchUi({ view });
}

export function toggleSection(key: SectionKey): void {
  const sections = get().ui.sections;
  patchUi({ sections: { ...sections, [key]: !sections[key] } });
}

export function toggleLayer(key: string): void {
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

export function setPreviewLook(previewLook: PreviewLook): void {
  patchUi({ previewLook });
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
