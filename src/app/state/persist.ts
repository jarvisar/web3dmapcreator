// Saved state in localStorage, merged onto the defaults on load so settings
// added later start at their default value.

import {
  COLOUR_GROUPS,
  DEFAULT_EXPORT,
  DEFAULT_PALETTE,
  DEFAULT_SETTINGS,
  PRINTERS,
  cloneSettings,
} from '../../core/settings';
import type { AreaSpec, ExportSettings, ModelSettings, Palette, SurfaceCategory } from '../../core/settings';

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

const SURFACES: SurfaceCategory[] = ['paved', 'sand', 'rock', 'green', 'forest'];
const HEX = /^#[0-9a-f]{6}$/i;

function readSettings(saved: unknown): ModelSettings | undefined {
  if (!isObject(saved)) return undefined;
  const settings = merge(cloneSettings(DEFAULT_SETTINGS), saved);
  const priority = settings.land.priority;
  const valid = priority.length === SURFACES.length && SURFACES.every((item) => priority.includes(item));
  if (!valid) settings.land.priority = [...DEFAULT_SETTINGS.land.priority];
  if (settings.scale.mode !== 'fixed' && settings.scale.mode !== 'fit') settings.scale.mode = 'fixed';
  if (!(settings.scale.mmPerMetre > 0)) settings.scale.mmPerMetre = DEFAULT_SETTINGS.scale.mmPerMetre;
  if (!(settings.scale.fitMm > 0)) settings.scale.fitMm = DEFAULT_SETTINGS.scale.fitMm;
  return settings;
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
  if (!['bambu', 'prusa', '3mf', 'stl-zip', 'stl'].includes(settings.format)) settings.format = DEFAULT_EXPORT.format;
  const printer = PRINTERS.find((item) => item.key === settings.printer) ?? PRINTERS.find((item) => item.key === DEFAULT_EXPORT.printer)!;
  settings.printer = printer.key;
  settings.sectionWidthMm = Math.min(printer.width, Math.max(20, settings.sectionWidthMm));
  settings.sectionHeightMm = Math.min(printer.depth, Math.max(20, settings.sectionHeightMm));
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
  };
}

export function saveState(state: {
  area: AreaSpec;
  settings: ModelSettings;
  palette: Palette;
  exportSettings: ExportSettings;
  placeName: string;
  fileName: string | null;
  ui: { sections: object; basemap: string; showBed: boolean; sizeUnit: string; mapHintDismissed: boolean };
}): void {
  const { sections, basemap, showBed, sizeUnit, mapHintDismissed } = state.ui;
  const data = {
    v: 1,
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
