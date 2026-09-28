"""Model colours: the scene palette, its presets, and the Colours sub-panel.

The palette is a pointer property of the scene settings, which the generation
worker's settings snapshot leaves out. Colours never reach the worker; they
are applied in the foreground when the model's materials are staged, and to
existing JCM_* materials whenever a colour changes outside a generation.
"""

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatVectorProperty, StringProperty
from bpy.types import Menu, Operator, PropertyGroup
from bpy_extras.node_shader_utils import PrincipledBSDFWrapper

from .blender import materials
from .blender.generation_modal import is_generating
from .data.export_plates import DEFAULT_LINE, FILAMENT_LINES
from .data.palette import (
    DEFAULT_PRESET, FILAMENTS, GROUP_KEYS, GROUPS, PRESETS, filament, filament_count, filament_name,
    hex_code, matching_preset, rgb, role_palette, settings_palette, used_groups,
)


_LINES = [(line, line.replace("PLA ", ""), f"Bambu {line}") for line in FILAMENT_LINES]
_FILAMENTS = [(f"{line}:{name}", f"{line.replace('PLA ', '')} {name}", f"Bambu {line} {name}, {code}")
              for line, names in FILAMENTS.items() for name, code in names.items()]
_suspended = False


def recolour(palette, groups=GROUP_KEYS):
    """Recolour the existing JCM_* materials of ``groups``; return how many.

    Uses the material setup generation applies, so the viewport and shader
    colours stay in sync. Never creates a material.
    """
    entries = role_palette(settings_palette(palette))
    count = 0
    for group in GROUPS:
        if group.key not in groups:
            continue
        for role in group.roles:
            name = materials._material_name(role)
            if bpy.data.materials.get((name, None)) is None:
                continue
            colour, line = entries[role]
            material = materials.get_or_create_material(
                name, colour, materials._ROUGHNESS.get(role, materials._DEFAULT_ROUGHNESS))
            material[materials.FILAMENT_KEY] = line
            count += 1
    return count


def _set_entries(palette, entries):
    """Set several groups, then recolour their materials once."""
    global _suspended
    _suspended = True
    try:
        for key, (colour, line) in entries.items():
            setattr(palette, key, tuple(min(1.0, max(0.0, c)) for c in colour[:3]))
            setattr(palette, key + "_line", line)
    finally:
        _suspended = False
    return recolour(palette, tuple(entries))


def _update(key):
    def update(self, context):
        # A generation stages its materials from the palette itself.
        if not _suspended and not is_generating():
            recolour(self, (key,))
    return update


def _properties():
    annotations = {}
    for group in GROUPS:
        colour, line = DEFAULT_PRESET.entries[group.key]
        annotations[group.key] = FloatVectorProperty(
            name=group.label, description=group.description, subtype="COLOR_GAMMA", size=3,
            min=0.0, max=1.0, default=colour, update=_update(group.key))
        annotations[group.key + "_line"] = EnumProperty(
            name=f"{group.label} PLA Line", description="Bambu PLA line of this filament in the exported project",
            items=_LINES, default=line, update=_update(group.key))
    annotations["show_lines"] = BoolProperty(
        name="PLA Lines", description="Show each group's Bambu PLA line in place of its colour", default=False,
        options={"SKIP_SAVE"})
    return annotations


class JARVIZAR_PG_palette(PropertyGroup):
    """One colour and Bambu PLA line per group of materials (data/palette.py).

    Colours are stored as the materials store them and the export writes them,
    so the swatch and its hex value show the filament's colour code.
    """

    __annotations__ = _properties()


def _palette(context):
    return context.scene.jarvizar_city_model.palette


class JARVIZAR_MT_palette_presets(Menu):
    bl_label = "Colour Presets"
    bl_idname = "JARVIZAR_MT_palette_presets"

    def draw(self, context):
        for preset in PRESETS:
            self.layout.operator("jarvizar.palette_preset", text=preset.name).preset = preset.key


class JARVIZAR_OT_palette_preset(Operator):
    bl_idname = "jarvizar.palette_preset"
    bl_label = "Colour Preset"
    bl_description = "Set every colour from a preset and recolour the model"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    preset: EnumProperty(name="Preset", items=[(p.key, p.name, p.description) for p in PRESETS])

    @classmethod
    def description(cls, context, properties):
        return next(p.description for p in PRESETS if p.key == properties.preset)

    @classmethod
    def poll(cls, context):
        return not is_generating()

    def execute(self, context):
        preset = next(p for p in PRESETS if p.key == self.preset)
        count = _set_entries(_palette(context), preset.entries)
        self.report({"INFO"}, f"{preset.name} colours applied to {count} materials" if count
                    else f"{preset.name} colours set; Generate applies them")
        return {"FINISHED"}


class JARVIZAR_OT_palette_filament(Operator):
    bl_idname = "jarvizar.palette_filament"
    bl_label = "Bambu Filament"
    bl_description = "Choose this colour from Bambu PLA Basic and Matte filaments"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}
    bl_property = "filament"

    group: StringProperty(options={"HIDDEN", "SKIP_SAVE"})
    filament: EnumProperty(name="Filament", items=_FILAMENTS)

    @classmethod
    def description(cls, context, properties):
        group = next((g for g in GROUPS if g.key == properties.group), None)
        if group is None:
            return cls.bl_description
        entry = settings_palette(_palette(context))[group.key]
        return f"{group.label}: {filament_name(entry) or 'custom colour'}. {cls.bl_description}"

    @classmethod
    def poll(cls, context):
        return not is_generating()

    def invoke(self, context, event):
        context.window_manager.invoke_search_popup(self)
        return {"RUNNING_MODAL"}

    def execute(self, context):
        if self.group not in GROUP_KEYS:
            return {"CANCELLED"}
        line, name = self.filament.split(":", 1)
        _set_entries(_palette(context), {self.group: filament(line, name)})
        return {"FINISHED"}


class JARVIZAR_OT_apply_palette(Operator):
    bl_idname = "jarvizar.apply_palette"
    bl_label = "Apply Colours to Model"
    bl_description = "Recolour the generated model's materials with these colours"
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return not is_generating()

    def execute(self, context):
        count = recolour(_palette(context))
        self.report({"INFO"}, f"Recoloured {count} materials" if count
                    else "No model materials yet; Generate applies these colours")
        return {"FINISHED"}


class JARVIZAR_OT_palette_from_model(Operator):
    bl_idname = "jarvizar.palette_from_model"
    bl_label = "Read Colours From Model"
    bl_description = (
        "Set these colours from the model's materials, as the 3MF export reads them, "
        "keeping colours edited in Blender for the next Generate"
    )
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return not is_generating()

    def execute(self, context):
        from .blender.export_cutout import material_color

        entries = {}
        for group in GROUPS:
            found = (bpy.data.materials.get((materials._material_name(role), None)) for role in group.roles)
            material = next((item for item in found if item is not None), None)
            if material is None:
                continue
            # The Principled base colour, else the viewport colour, at full
            # precision; the export's own reading wins where the two differ.
            colour = tuple(PrincipledBSDFWrapper(material, is_readonly=True).base_color)[:3]
            if hex_code(colour) != material_color(material):
                colour = rgb(material_color(material))
            line = material.get(materials.FILAMENT_KEY)
            entries[group.key] = colour, line if line in FILAMENT_LINES else DEFAULT_LINE
        if not entries:
            self.report({"WARNING"}, "No model materials to read")
            return {"CANCELLED"}
        _set_entries(_palette(context), entries)
        self.report({"INFO"}, f"Read {len(entries)} colours from the model")
        return {"FINISHED"}


def draw_palette(layout, settings):
    """The Colours sub-panel: presets, one row per group, and the filament count.

    Rows of groups the enabled features cannot generate are greyed, and the
    count covers only the others.
    """
    palette = settings.palette
    entries = settings_palette(palette)
    preset = matching_preset(entries)
    layout.menu("JARVIZAR_MT_palette_presets", text=preset.name if preset else "Custom", icon="PRESET")
    used = used_groups(settings)
    column = layout.column(align=True)
    for group in GROUPS:
        row = column.row(align=True)
        row.active = group.key in used
        split = row.split(factor=0.4, align=True)
        split.label(text=group.label)
        # A swatch and a line menu side by side truncate at the default width.
        value = split.row(align=True)
        value.prop(palette, group.key + "_line" if palette.show_lines else group.key, text="")
        value.operator("jarvizar.palette_filament", text="", icon="COLOR").group = group.key
    layout.prop(palette, "show_lines")
    count = filament_count(entries, used)
    layout.label(text=f"Filaments: {count}")
    if count > 4:
        layout.label(text="More than one AMS unit", icon="INFO")
    column = layout.column(align=True)
    column.operator("jarvizar.apply_palette", icon="BRUSH_DATA")
    column.operator("jarvizar.palette_from_model", icon="EYEDROPPER")


CLASSES = (
    JARVIZAR_MT_palette_presets,
    JARVIZAR_OT_palette_preset,
    JARVIZAR_OT_palette_filament,
    JARVIZAR_OT_apply_palette,
    JARVIZAR_OT_palette_from_model,
)
