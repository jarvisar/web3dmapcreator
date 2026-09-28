// Native, unsliced Bambu Studio project written straight from mesh arrays.
//
// Each plate is one assembly object whose components are its parts, placed
// on its own virtual bed the way Bambu's PartPlateList lays them out. Every
// part is a normal_part whose filament is its model_settings "extruder".
// Filaments are one per distinct colour and PLA line, in order of first use.
// All plates share one Z datum: the lowest point of the whole project rests
// on the bed.

import type { Palette, Printer } from '../settings';
import type { Plate } from '../types';
import {
  ATTRIBUTION,
  CONTENT_TYPES_NAMESPACE,
  CORE_NAMESPACE,
  DESCRIPTION,
  FILAMENT_IDS,
  FilamentTable,
  MODEL_PATH,
  MODEL_RELATIONSHIP,
  ModelStream,
  RELATIONSHIPS_NAMESPACE,
  XML_HEADER,
  preparePlates,
} from './common';
import { fixed6, formatG, quoteattr } from './format';
import { BAMBU_MAX_PLATES, plateOrigin } from './sections';
import { ZipWriter } from './zip';

export const SETTINGS_PATH = 'Metadata/model_settings.config';
export const PROJECT_PATH = 'Metadata/project_settings.config';
const BAMBU_NAMESPACE = 'http://schemas.bambulab.com/package/2021';
// Bambu gates project loading on this Application prefix. Without it the file
// imports as plain geometry and the printer, filaments and part assignments
// are dropped. Version 2.0 also avoids its pre-1.5.9 bed-offset and pre-2.0
// prime-volume migrations.
export const APPLICATION = 'BambuStudio-02.00.00.00';
// Printer presets name Bambu PLA Basic. A line's presets are named the same
// way for each printer: "Bambu PLA Matte @BBL X1C".
const DEFAULT_LINE = 'PLA Basic';

interface PlacedPart {
  id: number;
  name: string;
  extruder: number;
}

export function writeBambuProject(plates: Plate[], palette: Palette, printer: Printer): Uint8Array {
  const presets = printer.bambu;
  if (!presets) throw new Error(`${printer.model} has no Bambu Studio presets`);
  if (plates.length > BAMBU_MAX_PLATES) throw new Error(`Bambu Studio supports at most ${BAMBU_MAX_PLATES} plates`);
  const model = preparePlates(plates, palette);
  const bottom = model.extents.minZ;

  // Parts are written before the assembly that references them, as 3MF requires.
  const filaments = new FilamentTable();
  let nextId = 1;
  const layout = model.plates.map((plate) => {
    const parts: PlacedPart[] = plate.parts.map((p) => ({ id: nextId++, name: p.name, extruder: filaments.slot(p.colour) }));
    return { plate, parts, assembly: nextId++ };
  });

  const zip = new ZipWriter();
  const out = new ModelStream(zip.entry(MODEL_PATH));
  out.text(
    XML_HEADER +
      `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}" xmlns:BambuStudio="${BAMBU_NAMESPACE}">\n` +
      ` <metadata name="Application">${APPLICATION}</metadata>\n` +
      ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
      ` <metadata name="Description">${DESCRIPTION}</metadata>\n` +
      ` <metadata name="Copyright">${ATTRIBUTION}</metadata>\n` +
      ' <resources>\n',
  );
  for (const { plate, parts, assembly } of layout) {
    plate.parts.forEach((prepared, i) => {
      out.text(`  <object id="${parts[i].id}" name=${quoteattr(parts[i].name)} type="model">\n   <mesh>\n    <vertices>\n`);
      out.vertices(prepared.part.positions);
      out.text('    </vertices>\n    <triangles>\n');
      out.triangles(prepared.part.indices);
      out.text('    </triangles>\n   </mesh>\n  </object>\n');
    });
    out.text(`  <object id="${assembly}" name=${quoteattr(plate.name)} type="model">\n   <components>\n`);
    out.text(parts.map((part) => `    <component objectid="${part.id}"/>\n`).join(''));
    out.text('   </components>\n  </object>\n');
  }
  out.text(' </resources>\n <build>\n');
  const count = layout.length;
  layout.forEach(({ plate, assembly }, index) => {
    const [west, south, east, north] = plate.bounds;
    const [ox, oy] = plateOrigin(index, count, printer.width, printer.depth);
    const tx = ox + printer.width / 2 - (west + east) / 2;
    const ty = oy + printer.depth / 2 - (south + north) / 2;
    out.text(
      `  <item objectid="${assembly}" transform="1 0 0 0 1 0 0 0 1 ${fixed6(tx)} ${fixed6(ty)} ${fixed6(-bottom)}" printable="1"/>\n`,
    );
  });
  out.text(' </build>\n</model>\n');
  out.close();

  // Bambu's _generate_volumes_new matches part ids to component object ids
  // and shows these names in the Objects tree.
  const config = [XML_HEADER, '<config>\n'];
  for (const { plate, parts, assembly } of layout) {
    config.push(
      ` <object id="${assembly}">\n  <metadata key="name" value=${quoteattr(plate.name)}/>\n` +
        `  <metadata key="extruder" value="${parts[0].extruder}"/>\n`,
    );
    for (const part of parts) {
      config.push(
        `  <part id="${part.id}" subtype="normal_part">\n` +
          `   <metadata key="name" value=${quoteattr(part.name)}/>\n` +
          `   <metadata key="extruder" value="${part.extruder}"/>\n  </part>\n`,
      );
    }
    config.push(' </object>\n');
  }
  layout.forEach(({ plate, assembly }, index) => {
    config.push(
      ` <plate>\n  <metadata key="plater_id" value="${index + 1}"/>\n` +
        `  <metadata key="plater_name" value=${quoteattr(plate.name)}/>\n` +
        '  <metadata key="locked" value="false"/>\n  <model_instance>\n' +
        `   <metadata key="object_id" value="${assembly}"/>\n` +
        '   <metadata key="instance_id" value="0"/>\n' +
        `   <metadata key="identify_id" value="${index + 1}"/>\n` +
        '  </model_instance>\n </plate>\n',
    );
  });
  config.push('</config>\n');
  zip.file(SETTINGS_PATH, config.join(''));

  // Bambu matches the literal OPC tag names, so each XML part carries its own
  // default namespace. The project holds no thumbnails or external models, so
  // declare exactly its parts.
  zip.file(
    '[Content_Types].xml',
    XML_HEADER +
      `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">\n` +
      ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
      ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
      ' <Default Extension="config" ContentType="application/xml"/>\n' +
      ` <Override PartName="/${PROJECT_PATH}" ContentType="application/json"/>\n` +
      '</Types>\n',
  );

  const list = filaments.filaments;
  const width = formatG(printer.width);
  const depth = formatG(printer.depth);
  const project = {
    name: 'project_settings',
    version: '02.00.00.00',
    printer_model: printer.model,
    printer_settings_id: `${printer.model} 0.4 nozzle`,
    print_settings_id: presets.printProfile,
    printer_technology: 'FFF',
    nozzle_diameter: ['0.4'],
    printable_area: ['0x0', `${width}x0`, `${width}x${depth}`, `0x${depth}`],
    printable_height: formatG(printer.height),
    filament_colour: list.map((f) => f.hex),
    filament_settings_id: list.map((f) => presets.filamentProfile.replace(DEFAULT_LINE, f.line)),
    filament_ids: list.map((f) => FILAMENT_IDS[f.line]),
    filament_vendor: list.map(() => 'Bambu Lab'),
    filament_type: list.map(() => 'PLA'),
    filament_diameter: list.map(() => '1.75'),
    // The native project loader requires a square matrix. This is the
    // standard 140 mm^3 unload + 140 mm^3 load starting allowance. Bambu's
    // Flushing Volumes dialog can recalculate it for the actual filaments.
    flush_volumes_matrix: list.flatMap((_, a) => list.map((__, b) => (a === b ? '0' : '280'))),
  };
  zip.file(PROJECT_PATH, JSON.stringify(project, null, 2));
  zip.file(
    '_rels/.rels',
    XML_HEADER +
      `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">\n` +
      ` <Relationship Id="rel0" Target="/${MODEL_PATH}" Type="${MODEL_RELATIONSHIP}"/>\n` +
      '</Relationships>\n',
  );
  return zip.finish();
}
