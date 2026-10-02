// PrusaSlicer 3MF, as its 2.x 3mf.cpp reads and writes it: one object per
// plate whose mesh concatenates every part, and Metadata/Slic3r_PE_model.config
// splitting that mesh back into named parts (volumes) by triangle range, each
// with its own extruder.
//
// There is deliberately no Metadata/Slic3r_PE.config. Its presence makes the
// file a project: PrusaSlicer then lays the file's settings over its built-in
// defaults and replaces the selected printer, print and filament presets with
// that, so a partial config holding only colours would leave a single-extruder
// default printer. Colours therefore come from the user's own extruders.
//
// PrusaSlicer 2.9 has up to 9 beds but stores no bed index: an object belongs
// to the bed its position falls on, so sections are placed on those virtual
// beds. PrusaSlicer 3.0 (alpha) reads a 3MF like this as plain shapes.

import type { Printer } from '../settings';
import {
  APP_NAME,
  CONFIG_CONTENT_TYPE,
  CORE_NAMESPACE,
  DESCRIPTION,
  MIME_3MF,
  MODEL_PATH,
  ModelStream,
  XML_HEADER,
  contentTypes,
  modelFilaments,
  modelRelationship,
  triangleCount,
  writeOrder,
  type PreparedModel,
  type RowTally,
} from './common';
import { escapeText, fixed6, quoteattr } from './format';
import { sideBySide } from './sections';
import { ZipWriter } from './zip';

export const PRUSA_MODEL_CONFIG_PATH = 'Metadata/Slic3r_PE_model.config';
const SLIC3RPE_NAMESPACE = 'http://schemas.slic3r.org/3mf/2017/06';
// MAX_NUMBER_OF_BEDS in PrusaSlicer 2.9.
export const PRUSA_MAX_BEDS = 9;

/**
 * Sections go side by side on the first bed. PrusaSlicer 2.9 centres a 3MF
 * that isn't one of its own projects on the first bed when it opens it,
 * which would scatter a layout spread over its beds. Arrange puts them on
 * beds from here.
 */
function prusaPlacement(bounds: [number, number, number, number][], bedWidth: number, bedDepth: number): [number, number][] {
  return sideBySide(bounds, bedWidth, bedDepth);
}

export function writePrusaProject(model: PreparedModel, printer: Printer, title = 'City Model', tally?: RowTally): Blob {
  const bottom = model.extents.minZ;
  const extruders = modelFilaments(model);
  const layout = model.plates.map((plate, index) => {
    const parts = writeOrder(plate.parts);
    let firstTriangle = 0;
    const volumes = parts.map((p) => {
      const first = firstTriangle;
      firstTriangle += triangleCount(p.part);
      return { name: p.name, first, last: firstTriangle - 1, extruder: extruders.slot(p.colour) };
    });
    return { plate, parts, volumes, id: index + 1, extruder: extruders.slot(plate.parts[0].colour) };
  });
  const placement = prusaPlacement(
    model.plates.map((p) => p.bounds),
    printer.width,
    printer.depth,
  );

  const zip = new ZipWriter();
  const out = new ModelStream(zip.entry(MODEL_PATH), tally);
  // Version3mf is required. At version 0 PrusaSlicer 2.x bakes the item
  // transform into the first volume only and then resets it, which leaves
  // every other part at the origin.
  out.text(
    XML_HEADER +
      `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}" xmlns:slic3rpe="${SLIC3RPE_NAMESPACE}">\n` +
      ' <metadata name="slic3rpe:Version3mf">1</metadata>\n' +
      ` <metadata name="Title">${escapeText(title)}</metadata>\n` +
      ` <metadata name="Description">${DESCRIPTION}</metadata>\n` +
      ` <metadata name="Copyright">${escapeText(model.attribution)}</metadata>\n` +
      ` <metadata name="Application">${APP_NAME}</metadata>\n` +
      ' <resources>\n',
  );
  // PrusaSlicer takes a volume's vertices as the index range its triangles
  // use, and every part has its own vertices, so parts stay apart.
  for (const { plate, parts, id } of layout) {
    out.meshObject(id, plate.name, parts.map((p) => p.part));
  }
  out.text(' </resources>\n <build>\n');
  layout.forEach(({ id }, i) => {
    const [tx, ty] = placement[i];
    out.text(`  <item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${fixed6(tx)} ${fixed6(ty)} ${fixed6(-bottom)}" printable="1"/>\n`);
  });
  out.text(' </build>\n</model>\n');
  out.close();

  const config = [XML_HEADER, '<config>\n'];
  for (const { plate, volumes, id, extruder } of layout) {
    config.push(
      ` <object id="${id}" instances_count="1">\n` +
        `  <metadata type="object" key="name" value=${quoteattr(plate.name)}/>\n` +
        `  <metadata type="object" key="extruder" value="${extruder}"/>\n`,
    );
    for (const volume of volumes) {
      config.push(
        `  <volume firstid="${volume.first}" lastid="${volume.last}">\n` +
          `   <metadata type="volume" key="name" value=${quoteattr(volume.name)}/>\n` +
          '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n' +
          `   <metadata type="volume" key="extruder" value="${volume.extruder}"/>\n` +
          '  </volume>\n',
      );
    }
    config.push(' </object>\n');
  }
  config.push('</config>\n');
  zip.file(PRUSA_MODEL_CONFIG_PATH, config.join(''));
  zip.file('[Content_Types].xml', contentTypes(CONFIG_CONTENT_TYPE));
  // PrusaSlicer refuses a 3MF without this file. Written the way PrusaSlicer writes it.
  zip.file('_rels/.rels', modelRelationship(`Target="/${MODEL_PATH}" Id="rel-1"`));
  return zip.finish(MIME_3MF);
}
