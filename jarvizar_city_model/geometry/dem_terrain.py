"""Printable terrain solid built from the shared model height field.

The terrain is one closed solid: a displaced top grid, walls around every
opening, and a flat bottom.  Its bottom sits a configurable thickness below the
*lowest* point of the relief, so the base stays solid everywhere rather than
opening up under a valley.

Open water is removed from the solid rather than covered over.  A river printed
as a void reads at a glance, needs no second material to be legible, and
matches how a terrain model is normally cut for display.  The uncut grid lives
in :mod:`jarvizar_city_model.geometry.terrain_mesh`.

An optional rim raises a wall around the selection edge.  It is purely a
presentation choice for a display piece, so it is generated as its own object
that can be deleted without touching the terrain.
"""

from __future__ import annotations

from typing import Any, Dict

from ..blender.mesh_utils import MeshBuilder
from .footprint_cut import area_xy
from .planar import clean_ring, densify_ring
from .surface_priority import CUT_EDGE_SPACING_MM, _solid, _triangulate
from .terrain_mesh import terrain_solid_geometry


def _cut_terrain_geometry(heightfield, thickness_mm: float):
    """Terrain solid with the void mask's exact outlines cut out of its top.

    Cutting along grid cells cannot follow water narrower than a cell: a
    channel between two rows of nodes was left standing, and a single wet
    node opened a diamond. Instead every grid node, the water outlines and the
    kept-ground footprints go into one constrained triangulation. A triangle
    is removed where the water's winding is positive and the footprints' is
    not, so the opening is exactly the polygon the water fill is built from.
    Grid nodes keep their heights; outline vertices take the height field's.

    Returns ``(vertices, faces, bottom_z, cut_area_mm2)``.
    """
    mask = heightfield.void_mask
    columns, rows = heightfield.columns, heightfield.rows
    left, low, right, high = heightfield.min_x, heightfield.min_y, heightfield.max_x, heightfield.max_y
    points = [(left + heightfield.step_x * column, low + heightfield.step_y * row)
              for row in range(rows) for column in range(columns)]
    grid = len(points)
    # The outline follows the ground between nodes rather than bridging it.
    spacing = min(CUT_EDGE_SPACING_MM, heightfield.cell_size_mm * 0.5)
    loops = []
    for group, polygons in ((0, mask.water_polygons), (1, mask.ground_polygons)):
        for rings in polygons:
            for index, ring in enumerate(rings):
                ring = clean_ring([(min(max(x, left), right), min(max(y, low), high)) for x, y in ring])
                area = area_xy(ring)  # 0 for fewer than three points
                if area == 0:
                    continue
                if (area < 0) != (index > 0):
                    ring.reverse()
                ring = densify_ring(ring, spacing)
                loops.append((group, list(range(len(points), len(points) + len(ring)))))
                points.extend(ring)

    out_points, out_faces, out_origins, winding = _triangulate(points, loops, 2)
    kept = []
    cut_area = 0.0
    for face, (water, ground) in zip(out_faces, winding):
        if water > 0 and ground <= 0:
            cut_area += abs(area_xy([out_points[i] for i in face]))
        else:
            kept.append(tuple(face))
    if not kept:
        raise ValueError("Terrain solid has no dry land left to build")

    values = heightfield.values

    def height(index):
        for origin in out_origins[index]:
            if origin < grid:
                return values[origin]
        x, y = out_points[index]
        return heightfield.height_mm(x, y)

    vertices, faces, _shells = _solid(out_points, kept, height, float(thickness_mm), flat=True)
    return vertices, faces, vertices[0][2], cut_area


def generate_terrain_solid(
    heightfield,
    thickness_mm: float,
    collection,
    material=None,
    name: str = "TERRAIN_SURFACE",
) -> Dict[str, Any]:
    """Create the terrain solid and return its descriptive metadata."""
    cut_area = 0.0
    if heightfield.void_mask is None:
        vertices, faces, statistics = terrain_solid_geometry(
            heightfield.rows_2d(),
            heightfield.min_x,
            heightfield.min_y,
            heightfield.max_x,
            heightfield.max_y,
            float(thickness_mm),
        )
        bottom_z = statistics["bottom_z"]
    else:
        vertices, faces, bottom_z, cut_area = _cut_terrain_geometry(heightfield, thickness_mm)
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
    obj["water_cut_area_mm2"] = round(cut_area, 4)
    summary = {
        "terrain_bottom_z_mm": bottom_z,
        "terrain_mode": obj["terrain_mode"],
        "terrain_grid": f"{heightfield.columns}x{heightfield.rows}",
        "terrain_relief_mm": obj["relief_mm"],
        "terrain_bottom_mm": obj["bottom_z_mm"],
    }
    if cut_area:
        frame = (heightfield.max_x - heightfield.min_x) * (heightfield.max_y - heightfield.min_y)
        summary["terrain_water_cut_percent"] = round(100.0 * cut_area / frame, 1)
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
