"""Simple, reusable materials for an architectural miniature.

Each material is written twice: as ``diffuse_color`` for the Solid viewport
shading most modelling work happens in, and as a Principled BSDF base colour so
Material Preview and render output agree with it.  Setting only one of the two
makes the model look completely different depending on the shading mode.

The palette pairs caramel buildings with white terrain, dark-grey roads and
paving, green parks, dark-green forest and trees, and desert-tan sand and rock.
Values are linear RGB, shared by the viewport and shader materials. Export
writes them unchanged as filament bytes, so a Bambu filament's colour is its
hex code over 255; Blender's colour management displays it differently from
the printed filament.
"""

from __future__ import annotations

from typing import Dict, Tuple

import bpy

from .collections import GENERATED_KEY


def _bambu(code: str) -> Tuple[float, float, float, float]:
    return (*(int(code[i:i + 2], 16) / 255 for i in (1, 3, 5)), 1.0)


# Bambu filament colours, from Bambu Studio's filaments_color_codes.json.
MATTE_CARAMEL = _bambu("#AE835B")
MATTE_IVORY_WHITE = _bambu("#FFFFFF")
BASIC_BAMBU_GREEN = _bambu("#00AE42")
BASIC_DARK_GRAY = _bambu("#545454")

PALETTE: Dict[str, Tuple[float, float, float, float]] = {
    "terrain": MATTE_IVORY_WHITE,
    "building": MATTE_CARAMEL,
    "building_part": MATTE_CARAMEL,
    "road": BASIC_DARK_GRAY,
    "bridge": BASIC_DARK_GRAY,
    "bridge_support": BASIC_DARK_GRAY,
    "water": (0.36, 0.70, 0.82, 1.0),
    "surface_green": BASIC_BAMBU_GREEN,
    "surface_forest": (0.06, 0.18, 0.08, 1.0),
    "surface_sand": (0.55, 0.39, 0.22, 1.0),
    "surface_rock": (0.55, 0.39, 0.22, 1.0),
    "surface_paved": BASIC_DARK_GRAY,
    "tree": (0.06, 0.18, 0.08, 1.0),
    "rim": (0.16, 0.16, 0.17, 1.0),
}
# The Bambu PLA line exported for each role's filament; the rest are PLA Basic.
FILAMENT_KEY = "jarvizar_filament"
MATTE_ROLES = {"terrain", "building", "building_part"}

_ROUGHNESS = {
    "water": 0.15,
    "road": 0.75,
    "bridge": 0.75,
}
_DEFAULT_ROUGHNESS = 0.88


def _material_name(key: str) -> str:
    return "JCM_" + "".join(part.capitalize() for part in key.split("_"))


def get_or_create_material(name: str, color, roughness: float = _DEFAULT_ROUGHNESS, *, staging=False):
    material = bpy.data.materials.get(name)
    if staging:
        material = material.copy() if material is not None else bpy.data.materials.new(name=name)
        material.name = "_JCM_STAGING_" + name
    elif material is None:
        material = bpy.data.materials.new(name=name)
    rgba = (*color[:3], color[3] if len(color) > 3 else 1.0)
    material.diffuse_color = rgba
    material.roughness = roughness
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is not None:
        principled.inputs["Base Color"].default_value = rgba
        if "Roughness" in principled.inputs:
            principled.inputs["Roughness"].default_value = roughness
    material[GENERATED_KEY] = True
    return material


def model_materials(*, staging=False) -> Dict[str, bpy.types.Material]:
    """Return every material the generators use, keyed by their role name."""
    materials = {
        key: get_or_create_material(
            _material_name(key), color, _ROUGHNESS.get(key, _DEFAULT_ROUGHNESS), staging=staging
        )
        for key, color in PALETTE.items()
    }
    for role, material in materials.items():
        material["jarvizar_material_role"] = role
        material[FILAMENT_KEY] = "PLA Matte" if role in MATTE_ROLES else "PLA Basic"
    return materials
