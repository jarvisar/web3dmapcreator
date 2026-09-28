// Plates for export: the whole model on one plate, or the model cut into
// equal sections that each fit the bed. Sections are cut in 2D before
// meshing, so every section's parts are closed shells like the whole model.

import { sectionGrid } from '../export/sections';
import { intersection, rectangle, ringBounds } from '../geometry/polygon';
import type { Plate } from '../types';
import type { Progress } from './context';
import type { ModelSpec } from './generate';
import { meshLayers } from './mesh';

export interface PlateOptions {
  multiPlate: boolean;
  sectionWidthMm: number;
  sectionHeightMm: number;
  bedWidth: number;
  bedDepth: number;
  /** Layer ids left out. */
  exclude?: string[];
  progress?: Progress;
}

export async function buildPlates(spec: ModelSpec, options: PlateOptions): Promise<Plate[]> {
  const excluded = new Set(options.exclude ?? []);
  const layers = spec.layers.filter((layer) => !excluded.has(layer.id));
  const outline = spec.outline;
  const [west, south, east, north] = ringBounds(outline[0]);
  const zShift = -spec.baseZ;

  if (!options.multiPlate) {
    const meshed = await meshLayers(layers, { zShift, progress: options.progress, span: [0, 0.8] });
    return [{ name: 'Map', parts: meshed.parts, bounds: [west, south, east, north] }];
  }

  const width = Math.min(options.sectionWidthMm, options.bedWidth);
  const depth = Math.min(options.sectionHeightMm, options.bedDepth);
  const cells = sectionGrid([west, south, east, north], width, depth, options.bedWidth, options.bedDepth);
  const plates: Plate[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const clip = intersection(rectangle(...cell.bounds), [outline]);
    if (!clip.length) continue;
    const span: [number, number] = [(0.8 * i) / cells.length, (0.8 * (i + 1)) / cells.length];
    const meshed = await meshLayers(layers, { clip, zShift, progress: options.progress, span });
    if (!meshed.parts.length) continue;
    plates.push({ name: cell.name, parts: meshed.parts, bounds: cell.bounds });
  }
  if (!plates.length) throw new Error('Nothing to export: every part is hidden or empty');
  return plates;
}
