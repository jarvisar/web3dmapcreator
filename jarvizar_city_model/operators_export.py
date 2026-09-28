"""Cutout frame and STL export operators, and their rows in the export box.

The STL export shares the 3MF export's pipeline: the deferred road cut and
the crop to the ``cutout`` frame's opening (``export_geometry``), and with
Multi-Plate Export the same sections (``export_sections``).
"""

from __future__ import annotations

from pathlib import Path
import tempfile
from types import SimpleNamespace

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, StringProperty
from bpy.types import Operator
from bpy_extras.io_utils import ExportHelper
from mathutils import Matrix, Vector
import numpy as np

from .blender.collections import generated_objects, update_from_edit_mode
from .blender.download_modal import is_downloading
from .blender.generation_modal import is_generating
from .blender.materials import MATERIAL_ROLE_KEY
from .data.export_3mf import MATERIAL_NAMES, semantic_part_name
from .data.export_frame import RIM_MM, SHAPES, THICKNESS_MM, frame_geometry, opening_ring
from .data.export_plates import ATTRIBUTION, PRINTERS
from .data.folders import ensure_writable


CUTOUT = "cutout"
FRAME_MATERIAL = "Cutout Frame"
FRAME_COLOUR = (0.9, 0.05, 0.05, 0.35)
FRAME_GAP_MM = 2.0
SHAPE_NAMES = {
    "RECTANGLE": ("Rectangle", "Rectangular opening"),
    "ROUNDED": ("Rounded Rectangle", "Rectangular opening with rounded corners"),
    "CIRCLE": ("Circle", "The largest circle inside the width and height"),
    "HEXAGON": ("Hexagon", "The largest regular hexagon inside the width and height, flat to north and south"),
}
# Registration evaluates annotations with module names as locals, which a
# comprehension inside the annotation cannot see.
SHAPE_ITEMS = tuple((key, *SHAPE_NAMES[key]) for key in SHAPES)


def _model_bounds(scene):
    """World (min, max) corners of the generated model, or None without one."""
    points = []
    for obj in generated_objects(scene):
        if len(obj.data.vertices):
            points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        return None
    return (Vector([min(p[i] for p in points) for i in range(3)]),
            Vector([max(p[i] for p in points) for i in range(3)]))


def _frame_material():
    material = bpy.data.materials.get((FRAME_MATERIAL, None))
    if material is None:
        material = bpy.data.materials.new(FRAME_MATERIAL)
        material.diffuse_color = FRAME_COLOUR
        principled = material.node_tree.nodes.get("Principled BSDF") if material.node_tree else None
        if principled is not None:
            principled.inputs["Base Color"].default_value = FRAME_COLOUR
    return material


class JARVIZAR_OT_add_cutout_frame(Operator):
    bl_idname = "jarvizar.add_cutout_frame"
    bl_label = "Add Cutout Frame"
    bl_description = (
        "Add a frame named cutout; exports keep only what lies inside its opening. "
        "Move, rotate or scale it to choose the area"
    )
    bl_options = {"REGISTER", "UNDO"}

    shape: EnumProperty(
        name="Shape",
        items=SHAPE_ITEMS,
        default="RECTANGLE",
    )
    size: EnumProperty(
        name="Size",
        items=(
            ("BED", "Fit Printer Bed", "The selected printer's bed less the margin on each side"),
            ("MODEL", "Fit Model", "The width and depth of the generated model"),
            ("CUSTOM", "Custom", "Width and height in millimetres"),
        ),
        default="BED",
    )
    margin_mm: FloatProperty(
        name="Bed Margin (mm)", description="Space left free on each side of the bed",
        default=20.0, min=0.0, soft_max=60.0, precision=1,
    )
    width_mm: FloatProperty(name="Width (mm)", default=150.0, min=1.0, soft_max=1000.0, precision=1)
    height_mm: FloatProperty(name="Height (mm)", default=150.0, min=1.0, soft_max=1000.0, precision=1)
    corner_radius_mm: FloatProperty(
        name="Corner Radius (mm)", default=10.0, min=0.0, soft_max=100.0, precision=1,
    )
    # Set when the dialog opens, so Adjust Last Operation shows the same note.
    replacing: BoolProperty(options={"HIDDEN", "SKIP_SAVE"})

    @classmethod
    def poll(cls, context):
        if is_generating():
            return False
        if context.mode != "OBJECT":
            cls.poll_message_set("Switch to Object Mode")
            return False
        return True

    def invoke(self, context, event):
        self.replacing = context.scene.objects.get(CUTOUT) is not None
        return context.window_manager.invoke_props_dialog(self, width=280)

    def draw(self, context):
        layout = self.layout
        if self.replacing:
            column = layout.column(align=True)
            column.alert = True
            column.label(text="Replaces the existing cutout", icon="ERROR")
            column.label(text="Keeps its position and rotation")
        layout.prop(self, "shape")
        layout.prop(self, "size")
        if self.size == "BED":
            printer = PRINTERS[context.scene.jarvizar_city_model.bambu_printer]
            layout.label(text=f"{printer.model}: {printer.bed}")
            layout.prop(self, "margin_mm")
        elif self.size == "MODEL":
            bounds = _model_bounds(context.scene)
            size = bounds[1] - bounds[0] if bounds else None
            layout.label(text=f"Model: {size.x:.1f} x {size.y:.1f} mm" if size else "No generated model")
        else:
            column = layout.column(align=True)
            column.prop(self, "width_mm")
            column.prop(self, "height_mm")
        if self.shape == "ROUNDED":
            layout.prop(self, "corner_radius_mm")

    def _opening_size(self, context, bounds):
        if self.size == "BED":
            printer = PRINTERS[context.scene.jarvizar_city_model.bambu_printer]
            width, height = printer.width - 2 * self.margin_mm, printer.depth - 2 * self.margin_mm
            if width <= 0 or height <= 0:
                raise ValueError(f"A {self.margin_mm:g} mm margin leaves no room on the {printer.bed} bed")
            return width, height
        if self.size == "MODEL":
            if bounds is None:
                raise ValueError("No generated model to fit; choose another size")
            return bounds[1].x - bounds[0].x, bounds[1].y - bounds[0].y
        return self.width_mm, self.height_mm

    def execute(self, context):
        scene = context.scene
        settings = scene.jarvizar_city_model
        try:
            existing = scene.objects.get(CUTOUT)
            if existing is None and bpy.data.objects.get(CUTOUT) is not None:
                raise ValueError("Another scene has an object named cutout; rename it first")
            bounds = _model_bounds(scene)
            ring = opening_ring(self.shape, *self._opening_size(context, bounds), self.corner_radius_mm)
            vertices, faces = frame_geometry(ring, RIM_MM, THICKNESS_MM)
        except ValueError as exc:
            settings.last_status = f"Cutout frame not added: {exc}"
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}

        if bounds is not None:
            centre = (bounds[0] + bounds[1]) / 2
            z = bounds[1].z + FRAME_GAP_MM
        else:
            centre = scene.cursor.location.copy()
            z = centre.z
        rotation = Matrix.Identity(4)
        if existing is not None:
            # Keep where the user put it: its visible centre and its rotation.
            world = existing.matrix_world
            corners = [world @ Vector(corner) for corner in existing.bound_box]
            centre = sum(corners, Vector()) / len(corners)
            if bounds is None:
                z = world.translation.z
            rotation = world.to_quaternion().to_matrix().to_4x4()

        mesh = bpy.data.meshes.new(CUTOUT)
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        mesh.materials.append(_frame_material())
        if existing is not None and existing.type == "MESH":
            frame, previous = existing, existing.data
            frame.data = mesh
            if previous.users == 0:
                bpy.data.meshes.remove(previous)
            mesh.name = CUTOUT
        else:
            if existing is not None:
                bpy.data.objects.remove(existing, do_unlink=True)
            frame = bpy.data.objects.new(CUTOUT, mesh)
            scene.collection.objects.link(frame)
        frame.matrix_world = Matrix.Translation((centre.x, centre.y, z)) @ rotation
        frame.hide_render = True
        frame.color = FRAME_COLOUR
        for obj in context.selected_objects:
            obj.select_set(False)
        frame.select_set(True)
        context.view_layer.objects.active = frame

        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        settings.last_status = (
            f"{'Replaced' if existing is not None else 'Added'} cutout frame: {SHAPE_NAMES[self.shape][0]}, "
            f"{max(xs) - min(xs):.1f} x {max(ys) - min(ys):.1f} mm opening. "
            "Exports keep what lies inside it"
        )
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


def _slot_labels(obj):
    """A name per material slot of *obj*, aligned with part_arrays' colours."""
    labels = []
    for slot in obj.material_slots:
        material = slot.material
        if material is None:
            labels.append(semantic_part_name(obj))
        else:
            labels.append(MATERIAL_NAMES.get(material.get(MATERIAL_ROLE_KEY), material.name))
    return labels or [semantic_part_name(obj)]


def _extents(objects, depsgraph):
    """World (min, max) of the evaluated vertices of *objects*, as part_arrays places them."""
    low, high = np.full(3, np.inf), np.full(3, -np.inf)
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            coordinates = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
            mesh.vertices.foreach_get("co", coordinates)
            points = coordinates.reshape(-1, 3).astype(np.float64)
            matrix = np.array(evaluated.matrix_world, dtype=np.float64)
        finally:
            evaluated.to_mesh_clear()
        if len(points):
            points = points @ matrix[:3, :3].T + matrix[:3, 3]
            low, high = np.minimum(low, points.min(axis=0)), np.maximum(high, points.max(axis=0))
    return low, high


def _write_sections(context, stl, sections):
    """Write each (tag, objects, bounds) section; return the number of parts.

    Z is relative to the lowest point of the whole export, as the 3MF places
    every plate. XY is relative to a section's cell centre, or without
    sections the centre of the exported geometry, as the 3MF centres a plate.
    """
    from .blender.export_cutout import part_arrays

    depsgraph = context.evaluated_depsgraph_get()
    extents = [_extents(objects, depsgraph) for _, objects, _ in sections]
    bottom = min(low[2] for low, _ in extents)
    parts = 0
    for (tag, objects, bounds), (low, high) in zip(sections, extents):
        if bounds is None:
            origin = ((low[0] + high[0]) / 2, (low[1] + high[1]) / 2, bottom)
        else:
            origin = ((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, bottom)
        for obj in objects:
            arrays = part_arrays(obj, depsgraph)
            # An object whose faces were all deleted has nothing to print.
            if not arrays[1]:
                continue
            stl.add_part(*arrays, _slot_labels(obj), section=tag, origin=origin)
            parts += 1
        stl.close_section(tag)
    return parts


class JARVIZAR_OT_export_stl(Operator, ExportHelper):
    bl_idname = "jarvizar.export_stl"
    bl_label = "Export STL"
    bl_description = (
        "Export generated geometry inside cutout's inner opening as binary STL for PrusaSlicer, "
        "OrcaSlicer, Cura and other slicers: one file per colour in a shared position, "
        "or one combined file. Replaces an earlier export of the same name"
    )
    bl_options = {"REGISTER"}

    filename_ext = ".stl"
    filter_glob: StringProperty(default="*.stl", options={"HIDDEN"})
    # Not "files": the file browser reserves that name for its selection.
    stl_files: EnumProperty(
        name="Files",
        items=(
            ("COLOUR", "One per Colour",
             "One STL per colour, all in one position: import them together as one multipart object"),
            ("COMBINED", "One Combined File", "All geometry in one STL, for single-colour printing"),
        ),
        default="COLOUR",
    )

    @classmethod
    def poll(cls, context):
        # Same availability as Export 3MF for Bambu.
        return not is_generating() and not is_downloading()

    def execute(self, context):
        from .blender.export_cutout import export_geometry, export_grid, export_sections
        from .data.export_stl import StlSet, publish

        settings = context.scene.jarvizar_city_model
        # Objects still in Edit Mode export their edits, not the mesh from before.
        update_from_edit_mode(context.scene)
        objects = generated_objects(context.scene)
        if not objects:
            settings.last_status = "Nothing to export: generate a model first"
            self.report({"ERROR"}, settings.last_status)
            return {"CANCELLED"}
        destination = Path(bpy.path.abspath(self.filepath))
        combined = self.stl_files == "COMBINED"
        try:
            if not destination.parent.is_dir():
                raise ValueError(f"Folder not found: {destination.parent}")
            ensure_writable(destination.parent, create=False)
            with export_geometry(context, objects) as (parts, stats, opening):
                if not parts:
                    raise ValueError("Nothing to export inside cutout's inner opening")
                # Stage beside the destination; publish only a complete set.
                with tempfile.TemporaryDirectory(prefix=".jcm-stl-", dir=destination.parent,
                                                 ignore_cleanup_errors=True) as folder:
                    stl = StlSet(Path(folder), destination.stem, combined=combined)
                    try:
                        if settings.multi_plate_export:
                            width, height = settings.section_width_mm, settings.section_height_mm
                            # Sections need not fit a Bambu bed here.
                            grid = export_grid(context, parts, opening, width, height,
                                               SimpleNamespace(width=width, depth=height))
                            with export_sections(context, parts, grid) as sections:
                                if not sections:
                                    raise ValueError("No section received geometry inside cutout's inner opening")
                                part_count = _write_sections(context, stl, [
                                    (f"R{section.row}C{section.column}", section_parts, section.bounds)
                                    for section, section_parts in sections])
                        else:
                            part_count = _write_sections(context, stl, [(None, parts, None)])
                        if not stl.triangles:
                            raise ValueError("Nothing to export: the parts have no triangles")
                        files = stl.close()
                    finally:
                        stl.discard()
                    try:
                        removed = publish(files, destination.parent, destination.stem)
                    except PermissionError as exc:
                        raise ValueError(f"Close the {destination.stem} STL files in other programs "
                                         "or choose another name") from exc
                crop_status = ""
                if opening:
                    crop_status = (f"; cutout: {stats['inside_objects']} inside objects, "
                                   f"{stats['outside_objects']} outside objects skipped, "
                                   f"{stats['crossing_shells']} crossing solids clipped")
        except Exception as exc:  # noqa: BLE001 - reported to the user
            settings.last_status = f"STL export failed: {exc}"
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}

        sections = len({record.section for record in files})
        grouping = "one combined file" if combined else "one per colour"
        if sections > 1:
            grouping += f" for each of {sections} sections"
        notes = ""
        if stl.mixed_shells:
            notes += f"; {stl.mixed_shells} solids mixing colours kept whole in their main colour"
        if removed:
            notes += f"; removed {removed} files of an earlier export"
        settings.last_status = (
            f"Exported {part_count} parts, {stl.triangles:,} triangles, as {len(files)} STL files "
            f"({grouping}) named {destination.stem}*.stl{crop_status}{notes}. {ATTRIBUTION}"
        )
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


def draw_export_extras(layout, context):
    """The frame and STL buttons and the crop hint, below Export 3MF for Bambu."""
    row = layout.row(align=True)
    row.operator("jarvizar.add_cutout_frame", text="Add Frame", icon="SELECT_SET")
    row.operator("jarvizar.export_stl", text="Export STL", icon="EXPORT")
    if context.scene.objects.get(CUTOUT) is None:
        row = layout.row()
        if context.scene.jarvizar_city_model.multi_plate_export:
            row.alert = True
            row.label(text="Multi-Plate needs a frame", icon="ERROR")
        else:
            row.label(text="No frame: whole model", icon="INFO")


CLASSES = (
    JARVIZAR_OT_add_cutout_frame,
    JARVIZAR_OT_export_stl,
)
