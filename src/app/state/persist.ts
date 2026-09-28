// Saved state in localStorage, merged onto the defaults on load so settings
// added later start at their default value.

import {
  COLOUR_GROUPS,
  DEFAULT_EXPORT,
  DEFAULT_PALETTE,
  EXPORT_FORMATS,
  MIN_SECTION_MM,
  PRINTERS,
  sanitizeSettings,
} from '../../core/settings';
import type { AreaSpec, ExportSettings, ModelSettings, Palette } from '../../core/settings';

const KEY = 'jarvizar-city-model:v1';

export interface SavedState {
  area?: AreaSpec;
  settings?: ModelSettings;
  palette?: Palette;
  exportSettings?: ExportSettings;
  placeName?: string;
  fileName?: string | null;
  sections?: Partial<Record<string, boolean>>;
  basemap?: 'streets' | 'light' | 'satellite';
  showBed?: boolean;
  sizeUnit?: 'km' | 'm';
  mapHintDismissed?: boolean;
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

function readPalette(saved: unknown): Palette | undefined {
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

function readExport(saved: unknown): ExportSettings | undefined {
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

export function loadSaved(): SavedState {
  let raw: unknown;
  try {
    const text = localStorage.getItem(KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    return {};
  }
  if (!isObject(raw)) return {};
  const ui = isObject(raw.ui) ? raw.ui : {};
  return {
    area: readArea(raw.area),
    settings: readSettings(raw.settings),
    palette: readPalette(raw.palette),
    exportSettings: readExport(raw.exportSettings),
    placeName: typeof raw.placeName === 'string' ? raw.placeName : undefined,
    fileName: typeof raw.fileName === 'string' ? raw.fileName : null,
    sections: isObject(ui.sections) ? (ui.sections as Record<string, boolean>) : undefined,
    basemap: ui.basemap === 'streets' || ui.basemap === 'light' || ui.basemap === 'satellite' ? ui.basemap : undefined,
    showBed: typeof ui.showBed === 'boolean' ? ui.showBed : undefined,
    sizeUnit: ui.sizeUnit === 'km' || ui.sizeUnit === 'm' ? ui.sizeUnit : undefined,
    mapHintDismissed: typeof ui.mapHintDismissed === 'boolean' ? ui.mapHintDismissed : undefined,
    hash: typeof raw.hash === 'string' ? raw.hash : undefined,
  };
}

export function saveState(
  state: {
  area: AreaSpec;
  settings: ModelSettings;
  palette: Palette;
  exportSettings: ExportSettings;
  placeName: string;
  fileName: string | null;
  ui: { sections: object; basemap: string; showBed: boolean; sizeUnit: string; mapHintDismissed: boolean };
  },
  hash: string,
): void {
  const { sections, basemap, showBed, sizeUnit, mapHintDismissed } = state.ui;
  const data = {
    hash,
    area: state.area,
    settings: state.settings,
    palette: state.palette,
    exportSettings: state.exportSettings,
    placeName: state.placeName,
    fileName: state.fileName,
    ui: { sections, basemap, showBed, sizeUnit, mapHintDismissed },
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Private browsing or storage full: settings just are not remembered.
  }
}
