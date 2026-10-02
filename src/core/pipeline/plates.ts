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
  /** Refuse before meshing when there are more non-empty sections than this. */
  maxPlates?: number;
  progress?: Progress;
}

export interface PlatesResult {
  plates: Plate[];
  /** Solids that could not be meshed, whole or cut to a section. They are missing from the plates. */
  failed: number;
}

export async function buildPlates(spec: ModelSpec, options: PlateOptions): Promise<PlatesResult> {
  const excluded = new Set(options.exclude ?? []);
  const layers = spec.layers.filter((layer) => !excluded.has(layer.id));
  // Sections follow what is printed, so a hidden rim doesn't widen the grid.
  const outline = excluded.has('rim') ? spec.crop : spec.outline;
  const [west, south, east, north] = ringBounds(outline[0]);
  const zShift = -spec.baseZ;

  if (!options.multiPlate) {
    const meshed = await meshLayers(layers, { zShift, progress: options.progress });
    return { plates: [{ name: 'Map', parts: meshed.parts, bounds: [west, south, east, north] }], failed: meshed.failed };
  }

  const width = Math.min(options.sectionWidthMm, options.bedWidth);
  const depth = Math.min(options.sectionHeightMm, options.bedDepth);
  // Round shapes can leave corner cells empty.
  const cells = sectionGrid([west, south, east, north], width, depth, options.bedWidth, options.bedDepth)
    .map((cell) => ({ cell, clip: intersection(rectangle(...cell.bounds), [outline]) }))
    .filter(({ clip }) => clip.length > 0);
  if (options.maxPlates !== undefined && cells.length > options.maxPlates) {
    throw new Error(
      `The model needs ${cells.length} plates and a Bambu Studio project holds at most ${options.maxPlates}. ` +
        'Make the sections larger or reduce the scale.',
    );
  }
  const plates: Plate[] = [];
  let failed = 0;
  for (let i = 0; i < cells.length; i++) {
    const { cell, clip } = cells[i];
    const span: [number, number] = [i / cells.length, (i + 1) / cells.length];
    let meshed = await meshLayers(layers, { clip, zShift, progress: options.progress, span });
    // A single plate isn't cut to the outline, so the section's box alone
    // cuts the same. Cut along a round outline as well, a LiDAR only surface
    // could leave the triangulation stuck and the section came out without it.
    if (meshed.failed) {
      const plain = await meshLayers(layers, { clip: rectangle(...cell.bounds), zShift });
      if (plain.failed < meshed.failed) meshed = plain;
    }
    failed += meshed.failed;
    if (!meshed.parts.length) continue;
    plates.push({ name: cell.name, parts: meshed.parts, bounds: cell.bounds });
  }
  // Every section failing is a meshing failure, not an empty model.
  if (!plates.length && failed) throw new Error('The model could not be cut into sections. Try another section size, or export it as one plate.');
  if (!plates.length) throw new Error('Nothing to export: every part is hidden or empty');
  return { plates, failed };
}
