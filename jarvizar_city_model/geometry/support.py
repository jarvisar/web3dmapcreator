"""Ground kept under structures where the water cut took it away.

Cutting a river out of the terrain removes the ground under everything that
was mapped across or inside it: the bridges, a boathouse, a floating dock, the
pier a walkway runs along.  Each of those still has to stand on something in
the print.  Extending the structure itself down to the build plate would turn
a bridge deck into a tall wall of the wrong colour and the wrong shape, so the
answer is the opposite: put the terrain back, but only under the structure.

A support is a solid built from the same height field as the terrain, from
the terrain's own underside up to the ground surface, over the part of a
footprint that actually lacks ground: cut water, a recessed basin, or a grade
lifted clear of the terrain.  The rest of a footprint already stands on the
terrain, and a pedestal there would only be buried in it, its top a hair under
the ground and flickering through it in the viewport.  Under a bridge that is
a strip following the deck -- a causeway -- and under a building a pedestal
of its footprint.  Each keeps one ring of triangles over the bank, so it
overlaps the terrain rather than meeting the cut wall face to face; every
generated solid is individually watertight and a slicer unions them.

Only water that keeps its terrain under a surface sheet lifts foundations:
their grade exposes 0.2 mm of terrain above that sheet.  Cut water sits
``CUT_WATER_DROP_MM`` below a bank the terrain is held at or above, and a
basin's water below its lowest bank, so the ordinary grade already clears
both.  Bridge causeways over cut water sit just below its surface. Only
paved land-cover slabs retain ground; natural land cover is cleared from the
water footprint.
"""

from __future__ import annotations

import math
from collections import defaultdict
from copy import copy
from typing import Any, Dict, Sequence, Tuple

from ..blender.mesh_utils import MeshBuilder, _prism_geometry
from ..data.linework import simplify_polyline
from .footprint_cut import FootprintIndex, area_xy, bounds_overlap
from .heightfield import ModelHeightField
from .planar import (
    EPSILON,
    buffer_polyline,
    buffer_polyline_convex_pieces,
    clean_ring,
    densify_ring,
    offset_is_safe,
    ring_bounds,
    signed_area,
)
from .surface_priority import _lattice, _solid, _triangulate
from .water_geometry import _clip_segment

Point = Tuple[float, float]
Ring = Sequence[Point]

# How far below the height field the support's top is placed.  A quarter of a
# 0.2 mm layer: invisible in the print, but enough that a support overlapping
# the bank never shares a face with the terrain there.
SUPPORT_TOP_OFFSET_MM = 0.05
# The least a support stands above the base's underside, so a structure low
# over a deep cut never collapses its pedestal to zero height.
SUPPORT_MINIMUM_THICKNESS_MM = 0.05
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


def _cross(o, a, b) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _segment_crosses_triangle(p, q, triangle, margin=EPSILON) -> bool:
    """Whether a segment passes through a triangle's interior.

    The triangle is first shrunk by *margin*: an outline the triangle was cut
    along matches its edge only to float32 rounding, and does not cross it.
    """
    a, b, c = triangle
    if area_xy(triangle) < 0:
        b, c = c, b
    mx, my = (a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3
    reach = min(_cross(u, v, (mx, my)) / max(math.dist(u, v), 1e-12)
                for u, v in ((a, b), (b, c), (c, a)))
    if reach <= margin:
        return False
    scale = 1.0 - margin / reach
    a, b, c = ((mx + (x - mx) * scale, my + (y - my) * scale) for x, y in (a, b, c))
    for point in (p, q, ((p[0] + q[0]) * .5, (p[1] + q[1]) * .5)):
        if _cross(a, b, point) > 0 and _cross(b, c, point) > 0 and _cross(c, a, point) > 0:
            return True
    for u, v in ((a, b), (b, c), (c, a)):
        if (_cross(p, q, u) > 0) != (_cross(p, q, v) > 0) and \
                (_cross(u, v, p) > 0) != (_cross(u, v, q) > 0):
            return True
    return False


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
        embed_mm: float = 0.15,
    ) -> None:
        self.heightfield = heightfield
        self.bottom_z = float(bottom_z)
        self.drape_spacing_mm = float(drape_spacing_mm)
        self.top_offset_mm = float(top_offset_mm)
        self.minimum_area_mm2 = float(minimum_area_mm2)
        # A structure's underside reaches this far below its grade, so a
        # grade lifted by less still stands on the terrain.
        self.embed_mm = float(embed_mm)
        self.builder = MeshBuilder(name)
        self.counts: Dict[str, int] = {}
        self.rejected = 0
        self.already_grounded = 0
        self.buried_area_mm2 = 0.0
        self._grounded_footprints = set()
        # Structures retain the pre-recess grade. Keep the physical field's
        # floors for terrain/water queries; share its cut/support registries.
        self.structure_heightfield = heightfield
        self._basin_bounds = []
        self._basin_mask = FootprintIndex(clearance=0)
        self._water_levels = []
        self._paved_levels = []
        for body in water_bodies:
            # Only a sheet laid on kept terrain can cover a foundation. Cut
            # water sits under its bank, and basin water under its rim.
            if body.cut or body.basin_kind:
                continue
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
        Only retained water sheets and paving lifted over them set a grade.
        """
        if kind == 'bridge_causeway' or not (self._water_levels or self._paved_levels) or not rings:
            return None
        a = ring_bounds(rings[0])
        sources = [(b, mask, top + SUPPORT_WATER_CLEARANCE_MM + self.top_offset_mm)
                   for b, mask, top in self._water_levels] + self._paved_levels
        candidates = [(mask, minimum) for b, mask, minimum in sources if bounds_overlap(a, b)]
        if not candidates:
            return None
        caps = list(self._footprint_caps(rings))
        levels = [minimum for mask, minimum in candidates
                  if any(mask.covered_area(cap) > 1e-8 for cap in caps)]
        return max(levels) if levels else None

    def foundation_field(self, minimum):
        if minimum is None:
            return self.structure_heightfield
        return _FoundationHeightField(self.structure_heightfield, minimum)

    def support_paved_surfaces(self, collection, rise, embed):
        """Support surviving paved caps after surface priority is resolved.

        Use final cap triangles so erased paving and its holes never gain
        terrain. Only triangles over the cut, or lifted clear of the ground
        by a retained-water grade, need it, plus one ring of neighbours over
        the bank; they are welded into one solid per slab rather than a prism
        per triangle, whose shared walls met face to face. These foundations
        remain under later road cutouts, providing the same raised grade for
        roads and buildings crossing the paving. No other land-cover category
        participates.
        """
        field = self.structure_heightfield
        supported = 0
        for obj in list(collection.objects):
            if obj.get('feature_type') != 'land_surface' or obj.get('surface_category') != 'paved':
                continue
            mesh = obj.data
            coords = [vertex.co[:] for vertex in mesh.vertices]
            tops = {}
            for x, y, z in coords:
                if z > tops.get((x, y), -math.inf):
                    tops[x, y] = z
            mesh.calc_loop_triangles()
            caps = [tuple(t.vertices) for t in mesh.loop_triangles
                    if all(coords[i][2] >= tops[coords[i][:2]] - 1e-6 for i in t.vertices)
                    and abs(area_xy([coords[i] for i in t.vertices])) > 1e-12]
            points = [c[:2] for c in coords]
            grade = {i: coords[i][2] - rise for cap in caps for i in cap}
            lifted = {i for i, z in grade.items() if z - embed > field.height_mm(*points[i]) + 1e-5}
            needed = [cap for cap in caps if any(i in lifted for i in cap)
                      or self._meets_hole([points[i] for i in cap])]
            if not needed:
                continue
            kept = self._with_neighbours(caps, needed)
            height = self._band_height(
                needed, lambda i: max(grade[i] - self.top_offset_mm, self.bottom_z + .05))
            low = min(height(i) for cap in kept for i in cap)
            vertices, faces, _shells = _solid(points, kept, height, low - self.bottom_z, flat=True)
            if not self.builder.add_raw(vertices, faces):
                self.rejected += 1
                continue
            for cap in kept:
                self.heightfield.add_support([[points[i] for i in cap]])
            for cap in needed:
                # The grade the paving was lifted to, never the height of a
                # vertex that simply stands higher on the slope.
                up = [grade[i] for i in cap if i in lifted]
                if up:
                    ring = [points[i] for i in cap]
                    mask = FootprintIndex(clearance=0)
                    mask.add(ring)
                    self._paved_levels.append((ring_bounds(ring), mask, max(up)))
            supported += len(kept)
            self.counts['paved'] = self.counts.get('paved', 0) + 1
        return {'paved_surface_supports': supported}

    @staticmethod
    def _footprint_caps(rings):
        vertices, faces = _prism_geometry(
            [[(x, y, 0.0, 1.0) for x, y in ring] for ring in rings])
        for face in faces:
            if all(vertices[i][2] == 1.0 for i in face):
                yield [vertices[i] for i in face]

    @staticmethod
    def _with_neighbours(triangles, needed):
        """*needed* plus every triangle sharing an edge with one of them.

        That ring carries a support over the bank beside every edge it has
        there, so it overlaps the terrain rather than meeting its cut wall.
        """
        touching = defaultdict(list)
        for triangle in triangles:
            for c in range(3):
                a, b = triangle[c], triangle[(c + 1) % 3]
                touching[(a, b) if a < b else (b, a)].append(triangle)
        kept = dict.fromkeys(needed)
        for triangle in needed:
            for c in range(3):
                a, b = triangle[c], triangle[(c + 1) % 3]
                kept.update(dict.fromkeys(touching[(a, b) if a < b else (b, a)]))
        return list(kept)

    def _band_height(self, needed, height):
        """Heights that sink the overlap ring a structure's embed further.

        Corners of needed triangles keep *height*; the ring's outer corners
        lie inside the bank, where a top a hair under the ground only
        flickers through it in the viewport.
        """
        core = {index for triangle in needed for index in triangle}

        def banded(index):
            z = height(index)
            if index in core:
                return z
            return max(z - self.embed_mm, self.bottom_z + SUPPORT_MINIMUM_THICKNESS_MM)
        return banded

    def overlaps_basin(self, rings: Sequence[Ring]) -> bool:
        """Positive-area basin overlap, including sub-cell and interior hits.

        Use cap footprints rather than point samples: a thin shore overlap or
        a small basin wholly inside a structure must not lose its foundation.
        Triangulated caps preserve both basin islands and structure courtyards.
        """
        if not self._basin_bounds or not rings or len(rings[0]) < 3:
            return False
        a = ring_bounds(rings[0])
        if not any(bounds_overlap(a, b) for b in self._basin_bounds):
            return False
        return any(self._basin_mask.covered_area(cap) > 1e-8 for cap in self._footprint_caps(rings))

    def _near_missing_ground(self, rings: Sequence[Ring]) -> bool:
        """Cheap and conservative: could any of this footprint lack ground?

        Only a footprint whose grid window meets cut water, or whose bounds
        meet a basin's, is triangulated by :meth:`_trimmed`, which decides
        exactly. Mapped decks are collected by a broad water-window test
        before the terrain is built; a nearby dry quay, or a deck the terrain
        already keeps, passes here and gains no solid there.
        """
        mask = self.heightfield.void_mask
        if mask is not None and mask.touches_water(rings):
            return True
        a = ring_bounds(rings[0])
        return any(bounds_overlap(a, b) for b in self._basin_bounds)

    def _outline_edges(self, box, water_only=False):
        """Cut and basin outline segments inside *box*, as constraint edges."""
        field = self.heightfield
        edges = (list(field.void_mask.outline_edges(box, water_only))
                 if field.void_mask is not None else [])
        for bounds, rings, _floor in field.basins:
            if bounds_overlap(bounds, box):
                for ring in rings:
                    edges.extend(zip(ring, list(ring[1:]) + [ring[0]]))
        clipped = []
        for a, b in edges:
            segment = _clip_segment(a, b, box)
            if segment is not None and segment[0] != segment[1]:
                clipped.append(segment)
        return clipped

    def _meets_hole(self, triangle) -> bool:
        """Whether a triangle has any area over cut water or a basin."""
        field = self.heightfield
        (ax, ay), (bx, by), (cx, cy) = triangle
        mx, my = (ax+bx+cx)/3, (ay+by+cy)/3
        # Strictly inside: slabs are cut along these outlines, so corners and
        # edges lie on them, where a point test can answer either way.
        samples = [(mx, my)] + [(x + .2*(mx-x), y + .2*(my-y)) for x, y in (
            (ax, ay), (bx, by), (cx, cy), ((ax+bx)/2, (ay+by)/2), ((bx+cx)/2, (by+cy)/2),
            ((cx+ax)/2, (cy+ay)/2))]
        if any(field.in_cut_water(x, y) or field.in_basin(x, y) for x, y in samples):
            return True
        # A channel narrower than the triangle passes between its samples.
        # Kept-ground outlines, buildings along a river, bound no water.
        return any(_segment_crosses_triangle(p, q, triangle)
                   for p, q in self._outline_edges(ring_bounds(triangle), water_only=True))

    def _trimmed(self, rings, top):
        """The part of a footprint's pedestal that adds ground, or ``None``.

        The footprint is triangulated with the cut and basin outlines as
        constraints, so every triangle lies wholly over a hole, a basin or
        ground, and its centre says which.  A triangle is kept over a hole or
        a basin, or where *top* stands clear of the terrain by more than a
        structure's embed; the rest of the pedestal would be buried.  One
        ring of neighbours overlaps the bank.  Returns ``(vertices, faces)``.

        Earlier supports are not consulted: their footprints are not among
        the constraints, so a triangle straddling one was judged by its centre
        and a road beside it left hanging over the river. Where two supports
        overlap, the second lies under its own structure.
        """
        spacing = self.drape_spacing_mm
        points, loops = [], []
        for index, ring in enumerate(rings):
            dense = clean_ring(densify_ring(ring, spacing), EPSILON)
            if len(dense) < 3 or signed_area(dense) == 0:
                if index == 0:
                    return [], []
                continue
            if (signed_area(dense) < 0) != (index > 0):
                dense.reverse()
            loops.append((0, list(range(len(points), len(points) + len(dense)))))
            points.extend(dense)
        bounds = ring_bounds(points[:len(loops[0][1])])
        box = (bounds[0] - spacing, bounds[1] - spacing, bounds[2] + spacing, bounds[3] + spacing)
        for a, b in self._outline_edges(box):
            # Both directions: a constraint for the triangulation that adds
            # nothing to the footprint's winding.
            loops.append((1, [len(points), len(points) + 1]))
            points.extend((a, b))
        points.extend(_lattice(points, bounds, spacing))
        out_points, out_faces, _origins, winding = _triangulate(points, loops, 2)
        field = self.heightfield
        # Lift is judged against the ground before any recess: corners on a
        # basin outline may read its floor, and the basin test covers inside.
        ground = self.structure_heightfield.height_mm
        clearance = self.embed_mm - self.top_offset_mm
        heights = {}

        def height(index):
            if index not in heights:
                heights[index] = top(*out_points[index])
            return heights[index]

        inside, needed = [], []
        for face, (count, _edges) in zip(out_faces, winding):
            if count <= 0:
                continue
            face = tuple(face)
            inside.append(face)
            corners = [out_points[i] for i in face]
            x = sum(p[0] for p in corners) / 3
            y = sum(p[1] for p in corners) / 3
            if field.in_cut_water(x, y) or field.in_basin(x, y) or any(
                    height(i) > ground(*out_points[i]) + clearance for i in face) \
                    or top(x, y) > ground(x, y) + clearance:
                needed.append(face)
        if not needed:
            self.buried_area_mm2 += sum(abs(area_xy([out_points[i] for i in f])) for f in inside)
            return None
        kept = self._with_neighbours(inside, needed)
        self.buried_area_mm2 += sum(abs(area_xy([out_points[i] for i in f]))
                                    for f in inside) - sum(abs(area_xy([out_points[i] for i in f]))
                                                           for f in kept)
        banded = self._band_height(needed, height)
        low = min(banded(i) for face in kept for i in face)
        vertices, faces, _shells = _solid(out_points, kept, banded, low - self.bottom_z, flat=True)
        return vertices, faces

    def _top(self, x: float, y: float, minimum_ground=None, drop=0.0) -> float:
        """Support top: the structure's grade less the offset, above the base."""
        top = max(
            self.structure_heightfield.height_mm(x, y) - self.top_offset_mm - drop,
            self.bottom_z + SUPPORT_MINIMUM_THICKNESS_MM,
        )
        if minimum_ground is not None:
            top = max(top, minimum_ground - self.top_offset_mm)
        return top

    def footprint(self, rings: Sequence[Ring], kind: str, *, minimum_ground=None) -> bool:
        """Add a pedestal under a polygon (outer ring first, then holes)."""
        if not rings or len(rings[0]) < 3:
            return False
        if abs(signed_area(rings[0])) < self.minimum_area_mm2:
            return False
        sunk = kind == 'bridge_causeway'
        water_minimum = self.minimum_ground(rings, kind)
        if sunk:
            minimum_ground = None
        elif water_minimum is not None:
            minimum_ground = max(water_minimum, minimum_ground) if minimum_ground is not None else water_minimum
        footprint_key = (sunk, minimum_ground,
                         tuple(tuple(tuple(point) for point in ring) for ring in rings))
        known = footprint_key in self._grounded_footprints
        # Point-in-polygon tests exclude some boundary edges, so an identical
        # footprint must not appear unsupported along its own outline.
        needs_lift = (minimum_ground is not None and self.structure_heightfield.minimum_over(
            point for ring in rings for point in densify_ring(ring, self.drape_spacing_mm)
        ) < minimum_ground - 1.0e-6)
        built = None
        if not known and (needs_lift or self._near_missing_ground(rings)):
            # A causeway across cut water is lowered as a whole, not per
            # vertex: switching at the shoreline would ramp its top up out of
            # the water. The part on land stays buried under the bank.
            mask = self.heightfield.void_mask
            drop = CUT_WATER_DROP_MM if sunk and mask is not None and mask.touches_water(rings) else 0.0
            built = self._trimmed(rings, lambda x, y: self._top(x, y, minimum_ground, drop))
        if built is None:
            # Even without another solid, this footprint is usable ground.
            # Bridge piers use has_ground(), whose conservative shoreline-cell
            # test needs this registration to recognize a dry quay/deck.
            if not known and self.heightfield.void_mask is not None:
                self.heightfield.add_support(rings)
                self._grounded_footprints.add(footprint_key)
            self.already_grounded += 1
            return False
        if not self.builder.add_raw(*built):
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
            "terrain_support_buried_area_skipped_mm2": round(self.buried_area_mm2, 2),
        }
