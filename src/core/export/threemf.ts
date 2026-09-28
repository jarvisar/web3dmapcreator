// Core-spec 3MF for slicers and viewers without a native project format
// (Cura, Windows 3D Viewer and others). One colour per base material, each
// part an object carrying its colour, and each plate one assembly of its
// parts: Cura drops every top-level build item to the bed on its own, which
// would sink roads and buildings into the terrain if parts were separate
// items. The model is centred on the bed with its lowest point at z = 0.
// Several sections are laid out in their grid, 10 mm apart.

import { filamentName, type Palette, type Printer } from '../settings';
import type { Plate } from '../types';
import {
  APP_NAME,
  ATTRIBUTION,
  CONTENT_TYPES_NAMESPACE,
  CORE_NAMESPACE,
  DESCRIPTION,
  FilamentTable,
  MODEL_PATH,
  MODEL_RELATIONSHIP,
  ModelStream,
  RELATIONSHIPS_NAMESPACE,
  XML_HEADER,
  preparePlates,
} from './common';
import { escapeText, fixed6, quoteattr } from './format';
import { sideBySide } from './sections';
import { ZipWriter } from './zip';

export function writeGeneric3mf(plates: Plate[], palette: Palette, printer: Printer, title = 'City Model'): Uint8Array {
  const model = preparePlates(plates, palette);
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
      out.text(
        `  <object id="${part.id}" name=${quoteattr(part.name)} type="model" pid="1" pindex="${part.index}">\n` +
          '   <mesh>\n    <vertices>\n',
      );
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
  layout.forEach(({ assembly }, i) => {
    const [tx, ty] = placement[i];
    out.text(`  <item objectid="${assembly}" transform="1 0 0 0 1 0 0 0 1 ${fixed6(tx)} ${fixed6(ty)} ${fixed6(-bottom)}"/>\n`);
  });
  out.text(' </build>\n</model>\n');
  out.close();

  zip.file(
    '[Content_Types].xml',
    XML_HEADER +
      `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">\n` +
      ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
      ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
      '</Types>\n',
  );
  zip.file(
    '_rels/.rels',
    XML_HEADER +
      `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">\n` +
      ` <Relationship Id="rel0" Target="/${MODEL_PATH}" Type="${MODEL_RELATIONSHIP}"/>\n` +
      '</Relationships>\n',
  );
  return zip.finish();
}
