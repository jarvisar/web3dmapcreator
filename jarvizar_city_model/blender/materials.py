"""Simple, reusable materials for an architectural miniature.

Each material is written twice: as ``diffuse_color`` for the Solid viewport
shading most modelling work happens in, and as a Principled BSDF base colour so
Material Preview and render output agree with it.  Setting only one of the two
makes the model look completely different depending on the shading mode.

The palette pairs white buildings with ash-grey terrain, charcoal roads and
paving, dark-green vegetation, and desert-tan sand and rock. Values are linear
RGB, shared by the viewport and shader materials.
"""

from __future__ import annotations

from typing import Dict, Tuple

import bpy


PALETTE: Dict[str, Tuple[float, float, float, float]] = {
    "terrain": (0.36, 0.38, 0.38, 1.0),
    "building": (1.0, 1.0, 1.0, 1.0),
    "building_part": (1.0, 1.0, 1.0, 1.0),
    "road": (0.06, 0.06, 0.06, 1.0),
    "bridge": (0.06, 0.06, 0.06, 1.0),
    "bridge_support": (0.06, 0.06, 0.06, 1.0),
    "water": (0.36, 0.70, 0.82, 1.0),
    "surface_green": (0.06, 0.18, 0.08, 1.0),
    "surface_forest": (0.06, 0.18, 0.08, 1.0),
    "surface_sand": (0.55, 0.39, 0.22, 1.0),
    "surface_rock": (0.55, 0.39, 0.22, 1.0),
    "surface_paved": (0.06, 0.06, 0.06, 1.0),
    "tree": (0.06, 0.18, 0.08, 1.0),
    "rim": (0.16, 0.16, 0.17, 1.0),
}

_ROUGHNESS = {
    "water": 0.15,
    "road": 0.75,
    "bridge": 0.75,
}
_DEFAULT_ROUGHNESS = 0.88


def _material_name(key: str) -> str:
    return "JCM_" + "".join(part.capitalize() for part in key.split("_"))


def get_or_create_material(name: str, color, roughness: float = _DEFAULT_ROUGHNESS):
    material = bpy.data.materials.get(name)
    if material is None:
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
    material["jarvizar_generated"] = True
    return material


def model_materials() -> Dict[str, bpy.types.Material]:
    """Return every material the generators use, keyed by their role name."""
    return {
        key: get_or_create_material(
            _material_name(key), color, _ROUGHNESS.get(key, _DEFAULT_ROUGHNESS)
        )
        for key, color in PALETTE.items()
    }


# Retained for callers written against the Phase 1 API.
def phase1_materials() -> Dict[str, bpy.types.Material]:
    return model_materials()
