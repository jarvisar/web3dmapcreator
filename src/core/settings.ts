// Every setting that shapes a model, with the defaults of the Blender add-on
// this was ported from. One model millimetre is one printed millimetre.

import type { ColourGroup } from './types';

export type AreaShape = 'rectangle' | 'rounded' | 'circle' | 'hexagon';

/**
 * The selected area, defined in real metres around a centre so the model is
 * the same size wherever it is on the globe. The shape is axis-aligned in the
 * rotated frame: with rotation 30 the model's +Y points 30 degrees east of
 * north, and the model is built square to that direction.
 */
export interface AreaSpec {
  center: [number, number]; // lon, lat
  widthM: number;
  heightM: number;
  /** Bearing of the model's +Y axis, degrees clockwise from north. */
  rotationDeg: number;
  shape: AreaShape;
  /** Corner radius of the rounded shape, as a fraction of the shorter side. */
  cornerRadius: number;
}

export type ScaleMode = 'fixed' | 'fit';
export type SurfaceCategory = 'paved' | 'sand' | 'rock' | 'green' | 'forest';
export type FilamentLine = 'PLA Basic' | 'PLA Matte';
export type LidarRoofMode = 'envelope' | 'heights';
/** 'layer' prints large water as a thin layer on a terrain floor, 'through' cuts it through the base. */
export type WaterMode = 'layer' | 'through';
/** LiDAR only water: recessed in the one solid, a thin layer of its own on a terrain floor, or cut away through the base. */
export type LidarWaterMode = 'recess' | 'layer' | 'cut';
/** Tree canopy in a LiDAR Only model: as scanned, rounded into domes, or left out. */
export type TreeStyle = 'natural' | 'rounded' | 'off';
/** 'map' builds a multicolour model from map data, 'lidar' the whole model from a LiDAR survey alone. */
export type ModelSource = 'map' | 'lidar';

export interface ModelSettings {
  modelSource: ModelSource;
  scale: {
    mode: ScaleMode;
    /** Printed millimetres per real metre in fixed mode. 0.07 is about 1:14,286. */
    mmPerMetre: number;
    /** Longest printed side in fit mode. */
    fitMm: number;
  };
  terrain: {
    /** false builds a flat base; no elevation download. */
    elevation: boolean;
    exaggeration: number;
    /** Radius in grid cells of the mean filter over the elevation grid. */
    smoothing: number;
    /** Grid cells across the longer side. */
    resolution: number;
    /** Thickness below the lowest terrain point. */
    baseThicknessMm: number;
  };
  water: {
    enabled: boolean;
    mode: WaterMode;
    /** Thickness of the water part, except large water cut through the base, which runs down to the base. */
    thicknessMm: number;
    /** Water at least this large is levelled from its shores (and cut through with 'through'); smaller water is a surface sheet. */
    cutMinAreaM2: number;
    skipPonds: boolean;
  };
  land: {
    enabled: boolean;
    riseMm: number;
    embedMm: number;
    /** Highest priority first; a higher category owns overlapping ground. */
    priority: SurfaceCategory[];
    taperBeaches: boolean;
    beachWidthMm: number;
  };
  roads: {
    enabled: boolean;
    thicknessMm: number;
    minWidthMm: number;
    maxWidthMm: number;
    includePaths: boolean;
    skipSidewalks: boolean;
    includeRail: boolean;
    includeAirports: boolean;
    /** Tidy the centerlines before they're widened. Off prints every mapped line as it comes. */
    tidy: boolean;
    /** Leave out a line running alongside a more important one closer than the gap. */
    removeDoubled: boolean;
    /** Merge the two carriageways of a divided road onto the middle of the road. */
    mergeDivided: boolean;
    /** Join a loose end to the road it nearly meets. */
    joinEnds: boolean;
    /** Leave out short spurs leading nowhere and small pieces touching nothing. */
    removeFragments: boolean;
    /** Fill ground narrower than the gap between two ribbons, so it prints as road. */
    fillGaps: boolean;
    /** Narrowest strip of ground left between two ribbons running alongside each other. */
    gapMm: number;
  };
  bridges: {
    enabled: boolean;
    deckThicknessMm: number;
    clearanceMm: number;
    maxGrade: number;
    minLiftMm: number;
    pierSpacingM: number;
    pierMinSizeMm: number;
  };
  buildings: {
    enabled: boolean;
    heightScale: number;
    minHeightMm: number;
    /** Only footprints covering at least this square are raised to the minimum height. */
    minHeightFootprintMm: number;
    defaultHeightM: number;
    floorHeightM: number;
    roofShapes: boolean;
    restoreMainBodies: boolean;
    /** Build parts mapped to start above the ground down to the terrain, so nothing hangs in the air. */
    groundRaisedParts: boolean;
    /** Drop masses narrower than this. 0 keeps everything. */
    minWidthMm: number;
    /** Drop masses taller than this multiple of their width. 0 disables. */
    maxSlenderness: number;
    slendernessExemptMm: number;
  };
  trees: {
    enabled: boolean;
    spacingM: number;
    minHeightMm: number;
    minWidthMm: number;
    variation: number;
    maxTrees: number;
    mapped: boolean;
    forestScatter: boolean;
    landCoverScatter: boolean;
    avoidRoads: boolean;
  };
  /** Building roofs and heights measured from public LiDAR surveys. */
  lidar: {
    enabled: boolean;
    /** 'envelope' rebuilds whole roofs; 'heights' only corrects mapped heights. */
    roofMode: LidarRoofMode;
    /** Use a usable scan even where mapped heights, dates or another survey disagree. */
    preferLidar: boolean;
    /** Buildings with a smaller printed footprint keep their mapped shape. 0 measures every one. */
    minFootprintMm2: number;
    /** Also measure mapped bare rock. */
    rockSurfaces: boolean;
  };
  /**
   * The LiDAR Only model: one solid in the terrain colour, and optionally the
   * water as a part of its own. Scale, terrain exaggeration, base thickness,
   * the rim, and the water thickness and cut size are shared with map models.
   */
  lidarModel: {
    /** Printed size of one grid cell. Cells grow where the survey is too sparse or the area too large. */
    detailMm: number;
    /** Crowns as scanned with speckle softened, rounded into smooth masses, or off with the ground or roof under them in their place. */
    trees: TreeStyle;
    /** Keep cars, fences, benches and whatever else stands under 2 m. Off flattens them. Poles, crane jibs and wires go either way. */
    keepClutter: boolean;
    /** How far recessed water sits below its lowest bank. A water layer sits 0.25 mm below, like map models'. */
    waterDepthMm: number;
    waterMode: LidarWaterMode;
    /** Cut water along mapped water's outline where it agrees with the survey, and fill in water where the survey has no returns. */
    mapWater: boolean;
    /** Multiplies the height of everything standing on the ground. */
    heightScale: number;
  };
  /** Keep ground under roads, buildings and piers that stand over cut water. */
  supports: boolean;
  rim: {
    enabled: boolean;
    heightMm: number;
    widthMm: number;
  };
}

export const DEFAULT_SETTINGS: ModelSettings = {
  modelSource: 'map',
  scale: { mode: 'fixed', mmPerMetre: 0.07, fitMm: 180 },
  terrain: { elevation: true, exaggeration: 1, smoothing: 1, resolution: 192, baseThicknessMm: 1.3 },
  water: {
    enabled: true,
    mode: 'layer',
    thicknessMm: 1,
    cutMinAreaM2: 5000,
    skipPonds: false,
  },
  land: {
    enabled: true,
    riseMm: 0.4,
    embedMm: 0.04,
    priority: ['paved', 'sand', 'rock', 'green', 'forest'],
    taperBeaches: false,
    beachWidthMm: 1.5,
  },
  roads: {
    enabled: true,
    thicknessMm: 0.6,
    minWidthMm: 0.45,
    maxWidthMm: 0.7,
    includePaths: true,
    skipSidewalks: true,
    includeRail: true,
    includeAirports: true,
    tidy: true,
    removeDoubled: true,
    mergeDivided: true,
    joinEnds: true,
    removeFragments: true,
    fillGaps: true,
    gapMm: 0.4,
  },
  bridges: {
    enabled: false,
    deckThicknessMm: 0.6,
    clearanceMm: 0.4,
    maxGrade: 0.08,
    minLiftMm: 0.2,
    pierSpacingM: 30,
    pierMinSizeMm: 0.6,
  },
  buildings: {
    enabled: true,
    heightScale: 1.1,
    minHeightMm: 0.8,
    minHeightFootprintMm: 0.6,
    defaultHeightM: 10,
    floorHeightM: 3,
    roofShapes: true,
    restoreMainBodies: true,
    groundRaisedParts: true,
    minWidthMm: 0,
    maxSlenderness: 0,
    slendernessExemptMm: 0.45,
  },
  trees: {
    enabled: false,
    spacingM: 26,
    minHeightMm: 1.6,
    minWidthMm: 1.1,
    variation: 0.18,
    maxTrees: 24000,
    mapped: true,
    forestScatter: true,
    landCoverScatter: true,
    avoidRoads: true,
  },
  lidar: { enabled: false, roofMode: 'envelope', preferLidar: true, minFootprintMm2: 0.7, rockSurfaces: false },
  lidarModel: { detailMm: 0.05, trees: 'natural', keepClutter: true, waterDepthMm: 0.6, waterMode: 'recess', mapWater: true, heightScale: 1 },
  supports: true,
  rim: { enabled: false, heightMm: 1.5, widthMm: 2 },
};

// The Chicago Loop at 170.5 x 119.5 mm printed (the default 0.07 mm per metre).
export const DEFAULT_AREA: AreaSpec = {
  center: [-87.62838, 41.883335],
  widthM: 2435.71,
  heightM: 1707.14,
  rotationDeg: 0,
  shape: 'rectangle',
  cornerRadius: 0.1,
};

// ------------------------------------------------------------------ printers

export interface Printer {
  key: string;
  model: string;
  vendor: 'Bambu Lab' | 'Prusa' | 'Other';
  width: number;
  depth: number;
  height: number;
  /** Bambu Studio presets, as bundled with Bambu Studio 2.8. */
  bambu?: { printProfile: string; filamentProfile: string };
}

export const PRINTERS: Printer[] = [
  { key: 'A1M', model: 'Bambu Lab A1 mini', vendor: 'Bambu Lab', width: 180, depth: 180, height: 180,
    bambu: { printProfile: '0.20mm Standard @BBL A1M', filamentProfile: 'Bambu PLA Basic @BBL A1M' } },
  { key: 'A1', model: 'Bambu Lab A1', vendor: 'Bambu Lab', width: 256, depth: 256, height: 256,
    bambu: { printProfile: '0.20mm Standard @BBL A1', filamentProfile: 'Bambu PLA Basic @BBL A1' } },
  { key: 'P1P', model: 'Bambu Lab P1P', vendor: 'Bambu Lab', width: 256, depth: 256, height: 250,
    bambu: { printProfile: '0.20mm Standard @BBL P1P', filamentProfile: 'Bambu PLA Basic @BBL P1P' } },
  { key: 'P1S', model: 'Bambu Lab P1S', vendor: 'Bambu Lab', width: 256, depth: 256, height: 250,
    bambu: { printProfile: '0.20mm Standard @BBL X1C', filamentProfile: 'Bambu PLA Basic @BBL P1S 0.4 nozzle' } },
  { key: 'P2S', model: 'Bambu Lab P2S', vendor: 'Bambu Lab', width: 256, depth: 256, height: 256,
    bambu: { printProfile: '0.20mm Standard @BBL P2S', filamentProfile: 'Bambu PLA Basic @BBL P2S' } },
  { key: 'X1C', model: 'Bambu Lab X1 Carbon', vendor: 'Bambu Lab', width: 256, depth: 256, height: 250,
    bambu: { printProfile: '0.20mm Standard @BBL X1C', filamentProfile: 'Bambu PLA Basic @BBL X1C' } },
  { key: 'X1E', model: 'Bambu Lab X1E', vendor: 'Bambu Lab', width: 256, depth: 256, height: 250,
    bambu: { printProfile: '0.20mm Standard @BBL X1C', filamentProfile: 'Bambu PLA Basic @BBL X1C' } },
  { key: 'X2D', model: 'Bambu Lab X2D', vendor: 'Bambu Lab', width: 256, depth: 256, height: 261,
    bambu: { printProfile: '0.20mm Standard @BBL X2D', filamentProfile: 'Bambu PLA Basic @BBL X2D 0.4 nozzle' } },
  { key: 'A2L', model: 'Bambu Lab A2L', vendor: 'Bambu Lab', width: 330, depth: 320, height: 325,
    bambu: { printProfile: '0.20mm Standard @BBL A2L', filamentProfile: 'Bambu PLA Basic @BBL A2L 0.4 nozzle' } },
  { key: 'H2C', model: 'Bambu Lab H2C', vendor: 'Bambu Lab', width: 330, depth: 320, height: 325,
    bambu: { printProfile: '0.20mm Standard @BBL H2C', filamentProfile: 'Bambu PLA Basic @BBL H2C' } },
  { key: 'H2S', model: 'Bambu Lab H2S', vendor: 'Bambu Lab', width: 340, depth: 320, height: 340,
    bambu: { printProfile: '0.20mm Standard @BBL H2S', filamentProfile: 'Bambu PLA Basic @BBL H2S' } },
  { key: 'H2D', model: 'Bambu Lab H2D', vendor: 'Bambu Lab', width: 350, depth: 320, height: 325,
    bambu: { printProfile: '0.20mm Standard @BBL H2D', filamentProfile: 'Bambu PLA Basic @BBL H2D' } },
  { key: 'H2DP', model: 'Bambu Lab H2D Pro', vendor: 'Bambu Lab', width: 350, depth: 320, height: 325,
    bambu: { printProfile: '0.20mm Standard @BBL H2DP', filamentProfile: 'Bambu PLA Basic @BBL H2DP' } },
  { key: 'MK4', model: 'Prusa MK4 / MK4S', vendor: 'Prusa', width: 250, depth: 210, height: 220 },
  { key: 'COREONE', model: 'Prusa CORE One', vendor: 'Prusa', width: 250, depth: 220, height: 270 },
  { key: 'MINI', model: 'Prusa MINI+', vendor: 'Prusa', width: 180, depth: 180, height: 180 },
  { key: 'XL', model: 'Prusa XL', vendor: 'Prusa', width: 360, depth: 360, height: 360 },
  { key: 'GENERIC220', model: 'Other printer (220 x 220 mm)', vendor: 'Other', width: 220, depth: 220, height: 250 },
  { key: 'GENERIC300', model: 'Other printer (300 x 300 mm)', vendor: 'Other', width: 300, depth: 300, height: 300 },
];

export const DEFAULT_PRINTER = 'P1S';

export function printerByKey(key: string): Printer {
  return PRINTERS.find((p) => p.key === key) ?? PRINTERS.find((p) => p.key === DEFAULT_PRINTER)!;
}

// ------------------------------------------------------------------ palette

export interface PaletteEntry {
  /** #RRGGBB */
  hex: string;
  line: FilamentLine;
}

export type Palette = Record<ColourGroup, PaletteEntry>;

export interface ColourGroupInfo {
  key: ColourGroup;
  label: string;
  description: string;
}

export const COLOUR_GROUPS: ColourGroupInfo[] = [
  { key: 'terrain', label: 'Terrain', description: 'Terrain, and the ground kept under structures over water' },
  { key: 'buildings', label: 'Buildings', description: 'Buildings and building parts' },
  { key: 'roads', label: 'Roads', description: 'Roads, paths, railways, airport paving, bridges and piers' },
  { key: 'paved', label: 'Paved', description: 'Paved plazas and pedestrian areas' },
  { key: 'water', label: 'Water', description: 'Rivers, lakes, the sea and ponds' },
  { key: 'green', label: 'Parks', description: 'Parks, grass and other green land cover' },
  { key: 'forest', label: 'Forest', description: 'Forest floor' },
  { key: 'trees', label: 'Trees', description: 'Trees' },
  { key: 'sand', label: 'Sand', description: 'Sand and beaches' },
  { key: 'rock', label: 'Rock', description: 'Bare rock' },
  { key: 'rim', label: 'Rim', description: 'Border rim' },
];

// Single-colour PLA Basic and PLA Matte filaments, as named and coded in
// Bambu Studio 2.8's filaments_color_codes.json.
export const FILAMENTS: Record<FilamentLine, Record<string, string>> = {
  'PLA Basic': {
    'Bambu Green': '#00AE42', Beige: '#F7E6DE', Black: '#000000', Blue: '#0A2989',
    'Blue Gray': '#5B6579', 'Bright Green': '#BECF00', Bronze: '#847D48',
    Brown: '#9D432C', 'Cobalt Blue': '#0056B8', 'Cocoa Brown': '#6F5034',
    Cyan: '#0086D6', 'Dark Gray': '#545454', Gold: '#E4BD68', Gray: '#8E9089',
    'Hot Pink': '#F5547C', 'Indigo Purple': '#482960', 'Jade White': '#FFFFFF',
    'Light Gray': '#D1D3D5', Magenta: '#EC008C', 'Maroon Red': '#9D2235',
    'Mistletoe Green': '#3F8E43', Orange: '#FF6A13', Pink: '#F55A74',
    'Pumpkin Orange': '#FF9016', Purple: '#5E43B7', Red: '#C12E1F',
    Silver: '#A6A9AA', 'Sunflower Yellow': '#FEC600', Turquoise: '#00B1B7',
    Yellow: '#F4EE2A',
  },
  'PLA Matte': {
    'Apple Green': '#C2E189', 'Ash Gray': '#9B9EA0', 'Bone White': '#CBC6B8',
    Caramel: '#AE835B', Charcoal: '#000000', 'Dark Blue': '#042F56',
    'Dark Brown': '#7D6556', 'Dark Chocolate': '#4D3324', 'Dark Green': '#68724D',
    'Dark Red': '#BB3D43', 'Desert Tan': '#E8DBB7', 'Grass Green': '#61C680',
    'Ice Blue': '#A3D8E1', 'Ivory White': '#FFFFFF', 'Latte Brown': '#D3B7A7',
    'Lemon Yellow': '#F7D959', 'Lilac Purple': '#AE96D4', 'Mandarin Orange': '#F99963',
    'Marine Blue': '#0078BF', 'Nardo Gray': '#757575', Plum: '#950051',
    'Sakura Pink': '#E8AFCF', 'Scarlet Red': '#DE4343', 'Sky Blue': '#56B7E6',
    Terracotta: '#B15533',
  },
};

/** The Bambu filament a palette entry exports as, e.g. "PLA Matte Caramel", else "". */
export function filamentName(entry: PaletteEntry): string {
  const hex = entry.hex.toUpperCase();
  for (const [name, code] of Object.entries(FILAMENTS[entry.line] ?? {})) {
    if (code === hex) return `${entry.line} ${name}`;
  }
  return '';
}

const f = (line: FilamentLine, name: string): PaletteEntry => ({ hex: FILAMENTS[line][name], line });
const IVORY = f('PLA Matte', 'Ivory White');
const CARAMEL = f('PLA Matte', 'Caramel');
const DARK_GRAY = f('PLA Basic', 'Dark Gray');
const ASH_GRAY = f('PLA Matte', 'Ash Gray');
const BAMBU_GREEN = f('PLA Basic', 'Bambu Green');
const FOREST = f('PLA Basic', 'Mistletoe Green');
// The add-on's original non-Bambu colours of the Default preset (stored as
// 0-1 floats there, written here as the hex the export produced).
const WATER: PaletteEntry = { hex: '#5CB2D1', line: 'PLA Basic' };
const SAND: PaletteEntry = { hex: '#8C6338', line: 'PLA Basic' };
const RIM: PaletteEntry = { hex: '#29292B', line: 'PLA Basic' };

export interface PalettePreset {
  key: string;
  name: string;
  description: string;
  palette: Palette;
}

export const PALETTE_PRESETS: PalettePreset[] = [
  {
    key: 'DEFAULT', name: 'Default',
    description: 'Matte Caramel buildings, Matte Ivory White terrain, Basic Dark Gray roads, Matte Ash Gray paving, Basic Bambu Green parks',
    palette: { terrain: IVORY, buildings: CARAMEL, roads: DARK_GRAY, paved: ASH_GRAY, water: WATER,
      green: BAMBU_GREEN, forest: FOREST, trees: FOREST, sand: SAND, rock: SAND, rim: RIM },
  },
  {
    key: 'AMS4', name: '4-Colour AMS',
    description: 'White terrain and buildings, dark gray roads, green parks and trees, blue water: at most four filaments',
    palette: { terrain: IVORY, buildings: IVORY, roads: DARK_GRAY, paved: DARK_GRAY,
      water: f('PLA Matte', 'Sky Blue'), green: BAMBU_GREEN, forest: BAMBU_GREEN, trees: BAMBU_GREEN,
      sand: IVORY, rock: IVORY, rim: DARK_GRAY },
  },
  {
    key: 'CLASSIC', name: 'Classic Map',
    description: 'Beige land, terracotta buildings, white roads, pale blue water and green parks',
    palette: { terrain: f('PLA Basic', 'Beige'), buildings: f('PLA Matte', 'Terracotta'),
      roads: f('PLA Basic', 'Jade White'), paved: f('PLA Basic', 'Jade White'),
      water: f('PLA Matte', 'Ice Blue'), green: f('PLA Matte', 'Apple Green'),
      forest: f('PLA Matte', 'Apple Green'), trees: f('PLA Matte', 'Grass Green'),
      sand: f('PLA Matte', 'Desert Tan'), rock: f('PLA Matte', 'Desert Tan'), rim: f('PLA Matte', 'Dark Brown') },
  },
  {
    key: 'NIGHT', name: 'Night',
    description: 'Black terrain, gray buildings, gold roads, dark blue water and dark green parks',
    palette: { terrain: f('PLA Matte', 'Charcoal'), buildings: f('PLA Matte', 'Ash Gray'),
      roads: f('PLA Basic', 'Gold'), paved: f('PLA Basic', 'Gold'),
      water: f('PLA Matte', 'Dark Blue'), green: f('PLA Matte', 'Dark Green'),
      forest: f('PLA Matte', 'Dark Green'), trees: f('PLA Matte', 'Dark Green'),
      sand: f('PLA Matte', 'Dark Brown'), rock: f('PLA Matte', 'Dark Brown'), rim: f('PLA Matte', 'Charcoal') },
  },
  {
    key: 'SINGLE', name: 'Single Colour',
    description: 'Everything in PLA Matte Ivory White: one filament, for printers without multi-material',
    palette: { terrain: IVORY, buildings: IVORY, roads: IVORY, paved: IVORY, water: IVORY, green: IVORY,
      forest: IVORY, trees: IVORY, sand: IVORY, rock: IVORY, rim: IVORY },
  },
];

export const DEFAULT_PALETTE: Palette = PALETTE_PRESETS[0].palette;

// ------------------------------------------------------------------ export

export const EXPORT_FORMATS = ['bambu', 'prusa', '3mf', 'stl-zip', 'stl'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// Smallest print section, per side.
export const MIN_SECTION_MM = 20;

export interface ExportSettings {
  format: ExportFormat;
  printer: string;
  multiPlate: boolean;
  sectionWidthMm: number;
  sectionHeightMm: number;
}

export const DEFAULT_EXPORT: ExportSettings = {
  format: 'bambu',
  printer: DEFAULT_PRINTER,
  multiPlate: false,
  sectionWidthMm: 210,
  sectionHeightMm: 210,
};

/** Deep copy that keeps the shape of the defaults, for resets and saved state. */
export function cloneSettings(settings: ModelSettings = DEFAULT_SETTINGS): ModelSettings {
  return structuredClone(settings);
}

type Range = [min: number, max: number, integer?: boolean];
type NumberKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];
type SettingsRanges = {
  [G in keyof ModelSettings as ModelSettings[G] extends object ? G : never]: Record<NumberKeys<ModelSettings[G]>, Range>;
};

// Valid values of every number setting, shared with the panels. Grades and
// tree size variation are fractions here and percentages in the UI.
const RANGES: SettingsRanges = {
  scale: { mmPerMetre: [0.001, 2], fitMm: [20, 2000] },
  terrain: { exaggeration: [0, 10], smoothing: [0, 4, true], resolution: [16, 1024, true], baseThicknessMm: [0.1, 20] },
  water: { thicknessMm: [0.1, 5], cutMinAreaM2: [0, 1e6, true] },
  land: { riseMm: [0.02, 3], embedMm: [0.02, 1], beachWidthMm: [0.1, 5] },
  roads: { thicknessMm: [0.05, 5], minWidthMm: [0.05, 5], maxWidthMm: [0.1, 5], gapMm: [0, 2] },
  bridges: {
    deckThicknessMm: [0.05, 10],
    clearanceMm: [0, 3],
    maxGrade: [0.01, 0.5],
    minLiftMm: [0, 2],
    pierSpacingM: [1, 200],
    pierMinSizeMm: [0.1, 3],
  },
  buildings: {
    heightScale: [0.1, 3],
    minHeightMm: [0, 5],
    minHeightFootprintMm: [0, 10],
    defaultHeightM: [1, 100],
    floorHeightM: [1, 10],
    minWidthMm: [0, 2],
    maxSlenderness: [0, 60],
    slendernessExemptMm: [0, 2],
  },
  trees: { spacingM: [2, 200], minHeightMm: [0.1, 10], minWidthMm: [0.1, 5], variation: [0, 0.8], maxTrees: [0, 500000, true] },
  lidar: { minFootprintMm2: [0, 10] },
  lidarModel: { detailMm: [0.02, 0.3], waterDepthMm: [0, 3], heightScale: [0.1, 3] },
  rim: { heightMm: [0.1, 30], widthMm: [0.1, 20] },
};

/** Input bounds in displayed units, matching NumberInput's scale. */
export function modelFieldRange<G extends keyof SettingsRanges>(
  group: G,
  field: keyof SettingsRanges[G],
  scale = 1,
): { min: number; max: number } {
  const [min, max] = RANGES[group][field] as Range;
  return { min: min * scale, max: max * scale };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Settings made safe to generate from, wherever they came from (saved state,
 * a CLI file). Numbers are clamped to their range and integers rounded.
 * Anything missing or of the wrong type takes its default, and unknown keys
 * are dropped. A 0 cell terrain grid or a 0 m floor height would otherwise
 * give NaN terrain or silently drop buildings.
 */
export function sanitizeSettings(settings: unknown): ModelSettings {
  const source = isObject(settings) ? settings : {};
  const out = cloneSettings();
  const groups = out as unknown as Json;
  for (const [key, group] of Object.entries(groups)) {
    const given = source[key];
    if (!isObject(group)) {
      if (typeof given === typeof group) groups[key] = given;
      continue;
    }
    const values = isObject(given) ? given : {};
    const ranges = (RANGES as unknown as Record<string, Record<string, Range>>)[key];
    for (const [field, fallback] of Object.entries(group)) {
      const value = values[field];
      if (typeof fallback === 'number' && typeof value === 'number' && Number.isFinite(value)) {
        const [min, max, integer] = ranges[field];
        group[field] = Math.min(max, Math.max(min, integer ? Math.round(value) : value));
      } else if (typeof fallback === 'boolean' && typeof value === 'boolean') {
        group[field] = value;
      }
    }
  }
  out.modelSource = source.modelSource === 'lidar' ? 'lidar' : 'map';
  const scale = isObject(source.scale) ? source.scale : {};
  if (scale.mode === 'fixed' || scale.mode === 'fit') out.scale.mode = scale.mode;
  const water = isObject(source.water) ? source.water : {};
  if (water.mode === 'layer' || water.mode === 'through') out.water.mode = water.mode;
  const lidar = isObject(source.lidar) ? source.lidar : {};
  if (lidar.roofMode === 'envelope' || lidar.roofMode === 'heights') out.lidar.roofMode = lidar.roofMode;
  const lidarModel = isObject(source.lidarModel) ? source.lidarModel : {};
  const waterMode = lidarModel.waterMode;
  if (waterMode === 'recess' || waterMode === 'layer' || waterMode === 'cut') out.lidarModel.waterMode = waterMode;
  // Saved before the water modes, when cutting was a checkbox.
  else if (lidarModel.cutWater === true) out.lidarModel.waterMode = 'cut';
  const trees = lidarModel.trees;
  if (trees === 'natural' || trees === 'rounded' || trees === 'off') out.lidarModel.trees = trees;
  // Saved when trees were rounded or left out. Rounded was the only way to
  // keep them then, but the new default is closer to what was asked for.
  else if (lidarModel.keepTrees === false) out.lidarModel.trees = 'off';
  // The priority must name every surface category once.
  const land = isObject(source.land) ? source.land : {};
  const all = DEFAULT_SETTINGS.land.priority;
  const priority = land.priority;
  if (Array.isArray(priority) && priority.length === all.length && all.every((c) => priority.includes(c))) {
    out.land.priority = [...priority];
  }
  return out;
}
