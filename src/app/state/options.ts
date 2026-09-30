import { sanitizeEdits, type ModelEdits } from '../../core/edit/types';
import { sanitizeSettings, type AreaSpec, type ExportSettings, type ModelSettings, type Palette } from '../../core/settings';
import { normalizeArea } from '../lib/area';
import { defaultSvgSettings, isObject, mergeSettings, type SvgSettings } from '../svgmap/settings';
import { readExport, readPalette } from './persist';

export const MAX_OPTIONS_BYTES = 1024 * 1024;
const FORMAT = 'jarvizar-city-model-options';
const SVG_CHOICES: Record<string, readonly (string | number)[]> = {
  'border.style': ['double', 'single', 'none'],
  'label.style': ['box', 'band'],
  'label.position': ['lower_right', 'lower_left', 'upper_right', 'upper_left', 'lower_center', 'upper_center'],
  'label.rotation': [0, 90, 180, 270],
  'label.bandPosition': ['bottom', 'top'],
  'label.bandAlign': ['left', 'center', 'right'],
  cleanupPreset: ['off', 'light', 'standard', 'strong', 'custom'],
};

export interface Options {
  output: 'model' | 'svg';
  settings: ModelSettings;
  palette: Palette;
  exportSettings: ExportSettings;
  svg: SvgSettings;
  map?: SavedMap;
}

export interface SavedMap {
  area: AreaSpec;
  placeName: string;
  fileName: string | null;
  /** The 3D editor's changes, which only mean something for this area. */
  edits?: ModelEdits;
}

export function encodeOptions({ output, settings, palette, exportSettings, svg }: Options, map?: SavedMap): string {
  return JSON.stringify({ format: FORMAT, version: 1, output, settings, palette, exportSettings, svg, map }, null, 2) + '\n';
}

// Missing fields get defaults and unknown fields are ignored. Reject damaged
// known values rather than silently importing only part of the user's options.
function checkValues(given: unknown, clean: unknown, path: string): void {
  const svgPath = path.startsWith('options.svg.') ? path.slice('options.svg.'.length) : null;
  if (svgPath) {
    const choices = svgPath.includes('.fillModes.') ? ['fill', 'outline', 'hatch', 'hatch-outline'] : SVG_CHOICES[svgPath];
    if (choices && !choices.includes(given as string | number)) throw new Error(`Invalid option: ${path}.`);
    if (typeof given === 'number' && given < 0 && !svgPath.endsWith('.angle')) throw new Error(`Invalid option: ${path}.`);
  }
  if (isObject(clean) && isObject(given)) {
    for (const [key, value] of Object.entries(clean)) {
      if (Object.hasOwn(given, key)) checkValues(given[key], value, `${path}.${key}`);
    }
    return;
  }
  if (Array.isArray(clean) && Array.isArray(given) && JSON.stringify(clean) === JSON.stringify(given)) return;
  if (typeof clean === 'string' && /^#[0-9a-f]{6}$/i.test(clean) && typeof given === 'string' && clean.toLowerCase() === given.toLowerCase()) return;
  if (given !== clean) throw new Error(`Invalid option: ${path}.`);
}

export function decodeOptions(text: string): Options {
  if (new TextEncoder().encode(text).byteLength > MAX_OPTIONS_BYTES) throw new Error('Options files must be smaller than 1 MB.');
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('This file is not valid JSON. Choose an exported options file.');
  }
  if (!isObject(raw) || raw.format !== FORMAT) throw new Error('This is not a City Model options file.');
  if (raw.version !== 1) throw new Error('This options file uses an unsupported version. Try updating the app.');
  if (raw.output !== 'model' && raw.output !== 'svg') throw new Error('Invalid option: output.');
  for (const key of ['settings', 'palette', 'exportSettings', 'svg']) {
    if (!isObject(raw[key])) throw new Error(`Missing or invalid options: ${key}.`);
  }
  const options: Options = {
    output: raw.output,
    settings: sanitizeSettings(raw.settings),
    palette: readPalette(raw.palette)!,
    exportSettings: readExport(raw.exportSettings)!,
    svg: mergeSettings(defaultSvgSettings(), raw.svg),
  };
  if (raw.map !== undefined) {
    const map = raw.map;
    const area = isObject(map) && isObject(map.area) ? map.area : {};
    if (!isObject(map) || !Array.isArray(area.center) || area.center.length !== 2 ||
      !area.center.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
      !['widthM', 'heightM', 'rotationDeg', 'cornerRadius'].every((key) => typeof area[key] === 'number' && Number.isFinite(area[key])) ||
      typeof area.shape !== 'string' || typeof map.placeName !== 'string' || (map.fileName !== null && typeof map.fileName !== 'string')) {
      throw new Error('Missing or invalid saved map area.');
    }
    options.map = { area: normalizeArea(area as unknown as AreaSpec), placeName: map.placeName, fileName: map.fileName };
    if (map.edits !== undefined) {
      if (!isObject(map.edits)) throw new Error('Invalid option: map.edits.');
      options.map.edits = sanitizeEdits(map.edits);
    }
  }
  // Edits and picked roads are cleaned rather than checked: a colour's case
  // or a clamped height is no reason to refuse the file.
  const { routes: _routes, hiddenLines: _hidden, ...svg } = options.svg;
  const checked = { ...structuredClone(options), svg };
  if (checked.map) delete checked.map.edits;
  checkValues(raw, checked, 'options');
  return options;
}
