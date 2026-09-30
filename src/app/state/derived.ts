// Values computed from the state: colour groups in use, bed fit, summaries.

import { cellSize, gridProblem } from '../../core/dsm/grid';
import { areaModelRing, effectiveScale } from '../../core/geo/area';
import { MAX_SECTIONS, sectionCount } from '../../core/export/sections';
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
import { validateArea } from '../../core/geo/area';
import { ROLE_GROUP } from '../../core/types';
import type { ColourGroup } from '../../core/types';
import { areaInBox, withRim } from '../lib/area';
import { cleanFileName, slugify } from '../lib/browser';
import { editOf, objectOf } from '../../core/edit/keys';
import type { ModelEdits } from '../../core/edit/types';
import type { RoadLines } from '../../core/engine/protocol';
import { SHAPES_PART } from '../viewer/shown';
import type { EditData } from './model';
import type { ResultMeta } from './store';

/** Colour groups the enabled layers can produce, in palette order. */
export function usedGroups(settings: ModelSettings): ColourGroup[] {
  const used = new Set<ColourGroup>(['terrain']);
  if (settings.rim.enabled) used.add('rim');
  // A LiDAR Only model is one part in the terrain colour, and its water can be another.
  if (settings.modelSource === 'lidar') {
    if (settings.lidarModel.waterMode === 'layer') used.add('water');
    return COLOUR_GROUPS.map((group) => group.key).filter((key) => used.has(key));
  }
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

/** Distinct (colour, line) pairs among the groups and custom layers: the number of filaments to load. */
export function filamentCount(palette: Palette, groups: ColourGroup[], layers: readonly PaletteEntry[] = []): number {
  return new Set([...groups.map((group) => filamentKey(palette[group])), ...layers.map(filamentKey)]).size;
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

const roadKeySets = new WeakMap<RoadLines, Set<string>>();

function roadKeys(roads: RoadLines | null): Set<string> {
  if (!roads) return new Set();
  let keys = roadKeySets.get(roads);
  if (!keys) roadKeySets.set(roads, (keys = new Set(roads.keys)));
  return keys;
}

/**
 * The parts a download can have, by the ids the viewer hides them by: the
 * model's own, custom layers something in this model is in, and added
 * shapes in a model colour. Hiding one leaves it out of the download.
 * Edits are kept for every area, so a layer can hold only things this
 * model doesn't have, and then it adds nothing.
 */
export function downloadParts(result: ResultMeta, edits: ModelEdits, data: Pick<EditData, 'editable' | 'objects' | 'roads'>): string[] {
  const ids = result.parts.map((part) => part.id);
  // A model that couldn't be edited downloads as generated.
  if (!data.editable) return ids;
  const trees = ids.includes('trees');
  const roads = roadKeys(data.roads);
  const has = (key: string) => (key.startsWith('t:') ? trees : key.startsWith('r:') ? roads.has(key) : objectOf(key) in data.objects);
  const filled = new Set(edits.shapes.map((shape) => shape.layer));
  for (const [key, edit] of Object.entries(edits.objects)) {
    if (!edit.layer || edit.removed || editOf(edits, objectOf(key))?.removed) continue;
    if (has(key)) filled.add(edit.layer);
  }
  for (const layer of edits.layers) if (filled.has(layer.id)) ids.push(`layer:${layer.id}`);
  if (edits.shapes.some((shape) => !edits.layers.some((layer) => layer.id === shape.layer))) ids.push(SHAPES_PART);
  return ids;
}

/** How many of those are hidden, and whether that's all of them. */
export function hiddenDownloadParts(
  result: ResultMeta,
  edits: ModelEdits,
  data: Pick<EditData, 'editable' | 'objects' | 'roads'>,
  hidden: readonly string[],
): { hidden: number; all: boolean } {
  const ids = downloadParts(result, edits, data);
  const count = ids.filter((id) => hidden.includes(id)).length;
  return { hidden: count, all: ids.length > 0 && count === ids.length };
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

type SizeSettings = Pick<ModelSettings, 'scale' | 'rim'>;

// Measured the way the export does it, so sizes and plate counts agree.
function modelOutline(area: AreaSpec, settings: SizeSettings) {
  const outline = withRim(areaModelRing(area, effectiveScale(area, settings.scale)), settings.rim.enabled ? settings.rim.widthMm : 0);
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const [west, south, east, north] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return { outline, west, south, width: east - west, depth: north - south };
}

/** Printed width and depth, rim included. */
export function printedSize(area: AreaSpec, settings: SizeSettings): { width: number; depth: number } {
  const { width, depth } = modelOutline(area, settings);
  return { width, depth };
}

export function bedFit(area: AreaSpec, settings: ModelSettings, exportSettings: ExportSettings): BedFit {
  const printer = printerByKey(exportSettings.printer);
  const { outline, west, south, width, depth } = modelOutline(area, settings);
  const straight = width <= printer.width && depth <= printer.depth;
  const turned = width <= printer.depth && depth <= printer.width;
  const cols = sectionCount(width, Math.min(exportSettings.sectionWidthMm, printer.width));
  const rows = sectionCount(depth, Math.min(exportSettings.sectionHeightMm, printer.depth));
  // Round shapes leave some corner cells empty, and those get no plate. The
  // export refuses a grid over MAX_SECTIONS cells, empty or not, so those
  // aren't counted. A 30 km area in 20 mm sections is nine million cells.
  let plates = cols * rows;
  if (plates <= MAX_SECTIONS) {
    plates = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const box: [number, number, number, number] = [
          west + (width * c) / cols,
          south + (depth * r) / rows,
          west + (width * (c + 1)) / cols,
          south + (depth * (r + 1)) / rows,
        ];
        if (areaInBox(outline, box) > 1e-6) plates++;
      }
    }
  }
  return { printer, width, depth, fits: straight || turned, rotated: !straight && turned, cols, rows, plates };
}

/** Why the model cannot be generated from this area and these settings, or null. */
export function generationProblem(area: AreaSpec, settings: ModelSettings): string | null {
  return validateArea(area) ?? settingsProblem(settings) ?? lidarModelProblem(area, settings);
}

function lidarModelProblem(area: AreaSpec, settings: ModelSettings): string | null {
  if (settings.modelSource !== 'lidar') return null;
  const scale = effectiveScale(area, settings.scale);
  if (!(scale > 0)) return null;
  return gridProblem(area.widthM, area.heightM, cellSize(settings.lidarModel.detailMm, scale, area.widthM, area.heightM));
}

function settingsProblem(settings: ModelSettings): string | null {
  if (settings.scale.mode === 'fixed' && !(settings.scale.mmPerMetre > 0)) return 'The scale must be more than zero.';
  if (settings.scale.mode === 'fit' && !(settings.scale.fitMm > 0)) return 'The printed size must be more than zero.';
  if (settings.modelSource === 'lidar') return settings.lidarModel.detailMm > 0 ? null : 'The detail must be more than zero.';
  if (settings.roads.enabled && settings.roads.minWidthMm > settings.roads.maxWidthMm) {
    return 'The minimum road width is larger than the maximum road width.';
  }
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

/** File name for downloads and screenshots, without the extension. */
export function fileBase(placeName: string, fileName: string | null): string {
  const typed = fileName?.trim();
  return (typed && cleanFileName(typed)) || autoFileBase(placeName);
}
