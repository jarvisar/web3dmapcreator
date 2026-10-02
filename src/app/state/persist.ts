// Saved state in localStorage, merged onto the defaults on load so settings
// added later start at their default value. The model's edits and an SVG
// map's picked roads can get big, so each has a key of its own: running out
// of space for them shouldn't stop the settings from saving. They're the
// user's work, so a tab only writes them once it has changed them, and
// takes on what another tab saves (sync.ts). Otherwise an idle tab closing
// wrote its old copy over the other tab's.

import {
  COLOUR_GROUPS,
  DEFAULT_EXPORT,
  DEFAULT_PALETTE,
  EXPORT_FORMATS,
  MIN_SECTION_MM,
  PALETTE_PRESETS,
  PRINTERS,
  sanitizeSettings,
} from '../../core/settings';
import { MAX_SIDE_M, MIN_SIDE_M } from '../../core/geo/area';
import type { AreaSpec, ExportSettings, ModelSettings, Palette } from '../../core/settings';
import { emptyEdits, hasEdits, sanitizeEdits, type ModelEdits } from '../../core/edit/types';
import { sanitizeLines, sanitizeRoutes, type Picks } from '../../core/svgmap/routes';
import { sanitizeTracks, type Track } from '../../core/tracks/track';
import { type SvgSettings, defaultSvgSettings, mergeSettings } from '../svgmap/settings';
import { matchingPreset } from './derived';

export const STORAGE_KEY = 'jarvizar-city-model:v1';
export const EDITS_KEY = 'jarvizar-city-model:edits';
export const PICKS_KEY = 'jarvizar-city-model:picks';
export const TRACKS_KEY = 'jarvizar-city-model:tracks';
export const BACKUP_KEY = 'jarvizar-city-model:backup';
const KEY = STORAGE_KEY;

export interface SavedState {
  output?: 'model' | 'svg';
  area?: AreaSpec;
  /** The size each output had when it was last left. */
  areaSizes?: Partial<Record<'model' | 'svg', { widthM: number; heightM: number }>>;
  settings?: ModelSettings;
  palette?: Palette;
  exportSettings?: ExportSettings;
  /** Read even when the settings can't be, and empty when nothing was saved. */
  edits: ModelEdits;
  picks: Picks;
  /** Imported routes. */
  tracks: Track[];
  /** Without the picks. */
  svg?: SvgSettings;
  placeName?: string;
  fileName?: string | null;
  sections?: Partial<Record<string, boolean>>;
  basemap?: 'streets' | 'light' | 'satellite';
  showBed?: boolean;
  sizeUnit?: 'km' | 'm' | 'mm';
  mapHintDismissed?: boolean;
  previewLook?: 'material' | 'colors';
  largeGrids?: boolean;
  /** The URL hash the app last wrote, to tell its own hash from a share link. */
  hash?: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Copy of `defaults` with every value of the same type taken from `saved`. */
function merge<T>(defaults: T, saved: unknown): T {
  if (Array.isArray(defaults)) return (Array.isArray(saved) ? saved : defaults) as T;
  if (isObject(defaults)) {
    const source = isObject(saved) ? saved : {};
    const out: Json = {};
    for (const key of Object.keys(defaults)) out[key] = merge((defaults as Json)[key], source[key]);
    return out as T;
  }
  if (typeof saved === typeof defaults && (typeof saved !== 'number' || Number.isFinite(saved))) return saved as T;
  return defaults;
}

const HEX = /^#[0-9a-f]{6}$/i;

function readSettings(saved: unknown): ModelSettings | undefined {
  return isObject(saved) ? sanitizeSettings(saved) : undefined;
}

export function readPalette(saved: unknown, presetKey?: unknown): Palette | undefined {
  // A palette saved from a preset follows that preset's colours if they change
  const preset = PALETTE_PRESETS.find((item) => item.key === presetKey);
  if (preset) return structuredClone(preset.palette);
  if (!isObject(saved)) return undefined;
  const palette = structuredClone(DEFAULT_PALETTE);
  for (const { key } of COLOUR_GROUPS) {
    const entry = saved[key];
    if (!isObject(entry)) continue;
    const hex = typeof entry.hex === 'string' && HEX.test(entry.hex) ? entry.hex.toUpperCase() : null;
    const line = entry.line === 'PLA Basic' || entry.line === 'PLA Matte' ? entry.line : null;
    if (hex && line) palette[key] = { hex, line };
  }
  return palette;
}

export function readExport(saved: unknown): ExportSettings | undefined {
  if (!isObject(saved)) return undefined;
  const settings = merge({ ...DEFAULT_EXPORT }, saved);
  if (!(EXPORT_FORMATS as readonly string[]).includes(settings.format)) settings.format = DEFAULT_EXPORT.format;
  const printer = PRINTERS.find((item) => item.key === settings.printer) ?? PRINTERS.find((item) => item.key === DEFAULT_EXPORT.printer)!;
  settings.printer = printer.key;
  settings.sectionWidthMm = Math.min(printer.width, Math.max(MIN_SECTION_MM, settings.sectionWidthMm));
  settings.sectionHeightMm = Math.min(printer.depth, Math.max(MIN_SECTION_MM, settings.sectionHeightMm));
  return settings;
}

function readArea(saved: unknown): AreaSpec | undefined {
  if (!isObject(saved) || !Array.isArray(saved.center) || saved.center.length !== 2) return undefined;
  const [lon, lat] = saved.center;
  if (typeof lon !== 'number' || typeof lat !== 'number') return undefined;
  const merged = merge<AreaSpec>(
    { center: [0, 0], widthM: 2000, heightM: 2000, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 },
    saved,
  );
  return { ...merged, center: [lon, lat] };
}

function readJson(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function readStoredEdits(text: string | null): ModelEdits | null {
  try {
    const raw: unknown = text ? JSON.parse(text) : null;
    return isObject(raw) ? sanitizeEdits(raw) : null;
  } catch {
    return null;
  }
}

export function readStoredPicks(text: string | null): Picks | null {
  try {
    const raw: unknown = text ? JSON.parse(text) : null;
    return isObject(raw) ? readPicks(raw) : null;
  } catch {
    return null;
  }
}

function readPicks(raw: Json): Picks {
  return { routes: sanitizeRoutes(raw.routes), hiddenLines: sanitizeLines(raw.hiddenLines) };
}

export function readStoredTracks(text: string | null): Track[] | null {
  try {
    const raw: unknown = text ? JSON.parse(text) : null;
    return Array.isArray(raw) ? sanitizeTracks(raw) : null;
  } catch {
    return null;
  }
}

export function hasPicks(picks: Picks): boolean {
  return picks.hiddenLines.length > 0 || picks.routes.some((route) => route.lines.length > 0);
}

function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadSaved(): SavedState {
  const read = readJson(KEY);
  const raw = isObject(read) ? read : {};
  const ui = isObject(raw.ui) ? raw.ui : {};
  // The edits and picks keys are read whatever happened to the settings, or
  // the next save wrote nothing over them.
  const edits = readStoredEdits(readText(EDITS_KEY)) ?? emptyEdits();
  const picks = readStoredPicks(readText(PICKS_KEY)) ?? { routes: [], hiddenLines: [] };
  const tracks = readStoredTracks(readText(TRACKS_KEY)) ?? [];
  // They're what's in storage now, so saving them again waits for a change.
  written.set(EDITS_KEY, [edits]);
  written.set(PICKS_KEY, [picks.routes, picks.hiddenLines]);
  written.set(TRACKS_KEY, [tracks]);
  loadedHash = typeof raw.hash === 'string' ? raw.hash : undefined;
  return {
    output: raw.output === 'svg' || raw.output === 'model' ? raw.output : undefined,
    area: readArea(raw.area),
    areaSizes: readAreaSizes(raw.areaSizes),
    settings: readSettings(raw.settings),
    palette: readPalette(raw.palette, raw.palettePreset),
    exportSettings: readExport(raw.exportSettings),
    edits,
    picks,
    tracks,
    svg: isObject(raw.svg) ? mergeSettings(defaultSvgSettings(), raw.svg) : undefined,
    placeName: typeof raw.placeName === 'string' ? raw.placeName : undefined,
    fileName: typeof raw.fileName === 'string' ? raw.fileName : null,
    sections: isObject(ui.sections) ? (ui.sections as Record<string, boolean>) : undefined,
    basemap: ui.basemap === 'streets' || ui.basemap === 'light' || ui.basemap === 'satellite' ? ui.basemap : undefined,
    showBed: typeof ui.showBed === 'boolean' ? ui.showBed : undefined,
    sizeUnit: ui.sizeUnit === 'km' || ui.sizeUnit === 'm' || ui.sizeUnit === 'mm' ? ui.sizeUnit : undefined,
    mapHintDismissed: typeof ui.mapHintDismissed === 'boolean' ? ui.mapHintDismissed : undefined,
    previewLook: ui.previewLook === 'material' || ui.previewLook === 'colors' ? ui.previewLook : undefined,
    largeGrids: typeof ui.largeGrids === 'boolean' ? ui.largeGrids : undefined,
    hash: typeof raw.hash === 'string' ? raw.hash : undefined,
  };
}

let loadedHash: string | undefined;

/** The hash the saved settings had when this page loaded them. */
export function savedHash(): string | undefined {
  return loadedHash;
}

let saving = true;

// Also stops saving for the rest of this page. Otherwise a save still waiting
// in the sync, or the one on pagehide, puts the cleared settings straight back.
// The edits and picks go into the backup rather than away, unread in case
// they're what crashed. Unreadable ones go with the rest.
export function clearSavedState(): void {
  saving = false;
  const backup: Backup = { savedAt: Date.now(), reason: 'reset' };
  // Keys that go into the backup, only removed once it's written.
  const kept = new Set<string>();
  const edits = readStoredEdits(readText(EDITS_KEY));
  const picks = readStoredPicks(readText(PICKS_KEY));
  const tracks = readStoredTracks(readText(TRACKS_KEY));
  if (edits && hasEdits(edits)) {
    backup.edits = edits;
    kept.add(EDITS_KEY);
  }
  if (picks && hasPicks(picks)) {
    backup.picks = picks;
    kept.add(PICKS_KEY);
  }
  if (tracks?.length) {
    backup.tracks = tracks;
    kept.add(TRACKS_KEY);
  }
  try {
    // The settings go first, which also makes room for the backup.
    for (const key of [KEY, EDITS_KEY, PICKS_KEY, TRACKS_KEY]) if (!kept.has(key)) localStorage.removeItem(key);
    if (!kept.size) return;
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
    for (const key of kept) localStorage.removeItem(key);
  } catch {
    // Storage is off, or still no room for the backup. Whatever had no
    // backup yet stays where it was, so only the settings are reset.
  }
}

/** Whether these are what this tab last read or wrote under the key, so it has no change of its own waiting. */
export function isSaved(key: string, values: unknown[]): boolean {
  const before = written.get(key);
  return Boolean(before && before.length === values.length && before.every((value, i) => value === values[i]));
}

/** What another tab saved under the key, taken on here as if this tab had written it. */
export function markSaved(key: string, values: unknown[]): void {
  written.set(key, values);
}

// ---------------------------------------------------------------- backup

export type BackupReason = 'link' | 'import' | 'clear' | 'clear-picks' | 'reset' | 'restore';

const REASONS: readonly BackupReason[] = ['link', 'import', 'clear', 'clear-picks', 'reset', 'restore'];

/**
 * The user's edits or picked roads from before something replaced them: a
 * link or an options file that changed some of them, Undo all, or the crash
 * screen's reset. It stays until it's put back or forgotten. Routes are only
 * ever kept by the reset, since nothing else replaces them.
 */
export interface Backup {
  savedAt: number;
  reason: BackupReason;
  edits?: ModelEdits;
  picks?: Picks;
  tracks?: Track[];
}

export function readBackup(): Backup | null {
  try {
    const raw = readJson(BACKUP_KEY);
    if (!isObject(raw) || !REASONS.includes(raw.reason as BackupReason) || typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt)) return null;
    const backup: Backup = { savedAt: raw.savedAt, reason: raw.reason as BackupReason };
    const edits = isObject(raw.edits) ? sanitizeEdits(raw.edits) : null;
    const picks = isObject(raw.picks) ? readPicks(raw.picks) : null;
    const tracks = sanitizeTracks(raw.tracks);
    if (edits && hasEdits(edits)) backup.edits = edits;
    if (picks && hasPicks(picks)) backup.picks = picks;
    if (tracks.length) backup.tracks = tracks;
    return backup.edits || backup.picks || backup.tracks ? backup : null;
  } catch {
    return null;
  }
}

/** Keeps a backup in place of the one before, or drops it given nothing. False when the browser refused it. */
export function writeBackup(backup: Backup | null): boolean {
  try {
    if (!backup || (!backup.edits && !backup.picks && !backup.tracks)) localStorage.removeItem(BACKUP_KEY);
    else localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
    return true;
  } catch {
    return false;
  }
}

// What was last written under each key, so an unchanged edit list isn't
// turned into JSON again every time the area moves.
const written = new Map<string, unknown[]>();

/** Writes a key, unless it was last written from the same values. False when the browser refused it. */
function write(key: string, values: unknown[] | null, text: () => string): boolean {
  const before = written.get(key);
  if (values && before && before.every((value, i) => value === values[i])) return true;
  try {
    localStorage.setItem(key, text());
    if (values) written.set(key, values);
    return true;
  } catch {
    written.delete(key);
    return false;
  }
}

function readAreaSizes(raw: unknown): SavedState['areaSizes'] {
  if (!isObject(raw)) return undefined;
  const out: NonNullable<SavedState['areaSizes']> = {};
  for (const output of ['model', 'svg'] as const) {
    const size = raw[output];
    if (!isObject(size)) continue;
    const { widthM, heightM } = size;
    const side = (v: unknown): v is number => typeof v === 'number' && v >= MIN_SIDE_M && v <= MAX_SIDE_M;
    if (side(widthM) && side(heightM)) out[output] = { widthM, heightM };
  }
  return out;
}

export function saveState(
  state: {
    output: 'model' | 'svg';
    area: AreaSpec;
    areaSizes?: SavedState['areaSizes'];
    settings: ModelSettings;
    palette: Palette;
    exportSettings: ExportSettings;
    edits: ModelEdits;
    tracks?: Track[];
    svg: SvgSettings;
    placeName: string;
    fileName: string | null;
    ui: { sections: object; basemap: string; showBed: boolean; sizeUnit: string; mapHintDismissed: boolean; previewLook: string; largeGrids?: boolean };
  },
  hash: string,
  /** False leaves the settings key alone, for a tab that hasn't changed them. */
  settings = true,
): boolean {
  if (!saving) return true;
  const { sections, basemap, showBed, sizeUnit, mapHintDismissed, previewLook, largeGrids } = state.ui;
  const { routes, hiddenLines, ...svg } = state.svg;
  const data = {
    hash,
    output: state.output,
    area: state.area,
    areaSizes: state.areaSizes,
    settings: state.settings,
    palette: state.palette,
    palettePreset: matchingPreset(state.palette)?.key,
    exportSettings: state.exportSettings,
    svg,
    placeName: state.placeName,
    fileName: state.fileName,
    ui: { sections, basemap, showBed, sizeUnit, mapHintDismissed, previewLook, largeGrids },
  };
  // Private browsing or storage full: what doesn't fit just isn't remembered.
  let ok = settings ? write(KEY, null, () => JSON.stringify(data)) : true;
  ok = write(EDITS_KEY, [state.edits], () => JSON.stringify(state.edits)) && ok;
  ok = write(PICKS_KEY, [routes, hiddenLines], () => JSON.stringify({ routes, hiddenLines })) && ok;
  const tracks = state.tracks;
  if (tracks) ok = write(TRACKS_KEY, [tracks], () => JSON.stringify(tracks)) && ok;
  return ok;
}
