// Values computed from the state: colour groups in use, bed fit, summaries.

import { modelSizeMm } from '../../core/geo/area';
import { COLOUR_GROUPS, PALETTE_PRESETS, printerByKey } from '../../core/settings';
import type {
  AreaSpec,
  ExportFormat,
  ExportSettings,
  ModelSettings,
  Palette,
  PaletteEntry,
  PalettePreset,
  Printer,
} from '../../core/settings';
import { ROLE_GROUP } from '../../core/types';
import type { ColourGroup } from '../../core/types';
import { slugify } from '../lib/browser';
import type { ResultMeta } from './store';

/** Colour groups the enabled layers can produce, in palette order. */
export function usedGroups(settings: ModelSettings): ColourGroup[] {
  const used = new Set<ColourGroup>(['terrain']);
  if (settings.rim.enabled) used.add('rim');
  if (settings.buildings.enabled) used.add('buildings');
  if (settings.roads.enabled || settings.bridges.enabled) used.add('roads');
  if (settings.water.enabled) used.add('water');
  if (settings.land.enabled) for (const group of ['paved', 'green', 'forest', 'sand', 'rock'] as const) used.add(group);
  if (settings.trees.enabled) used.add('trees');
  return COLOUR_GROUPS.map((group) => group.key).filter((key) => used.has(key));
}

export function filamentKey(entry: PaletteEntry): string {
  return `${entry.hex.toUpperCase()}|${entry.line}`;
}

/** Distinct (colour, line) pairs among the groups: the number of filaments to load. */
export function filamentCount(palette: Palette, groups: ColourGroup[]): number {
  return new Set(groups.map((group) => filamentKey(palette[group]))).size;
}

export function matchingPreset(palette: Palette): PalettePreset | null {
  return (
    PALETTE_PRESETS.find((preset) =>
      COLOUR_GROUPS.every(({ key }) => filamentKey(preset.palette[key]) === filamentKey(palette[key])),
    ) ?? null
  );
}

export function resultGroups(result: ResultMeta): ColourGroup[] {
  const groups = new Set(result.parts.map((part) => ROLE_GROUP[part.role]));
  return COLOUR_GROUPS.map((group) => group.key).filter((key) => groups.has(key));
}

export interface BedFit {
  printer: Printer;
  width: number;
  depth: number;
  fits: boolean;
  /** Only fits turned 90 degrees on the bed. */
  rotated: boolean;
  cols: number;
  rows: number;
  plates: number;
}

export function bedFit(area: AreaSpec, settings: ModelSettings, exportSettings: ExportSettings): BedFit {
  const printer = printerByKey(exportSettings.printer);
  const { width, depth } = modelSizeMm(area, settings.scale);
  const straight = width <= printer.width && depth <= printer.depth;
  const turned = width <= printer.depth && depth <= printer.width;
  const sectionW = Math.min(exportSettings.sectionWidthMm, printer.width);
  const sectionD = Math.min(exportSettings.sectionHeightMm, printer.depth);
  const cols = Math.max(1, Math.ceil(width / sectionW - 1e-9));
  const rows = Math.max(1, Math.ceil(depth / sectionD - 1e-9));
  return { printer, width, depth, fits: straight || turned, rotated: !straight && turned, cols, rows, plates: cols * rows };
}

/** Why the model cannot be generated with these settings, or null. */
export function settingsProblem(settings: ModelSettings): string | null {
  if (settings.roads.enabled && settings.roads.minWidthMm > settings.roads.maxWidthMm) {
    return 'The minimum road width is larger than the maximum road width.';
  }
  if (settings.water.recessPonds && !settings.water.skipPonds && settings.water.pondWaterMm > settings.water.pondDepthMm) {
    return 'Pond water thickness must not be more than the recess depth.';
  }
  if (settings.scale.mode === 'fixed' && !(settings.scale.mmPerMetre > 0)) return 'The scale must be more than zero.';
  if (settings.scale.mode === 'fit' && !(settings.scale.fitMm > 0)) return 'The printed size must be more than zero.';
  return null;
}

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  bambu: '.3mf',
  prusa: '.3mf',
  '3mf': '.3mf',
  'stl-zip': '.zip',
  stl: '.stl',
};

export function autoFileBase(placeName: string): string {
  return slugify(placeName, 'city-model');
}

export function fileBase(placeName: string, fileName: string | null): string {
  const typed = fileName?.trim();
  return typed ? typed : autoFileBase(placeName);
}
