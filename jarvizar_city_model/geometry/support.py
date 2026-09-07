"""Ground kept under structures where the water cut took it away.

Cutting a river out of the terrain removes the ground under everything that
was mapped across or inside it: the bridges, a boathouse, a floating dock, the
pier a walkway runs along.  Each of those still has to stand on something in
the print.  Extending the structure itself down to the build plate would turn
a bridge deck into a tall wall of the wrong colour and the wrong shape, so the
answer is the opposite: put the terrain back, but only under the structure.

A support is a solid built from the same height field as the terrain, from
the terrain's own underside up to the ground surface, over exactly the
footprint that needs it.  Under a bridge that is a strip following the deck --
a causeway -- and under a building it is a pedestal of the footprint itself.
Overlaps with the surviving bank are fine: every generated solid is
individually watertight and a slicer unions them.

The support's top sits a hair below the surface the height field describes,
so where it overlaps real terrain the two never share a face.  Over the
opening the difference is a fraction of one printed layer.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

from ..blender.mesh_utils import MeshBuilder
from ..data.linework import simplify_polyline
from .planar import (
    EPSILON,
    buffer_polyline,
    buffer_polyline_convex_pieces,
    clean_ring,
    densify_ring,
    interior_grid_points,
    offset_is_safe,
    signed_area,
)

Point = Tuple[float, float]
Ring = Sequence[Point]

# How far below the height field the support's top is placed.  A quarter of a
# 0.2 mm layer: invisible in the print, but enough that a support overlapping
# the bank never shares a face with the terrain there.
SUPPORT_TOP_OFFSET_MM = 0.05


class SupportBuilder:
    """Accumulates support solids and registers their footprints as ground."""

    def __init__(
        self,
        heightfield,
        bottom_z: float,
        drape_spacing_mm: float = 1.5,
        top_offset_mm: float = SUPPORT_TOP_OFFSET_MM,
        minimum_area_mm2: float = 0.02,
        name: str = "TERRAIN_SUPPORTS",
    ) -> None:
        self.heightfield = heightfield
        self.bottom_z = float(bottom_z)
        self.drape_spacing_mm = float(drape_spacing_mm)
        self.top_offset_mm = float(top_offset_mm)
        self.minimum_area_mm2 = float(minimum_area_mm2)
        self.builder = MeshBuilder(name)
        self.counts: Dict[str, int] = {}
        self.rejected = 0
        self.already_grounded = 0
        self._grounded_footprints = set()

    def _needs_support(self, rings: Sequence[Ring]) -> bool:
        """Test the surviving ground, after deck restoration and prior supports.

        Mapped decks are collected using a broad water-window test before the
        terrain is built. That only makes them candidates: a nearby dry quay,
        or a deck fully restored by the terrain grid, needs no second solid.
        Check the outline finely enough to keep narrow piers, and the interior
        as well so an opening enclosed by a wide footprint is still supported.
        """
        field = self.heightfield
        if field.void_mask is None or not field.void_mask.touches_water(rings):
            return False
        spacing = min(0.5, field.cell_size_mm * 0.25)
        if any(field.over_open_water(x, y)
               for ring in rings for x, y in densify_ring(ring, spacing)):
            return True
        return any(field.over_open_water(x, y)
                   for x, y in interior_grid_points(rings, spacing, limit=600))

    def _levels(self, x: float, y: float):
        """Shared outline and cap sampling, keeping the flat model underside."""
        top = max(
            self.heightfield.height_mm(x, y) - self.top_offset_mm,
            self.bottom_z + 0.05,
        )
        return self.bottom_z, top

    def _draped(self, ring: Ring):
        dense = clean_ring(densify_ring(ring, self.drape_spacing_mm), EPSILON)
        if len(dense) < 3:
            return None
        return [(x, y, *self._levels(x, y)) for x, y in dense]

    def footprint(self, rings: Sequence[Ring], kind: str) -> bool:
        """Add a pedestal under a polygon (outer ring first, then holes)."""
        if not rings or len(rings[0]) < 3:
            return False
        if abs(signed_area(rings[0])) < self.minimum_area_mm2:
            return False
        footprint_key = tuple(tuple(tuple(point) for point in ring) for ring in rings)
        known = footprint_key in self._grounded_footprints
        # Point-in-polygon tests exclude some boundary edges, so an identical
        # footprint must not appear unsupported along its own outline.
        if known or not self._needs_support(rings):
            # Even without another solid, this footprint is usable ground.
            # Bridge piers use has_ground(), whose conservative shoreline-cell
            # test needs this registration to recognize a dry quay/deck.
            if not known and self.heightfield.void_mask is not None:
                self.heightfield.add_support(rings)
                self._grounded_footprints.add(footprint_key)
            self.already_grounded += 1
            return False
        outer = self._draped(rings[0])
        if outer is None:
            self.rejected += 1
            return False
        prism_rings = [outer]
        for hole in rings[1:]:
            draped_hole = self._draped(hole)
            if draped_hole is not None:
                prism_rings.append(draped_hole)
        # Perimeter heights alone can span straight across an interior hollow
        # and put a pedestal above the terrain it should blend into. Use the
        # same cap refinement already used by draped roads and land slabs.
        if not self.builder.add_prism(
            prism_rings, refine=(self.drape_spacing_mm, self._levels)
        ):
            self.rejected += 1
            return False
        self.heightfield.add_support(rings)
        self._grounded_footprints.add(footprint_key)
        self.counts[kind] = self.counts.get(kind, 0) + 1
        return True

    def corridor(self, centerline: Sequence[Point], half_width: float, kind: str) -> bool:
        """Add a causeway under a centerline, *half_width* to either side."""
        if len(centerline) < 2 or half_width <= 0.0:
            return False
        # The centerline arrives sampled finely enough to find the water's
        # edge, which is far finer than the strip can turn: a sidewalk's
        # one-metre jog around a pylon would fold the offset ring.  Vertices
        # closer than the strip's own half-width carry nothing it can show.
        centerline = simplify_polyline(centerline, half_width)
        if len(centerline) < 2:
            return False
        if offset_is_safe(centerline, half_width):
            rings = [buffer_polyline(centerline, half_width, arc_segments=4, epsilon=EPSILON)]
        else:
            rings = buffer_polyline_convex_pieces(
                centerline, half_width, arc_segments=4, epsilon=EPSILON
            )
        added = False
        for ring in rings:
            if ring and self.footprint([ring], kind):
                added = True
        return added

    def build(self, collection, material=None):
        obj = self.builder.build(collection, material)
        if obj is not None:
            obj["feature_type"] = "terrain_support"
            obj["support_kinds_json"] = str(dict(sorted(self.counts.items())))
            obj["bottom_z_mm"] = round(self.bottom_z, 4)
            obj["source"] = "derived: ground kept under structures over cut water"
        return obj

    def summary(self) -> Dict[str, Any]:
        return {
            "terrain_supports": sum(self.counts.values()),
            "terrain_support_kinds": dict(sorted(self.counts.items())),
            "terrain_supports_rejected": self.rejected,
            "terrain_supports_already_grounded": self.already_grounded,
        }
