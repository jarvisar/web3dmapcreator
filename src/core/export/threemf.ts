// Core-spec 3MF for slicers and viewers without a native project format
// (Cura, Windows 3D Viewer and others). One colour per base material, each
// part an object carrying its colour, and each plate one assembly of its
// parts: Cura drops every top-level build item to the bed on its own, which
// would sink roads and buildings into the terrain if parts were separate
// items. The model is centred on the bed with its lowest point at z = 0.
// Several sections are laid out in their grid, 10 mm apart.

import { filamentName, type Printer } from '../settings';
import {
  APP_NAME,
  ATTRIBUTION,
  CORE_NAMESPACE,
  DESCRIPTION,
  FilamentTable,
  MIME_3MF,
  MODEL_PATH,
  ModelStream,
  XML_HEADER,
  contentTypes,
  modelRelationship,
  type PreparedModel,
} from './common';
import { escapeText, fixed6, quoteattr } from './format';
import { sideBySide } from './sections';
import { ZipWriter } from './zip';

export function writeGeneric3mf(model: PreparedModel, printer: Printer, title = 'City Model'): Blob {
  const bottom = model.extents.minZ;
  const materials = new FilamentTable();
  let nextId = 2;
  const layout = model.plates.map((plate) => {
    const parts = plate.parts.map((p) => ({ id: nextId++, name: p.name, index: materials.slot(p.colour) - 1 }));
    return { plate, parts, assembly: nextId++ };
  });
  const placement = sideBySide(
    model.plates.map((p) => p.bounds),
    printer.width,
    printer.depth,
  );

  const zip = new ZipWriter();
  const out = new ModelStream(zip.entry(MODEL_PATH));
  out.text(
    XML_HEADER +
      `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}">\n` +
      ` <metadata name="Title">${escapeText(title)}</metadata>\n` +
      ` <metadata name="Application">${APP_NAME}</metadata>\n` +
      ` <metadata name="Description">${DESCRIPTION}</metadata>\n` +
      ` <metadata name="Copyright">${ATTRIBUTION}</metadata>\n` +
      ' <resources>\n  <basematerials id="1">\n',
  );
  for (const filament of materials.filaments) {
    const name = filamentName(filament) || `${filament.line} ${filament.hex}`;
    out.text(`   <base name=${quoteattr(name)} displaycolor="${filament.hex}FF"/>\n`);
  }
  out.text('  </basematerials>\n');
  for (const { plate, parts, assembly } of layout) {
    plate.parts.forEach((prepared, i) => {
      const part = parts[i];
      out.meshObject(part.id, part.name, [prepared.part], ` pid="1" pindex="${part.index}"`);
    });
    out.assembly(assembly, plate.name, parts.map((part) => part.id));
  }
  out.text(' </resources>\n <build>\n');
  layout.forEach(({ assembly }, i) => {
    const [tx, ty] = placement[i];
    out.text(`  <item objectid="${assembly}" transform="1 0 0 0 1 0 0 0 1 ${fixed6(tx)} ${fixed6(ty)} ${fixed6(-bottom)}"/>\n`);
  });
  out.text(' </build>\n</model>\n');
  out.close();

  zip.file('[Content_Types].xml', contentTypes());
  zip.file('_rels/.rels', modelRelationship());
  return zip.finish(MIME_3MF);
}
