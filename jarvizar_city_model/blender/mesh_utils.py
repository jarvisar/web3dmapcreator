"""Watertight mesh construction helpers.

Every generator funnels through :class:`MeshBuilder`, which accumulates closed
prisms and emits a single Blender object.  Batching matters: a dense city
selection produces tens of thousands of road ribbons and trees, and one Blender
object per ribbon makes both generation and later scene interaction far slower
than the geometry itself warrants.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import bpy
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

from ..data.geojson import geometry_polygons
from ..geometry.planar import (
    EPSILON,
    clean_ring,
    clip_ring_to_rectangle,
    ear_clip,
    orient_faces_outward,
    oriented_ring,
    refine_triangles,
    signed_area,
)
from ..geometry.roofs import apex_solid_geometry
from ..geometry.tree_geometry import tree_solid_geometry


# Re-exported for callers that historically imported these from this module.
_signed_area = signed_area
_clean_ring = clean_ring
_oriented_ring = oriented_ring
_clip_ring_to_rectangle = clip_ring_to_rectangle

# A prism ring vertex carries its own bottom and top height so a single ribbon
# or polygon can follow terrain instead of being forced flat.
PrismVertex = Tuple[float, float, float, float]

# Cap refinement: the longest edge a cap triangle may keep, and the function
# that drapes each vertex inserted to achieve it, returning ``(bottom, top)``.
Refinement = Tuple[float, Callable[[float, float], Sequence[float]]]

# How far a triangulated cap may differ from its own outline's area before the
# solid is rejected as untrustworthy.  Legitimate concave footprints triangulate
# exactly; the slack only absorbs float32 rounding.
TESSELLATION_AREA_TOLERANCE = 0.01

# A cap triangle thinner than this in XY carries no shape.  It is one micron at
# model scale, forty times finer than a 0.4 mm nozzle, so discarding it costs
# nothing printable while removing the sliver triangles that a near-collinear
# run of densified vertices provokes.
CAP_SLIVER_THICKNESS_MM = 1.0e-3


def _triangle_face(indices, vertices, upward: bool):
    a, b, c = indices
    ax, ay, _ = vertices[a]
    bx, by, _ = vertices[b]
    cx, cy, _ = vertices[c]
    is_upward = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0.0
    if is_upward != upward:
        return c, b, a
    return a, b, c


def _triangle_thickness(a: PrismVertex, b: PrismVertex, c: PrismVertex) -> float:
    """Return a triangle's smallest XY altitude: twice its area over its base."""
    longest = max(
        math.dist((a[0], a[1]), (b[0], b[1])),
        math.dist((b[0], b[1]), (c[0], c[1])),
        math.dist((c[0], c[1]), (a[0], a[1])),
    )
    if longest <= 0.0:
        return 0.0
    area = abs(
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    ) * 0.5
    return 2.0 * area / longest


def _tessellate_rings(
    rings: Sequence[Sequence[PrismVertex]],
) -> Tuple[List[PrismVertex], List[Tuple[int, int, int]]]:
    """Triangulate ring outlines in XY, as flat indices into the joined rings.

    ``tessellate_polygon`` returns either vertex indices or points depending on
    the input, so both forms are normalised here into index triples that the
    caller can rely on.

    Near-zero-area triangles are kept.  Around a hole the triangulator reaches
    the inner ring through a deliberately degenerate channel, and those
    triangles are the only thing joining the cap together; on a draped surface
    a flat-in-plan triangle still carries real extent in Z.
    """
    flat: List[PrismVertex] = [vertex for ring in rings for vertex in ring]
    if len(flat) < 3:
        return [], []
    loops = [[Vector((x, y, 0.0)) for x, y, _bottom, _top in ring] for ring in rings]
    try:
        raw = tessellate_polygon(loops)
    except Exception:
        return [], []
    if not raw:
        return [], []

    lookup: Dict[Tuple[float, float], int] = {}
    for index, vertex in enumerate(flat):
        lookup.setdefault((float(vertex[0]), float(vertex[1])), index)

    triangles: List[Tuple[int, int, int]] = []
    # A degenerate hole channel can be emitted twice.  Blender's mesh validation
    # then removes one copy, which quietly turns a shared edge into a boundary
    # edge and opens the solid, so duplicates are dropped here where the
    # consequences are still visible.
    seen: set = set()
    for triangle in raw:
        if len(triangle) != 3:
            continue
        if isinstance(triangle[0], int):
            indices = tuple(int(index) for index in triangle)
        else:
            indices = tuple(
                lookup.get((float(point.x), float(point.y)), -1) for point in triangle
            )
        if any(index < 0 or index >= len(flat) for index in indices):
            continue
        if len(set(indices)) != 3:
            continue
        key = tuple(sorted(indices))
        if key in seen:
            continue
        seen.add(key)
        triangles.append(indices)
    return flat, triangles


def _build_solid(
    flat: Sequence[PrismVertex],
    triangles: Sequence[Tuple[int, int, int]],
    rings: Sequence[Sequence[PrismVertex]],
):
    """Turn a triangulated outline into a closed prism, or return ``None``.

    The side walls are built from the *cap's own boundary*, never from the ring
    sequence.  That is what keeps the solid closed: a triangulator may span a
    run of vertices however it likes, and a wall built from the ring would then
    disagree with the cap above it and leave a hole in something this project
    promises is watertight.
    """
    if not triangles:
        return None

    used = sorted({index for triangle in triangles for index in triangle})
    remap = {old: position for position, old in enumerate(used)}
    vertices: List[Tuple[float, float, float]] = []
    for old in used:
        x, y, bottom_z, top_z = flat[old]
        vertices.append((x, y, bottom_z))
        vertices.append((x, y, top_z))

    faces: List[Tuple[int, ...]] = []
    shared: Dict[Tuple[int, int], int] = {}
    directed: List[Tuple[int, int]] = []
    for triangle in triangles:
        positions = tuple(remap[index] for index in triangle)
        top_face = _triangle_face(
            tuple(position * 2 + 1 for position in positions), vertices, upward=True
        )
        faces.append(top_face)
        faces.append(
            _triangle_face(
                tuple(index - 1 for index in top_face), vertices, upward=False
            )
        )
        wound = tuple((index - 1) // 2 for index in top_face)
        for offset in range(3):
            start, end = wound[offset], wound[(offset + 1) % 3]
            key = (start, end) if start < end else (end, start)
            shared[key] = shared.get(key, 0) + 1
            directed.append((start, end))

    for start, end in directed:
        key = (start, end) if start < end else (end, start)
        if shared[key] != 1:
            continue
        faces.append((start * 2, end * 2, end * 2 + 1, start * 2 + 1))

    # Assert what this module promises, directly: every edge of a closed solid
    # is shared by exactly two faces.  Checking the result beats reasoning
    # about the triangulator, which does return incomplete or self-overlapping
    # triangulations for awkward outlines.  Counting edges by direction costs
    # the same and answers a second question at once: two faces that share an
    # edge and traverse it the same way are wound against each other, which
    # the undirected count cannot see.
    edge_uses: Dict[Tuple[int, int], int] = {}
    for face in faces:
        count = len(face)
        for offset in range(count):
            key = (face[offset], face[(offset + 1) % count])
            edge_uses[key] = edge_uses.get(key, 0) + 1
    if not edge_uses:
        return None
    for (a, b), count in edge_uses.items():
        if count + edge_uses.get((b, a), 0) != 2:
            return None

    # A cap triangle with no area to speak of gets its winding from the sign of
    # float noise, and the full-size walls raised on its edges inherit it.  The
    # solid is still closed, so only the directions disagree; re-deriving them
    # by propagation from face to face costs nothing on the solids that were
    # already right.
    if any(count != 1 for count in edge_uses.values()):
        faces = orient_faces_outward(vertices, faces)

    # The cap must also cover the outline it came from, not merely close.  A
    # self-intersecting bow-tie ring, which Overture does publish, can
    # triangulate into overlapping triangles that are topologically sound but
    # look like a shard of building rather than a building.
    expected_area = abs(signed_area([(x, y) for x, y, _b, _t in rings[0]]))
    for hole in rings[1:]:
        expected_area -= abs(signed_area([(x, y) for x, y, _b, _t in hole]))
    triangulated = 0.0
    for triangle in triangles:
        a, b, c = (flat[index] for index in triangle)
        triangulated += abs(
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        ) * 0.5
    if expected_area > 0.0:
        if abs(triangulated - expected_area) / expected_area > TESSELLATION_AREA_TOLERANCE:
            return None

    return vertices, faces


def _prism_geometry(
    rings: Sequence[Sequence[PrismVertex]],
    refine: Optional[Refinement] = None,
) -> Tuple[List[Tuple[float, float, float]], List[Tuple[int, ...]]]:
    """Build a closed prism from an outer ring plus optional hole rings.

    Caps are tessellated from the rings projected to Z=0, so a draped,
    non-planar top still triangulates against its true horizontal outline.
    Blender's triangulator is tried first because it is fast and handles holes;
    when it returns something that will not close, a ring without holes is
    retried with ear clipping, which is slower but uses every vertex and cannot
    overlap itself.  Only if both fail is the solid rejected and counted.

    With *refine*, cap edges longer than the given spacing are split and the
    new vertices draped through the given function, so a wide slab follows
    the ground across its interior and not only along its outline.
    """
    flat, triangles = _tessellate_rings(rings)
    if refine is not None and triangles:
        flat, triangles = refine_triangles(flat, triangles, refine[0], refine[1])
    built = _build_solid(flat, triangles, rings)
    if built is not None:
        return built

    if len(rings) == 1:
        flat = list(rings[0])
        triangles = ear_clip(flat)
        if refine is not None and triangles:
            flat, triangles = refine_triangles(flat, triangles, refine[0], refine[1])
        built = _build_solid(flat, triangles, rings)
        if built is not None:
            return built
    return [], []


class MeshBuilder:
    """Accumulates closed solids and emits one Blender mesh object."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.vertices: List[Tuple[float, float, float]] = []
        self.faces: List[Tuple[int, ...]] = []
        # One material slot index per face, so one merged object can still
        # show its buildings and its building parts in their own colours.
        self.material_indices: List[int] = []
        self.solids = 0

    @property
    def is_empty(self) -> bool:
        return not self.vertices or not self.faces

    def add_raw(
        self,
        vertices: Sequence[Tuple[float, float, float]],
        faces: Sequence[Sequence[int]],
        material_index: int = 0,
    ) -> bool:
        """Append one closed solid; its vertices are never shared with another.

        Keeping every solid's vertices to itself is what lets thousands of
        them share one mesh and stay individually watertight: two buildings
        with a common wall would otherwise weld along it and put four faces
        on one edge.
        """
        if not vertices or not faces:
            return False
        offset = len(self.vertices)
        self.vertices.extend(tuple(float(value) for value in v) for v in vertices)
        self.faces.extend(tuple(index + offset for index in face) for face in faces)
        self.material_indices.extend([int(material_index)] * len(faces))
        self.solids += 1
        return True

    def add_prism(
        self,
        rings: Sequence[Sequence[PrismVertex]],
        refine: Optional[Refinement] = None,
        material_index: int = 0,
    ) -> bool:
        vertices, faces = _prism_geometry(rings, refine)
        if not vertices or not faces:
            return False
        return self.add_raw(vertices, faces, material_index)

    def add_flat_prism(
        self,
        ring: Sequence[Tuple[float, float]],
        bottom_z: float,
        top_z: float,
        holes: Sequence[Sequence[Tuple[float, float]]] = (),
        material_index: int = 0,
    ) -> bool:
        """Convenience wrapper for a constant-height prism."""
        rings = [[(x, y, bottom_z, top_z) for x, y in ring]]
        for hole in holes:
            rings.append([(x, y, bottom_z, top_z) for x, y in hole])
        return self.add_prism(rings, material_index=material_index)

    def add_prism_group(
        self,
        groups: Sequence[Sequence[Sequence[PrismVertex]]],
        material_index: int = 0,
    ) -> bool:
        """Add several prisms together, or none of them.

        The planar regions of a gabled or hipped roof only make sense as a set:
        one region rejected on its own would leave a wedge missing from the
        building, so every region is built first and nothing is committed
        unless all of them closed.
        """
        built = []
        for rings in groups:
            vertices, faces = _prism_geometry(rings)
            if not vertices or not faces:
                return False
            built.append((vertices, faces))
        for vertices, faces in built:
            self.add_raw(vertices, faces, material_index)
        return True

    def add_apex_solid(
        self,
        ring: Sequence[Tuple[float, float]],
        bottom_z: float | Callable[[float, float], float],
        wall_top_z: float,
        levels: Sequence[Tuple[Sequence[Tuple[float, float]], float]],
        apex: Tuple[float, float, float],
        material_index: int = 0,
    ) -> bool:
        """Add a prism that continues up through optional rings to one apex.

        *bottom_z* may be a function of ``(x, y)`` so the underside follows
        the ground under each outline vertex.
        """
        built = apex_solid_geometry(ring, bottom_z, wall_top_z, levels, apex)
        if built is None:
            return False
        return self.add_raw(built[0], built[1], material_index)

    def build(
        self,
        collection: bpy.types.Collection,
        material: bpy.types.Material | None = None,
        materials: Sequence[bpy.types.Material] | None = None,
    ) -> bpy.types.Object | None:
        """Emit the accumulated solids as one object, or ``None`` if empty.

        *materials* gives the slots that the per-face material indices refer
        to; *material* is the single-slot shorthand every generator used
        before merged objects needed two.
        """
        if self.is_empty:
            return None
        slots = list(materials) if materials else ([material] if material is not None else [])
        mesh = bpy.data.meshes.new(f"{self.name}_MESH")
        mesh["jarvizar_generated"] = True
        mesh.from_pydata(self.vertices, [], self.faces)
        for slot in slots:
            mesh.materials.append(slot)
        if len(slots) > 1 and len(mesh.polygons) == len(self.material_indices):
            mesh.polygons.foreach_set("material_index", self.material_indices)
        mesh.validate(clean_customdata=False)
        mesh.update(calc_edges=True)
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        obj["jarvizar_generated"] = True
        obj["solid_count"] = self.solids
        return obj


def projected_polygon_rings(
    geometry: Dict[str, Any],
    transform,
    clip: bool = True,
) -> List[List[List[Tuple[float, float]]]]:
    """Project GeoJSON polygons into model millimetres and clip to the frame.

    Returns a list of polygons, each a list of rings with the outer ring first.
    Holes that touch the clipped boundary are dropped rather than kept as an
    open notch, because a notched hole cannot close into a printable mesh.
    """
    model_bounds = transform.model_bounds
    polygons: List[List[List[Tuple[float, float]]]] = []
    for polygon in geometry_polygons(geometry):
        rings: List[List[Tuple[float, float]]] = []
        valid_outer = True
        for ring_index, source_ring in enumerate(polygon):
            projected = []
            for coordinate in source_ring:
                if not isinstance(coordinate, (list, tuple)) or len(coordinate) < 2:
                    continue
                x, y, _z = transform.geographic_to_model(
                    coordinate[0], coordinate[1], 0.0
                )
                projected.append((x, y))
            ring = oriented_ring(projected, counter_clockwise=ring_index == 0)
            if not ring:
                if ring_index == 0:
                    valid_outer = False
                    break
                continue
            if ring_index == 0:
                if clip:
                    ring = clip_ring_to_rectangle(
                        ring,
                        model_bounds.min_x_mm,
                        model_bounds.min_y_mm,
                        model_bounds.max_x_mm,
                        model_bounds.max_y_mm,
                    )
            elif clip and not all(
                model_bounds.min_x_mm + EPSILON < x < model_bounds.max_x_mm - EPSILON
                and model_bounds.min_y_mm + EPSILON < y < model_bounds.max_y_mm - EPSILON
                for x, y in ring
            ):
                continue
            ring = oriented_ring(ring, counter_clockwise=ring_index == 0)
            if ring:
                rings.append(ring)
            elif ring_index == 0:
                valid_outer = False
                break
        if valid_outer and rings:
            polygons.append(rings)
    return polygons


def create_extruded_geojson_object(
    name: str,
    geometry: Dict[str, Any],
    transform,
    bottom_m: float,
    height_m: float,
    collection: bpy.types.Collection,
    material: bpy.types.Material | None = None,
) -> bpy.types.Object | None:
    """Create one watertight mesh object from Polygon/MultiPolygon geometry."""
    builder = MeshBuilder(name)
    bottom_z = transform.vertical_meters_to_model_mm(bottom_m)
    top_z = transform.vertical_meters_to_model_mm(bottom_m + height_m)
    for rings in projected_polygon_rings(geometry, transform):
        builder.add_flat_prism(rings[0], bottom_z, top_z, rings[1:])
    return builder.build(collection, material)


def create_box_object(
    name: str,
    min_x: float,
    min_y: float,
    max_x: float,
    max_y: float,
    bottom_z: float,
    top_z: float,
    collection: bpy.types.Collection,
    material: bpy.types.Material | None = None,
) -> bpy.types.Object:
    vertices = [
        (min_x, min_y, bottom_z),
        (max_x, min_y, bottom_z),
        (max_x, max_y, bottom_z),
        (min_x, max_y, bottom_z),
        (min_x, min_y, top_z),
        (max_x, min_y, top_z),
        (max_x, max_y, top_z),
        (min_x, max_y, top_z),
    ]
    faces = [
        (3, 2, 1, 0),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    mesh = bpy.data.meshes.new(f"{name}_MESH")
    mesh["jarvizar_generated"] = True
    mesh.from_pydata(vertices, [], faces)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj["jarvizar_generated"] = True
    if material is not None:
        mesh.materials.append(material)
    return obj


def tree_mesh_datablock(
    name: str,
    canopy_radius_mm: float,
    height_mm: float,
    sides: int = 6,
    embed_mm: float = 0.0,
    *,
    reuse: bool = True,
) -> bpy.types.Mesh:
    """Reuse one layered tree mesh for linked objects of the same shape."""
    shape = (2, canopy_radius_mm, height_mm, sides, embed_mm)
    existing = bpy.data.meshes.get(name)
    if reuse and existing is not None and tuple(existing.get('tree_shape', ())) == shape:
        return existing
    vertices, faces = tree_solid_geometry(
        canopy_radius_mm, height_mm, sides, embed_mm,
    )
    mesh = bpy.data.meshes.new(name)
    mesh["jarvizar_generated"] = True
    mesh['tree_shape'] = shape
    mesh.from_pydata(vertices, [], faces)
    mesh.validate(clean_customdata=False)
    mesh.update(calc_edges=True)
    return mesh
