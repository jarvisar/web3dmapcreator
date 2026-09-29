import type { BorderStyle, ProductSettings } from './layout/layout';
import type { LabelSettings } from './text/label';

export interface ProductPreset {
  id: string;
  name: string;
  group: 'Plaques & frames' | 'Paper' | 'Coasters & squares';
  product: ProductSettings;
  border: BorderStyle;
  labelStyle: LabelSettings['style'];
}

const IN = 25.4;
// Frame lip of the original 5 x 7 plaque.
const plaqueMargins = { top: 3.75, right: 3.65, bottom: 3.75, left: 3.65 };
const uniform = (d: number) => ({ top: d, right: d, bottom: d, left: d });

export const PRODUCT_PRESETS: ProductPreset[] = [
  {
    id: 'plaque-5x7',
    name: '5 × 7 in plaque',
    group: 'Plaques & frames',
    product: { shape: 'rect', width: 7 * IN, height: 5 * IN, cornerRadius: 0, margins: plaqueMargins },
    border: 'double',
    labelStyle: 'box',
  },
  {
    id: 'plaque-4x6',
    name: '4 × 6 in plaque',
    group: 'Plaques & frames',
    product: { shape: 'rect', width: 6 * IN, height: 4 * IN, cornerRadius: 0, margins: plaqueMargins },
    border: 'double',
    labelStyle: 'box',
  },
  {
    id: 'plaque-8x10',
    name: '8 × 10 in plaque',
    group: 'Plaques & frames',
    product: { shape: 'rect', width: 10 * IN, height: 8 * IN, cornerRadius: 0, margins: plaqueMargins },
    border: 'double',
    labelStyle: 'box',
  },
  {
    id: 'a5',
    name: 'A5 (210 × 148 mm)',
    group: 'Paper',
    product: { shape: 'rect', width: 210, height: 148, cornerRadius: 0, margins: uniform(10) },
    border: 'single',
    labelStyle: 'band',
  },
  {
    id: 'a4',
    name: 'A4 (297 × 210 mm)',
    group: 'Paper',
    product: { shape: 'rect', width: 297, height: 210, cornerRadius: 0, margins: uniform(12) },
    border: 'single',
    labelStyle: 'band',
  },
  {
    id: 'a3',
    name: 'A3 (420 × 297 mm)',
    group: 'Paper',
    product: { shape: 'rect', width: 420, height: 297, cornerRadius: 0, margins: uniform(15) },
    border: 'single',
    labelStyle: 'band',
  },
  {
    id: 'letter',
    name: 'US Letter (11 × 8.5 in)',
    group: 'Paper',
    product: { shape: 'rect', width: 11 * IN, height: 8.5 * IN, cornerRadius: 0, margins: uniform(12) },
    border: 'single',
    labelStyle: 'band',
  },
  {
    id: 'square-150',
    name: 'Square tile, 150 mm',
    group: 'Coasters & squares',
    product: { shape: 'rounded', width: 150, height: 150, cornerRadius: 6, margins: uniform(3) },
    border: 'double',
    labelStyle: 'band',
  },
  {
    id: 'coaster-100',
    name: 'Round coaster, 100 mm',
    group: 'Coasters & squares',
    product: { shape: 'circle', width: 100, height: 100, cornerRadius: 0, margins: uniform(2) },
    border: 'single',
    labelStyle: 'band',
  },
  {
    id: 'coaster-sq-95',
    name: 'Square coaster, 95 mm',
    group: 'Coasters & squares',
    product: { shape: 'rounded', width: 95, height: 95, cornerRadius: 8, margins: uniform(2) },
    border: 'single',
    labelStyle: 'band',
  },
];

export interface PlacePreset {
  name: string;
  label: string;
  lon: number;
  lat: number;
  widthM: number;
}

// Where the engine's defaults start. The places to pick from are the app's
// presets (src/app/data/presets.ts).
export const DEFAULT_PLACE: PlacePreset = { name: 'Chicago', label: 'CHICAGO', lon: -87.62601, lat: 41.882245, widthM: 3208 };

export const DEFAULT_PRODUCT = PRODUCT_PRESETS[0];
