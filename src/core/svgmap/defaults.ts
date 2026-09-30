import { computeLayout } from './layout/layout';
import { DEFAULT_PLACE, DEFAULT_PRODUCT } from './presets';
import {
  DEFAULTS,
  defaultLineSpacing,
  LASER_STYLE,
  type ModeStyle,
  type OutputMode,
  PLOTTER_STYLE,
  type RenderSettings,
  printStyle,
} from './settings';

export function defaultStyle(mode: OutputMode): ModeStyle {
  const style = mode === 'laser' ? LASER_STYLE : mode === 'plotter' ? PLOTTER_STYLE : printStyle('classic');
  return structuredClone(style);
}

// 1:n of the starting map, 0.05 mm per metre. The place's own width is ignored
// for the default.
export const DEFAULT_SCALE = 20000;

export function defaultRenderSettings(mode: OutputMode = 'laser'): RenderSettings {
  const place = DEFAULT_PLACE;
  const product = DEFAULT_PRODUCT;
  const border = { ...DEFAULTS.border, style: product.border };
  const widthM = (DEFAULT_SCALE * computeLayout(product.product, border).window.w) / 1000;
  return structuredClone({
    area: { lon: place.lon, lat: place.lat, bearing: 0, widthM },
    product: product.product,
    border,
    mode,
    style: defaultStyle(mode),
    layers: DEFAULTS.layers,
    filters: DEFAULTS.filters,
    water: DEFAULTS.water,
    decks: DEFAULTS.decks,
    cleanup: { ...DEFAULTS.cleanup, lineSpacing: defaultLineSpacing(mode, DEFAULTS.plotter.penWidth) },
    label: { ...DEFAULTS.label, text: place.label, style: product.labelStyle },
    source: DEFAULTS.source,
    plotter: DEFAULTS.plotter,
    routes: [],
    hiddenLines: [],
    title: place.name,
  });
}
