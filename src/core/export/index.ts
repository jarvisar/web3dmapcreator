// Export entry point: one call per download, dispatching on the format.

import type { ExportRequest, ExportResult } from '../engine/protocol';
import { DEFAULT_PRINTER, filamentName, printerByKey, type Printer } from '../settings';
import type { Plate } from '../types';
import { writeBambuProject } from './bambu';
import { filamentUse, preparePlates, type PreparedModel } from './common';
import { formatG } from './format';
import { PRUSA_MAX_BEDS, writePrusaProject } from './prusa';
import { fileStem, writeStl, writeStlZip } from './stl';
import { writeGeneric3mf } from './threemf';

// Filaments an MMU3 or a Prusa XL can hold.
const PRUSA_MAX_FILAMENTS = 5;

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
function prusaNotes(model: PreparedModel, printer: Printer): string[] {
  const { filaments, labels } = filamentUse(model);
  const list = filaments.map((filament, i) => {
    const name = filamentName(filament);
    return `${i + 1} ${labels[i].join(' + ')} ${name ? `(${name}, ${filament.hex})` : `(${filament.hex})`}`;
  });
  const notes = [`PrusaSlicer does not read colours from a 3MF. Set the extruder colours to match: ${list.join(', ')}.`];
  if (printer.vendor === 'Prusa' && list.length > PRUSA_MAX_FILAMENTS) {
    notes.push(
      `The model uses ${list.length} filaments. An MMU3 or a Prusa XL holds at most ${PRUSA_MAX_FILAMENTS}, ` +
        'and parts on higher extruders print with the first one.',
    );
  }
  if (model.plates.length > 1) {
    notes.push(
      `The ${model.plates.length} sections open side by side on the first bed. Press Arrange (A) to put them on separate beds` +
        (model.plates.length > PRUSA_MAX_BEDS ? `. PrusaSlicer has at most ${PRUSA_MAX_BEDS}, so do the rest in a second project.` : '.'),
    );
  }
  return notes;
}

/** `credits` are attributions beyond the map data, such as the LiDAR surveys a model used. */
export function exportPlates(plates: Plate[], request: ExportRequest, credits: string[] = []): ExportResult {
  const printer = printerByKey(request.printer);
  const kept = printablePlates(plates, request.excludeParts);
  if (!kept.length) throw new Error('Nothing to export: every part is hidden or empty');
  const model = preparePlates(kept, request.palette, credits);
  const base = fileStem(request.fileBase);
  const warnings = sizeWarnings(model, printer);
  const result = (fileName: string, data: Blob): ExportResult => ({ fileName, data, plates: kept.length, warnings });

  switch (request.format) {
    case 'bambu': {
      let target = printer;
      if (!printer.bambu) {
        // The default printer's Bambu presets with the chosen printer's bed and height.
        const fallback = printerByKey(DEFAULT_PRINTER);
        target = { ...printer, model: fallback.model, vendor: fallback.vendor, bambu: fallback.bambu };
        warnings.unshift(
          `${printer.model} is not a Bambu Lab printer, so the project starts from the ${fallback.model} presets ` +
            `with a ${formatG(printer.width)} x ${formatG(printer.depth)} mm bed.`,
        );
      }
      return result(`${base}.3mf`, writeBambuProject(model, target));
    }
    case 'prusa':
      warnings.push(...prusaNotes(model, printer));
      return result(`${base}.3mf`, writePrusaProject(model, printer, base));
    case '3mf':
      return result(`${base}.3mf`, writeGeneric3mf(model, printer, base));
    case 'stl-zip':
      return result(`${base}-stl.zip`, writeStlZip(model, base));
    case 'stl':
      // Sections are separate prints: one file each, zipped.
      if (model.plates.length > 1) return result(`${base}-stl.zip`, writeStlZip(model, base, { combined: true }));
      return result(`${base}.stl`, writeStl(model.plates[0]));
    default:
      throw new Error(`Unknown export format: ${String(request.format)}`);
  }
}
