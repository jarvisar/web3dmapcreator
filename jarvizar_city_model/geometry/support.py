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

    def _draped(self, ring: Ring):
        dense = clean_ring(densify_ring(ring, self.drape_spacing_mm), EPSILON)
        if len(dense) < 3:
            return None
        floor = self.bottom_z
        prism = []
        for x, y, height in self.heightfield.sample_ring(dense):
            top = max(height - self.top_offset_mm, floor + 0.05)
            prism.append((x, y, floor, top))
        return prism

    def footprint(self, rings: Sequence[Ring], kind: str) -> bool:
        """Add a pedestal under a polygon (outer ring first, then holes)."""
        if not rings or len(rings[0]) < 3:
            return False
        if abs(signed_area(rings[0])) < self.minimum_area_mm2:
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
        if not self.builder.add_prism(prism_rings):
            self.rejected += 1
            return False
        self.heightfield.add_support(rings)
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
        }
