# Bambu projects: names, filaments, and plates

**Export 3MF for Bambu** writes a native, unsliced Bambu Studio project straight
from the generated meshes. `data/export_plates.py` holds the writer
(`PlateWriter`) and the printer presets, `data/export_3mf.py` the semantic part
names, and `data/export_sections.py` the section grid. Nothing depends on the
`io_mesh_3mf` add-on any more, and scene unit settings do not affect the file:
coordinates are model millimetres written with six decimals, which round-trips
Blender's float32 vertices.

## Archive contract

- `3D/3dmodel.model`: one core-namespace model carrying the `BambuStudio-…`
  Application marker and format version 1. Each part is an
  `<object name="Terrain" type="model">` with its mesh; each plate is an
  object with `<components>` referencing its parts (parts are written first,
  as the 3MF core specification requires) and one `<build><item>` translation
  placing it on its virtual plate with a shared Z datum. It also carries
  `<metadata name="Copyright">` with the map-data attribution; Bambu Studio
  keeps it when saving.
- `Metadata/model_settings.config`: per plate an `<object id>` with `name` and
  `extruder` metadata and a `<part id subtype="normal_part">` per part with
  its own `name` and `extruder`; then a `<plate>` per plate with `plater_id`,
  `plater_name`, `locked`, and a `model_instance` mapping the assembly to
  `instance_id` 0. Bambu's `_generate_volumes_new` matches part ids to
  component object ids and shows these names in the Objects tree.
- `Metadata/project_settings.config`: printer model and preset, process
  preset, printable area and height, per-filament lists (`filament_colour`,
  `filament_settings_id`, `filament_ids`, `filament_vendor`, `filament_type`,
  `filament_diameter`), and a square `flush_volumes_matrix` of Bambu's 280 mm³
  default. The native loader requires the square matrix.
- `[Content_Types].xml` and `_rels/.rels` declare exactly those parts. There
  are no thumbnails, sliced data, or external model files.

## Filaments and colours

Filaments are one per distinct colour and Bambu PLA line, numbered in order of
first use across all parts and plates. A material's colour is its Principled
BSDF base colour, or its viewport colour without nodes, scaled to bytes
without gamma conversion, the convention every previous export used. On
Blender 5, where every material has nodes, a Base Color still at the node
default counts as unset and the viewport colour is used. Its line is its
`jarvizar_filament` property, `PLA Basic` or `PLA Matte`, else PLA Basic; the
Colours sub-panel sets each group's line (the Default preset uses PLA Matte on
terrain and buildings). Each filament gets
that line's preset for the printer (`Bambu PLA Matte @BBL P1S 0.4 nozzle`) and
its `filament_ids` (`GFA00` Basic, `GFA01` Matte). Palette colours that are
Bambu filaments (Caramel, Ivory White, Bambu Green, Dark Gray) are their hex
codes from Bambu Studio's `filaments_color_codes.json`, over 255, so they
export as exactly those codes. A part whose triangles
share one colour is simply assigned that filament. A part mixing materials is
assigned the filament of its most common material, lowest slot on a tie, and
each other triangle carries Bambu's `paint_color` state for its own filament,
encoded as `TriangleSelector` does: two split bits, then the state, with
base-15 continuation nibbles above 17. Bambu reads that as painted faces on a
part that already has a filament, which is its own representation of a
multi-colour volume.

Without the Application marker Bambu imports a 3MF as plain geometry and
offers to map colours to filaments; the result was one painted object rather
than parts with filaments. The marker makes it a project: keep it.

## Printer presets

`PRINTERS` lists each model's bed, height, and the `default_print_profile` and
`default_filament_profile` (Bambu PLA Basic) of its "0.4 nozzle" machine
profile as bundled with Bambu Studio 2.8; the PLA Matte preset has the same
name with the line replaced. The bed sets the section maxima, the
plate stride and centring, and `printable_area`. Bambu re-lays plates when the
user switches printers, so a project made for one bed still opens on another;
the presets only choose the starting point. Front-left exclusion zones
(18×28 mm on P1/X1) are not modelled.

## Plates and sections

Every plate is one multipart object centred on its own virtual bed, laid out
as Bambu's `PartPlateList` does: `ceil(sqrt(count))` columns, a 20% gap
between beds, later rows at negative Y. Without Multi-Plate Export the whole
cropped model is the single plate `Map`, centred by its contents.

With it, `export_grid` measures the opening after the normal crop and
`section_grid` divides it evenly, never leaving a skinny remainder. The grid
is aligned to the opening's dominant edge direction (`grid_angle`: every edge
votes with its length for its heading modulo 90°, folded into ±45°; world axes
when nothing dominates, exactly 0 for an axis-aligned frame), so a frame
rotated to follow a street grid produces rectangles aligned with it whether
the rotation is on the object or applied to its mesh. Rows run along the
frame's north-south side and columns west to east; sections are written in
grid coordinates, so each one sits square on its plate. Grid edges and the
snapping tolerance are computed once for all cells.

`export_sections` bakes each cropped copy once into grid coordinates, then
`partition_mesh` walks its shells once: a shell inside a cell is copied there
whole, a shell straddling seams is cut in isolation against each cell it
reaches with the crop's own plane cutter, and zero-volume tangent remnants are
discarded only here. Independent overlapping shells, holes, material slots and
semantic tags survive, and the work no longer grows with the plate count.
Empty cells are omitted, a miniature that fits is one section, and a grid
beyond Bambu's 36 plates fails before partitioning. Each section is centred by
its cell bounds and all plates share one Z datum. No connectors, scaling,
gaps, or seam offsets are introduced.

The staged project replaces the destination only after every plate is
written; failures preserve an existing file and the scene.

## Verification

```powershell
& ./.venv-overture/Scripts/python.exe -m unittest tests.test_export_3mf tests.test_export_sections
& 'C:/Program Files/Blender Foundation/Blender 3.6/blender.exe' --background --factory-startup --python-exit-code 1 --python tests/blender_export_cutout.py
& 'C:/Program Files/Blender Foundation/Blender 3.6/blender.exe' --background --factory-startup --python-exit-code 1 --python tests/blender_export_plates.py
& ./.venv-overture/Scripts/python.exe tests/bambu_export_plates.py --bambu 'C:/Program Files/Bambu Studio/bambu-studio.exe'
```

The pure tests cover the archive contract, filament and paint assignment,
placement, presets, and rejected inputs. `blender_export_cutout.py` exports
real projects and checks names, filaments, both unit modes, scene restoration,
and atomic failure. `blender_export_plates.py` checks volume conservation,
closure/winding, layer bounds, shared seams, rotated frames, curved and
concave openings, presets and their clamping, and failure cleanup, and writes
the fixtures in `scratchpad/multi-plate`. `bambu_export_plates.py` imports,
saves, and reopens those fixtures through installed Bambu Studio in an
isolated data directory, comparing plate assignments, names, geometry,
filament colours, printer preset, and bed placement. It does not slice or
print. For a cached city, `blender_export_cutout_live.py` accepts
`--multi-plate`, `--printer`, `--section-width`, `--section-height`, and
`--output`.

Format references: Bambu's
[bbs_3mf reader/writer](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/Format/bbs_3mf.cpp),
[PartPlate layout](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/PartPlate.cpp),
[triangle paint serialization](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/TriangleSelector.cpp),
and [purge defaults](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/PrintConfig.cpp).
