// Everything the SVG map sections edit. Saved with the rest of the state and
// in share links, and turned into the engine's RenderSettings for each render.
// The place, rotation, width and shape come from the shared area.
import type { AreaSpec } from '../../core/settings';
import { DEFAULT_SCALE, defaultRenderSettings, defaultStyle } from '../../core/svgmap/defaults';
import type { ProductSettings } from '../../core/svgmap/layout/layout';
import { fitNumber } from '../../core/svgmap/limits';
import { DEFAULT_CLEANUP, type CleanupSettings } from '../../core/svgmap/lines/cleanup';
import { DEFAULT_PRODUCT } from '../../core/svgmap/presets';
import { sanitizeLines, sanitizeRoutes } from '../../core/svgmap/routes';
import {
  LASER_PALETTES,
  type ModeStyle,
  type OutputMode,
  type RenderSettings,
  defaultLineSpacing,
} from '../../core/svgmap/settings';
import { pieceProduct } from './piece';

export type CleanupPreset = 'off' | 'light' | 'standard' | 'strong' | 'custom';
export type LaserPalette = keyof typeof LASER_PALETTES;
export type PieceSize = Omit<ProductSettings, 'shape'>;

export interface SvgSettings extends Omit<RenderSettings, 'area' | 'product' | 'style' | 'title'> {
  productPreset: string;
  product: PieceSize;
  // Each mode keeps its own colours and fill styles.
  styles: Record<OutputMode, ModeStyle>;
  laserPalette: LaserPalette;
  printTheme: string;
  cleanupPreset: CleanupPreset;
  // 1:scale. Follows the area unless locked (Fixed scale in the panel), and
  // then the area follows it.
  scale: number;
  scaleLocked: boolean;
}

const OUTPUT_MODES: string[] = ['laser', 'plotter', 'print'] satisfies OutputMode[];

export function defaultSvgSettings(): SvgSettings {
  const { area: _area, style: _style, title: _title, product, ...shared } = defaultRenderSettings('laser');
  const { shape: _shape, ...size } = product;
  return {
    ...shared,
    productPreset: DEFAULT_PRODUCT.id,
    product: size,
    styles: { laser: defaultStyle('laser'), plotter: defaultStyle('plotter'), print: defaultStyle('print') },
    laserPalette: 'distinct',
    printTheme: 'classic',
    cleanupPreset: 'standard',
    scale: DEFAULT_SCALE,
    scaleLocked: true,
  };
}

// Presets scale the original defaults. Line spacing follows the output mode.
export function cleanupForPreset(preset: CleanupPreset, mode: OutputMode, penWidth: number, current: CleanupSettings): CleanupSettings {
  const spacing = defaultLineSpacing(mode, penWidth);
  const base: CleanupSettings = { ...DEFAULT_CLEANUP, lineSpacing: spacing };
  switch (preset) {
    case 'off':
      return { ...current, enabled: false };
    case 'light':
      return {
        ...base,
        lineSpacing: Math.round(spacing * 0.7 * 100) / 100,
        dense: false,
        aggressivePaths: false,
        pruneStubs: 0.4,
      };
    case 'strong':
      return {
        ...base,
        lineSpacing: Math.round(spacing * 1.4 * 100) / 100,
        denseLimit: 2.2,
        pruneStubs: 1.0,
        pathStubs: 1.8,
        tangleSpan: 8,
      };
    case 'custom':
      return { ...current, enabled: true };
    default:
      return base;
  }
}

// Without a title on the map, the place name titles the file, so a result
// downloaded after moving somewhere else keeps its own name.
export function toRenderSettings(area: AreaSpec, s: SvgSettings, placeName = ''): RenderSettings {
  return {
    area: { lon: area.center[0], lat: area.center[1], bearing: area.rotationDeg, widthM: area.widthM },
    product: pieceProduct(s.product, area.shape),
    border: s.border,
    mode: s.mode,
    style: s.styles[s.mode],
    layers: s.layers,
    filters: s.filters,
    water: s.water,
    decks: s.decks,
    cleanup: s.cleanup,
    label: s.label,
    source: s.source,
    plotter: s.plotter,
    routes: s.routes,
    hiddenLines: s.hiddenLines,
    title: s.label.text.trim() || placeName.trim(),
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
// The only fields allowed to be null.
const NULLABLE = new Set(['background']);

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validString(path: string[], value: string): boolean {
  const key = path[path.length - 1];
  if (key === 'background' || path[path.length - 2] === 'colors') return HEX_COLOR.test(value);
  if (path.length === 1 && key === 'mode') return OUTPUT_MODES.includes(value);
  return true;
}

// Takes each value from patch only where base has a value of the same type.
// Saved settings and share links can come from an older build or be edited by
// hand, so anything that doesn't fit is dropped instead of breaking the app or
// ending up in the SVG. Colours have to be #RRGGBB, and numbers have to be in
// the range the panels offer (core/svgmap/limits.ts).
export function mergeSettings<T>(base: T, patch: unknown, path: string[] = []): T {
  if (patch === undefined) return base;
  // The only lists: picked roads, cleaned on their own.
  if (path.length === 1 && path[0] === 'routes') return sanitizeRoutes(patch) as T;
  if (path.length === 1 && path[0] === 'hiddenLines') return sanitizeLines(patch) as T;
  if (isObject(base)) {
    if (!isObject(patch)) return base;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(base)) {
      if (typeof value !== 'function') out[key] = mergeSettings(value, patch[key], [...path, key]);
    }
    return out as T;
  }
  const nullable = NULLABLE.has(path[path.length - 1]);
  if (patch === null) return (nullable ? null : base) as T;
  if (typeof patch === 'string') {
    const fits = typeof base === 'string' || (base === null && nullable);
    return (fits && validString(path, patch) ? patch : base) as T;
  }
  if (typeof patch === 'number') return (typeof base === 'number' && fitNumber(path, patch) === patch ? patch : base) as T;
  return (typeof patch === 'boolean' && typeof base === 'boolean' ? patch : base) as T;
}
