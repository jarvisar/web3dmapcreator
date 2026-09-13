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

Other foundations use a minimum grade that exposes 0.2 mm of terrain above
retained water, with the structure seated on the same grade. Over cut water
that grade is the bank level the terrain is flattened to, so these supports
blend into the shore rather than standing proud of it. Bridge causeways over
cut water sit just below its surface. Only paved land-cover slabs retain
ground; natural land cover is cleared from the water footprint.
"""

from __future__ import annotations

from copy import copy
from typing import Any, Dict, List, Sequence, Tuple

from ..blender.mesh_utils import MeshBuilder, _prism_geometry
from ..data.linework import simplify_polyline
from .footprint_cut import FootprintIndex, area_xy
from .heightfield import ModelHeightField
from .planar import (
    EPSILON,
    buffer_polyline,
    buffer_polyline_convex_pieces,
    clean_ring,
    densify_ring,
    interior_grid_points,
    offset_is_safe,
    ring_bounds,
    signed_area,
)

Point = Tuple[float, float]
Ring = Sequence[Point]

# How far below the height field the support's top is placed.  A quarter of a
# 0.2 mm layer: invisible in the print, but enough that a support overlapping
# the bank never shares a face with the terrain there.
SUPPORT_TOP_OFFSET_MM = 0.05
# One default FDM layer of visible terrain above a retained water fill.
SUPPORT_WATER_CLEARANCE_MM = 0.2
# Cut water is set this far below the bank level its terrain is flattened to,
# so the foundation grade over it is the bank itself: structures standing in
# the water sit on the same surface as the shore around them.  Bridge
# causeways sink by the same amount and stay just under the water.
CUT_WATER_DROP_MM = SUPPORT_WATER_CLEARANCE_MM + SUPPORT_TOP_OFFSET_MM


class _FoundationHeightField:
    """A structure's continuous ground grade with a footprint-wide floor."""

    def __init__(self, field, minimum):
        self.field, self.minimum = field, minimum

    def __getattr__(self, name):
        return getattr(self.field, name)

    def height_mm(self, x, y):
        return max(self.field.height_mm(x, y), self.minimum)

    minimum_over = ModelHeightField.minimum_over
    maximum_over = ModelHeightField.maximum_over
    sample_ring = ModelHeightField.sample_ring


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
        water_bodies=(),
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
        # Structures retain the pre-recess grade. Keep the physical field's
        # floors for terrain/water queries; share its cut/support registries.
        self.structure_heightfield = heightfield
        self._basin_bounds = []
        self._basin_mask = FootprintIndex(clearance=0)
        self._water_levels = []
        self._paved_levels = []
        for body in water_bodies:
            mask = FootprintIndex(clearance=0)
            vertices, faces = body.geometry
            for face in faces:
                if all(vertices[i][2] == 1.0 for i in face):
                    mask.add([vertices[i] for i in face])
            self._water_levels.append((ring_bounds(body.rings[0]), mask, body.top_mm))
        if heightfield.basins:
            self.structure_heightfield = copy(heightfield)
            self.structure_heightfield.basins = []
            for bounds, rings, _floor in heightfield.basins:
                self._basin_bounds.append(bounds)
                for cap in self._footprint_caps(rings):
                    self._basin_mask.add(cap)

    def minimum_ground(self, rings, kind):
        """Grade needed to expose a non-bridge foundation above its water.

        Clamp the entire footprint, not individual wet samples: interpolating
        through a wet/dry step would recreate shoreline wedges. Exact cap
        overlap includes tiny shoreline contacts and preserves island holes.
        """
        if kind == 'bridge_causeway' or not (self._water_levels or self._paved_levels) or not rings:
            return None
        a = ring_bounds(rings[0])
        sources = [(b, mask, top + SUPPORT_WATER_CLEARANCE_MM + self.top_offset_mm)
                   for b, mask, top in self._water_levels] + self._paved_levels
        candidates = [(mask, minimum) for b, mask, minimum in sources
                      if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]]
        if not candidates:
            return None
        caps = list(self._footprint_caps(rings))
        levels = [minimum for mask, minimum in candidates
                  if any(area_xy(cap)-sum(area_xy(p) for p in mask.difference(cap)) > 1e-8
                         for cap in caps)]
        return max(levels) if levels else None

    def foundation_field(self, minimum):
        if minimum is None:
            return self.structure_heightfield
        return _FoundationHeightField(self.structure_heightfield, minimum)

    def support_paved_surfaces(self, collection, rise, embed):
        """Support surviving paved caps after surface priority is resolved.

        Use final cap triangles so erased paving and its holes never gain
        terrain. These foundations remain under later road cutouts, providing
        the same raised grade for roads and buildings crossing the paving.
        No other land-cover category participates.
        """
        from .surface_priority import _top_triangles

        supported = 0
        for obj in collection.objects:
            if obj.get('feature_type') != 'land_surface' or obj.get('surface_category') != 'paved':
                continue
            for cap in _top_triangles(obj.data):
                ring = [p[:2] for p in cap]
                if not (self._needs_support([ring]) or any(
                    z-rise-embed > self.structure_heightfield.height_mm(x,y)+1e-5 for x,y,z in cap
                )):
                    continue
                tops = [(x,y,max(z-rise-self.top_offset_mm,self.bottom_z+.05)) for x,y,z in cap]
                vertices = [(x,y,self.bottom_z) for x,y in ring] + tops
                faces = [(0,2,1),(3,4,5),(0,1,4,3),(1,2,5,4),(2,0,3,5)]
                if not self.builder.add_raw(vertices,faces):
                    self.rejected += 1
                    continue
                self.heightfield.add_support([ring])
                mask = FootprintIndex(clearance=0)
                mask.add(cap)
                self._paved_levels.append((ring_bounds(ring),mask,max(p[2] for p in cap)-rise))
                supported += 1
        if supported:
            self.counts['paved'] = self.counts.get('paved',0)+supported
        return {'paved_surface_supports':supported}

    @staticmethod
    def _footprint_caps(rings):
        vertices, faces = _prism_geometry(
            [[(x, y, 0.0, 1.0) for x, y in ring] for ring in rings])
        for face in faces:
            if all(vertices[i][2] == 1.0 for i in face):
                yield [vertices[i] for i in face]

    def overlaps_basin(self, rings: Sequence[Ring]) -> bool:
        """Positive-area basin overlap, including sub-cell and interior hits.

        Use cap footprints rather than point samples: a thin shore overlap or
        a small basin wholly inside a structure must not lose its foundation.
        Triangulated caps preserve both basin islands and structure courtyards.
        """
        if not self._basin_bounds or not rings or len(rings[0]) < 3:
            return False
        a = ring_bounds(rings[0])
        if not any(a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]
                   for b in self._basin_bounds):
            return False
        return any(area_xy(cap) - sum(area_xy(p) for p in self._basin_mask.difference(cap)) > 1e-8
                   for cap in self._footprint_caps(rings))

    def _needs_support(self, rings: Sequence[Ring]) -> bool:
        """Test the surviving ground, after deck restoration and prior supports.

        Mapped decks are collected using a broad water-window test before the
        terrain is built. That only makes them candidates: a nearby dry quay,
        or a deck fully restored by the terrain grid, needs no second solid.
        Check the outline finely enough to keep narrow piers, and the interior
        as well so an opening enclosed by a wide footprint is still supported.
        """
        field = self.heightfield
        if self.overlaps_basin(rings):
            return True
        if field.void_mask is None or not field.void_mask.touches_water(rings):
            return False
        spacing = min(0.5, field.cell_size_mm * 0.25)
        if any(field.over_open_water(x, y)
               for ring in rings for x, y in densify_ring(ring, spacing)):
            return True
        return any(field.over_open_water(x, y)
                   for x, y in interior_grid_points(rings, spacing, limit=600))

    def _levels(self, x: float, y: float, minimum_ground=None, drop=0.0):
        """Shared outline and cap sampling, keeping the flat model underside."""
        top = max(
            self.structure_heightfield.height_mm(x, y) - self.top_offset_mm - drop,
            self.bottom_z + 0.05,
        )
        if minimum_ground is not None:
            top = max(top, minimum_ground - self.top_offset_mm)
        return self.bottom_z, top

    def _draped(self, ring: Ring, levels):
        dense = clean_ring(densify_ring(ring, self.drape_spacing_mm), EPSILON)
        if len(dense) < 3:
            return None
        return [(x, y, *levels(x, y)) for x, y in dense]

    def footprint(self, rings: Sequence[Ring], kind: str, *, minimum_ground=None) -> bool:
        """Add a pedestal under a polygon (outer ring first, then holes)."""
        if not rings or len(rings[0]) < 3:
            return False
        if abs(signed_area(rings[0])) < self.minimum_area_mm2:
            return False
        water_minimum = self.minimum_ground(rings, kind)
        if kind == 'bridge_causeway':
            minimum_ground = None
        elif water_minimum is not None:
            minimum_ground = max(water_minimum, minimum_ground) if minimum_ground is not None else water_minimum
        footprint_key = (kind == 'bridge_causeway', minimum_ground,
                         tuple(tuple(tuple(point) for point in ring) for ring in rings))
        known = footprint_key in self._grounded_footprints
        # Point-in-polygon tests exclude some boundary edges, so an identical
        # footprint must not appear unsupported along its own outline.
        needs_lift = (minimum_ground is not None and self.structure_heightfield.minimum_over(
            point for ring in rings for point in densify_ring(ring, self.drape_spacing_mm)
        ) < minimum_ground - 1.0e-6)
        if known or not (needs_lift or self._needs_support(rings)):
            # Even without another solid, this footprint is usable ground.
            # Bridge piers use has_ground(), whose conservative shoreline-cell
            # test needs this registration to recognize a dry quay/deck.
            if not known and self.heightfield.void_mask is not None:
                self.heightfield.add_support(rings)
                self._grounded_footprints.add(footprint_key)
            self.already_grounded += 1
            return False
        # A causeway across cut water is lowered as a whole, not per vertex:
        # switching at the shoreline would ramp its top up out of the water.
        # The part on land stays buried under the bank.
        mask = self.heightfield.void_mask
        drop = (CUT_WATER_DROP_MM if kind == 'bridge_causeway' and mask is not None
                and mask.touches_water(rings) else 0.0)
        levels = lambda x, y: self._levels(x, y, minimum_ground, drop)
        outer = self._draped(rings[0], levels)
        if outer is None:
            self.rejected += 1
            return False
        prism_rings = [outer]
        for hole in rings[1:]:
            draped_hole = self._draped(hole, levels)
            if draped_hole is not None:
                prism_rings.append(draped_hole)
        # Perimeter heights alone can span straight across an interior hollow
        # and put a pedestal above the terrain it should blend into. Use the
        # same cap refinement already used by draped roads and land slabs.
        if not self.builder.add_prism(
            prism_rings, refine=(self.drape_spacing_mm, levels)
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
            obj["source"] = "derived: ground kept under structures over cut or recessed water"
        return obj

    def summary(self) -> Dict[str, Any]:
        return {
            "terrain_supports": sum(self.counts.values()),
            "terrain_support_kinds": dict(sorted(self.counts.items())),
            "terrain_supports_rejected": self.rejected,
            "terrain_supports_already_grounded": self.already_grounded,
        }
