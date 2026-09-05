"""Printable terrain solid built from the shared model height field.

The terrain is one closed solid: a displaced top grid, walls around every
opening, and a flat bottom.  Its bottom sits a configurable thickness below the
*lowest* point of the relief, so the base stays solid everywhere rather than
opening up under a valley.

Open water is removed from the solid rather than covered over.  A river printed
as a void reads at a glance, needs no second material to be legible, and
matches how a terrain model is normally cut for display.  The mesh work itself
lives in :mod:`jarvizar_city_model.geometry.terrain_mesh`.

An optional rim raises a wall around the selection edge.  It is purely a
presentation choice for a display piece, so it is generated as its own object
that can be deleted without touching the terrain.
"""

from __future__ import annotations

from typing import Any, Dict

from ..blender.mesh_utils import MeshBuilder
from .terrain_mesh import terrain_solid_geometry


def generate_terrain_solid(
    heightfield,
    thickness_mm: float,
    collection,
    material=None,
    name: str = "TERRAIN_SURFACE",
) -> Dict[str, Any]:
    """Create the terrain solid and return its descriptive metadata."""
    vertices, faces, statistics = terrain_solid_geometry(
        heightfield.rows_2d(),
        heightfield.min_x,
        heightfield.min_y,
        heightfield.max_x,
        heightfield.max_y,
        float(thickness_mm),
        heightfield.void_mask,
    )
    bottom_z = statistics["bottom_z"]
    builder = MeshBuilder(name)
    builder.add_raw(vertices, faces)
    obj = builder.build(collection, material)
    if obj is None:
        raise ValueError("Terrain solid could not be constructed")

    obj["feature_type"] = "terrain"
    obj["terrain_mode"] = "flat" if heightfield.is_flat else "dem"
    obj["base_thickness_mm"] = float(thickness_mm)
    obj["grid_columns"] = heightfield.columns
    obj["grid_rows"] = heightfield.rows
    obj["relief_mm"] = round(heightfield.maximum_mm - heightfield.minimum_mm, 4)
    obj["bottom_z_mm"] = round(bottom_z, 4)
    obj["cells_removed_for_water"] = statistics["cells_removed"]
    obj["cells_clipped_at_shoreline"] = statistics["cells_clipped"]
    summary = {
        "terrain_bottom_z_mm": bottom_z,
        "terrain_mode": obj["terrain_mode"],
        "terrain_grid": f"{heightfield.columns}x{heightfield.rows}",
        "terrain_relief_mm": obj["relief_mm"],
        "terrain_bottom_mm": obj["bottom_z_mm"],
    }
    if statistics["cells_removed"] or statistics["cells_clipped"]:
        removed = statistics["cells_removed"] + statistics["cells_clipped"]
        summary["terrain_water_cut_percent"] = round(
            100.0 * removed / max(1, statistics["cells_total"]), 1
        )
    if statistics["duplicate_edges"]:
        summary["terrain_duplicate_edges"] = statistics["duplicate_edges"]
    return summary


def generate_border_rim(
    heightfield,
    bottom_z: float,
    rim_height_mm: float,
    rim_width_mm: float,
    collection,
    material=None,
) -> Dict[str, Any]:
    """Create a raised rim framing the model, as a single closed ring solid.

    The rim is modelled as a prism with a rectangular hole so it remains one
    watertight object rather than four overlapping walls.
    """
    if rim_height_mm <= 0.0 or rim_width_mm <= 0.0:
        return {"border_rim": False}

    inner = (
        heightfield.min_x,
        heightfield.min_y,
        heightfield.max_x,
        heightfield.max_y,
    )
    outer_ring = [
        (inner[0] - rim_width_mm, inner[1] - rim_width_mm),
        (inner[2] + rim_width_mm, inner[1] - rim_width_mm),
        (inner[2] + rim_width_mm, inner[3] + rim_width_mm),
        (inner[0] - rim_width_mm, inner[3] + rim_width_mm),
    ]
    # The hole is wound the opposite way so the prism builder treats it as an
    # interior ring rather than a second outer boundary.
    inner_ring = [
        (inner[0], inner[1]),
        (inner[0], inner[3]),
        (inner[2], inner[3]),
        (inner[2], inner[1]),
    ]

    top_z = heightfield.maximum_mm + float(rim_height_mm)
    builder = MeshBuilder("TERRAIN_BORDER_RIM")
    if not builder.add_flat_prism(outer_ring, bottom_z, top_z, [inner_ring]):
        return {"border_rim": False}
    obj = builder.build(collection, material)
    if obj is None:
        return {"border_rim": False}
    obj["feature_type"] = "border_rim"
    obj["rim_height_mm"] = float(rim_height_mm)
    obj["rim_width_mm"] = float(rim_width_mm)
    return {
        "border_rim": True,
        "border_rim_top_mm": round(top_z, 4),
    }
