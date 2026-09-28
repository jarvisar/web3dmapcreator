// Export entry point: one call per download, dispatching on the format.

import type { ExportRequest, ExportResult } from '../engine/protocol';
import { COLOUR_GROUPS, filamentName, printerByKey, type Palette, type Printer } from '../settings';
import type { Plate } from '../types';
import { writeBambuProject } from './bambu';
import { FilamentTable, partGroup, preparePlates, type PreparedModel } from './common';
import { formatG } from './format';
import { PRUSA_MAX_BEDS, writePrusaProject } from './prusa';
import { fileStem, writeStl, writeStlZip } from './stl';
import { writeGeneric3mf } from './threemf';

export { writeBambuProject } from './bambu';
export { writePrusaProject } from './prusa';
export { BAMBU_MAX_PLATES, plateOrigin, sectionGrid, type Section } from './sections';
export { writeStl, writeStlZip } from './stl';
export { writeGeneric3mf } from './threemf';

const MIME_3MF = 'model/3mf';
const MIME_STL = 'model/stl';
const MIME_ZIP = 'application/zip';
// Filaments an MMU3 or a Prusa XL can hold.
const PRUSA_MAX_FILAMENTS = 5;
const FALLBACK_BAMBU = 'P1S';

/** Drops excluded parts, parts with nothing to print and plates left empty. */
export function printablePlates(plates: Plate[], exclude: string[] = []): Plate[] {
  const hidden = new Set(exclude);
  return plates
    .map((plate) => ({
      ...plate,
      parts: plate.parts.filter((part) => !hidden.has(part.id) && part.indices.length > 0),
    }))
    .filter((plate) => plate.parts.length > 0);
}

function fits(width: number, depth: number, printer: Printer): boolean {
  const tolerance = 1e-6;
  return width <= printer.width + tolerance && depth <= printer.depth + tolerance;
}

function sizeWarnings(model: PreparedModel, printer: Printer): string[] {
  const warnings: string[] = [];
  const bed = `${printer.model} bed (${formatG(printer.width)} x ${formatG(printer.depth)} mm)`;
  if (model.plates.length === 1) {
    const e = model.plates[0].extents;
    const width = e.maxX - e.minX;
    const depth = e.maxY - e.minY;
    if (fits(depth, width, printer) && !fits(width, depth, printer)) {
      warnings.push(`The model fits the ${bed} only when turned 90 degrees in the slicer.`);
    } else if (!fits(width, depth, printer)) {
      warnings.push(`The model is ${width.toFixed(0)} x ${depth.toFixed(0)} mm, larger than the ${bed}.`);
    }
  } else {
    const large = model.plates.filter((p) => !fits(p.extents.maxX - p.extents.minX, p.extents.maxY - p.extents.minY, printer));
    if (large.length) {
      const names = large.map((p) => p.name).join(', ');
      warnings.push(`${names} ${large.length === 1 ? 'is' : 'are'} larger than the ${bed}.`);
    }
  }
  const height = model.extents.maxZ - model.extents.minZ;
  if (height > printer.height + 1e-6) {
    warnings.push(`The model is ${height.toFixed(0)} mm tall, taller than the ${printer.model} build height (${formatG(printer.height)} mm).`);
  }
  return warnings;
}

// PrusaSlicer takes colours from its extruders, never from the file.
function prusaNotes(plates: Plate[], palette: Palette, printer: Printer): string[] {
  const extruders = new FilamentTable();
  const groups = new Map<number, Set<string>>();
  for (const plate of plates) {
    for (const part of plate.parts) {
      const slot = extruders.slot(palette[partGroup(part)]);
      if (!groups.has(slot)) groups.set(slot, new Set());
      groups.get(slot)!.add(partGroup(part));
    }
  }
  const list = extruders.filaments.map((filament, i) => {
    const used = groups.get(i + 1)!;
    const labels = COLOUR_GROUPS.filter((g) => used.has(g.key)).map((g) => g.label).join(' + ');
    const name = filamentName(filament);
    return `${i + 1} ${labels} ${name ? `(${name}, ${filament.hex})` : `(${filament.hex})`}`;
  });
  const notes = [`PrusaSlicer does not read colours from a 3MF. Set the extruder colours to match: ${list.join(', ')}.`];
  if (printer.vendor === 'Prusa' && list.length > PRUSA_MAX_FILAMENTS) {
    notes.push(
      `The model uses ${list.length} filaments. An MMU3 or a Prusa XL holds at most ${PRUSA_MAX_FILAMENTS}, ` +
        'and parts on higher extruders print with the first one.',
    );
  }
  if (plates.length > PRUSA_MAX_BEDS) {
    notes.push(
      `PrusaSlicer has at most ${PRUSA_MAX_BEDS} beds, so the ${plates.length} sections are laid out side by side. ` +
        'Use Arrange to put them on beds.',
    );
  }
  return notes;
}

export function exportPlates(plates: Plate[], request: ExportRequest): ExportResult {
  const printer = printerByKey(request.printer);
  const kept = printablePlates(plates, request.excludeParts);
  if (!kept.length) throw new Error('Nothing to export: every part is hidden or empty');
  const model = preparePlates(kept, request.palette);
  const base = fileStem(request.fileBase);
  const warnings = sizeWarnings(model, printer);
  const result = (fileName: string, mime: string, data: Uint8Array): ExportResult => ({
    fileName,
    mime,
    data,
    plates: kept.length,
    warnings,
  });

  switch (request.format) {
    case 'bambu': {
      let target = printer;
      if (!printer.bambu) {
        const fallback = printerByKey(FALLBACK_BAMBU);
        // Bambu presets with the chosen printer's bed and height.
        target = { ...printer, model: fallback.model, vendor: fallback.vendor, bambu: fallback.bambu };
        warnings.unshift(
          `${printer.model} is not a Bambu Lab printer, so the project starts from the ${fallback.model} presets ` +
            `with a ${formatG(printer.width)} x ${formatG(printer.depth)} mm bed.`,
        );
      }
      return result(`${base}.3mf`, MIME_3MF, writeBambuProject(kept, request.palette, target));
    }
    case 'prusa':
      warnings.push(...prusaNotes(kept, request.palette, printer));
      return result(`${base}.3mf`, MIME_3MF, writePrusaProject(kept, request.palette, printer, base));
    case '3mf':
      return result(`${base}.3mf`, MIME_3MF, writeGeneric3mf(kept, request.palette, printer, base));
    case 'stl-zip':
      return result(`${base}-stl.zip`, MIME_ZIP, writeStlZip(kept, request.palette, base));
    case 'stl':
      // Sections are separate prints: one file each, zipped.
      if (kept.length > 1) {
        return result(`${base}-stl.zip`, MIME_ZIP, writeStlZip(kept, request.palette, base, { combined: true }));
      }
      return result(`${base}.stl`, MIME_STL, writeStl(kept[0]));
    default:
      throw new Error(`Unknown export format: ${String(request.format)}`);
  }
}
