// Everything a render needs. The app keeps a copy per output mode and passes the
// current one to the engine.
import type { AreaSpec } from './geo/transform';
import { DEFAULT_BORDER, type BorderSettings, type ProductSettings } from './layout/layout';
import { DEFAULT_CLEANUP, type CleanupSettings } from './lines/cleanup';
import type { HatchSettings } from './plotter';
import type { LonLatLine, SvgRoute } from './routes';
import { DEFAULT_LABEL, type LabelSettings } from './text/label';
import type { FeatureFilters, FillLayerId, LineLayerId } from './tiles/schema';

export type { FillLayerId, LineLayerId };
export type OutputMode = 'laser' | 'plotter' | 'print';
export type LayerId = FillLayerId | LineLayerId;

// Draw order, bottom to top.
export const FILL_LAYERS: FillLayerId[] = ['water', 'greens', 'sand', 'rocks', 'aeroways', 'decks', 'buildings'];
export const LINE_LAYERS: LineLayerId[] = ['waterways', 'railways', 'paths', 'roads', 'raceways'];

export const LAYER_NAMES: Record<LayerId, string> = {
  water: 'Water',
  greens: 'Parks & greenery',
  sand: 'Beaches & sand',
  rocks: 'Rock',
  aeroways: 'Runways',
  decks: 'Piers & plazas',
  buildings: 'Buildings',
  waterways: 'Streams & canals',
  railways: 'Railways',
  paths: 'Footpaths & cycleways',
  roads: 'Roads',
  raceways: 'Racetracks',
};

export type FillMode = 'fill' | 'outline' | 'hatch' | 'hatch-outline';

export type ElementId = LayerId | 'text' | 'frame' | 'border' | 'band' | 'cut';

export interface ModeStyle {
  colors: Record<ElementId, string>;
  fillModes: Record<FillLayerId | 'text', FillMode>;
  hatch: Record<FillLayerId | 'text', HatchSettings>;
  // Only used by print. Lasers get a hairline and plotters the pen width.
  lineWidths: Record<LineLayerId, number>;
  // Print only. Wider lines for bigger roads.
  classWidths: boolean;
  // null leaves it transparent.
  background: string | null;
  cut: boolean;
}

export interface WaterSettings {
  // Gap around structures standing in water, mm. 0 turns it off.
  halo: number;
  // Half the width of the gap under bridges over water, mm. 0 turns it off.
  bridgeGap: number;
}

export interface DeckSettings {
  knockout: boolean;
  engrave: boolean;
}

export interface SourceSettings {
  // TileJSON URL, {z}/{x}/{y} template or .pmtiles URL, in the OpenMapTiles schema.
  tiles: string;
  // 14 is full detail for OpenMapTiles.
  maxZoom: number;
  maxTiles: number;
}

export interface PlotterSettings {
  penWidth: number;
  optimize: boolean;
}

export interface RenderSettings {
  area: AreaSpec;
  product: ProductSettings;
  border: BorderSettings;
  mode: OutputMode;
  style: ModeStyle;
  layers: Record<LayerId, boolean>;
  filters: FeatureFilters;
  water: WaterSettings;
  decks: DeckSettings;
  cleanup: CleanupSettings;
  label: LabelSettings;
  source: SourceSettings;
  plotter: PlotterSettings;
  /** Roads picked out in the preview, each route a group of its own. */
  routes: SvgRoute[];
  /** Roads picked to be left out. */
  hiddenLines: LonLatLine[];
  // SVG title.
  title: string;
}

export const DEFAULT_SOURCE: SourceSettings = {
  tiles: 'https://tiles.openfreemap.org/planet',
  maxZoom: 14,
  maxTiles: 400,
};

export const DEFAULT_FILTERS: FeatureFilters = {
  skipTunnels: true,
  roads: { service: true, parkingAisles: false, driveways: false, tracks: true, pedestrian: true, busways: true },
  paths: { footways: true, cycleways: true, steps: true, bridleways: true },
  railways: { minor: true, yards: false },
  waterways: { streams: true, rivers: true },
  water: { pools: false, intermittent: true },
  greens: { wetlands: true, pitches: true, cemeteries: true },
  decks: { bridges: false },
};

export const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  water: true,
  greens: true,
  sand: true,
  rocks: true,
  aeroways: true,
  decks: true,
  buildings: true,
  waterways: true,
  railways: true,
  paths: true,
  roads: true,
  raceways: true,
};

const hatch = (spacing: number, angle: number, cross = false): HatchSettings => ({ spacing, angle, cross });

const LASER_COLORS: Record<ElementId, string> = {
  water: '#1F77B4',
  greens: '#729653',
  sand: '#D9B46A',
  rocks: '#7F7F7F',
  aeroways: '#9467BD',
  decks: '#C49A6C',
  buildings: '#1A1A1A',
  waterways: '#17BECF',
  railways: '#8C564B',
  paths: '#009E73',
  roads: '#D55E00',
  raceways: '#E7298A',
  text: '#000000',
  frame: '#CC79A7',
  border: '#B8860B',
  band: '#8B6914',
  cut: '#E31A1C',
};

// LightBurn's layer palette, so each element lands on its own layer.
export const LIGHTBURN_COLORS: Record<ElementId, string> = {
  buildings: '#000000',
  water: '#0000FF',
  cut: '#FF0000',
  greens: '#00E000',
  sand: '#D0D000',
  roads: '#FF8000',
  paths: '#00E0E0',
  raceways: '#FF00FF',
  rocks: '#B4B4B4',
  band: '#0000A0',
  text: '#A00000',
  border: '#00A000',
  frame: '#A0A000',
  railways: '#C08000',
  waterways: '#00A0FF',
  aeroways: '#A000A0',
  decks: '#F0B98D',
};

// Three processes: engrave everything filled, score every line, cut the outline.
export const MINIMAL_COLORS: Record<ElementId, string> = {
  water: '#000000',
  greens: '#000000',
  sand: '#000000',
  rocks: '#000000',
  aeroways: '#000000',
  decks: '#000000',
  buildings: '#000000',
  text: '#000000',
  band: '#000000',
  waterways: '#0000FF',
  railways: '#0000FF',
  paths: '#0000FF',
  roads: '#0000FF',
  raceways: '#0000FF',
  frame: '#0000FF',
  border: '#0000FF',
  cut: '#FF0000',
};

export const LASER_PALETTES = {
  distinct: { name: 'Distinct colours (most software)', colors: LASER_COLORS },
  lightburn: { name: 'LightBurn layer palette', colors: LIGHTBURN_COLORS },
  minimal: { name: 'Minimal: engrave / score / cut', colors: MINIMAL_COLORS },
} as const;

const fillModes = (mode: FillMode): Record<FillLayerId | 'text', FillMode> => ({
  water: mode,
  greens: mode,
  sand: mode,
  rocks: mode,
  aeroways: mode,
  decks: mode,
  buildings: mode,
  text: mode,
});

const lineWidths = (w: number): Record<LineLayerId, number> => ({
  waterways: w,
  railways: w,
  paths: w,
  roads: w,
  raceways: w,
});

export const DEFAULT_HATCH: Record<FillLayerId | 'text', HatchSettings> = {
  water: hatch(0.8, 0),
  greens: hatch(1.4, 45),
  sand: hatch(1.6, 30),
  rocks: hatch(1.0, 60),
  aeroways: hatch(0.6, 90),
  decks: hatch(1.0, 135),
  buildings: hatch(0.7, 45),
  text: hatch(0.3, 45),
};

// A laser line needs about one kerf. A pen stroke needs its own width plus a gap.
export function defaultLineSpacing(mode: OutputMode, penWidth: number): number {
  if (mode === 'plotter') return Math.round(penWidth * 1.7 * 100) / 100;
  if (mode === 'print') return 0.35;
  return 0.3;
}

export const LASER_STYLE: ModeStyle = {
  colors: LASER_COLORS,
  fillModes: fillModes('fill'),
  hatch: DEFAULT_HATCH,
  lineWidths: lineWidths(0.05),
  classWidths: false,
  background: null,
  cut: true,
};

export const PLOTTER_STYLE: ModeStyle = {
  colors: {
    water: '#1F5FA8',
    greens: '#2E7D32',
    sand: '#000000',
    rocks: '#000000',
    aeroways: '#000000',
    decks: '#000000',
    buildings: '#000000',
    waterways: '#1F5FA8',
    railways: '#000000',
    paths: '#000000',
    roads: '#000000',
    raceways: '#C2185B',
    text: '#000000',
    frame: '#000000',
    border: '#000000',
    band: '#000000',
    cut: '#FF0000',
  },
  fillModes: { ...fillModes('hatch'), buildings: 'hatch-outline', text: 'hatch-outline', decks: 'outline' },
  hatch: DEFAULT_HATCH,
  lineWidths: lineWidths(0.3),
  classWidths: false,
  background: null,
  cut: false,
};

export interface PrintTheme {
  name: string;
  background: string;
  colors: Record<ElementId, string>;
}

const theme = (
  name: string,
  background: string,
  c: Partial<Record<ElementId, string>> & { ink: string; water: string; greens: string; buildings: string },
): PrintTheme => ({
  name,
  background,
  colors: {
    water: c.water,
    greens: c.greens,
    sand: c.sand ?? c.greens,
    rocks: c.rocks ?? c.buildings,
    aeroways: c.aeroways ?? c.buildings,
    decks: c.decks ?? background,
    buildings: c.buildings,
    waterways: c.waterways ?? c.water,
    railways: c.railways ?? c.ink,
    paths: c.paths ?? c.ink,
    roads: c.roads ?? c.ink,
    raceways: c.raceways ?? c.ink,
    text: c.text ?? c.ink,
    frame: c.frame ?? c.ink,
    border: c.border ?? c.ink,
    band: c.band ?? c.ink,
    cut: c.cut ?? '#FF0000',
  },
});

export const PRINT_THEMES: Record<string, PrintTheme> = {
  classic: theme('Classic', '#F5F0E6', {
    ink: '#3A3A3A',
    water: '#A7C7E0',
    greens: '#CADDB4',
    sand: '#EDDFB5',
    rocks: '#D5D0C7',
    buildings: '#C9BDAE',
    paths: '#8A8A8A',
    railways: '#8C6E5B',
    raceways: '#B0306A',
  }),
  minimal: theme('Minimal', '#FFFFFF', {
    ink: '#141414',
    water: '#DCE7EF',
    greens: '#E7EEE0',
    buildings: '#D2D2D2',
    paths: '#7A7A7A',
  }),
  blueprint: theme('Blueprint', '#173A5E', {
    ink: '#EAF2FB',
    water: '#244E78',
    greens: '#1E4468',
    sand: '#26507A',
    buildings: '#2F5B86',
    decks: '#1C4166',
    paths: '#9DB7D1',
  }),
  noir: theme('Noir', '#101010', {
    ink: '#F2F2F2',
    water: '#262626',
    greens: '#1B1B1B',
    sand: '#202020',
    buildings: '#363636',
    decks: '#141414',
    paths: '#8F8F8F',
  }),
  terracotta: theme('Terracotta', '#F4E6D6', {
    ink: '#5A3528',
    water: '#BFD3D6',
    greens: '#D9D3B2',
    buildings: '#DE9A7D',
    paths: '#A0776A',
  }),
};

export function printStyle(themeId: keyof typeof PRINT_THEMES = 'classic'): ModeStyle {
  const t = PRINT_THEMES[themeId] ?? PRINT_THEMES.classic;
  return {
    colors: { ...t.colors },
    fillModes: fillModes('fill'),
    hatch: DEFAULT_HATCH,
    lineWidths: { waterways: 0.25, railways: 0.25, paths: 0.14, roads: 0.28, raceways: 0.45 },
    classWidths: true,
    background: t.background,
    cut: false,
  };
}

// Print road widths relative to a minor street.
export const ROAD_WIDTH_SCALE: Record<string, number> = {
  motorway: 2.2,
  trunk: 2.0,
  primary: 1.7,
  secondary: 1.45,
  tertiary: 1.25,
  minor: 1,
  unclassified: 1,
  pedestrian: 0.85,
  busway: 0.8,
  service: 0.6,
  track: 0.5,
};

export const DEFAULTS = {
  border: DEFAULT_BORDER,
  cleanup: DEFAULT_CLEANUP,
  label: DEFAULT_LABEL,
  filters: DEFAULT_FILTERS,
  layers: DEFAULT_LAYERS,
  water: { halo: 0.175, bridgeGap: 0 } satisfies WaterSettings,
  decks: { knockout: true, engrave: false } satisfies DeckSettings,
  source: DEFAULT_SOURCE,
  plotter: { penWidth: 0.3, optimize: true } satisfies PlotterSettings,
};
