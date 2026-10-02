// App state. Heavy mesh arrays never go in here: see model.ts. Neither does
// a rendered SVG map: see svgmap/render.ts.

import { create } from 'zustand';
import { hasEdits, mergeEdits, type ModelEdits } from '../../core/edit/types';
import type { LidarOffer, LidarSummary, ProgressEvent, SurfaceSummary, SurveyChoice } from '../../core/engine/protocol';
import {
  DEFAULT_AREA,
  DEFAULT_EXPORT,
  DEFAULT_PALETTE,
  DEFAULT_SETTINGS,
  MIN_SECTION_MM,
  cloneSettings,
  modelFieldRange,
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
import { DEFAULT_LABEL, type LabelSettings } from '../../core/svgmap/text/label';
import { CUSTOM_FONT_ID } from '../../core/svgmap/text/fonts';
import { mergePicks, type Picks } from '../../core/svgmap/routes';
import type { FeatureFilters } from '../../core/svgmap/tiles/schema';
import type { ColourGroup, MaterialRole, ModelStats } from '../../core/types';
import { effectiveScale } from '../../core/geo/area';
import { surveyQuery } from '../../core/lidar/query';
import { Projection } from '../../core/geo/projection';
import { constrainSize, normalizeArea, scaleArea } from '../lib/area';
import { type PieceFit, areaShapeOf, fitAreaToPiece, pieceLayout } from '../svgmap/piece';
import { useSvgRender } from '../svgmap/render';
import { type CleanupPreset, type LaserPalette, type PieceSize, type SvgSettings, cleanupForPreset, defaultSvgSettings } from '../svgmap/settings';
import { stepBetween, type EditStep } from './history';
import { hasPicks, loadSaved, readBackup, writeBackup, type Backup } from './persist';
import type { Options } from './options';
import { type Output, readHash, unreadableText } from './shareLink';

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
/** What a click does in the 3D editor: select, select several, or add a shape. */
export type EditTool = 'select' | 'several' | 'text' | 'box' | 'cylinder' | 'pin' | 'path' | 'area';

export interface EditHistory {
  past: EditStep[];
  future: EditStep[];
  /** Changes with the same tag in a row (a drag, typing) undo as one. */
  coalesce: string | null;
}
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
  /** LiDAR tiles the last generation offered, for the area and settings in `key`. */
  offers: { key: string; list: LidarOffer[] } | null;
  /** LiDAR surveys found under the area in `key` (surveySearchKey), from a search or the last generation. */
  surveys: SurveySearch | null;
}

export interface SurveySearch {
  key: string;
  status: 'searching' | 'done' | 'error';
  list: SurveyChoice[];
  /** Catalogs that couldn't be searched. */
  failures: string[];
  error?: string;
}

export interface ExportState {
  status: 'idle' | 'running';
  progress: ProgressEvent | null;
  error: string | null;
  /** `version` is the model's (ResultMeta.version). */
  last: { fileName: string; format: ExportFormat; plates: number; warnings: string[]; bytes: number; version: number } | null;
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
  /** LiDAR only grids given in metres may go past what this machine's reported memory allows (core/dsm/grid.ts). Kept on this machine only. */
  largeGrids: boolean;
  /** The 3D viewer is editing the model. */
  editMode: boolean;
  tool: EditTool;
  /** Selected object keys (see core/edit/keys.ts). */
  selection: string[];
  /** The worker hasn't sent back the model for the latest edits yet. */
  editsPending: boolean;
  /** When the wait for it began, or the worker last answered, to tell an update that's stuck. */
  editsSince: number;
  /** One point of a selected path or area, tapped to delete it. */
  activePoint: { shape: string; index: number } | null;
  /** What the worker noted about added shapes, by key. */
  editNotes: Record<string, string>;
  /** The box around what the 3D view shows, edits and hidden parts included, and the model it's for. */
  shownBounds: { version: number; bounds: ResultMeta['bounds'] } | null;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
  /** A button on it, like Undo. */
  action?: { label: string; run: () => void };
}

export type AreaSizes = Partial<Record<Output, { widthM: number; heightM: number }>>;

export interface AppState {
  /** What to make: a 3D model or an SVG map. */
  output: Output;
  area: AreaSpec;
  /** The area's size each output had when it was last left, given back when it's picked again. */
  areaSizes: AreaSizes;
  settings: ModelSettings;
  palette: Palette;
  exportSettings: ExportSettings;
  /** Changes made to the model in the 3D editor, applied to every model of this area. */
  edits: ModelEdits;
  editHistory: EditHistory;
  svg: SvgSettings;
  /** Name of the title font the user loaded, set once the file is read back from IndexedDB. */
  customFontName: string | null;
  /** The loaded font file's fingerprint: another file can have the same name. */
  customFontId: string | null;
  /** Name of the searched place or preset, used for file names. */
  placeName: string;
  /** File name typed by the user, or null to follow the place name. */
  fileName: string | null;
  ui: UiState;
  generation: GenerationState;
  exporting: ExportState;
  toasts: Toast[];
  /** The user's edits or picks from before a link, a file or Undo all replaced them, to put back. */
  backup: Backup | null;
}

/** Undo steps kept for the edits. */
export const HISTORY_LIMIT = 100;

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

/** What a share link or an options file brought in, for the toast that says so and its Undo. */
export interface Brought {
  edits: number;
  picks: number;
  /** Theirs that didn't fit the limits. */
  left: number;
  /** Ours that theirs changed, to keep aside. */
  replaced: { edits?: ModelEdits; picks?: Picks };
  /** The backup that keeps them, once kept. */
  kept?: Backup;
  before: { edits: ModelEdits; picks: Picks };
  after: { edits: ModelEdits; picks: Picks };
}

/**
 * Edits and picks from a share link or an options file, added to these
 * rather than put in their place (mergeEdits, mergePicks). Null when they
 * change nothing.
 */
export function bringIn(edits: ModelEdits, picks: Picks, from: { edits?: ModelEdits | null; picks?: Picks | null }): Brought | null {
  const brought: Brought = { edits: 0, picks: 0, left: 0, replaced: {}, before: { edits, picks }, after: { edits, picks } };
  if (from.edits && hasEdits(from.edits)) {
    const merged = mergeEdits(edits, from.edits);
    if (merged.added || merged.replaced) brought.after.edits = merged.edits;
    if (merged.replaced) brought.replaced.edits = edits;
    brought.edits = merged.added;
    brought.left += merged.left;
  }
  if (from.picks && hasPicks(from.picks)) {
    const merged = mergePicks(picks, from.picks);
    if (merged.added || merged.replaced) brought.after.picks = { routes: merged.routes, hiddenLines: merged.hiddenLines };
    if (merged.replaced) brought.replaced.picks = picks;
    brought.picks = merged.added;
    brought.left += merged.left;
  }
  const changed = brought.after.edits !== edits || brought.after.picks !== picks;
  return changed || brought.left ? brought : null;
}

/** Keeps what a link or a file changed of ours, when it changed anything. Returns the backup in place now. */
export function keepReplaced(brought: Brought, reason: 'link' | 'import', current: Backup | null): Backup | null {
  const { edits, picks } = brought.replaced;
  if (!edits && !picks) return current;
  const backup: Backup = { savedAt: Date.now(), reason, ...(edits ? { edits } : {}), ...(picks ? { picks } : {}) };
  if (!writeBackup(backup)) return current;
  brought.kept = backup;
  return backup;
}

let openedLink: Brought | null = null;
let openedProblem: string | null = null;

/** What the share link the app was opened with brought, once. */
export function takeOpenedLink(): Brought | null {
  const brought = openedLink;
  openedLink = null;
  return brought;
}

/** What couldn't be read of the share link the app was opened with, once. */
export function takeLinkProblem(): string | null {
  const problem = openedProblem;
  openedProblem = null;
  return problem;
}

function initialState(): AppState {
  const saved = loadSaved();
  // The app keeps its own area in the hash too. Only a different hash is a share link.
  const shared = typeof location !== 'undefined' && location.hash !== saved.hash ? readHash() : null;
  openedProblem = shared ? unreadableText(shared) : null;
  const output = shared?.output ?? saved.output ?? 'model';
  // A link's edits and picks are added to what's here. Its SVG settings
  // don't carry picks, so they never clear them.
  openedLink = shared ? bringIn(saved.edits, saved.picks, { edits: shared.edits, picks: shared.picks }) : null;
  const edits = openedLink?.after.edits ?? saved.edits;
  const picks = openedLink?.after.picks ?? saved.picks;
  let svg: SvgSettings = { ...(shared?.svg?.svg ?? saved.svg ?? defaultSvgSettings()), routes: picks.routes, hiddenLines: picks.hiddenLines };
  const backup = openedLink ? keepReplaced(openedLink, 'link', readBackup()) : readBackup();
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
    areaSizes: saved.areaSizes ?? {},
    settings: saved.settings ?? cloneSettings(DEFAULT_SETTINGS),
    palette: saved.palette ?? structuredClone(DEFAULT_PALETTE),
    exportSettings: saved.exportSettings ?? { ...DEFAULT_EXPORT },
    edits,
    editHistory: { past: edits !== saved.edits ? [stepBetween(saved.edits, edits)] : [], future: [], coalesce: null },
    svg,
    customFontName: null,
    customFontId: null,
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
      largeGrids: saved.largeGrids ?? false,
      editMode: false,
      tool: 'select',
      selection: [],
      editsPending: false,
      editsSince: 0,
      activePoint: null,
      editNotes: {},
      shownBounds: null,
    },
    generation: {
      status: 'idle',
      progress: null,
      startedAt: 0,
      cancelling: false,
      error: null,
      result: null,
      stale: false,
      offers: null,
      surveys: null,
    },
    exporting: { status: 'idle', progress: null, error: null, last: null },
    toasts: [],
    backup,
  };
}

export const useApp = create<AppState>()(() => initialState());

const set = useApp.setState;
const get = useApp.getState;

// Keyed by the scale it works out to, so trading a fixed scale for a fitted
// size that gives the same one (the scale and size locks) isn't a change.
/**
 * What decides which surveys are under an area and the order they'd be read
 * in. Its shape doesn't, since surveys are found for its rectangle.
 */
export function surveySearchKey(area: AreaSpec, settings: ModelSettings): string {
  let order: unknown = null;
  try {
    const { rules, tiered } = surveyQuery(area, settings);
    order = [rules, tiered];
  } catch {
    // A cell that can't be worked out yet: the search fails the same way.
  }
  return JSON.stringify([area.center, area.widthM, area.heightM, area.rotationDeg, order]);
}

export function snapshotKey(area: AreaSpec, settings: ModelSettings): string {
  const scale = Number(effectiveScale(area, settings.scale).toPrecision(12));
  return JSON.stringify([area, { ...settings, scale }]);
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
    // Each output keeps its own size, wherever the area has moved since. The
    // place, rotation and shape are shared. Without this, a model came back
    // at the size the SVG map's piece and scale had made, not the one set.
    const areaSizes = { ...state.areaSizes, [state.output]: { widthM: state.area.widthM, heightM: state.area.heightM } };
    const kept = areaSizes[output];
    let requested = state.area;
    if (kept) {
      const [widthM, heightM] = constrainSize(requested.shape, kept.widthM, kept.heightM, 'smaller');
      requested = { ...requested, widthM, heightM };
    }
    const { area, svg } = fitForOutput(output, requested, state.svg);
    const view = state.ui.view === 'result' && !hasResult({ output, generation: state.generation }) ? 'map' : state.ui.view;
    return {
      output,
      area,
      areaSizes,
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

// ---------------------------------------------------------- scale and size

// The area on the map, the scale and the printed size go together, with one
// lock, on the scale. Locked, the scale stays: a model's printed size follows
// the area, and an SVG map's piece can't, so its box only moves and turns.
// Unlocked, the printed size (or piece) stays and the scale follows the area,
// the same for both. Models keep the modes they always had: a fixed scale is
// the lock on, fitting to a size the lock off.
export function scaleLocked(state: { output: Output; svg: { scaleLocked: boolean }; settings: { scale: Pick<ModelSettings['scale'], 'mode'> } }): boolean {
  return state.output === 'svg' ? state.svg.scaleLocked : state.settings.scale.mode === 'fixed';
}

// Whether the box on the map can be resized: not with the scale and the piece both fixed.
export function areaResizable(state: Parameters<typeof scaleLocked>[0]): boolean {
  return !(state.output === 'svg' && scaleLocked(state));
}

const clampTo = (value: number, { min, max }: { min: number; max: number }) => Math.min(max, Math.max(min, value));

// Toggling the lock never changes a model: it switches to the scale or the
// size it works out to now.
export function setScaleLock(locked: boolean): void {
  const { output, area, settings } = get();
  if (output === 'svg') {
    setScaleLocked(locked);
    return;
  }
  const now = effectiveScale(area, settings.scale);
  if (locked) patchSettings('scale', { mode: 'fixed', mmPerMetre: clampTo(now, modelFieldRange('scale', 'mmPerMetre')) });
  else patchSettings('scale', { mode: 'fit', fitMm: clampTo(now * Math.max(area.widthM, area.heightM), modelFieldRange('scale', 'fitMm')) });
}

// A typed scale. With the scale unlocked the printed size stays, so the area
// grows or shrinks around its centre, as far as the area limits allow. Locked,
// a model's printed size follows. Presets, links and options set the scale
// and area together and don't come through here.
export function setScale(mmPerMetre: number): void {
  const { output, area, settings } = get();
  if (output === 'svg') {
    setSvgScale(1000 / mmPerMetre);
    return;
  }
  const now = effectiveScale(area, settings.scale);
  if (settings.scale.mode === 'fixed') patchSettings('scale', { mmPerMetre });
  else if (now > 0 && mmPerMetre > 0 && mmPerMetre !== now) setArea((current) => scaleArea(current, now / mmPerMetre), { focus: 'if-needed' });
}

// A model's printed width or height typed, in mm without the rim. Only that
// side changes, so the area follows at the same scale, locked or not. Letting
// the scale follow while unlocked changed the other side too.
export function setPrintedSide(side: 'width' | 'height', mm: number): void {
  const { area, settings } = get();
  const scale = effectiveScale(area, settings.scale);
  const metres = mm / scale;
  setArea(
    (current) => {
      const [w, h] = constrainSize(current.shape, side === 'width' ? metres : current.widthM, side === 'height' ? metres : current.heightM, side);
      return { ...current, widthM: w, heightM: h };
    },
    { focus: 'if-needed' },
  );
  if (settings.scale.mode === 'fit') {
    const next = get().area;
    patchSettings('scale', { fitMm: clampTo(scale * Math.max(next.widthM, next.heightM), modelFieldRange('scale', 'fitMm')) });
  }
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

/** `keep` names fields that stay as they are, like the switch that turns a layer on. */
export function resetSettingsSection(key: SettingsSection, keep: readonly string[] = []): void {
  set((state) => {
    const fresh = structuredClone(DEFAULT_SETTINGS[key]) as Record<string, unknown>;
    const current = state.settings[key] as Record<string, unknown>;
    for (const field of keep) if (field in fresh) fresh[field] = current[field];
    const settings = { ...state.settings, [key]: fresh } as ModelSettings;
    return { settings, generation: withStale(state.generation, state.area, settings) };
  });
}

/**
 * Settings, colours and export options of both outputs back to their
 * defaults. The area, SVG title and scale (fixed or not) are kept, and so are
 * the model's edits and the SVG map's picked roads, which are work, not settings.
 */
export function resetAllSettings(): void {
  set((state) => {
    const settings = cloneSettings(DEFAULT_SETTINGS);
    const defaults = defaultSvgSettings();
    const reset: SvgSettings = {
      ...defaults,
      label: { ...defaults.label, text: state.svg.label.text },
      scale: state.svg.scale,
      scaleLocked: state.svg.scaleLocked,
      routes: state.svg.routes,
      hiddenLines: state.svg.hiddenLines,
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

/**
 * Options from a file. With its map area, its edits and picked roads are
 * added to the ones here, as a link's are. Without it they're left out, since
 * they belong to that area. Returns what came in, for a toast.
 */
export function applyOptions(options: Options, includeArea = true): Brought | null {
  const state = get();
  const { map, ...imported } = structuredClone(options);
  const savedMap = includeArea ? map : undefined;
  const requestedArea = savedMap?.area ?? state.area;
  // A piece preset also names a shape, which an options-only import keeps.
  const preset = PRODUCT_PRESETS.find((item) => item.id === imported.svg.productPreset);
  if (preset && areaShapeOf(preset.product.shape) !== requestedArea.shape) imported.svg.productPreset = 'custom';
  const { error } = pieceLayout(imported.svg.product, requestedArea.shape, imported.svg.border);
  if (error) throw new Error(`Invalid SVG options: ${error}`);
  const current: Picks = { routes: state.svg.routes, hiddenLines: state.svg.hiddenLines };
  const filePicks: Picks | undefined = savedMap ? { routes: imported.svg.routes, hiddenLines: imported.svg.hiddenLines } : undefined;
  const brought = bringIn(state.edits, current, { edits: savedMap?.edits, picks: filePicks });
  const picks = brought?.after.picks ?? current;
  const { area, svg } = fitForOutput(imported.output, requestedArea, { ...imported.svg, routes: picks.routes, hiddenLines: picks.hiddenLines });
  const view = state.ui.view === 'result' && !hasResult({ output: imported.output, generation: state.generation }) ? 'map' : state.ui.view;
  const edits = brought && brought.after.edits !== state.edits ? brought.after.edits : null;
  set({
    ...imported,
    area,
    svg,
    ...(savedMap ? { placeName: savedMap.placeName, fileName: savedMap.fileName } : {}),
    // Undo takes the file's edits back out.
    ...(edits ? { edits, editHistory: { past: [...state.editHistory.past, stepBetween(state.edits, edits)].slice(-HISTORY_LIMIT), future: [], coalesce: null } } : {}),
    generation: withStale(state.generation, area, imported.settings),
    ui: {
      ...state.ui,
      view,
      ...(savedMap ? { mapFocus: { seq: state.ui.mapFocus.seq + 1, mode: 'always' as const } } : {}),
      ...(edits ? { selection: [], activePoint: null } : {}),
    },
  });
  if (brought) set({ backup: keepReplaced(brought, 'import', get().backup) });
  return brought;
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
  const before = get();
  updateSvg((svg) => ({ product: { ...svg.product, ...patch }, productPreset: 'custom' }));
  // A margin moves the map window on the piece. Keep the map where it was on
  // the piece, so only the side whose margin changed is cropped or grows:
  // kept centred, a bigger top margin cropped the bottom of the map too. Only
  // while the scale stays, since otherwise the whole map was rescaled anyway.
  const after = get();
  if (after.output !== 'svg' || Object.keys(patch).some((key) => key !== 'margins') || after.svg.scale !== before.svg.scale) return;
  const was = pieceLayout(before.svg.product, before.area.shape, before.svg.border).layout;
  const now = pieceLayout(after.svg.product, after.area.shape, after.svg.border).layout;
  if (!was || !now) return;
  const dx = now.window.x + now.window.w / 2 - (was.window.x + was.window.w / 2);
  const dy = now.window.y + now.window.h / 2 - (was.window.y + was.window.h / 2);
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
  const metresPerMm = after.svg.scale / 1000;
  // Piece y runs down the page, the area's own y north.
  setArea((area) => ({ ...area, center: new Projection(area.center, area.rotationDeg, 1).localToGeo(dx * metresPerMm, -dy * metresPerMm) }));
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
      // A title dragged into place or resized on the last piece starts over on this one.
      label: { ...svg.label, style: preset.labelStyle, offsetX: 0, offsetY: 0, bandOffsetX: 0, bandOffsetY: 0, boxWidth: 0, boxHeight: 0 },
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

export function setCustomFont(customFontName: string | null, customFontId: string | null): void {
  set({ customFontName, customFontId });
}

/**
 * A title in the custom font, from someone else's link or after storage was
 * cleared, falls back to the default when no font file is loaded here.
 * Otherwise every render fails asking for the file.
 */
export function dropMissingFont(): void {
  const { svg, customFontId } = get();
  if (customFontId) return;
  if (svg.label.font === CUSTOM_FONT_ID) setLabel({ font: DEFAULT_LABEL.font });
  if (svg.label.subtitleFont === CUSTOM_FONT_ID) setLabel({ subtitleFont: '' });
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

export function setLargeGrids(largeGrids: boolean): void {
  patchUi({ largeGrids });
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

export function setShownBounds(version: number, bounds: ResultMeta['bounds'] | null): void {
  patchUi({ shownBounds: bounds ? { version, bounds } : null });
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

export function dismissOffers(): void {
  patchGeneration({ offers: null });
}

export function dismissGenerationError(): void {
  const generation = get().generation;
  if (generation.status !== 'error') return;
  patchGeneration({ status: generation.result ? 'done' : 'idle', error: null });
}

// ---------------------------------------------------------------- toasts

let nextToast = 1;

export function toast(text: string, tone: Toast['tone'] = 'info', action?: Toast['action']): void {
  const id = nextToast++;
  set((state) => ({ toasts: [...state.toasts.slice(-2), { id, text, tone, ...(action ? { action } : {}) }] }));
  setTimeout(() => dismissToast(id), action ? 6000 : tone === 'error' ? 5000 : 2800);
}

export function dismissToast(id: number): void {
  set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
}
