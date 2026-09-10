# Semantic names and colors in Bambu Studio

**Export 3MF for Bambu** exports one `Map` object with named normal Parts.
Names come from generated `feature_type`, `surface_category`, and `road_class`
properties copied from the generated meshes. Material roles cover older
untagged export copies (notably unmerged trees); owned collection roles are
also recognized when resolving original scene objects.
Unknown feature types retain a readable type name; unclassified user geometry
retains its Blender name. Road/bridge classes remain identifiable, and repeated
types receive numbered names. Numbering distinguishes parts; it never determines
their semantic type. Unmerged trees now receive the same type tag as merged trees.

Existing generator batches and disconnected shells stay intact. No export-time
joining, welding, material regrouping, resource reordering, or coordinate changes
are performed. In particular, merged buildings can contain multiple materials,
and separate overlapping parts can have slicer significance. Naming them does
not require changing those boundaries.

## Format contract

The external `io_mesh_3mf` writer writes each Blender mesh's exact unique name
as object `metadatagroup/metadata[@name='Title']`. This is the identity used to
associate the exported resource with its semantic name, independently of XML
resource order, component order, material indices, or numeric resource IDs.
Naming reads the tags already retained by the temporary export copies, after
the existing crop and writer operations have finished. Original Blender names,
data, transforms, and selection are preserved.

`data/export_3mf.py` completes the writer's archive with both:

- Standard core `<object id="…" name="Terrain">` attributes on the assembly
  and mesh resources. See the [3MF Core specification, object resources](https://github.com/3MFConsortium/spec_core/blob/master/3MF%20Core%20Specification.md).
- `Metadata/model_settings.config`, containing an `<object id="…">` for the
  **build item's assembly resource**, with `<metadata key="name" value="Map"/>`.
  Each child `<part id="…" subtype="normal_part">` uses the **component mesh
  resource ID**, with its own `<metadata key="name" value="Terrain"/>`.
  The package content types also declare the `.config` XML part.

[Bambu's current reader/writer](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/Format/bbs_3mf.cpp)
implements this in `_handle_start_config_volume`, `_generate_volumes_new`, and
`_add_model_config_file_to_archive`. Part IDs are resource IDs, not list indices
or triangle ranges. Name metadata becomes `ModelObject::name` and
`ModelVolume::name`; [the Objects tree](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/GUI_ObjectList.cpp)
uses those volume names in `AddVolumeChild`. A core name or a `Title` metadata
entry alone does not supply Bambu's multipart tree labels.

The export keeps its existing standard 3MF material workflow. It does **not**
claim to be produced by `BambuStudio-…`, add printer/AMS presets, or impose
extruder overrides. Bambu's importer uses that application identity to choose
whether to convert standard 3MF color data. Faking a native
project would change that behavior.

The external writer stores the Blender shader colors as core
`basematerials/base@displaycolor`. Bambu's current reader instead recognizes
`m:colorgroup/m:color`, in the standard 3MF Materials extension namespace.
The export mirrors the original palettes into color groups with fresh resource
IDs, preserving their exact color values and index ordering. Object and explicit
triangle `pid` references point to those color groups. `pindex`, per-triangle
overrides, named base materials, geometry, and component/build transforms remain
intact. This works for both solid-color parts and multi-material meshes.

[Bambu's GUI import code](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/Plater.cpp)
passes these source colors to its standard color-to-filament mapping dialog.
On import, accept or adjust that mapping to the filaments in your Bambu project.
Physical AMS slots and printer-specific filament profiles remain under Bambu's
control. The CLI does not execute this GUI color-mapping step, so a CLI re-save
alone is not a test of the final GUI filament colors.

Both writing and annotation happen in a temporary directory next to the target.
The finished ZIP replaces the target only after identity checks succeed. Missing
or ambiguous writer metadata fails the export rather than guessing by mesh order.

## Verification

Run the pure suite and `tests/blender_export_cutout.py` as described in
[shared context](../CLAUDE.md). The Blender test produces `semantic.3mf` and the
same writer output before annotation, `baseline.3mf`, under ignored
`scratchpad/3mf-names/`. It exercises arbitrary Blender names, repeated semantic
types, per-face materials, transformed parts, cropped output, both unit modes,
scene restoration, and preservation of an existing file after annotation failure.

With Bambu Studio installed, run:

```powershell
& ./.venv-overture/Scripts/python.exe tests/bambu_export_names.py --bambu 'C:/Program Files/Bambu Studio/bambu-studio.exe'
```

This uses an isolated data directory, imports/saves both fixtures through Bambu,
then opens the named export again in a fresh process. It checks retained names, unchanged mesh
data, placement, part types, repair statistics, and extruder settings relative to
the baseline. It does not slice or print. The CLI round trip validates Bambu's
loaded model and saved names; it is distinct from a visual GUI check or actual
print. Standard color conversion is also exercised by the GUI import workflow:
open the generated file, complete the usual color mapping, expand `Map` in
Objects, and check the named Parts and their filament assignments.
