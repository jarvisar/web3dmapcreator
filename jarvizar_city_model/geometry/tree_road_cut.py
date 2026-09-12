"""Trim individual tree solids to the printed ground-road corridor."""

import bmesh
import bpy
from mathutils import Vector

from ..blender.mesh_utils import MeshBuilder
from .footprint_cut import FootprintIndex, _bounds, _hull, _overlap, _split, area_xy, fragment_solid
from .surface_priority import _road_outline_triangles
from .tree_geometry import tree_base_width, merge_convex_footprints
from .planar import EPSILON


# A small separation avoids coincident material boundaries after 3MF rounding.
# Cut the whole crown height: cutting only the road volume leaves foliage above
# the road, potentially disconnected from the tree's remaining foundation.
TREE_ROAD_CLEARANCE_MM = 0.005


class TreeRoadCutter:
    def __init__(self, roads):
        self.mask = FootprintIndex(clearance=TREE_ROAD_CLEARANCE_MM)
        if roads is not None:
            for obj in roads.objects:
                if obj.type == 'MESH' and obj.get('feature_type') == 'surface_road':
                    for triangle in _road_outline_triangles(obj.data):
                        self.mask.add([tuple(obj.matrix_world @ Vector((*p[:2], 0)))
                                       for p in triangle])

    def trim(self, vertices, faces, minimum_width):
        """Return geometry and whether it changed; preserve untouched trees exactly.

        Only nearby footprints enter each Boolean. Work near the tree origin to
        retain precision even for large models. Overlapping road pieces require
        Exact's self-intersection handling, including at path junctions.
        """
        if not self.mask.cutters:
            return vertices, faces, False
        bottom = min(p[2] for p in vertices)
        base = [p for p in vertices if abs(p[2] - bottom) < 1e-9]
        pieces = self.mask.difference(base)
        retained_area = sum(area_xy(p) for p in pieces)
        if area_xy(base) - retained_area <= 1e-9:
            return vertices, faces, False
        if not pieces:
            return [], [], True
        hull = _hull([tuple(p[:2]) for piece in pieces for p in piece])
        # Most roadside cuts leave one convex footprint. Its boundary can be
        # applied directly with capped planes, avoiding objects, modifiers and
        # dependency-graph evaluation. A split tree or concave road junction
        # has less area than this hull and stays on the bounded Boolean path.
        if abs(area_xy(hull)-retained_area) <= 1e-10:
            fast = self._clip_planes(vertices, faces, hull, bottom, minimum_width)
            if fast is not None:
                return *fast, True
        bounds = _bounds(base)
        candidates = set()
        for cell in self.mask._cells(bounds):
            candidates.update(self.mask.cells.get(cell, ()))
        x0, y0, x1, y1 = bounds
        origin = ((x0+x1)/2, (y0+y1)/2, bottom)
        top = max(p[2] for p in vertices)
        cutter_builder = MeshBuilder('_TREE_ROAD_CUTTER')
        cutter_rings = []
        for index in sorted(candidates):
            box, planes = self.mask.cutters[index]
            if not _overlap(bounds, box):
                continue
            intersection = base
            for plane in planes:
                intersection, _ = _split(intersection, plane)
                if len(intersection) < 3:
                    break
            if len(intersection) < 3 or area_xy(intersection) <= 1e-12:
                continue
            ring = [(x0-1, y0-1), (x1+1, y0-1), (x1+1, y1+1), (x0-1, y1+1)]
            for plane in planes:
                ring, _ = _split(ring, plane)
                if len(ring) < 3:
                    break
            if len(ring) >= 3 and area_xy(ring) > 1e-12:
                cutter_rings.append(ring)
        cutter_rings = merge_convex_footprints(cutter_rings)
        for ring in cutter_rings:
            cutter_builder.add_raw(*fragment_solid(
                [(x-origin[0], y-origin[1], top-bottom+1) for x, y in ring], top-bottom+2))
        objects, meshes = [], []
        # Keep the Boolean dependency graph limited to these two tiny objects.
        # Evaluating it in a whole city repeatedly reevaluates large road and
        # terrain meshes and dominates the cost of otherwise local tree cuts.
        scene = bpy.data.scenes.new('_TREE_ROAD_BOOLEAN')
        try:
            cutter = cutter_builder.build(scene.collection)
            if cutter is None:
                raise ValueError('Could not construct tree road clearance')
            objects.append(cutter)
            meshes.append(cutter.data)
            tree_builder = MeshBuilder('_TREE_ROAD_WORK')
            tree_builder.add_raw([tuple(p[i]-origin[i] for i in range(3)) for p in vertices], faces)
            work = tree_builder.build(scene.collection)
            objects.append(work)
            meshes.append(work.data)
            modifier = work.modifiers.new('Road clearance', 'BOOLEAN')
            modifier.operation = 'DIFFERENCE'
            modifier.solver = 'EXACT'
            modifier.use_self = len(cutter_rings) > 1
            modifier.object = cutter
            with bpy.context.temp_override(scene=scene, view_layer=scene.view_layers[0]):
                evaluated = work.evaluated_get(bpy.context.evaluated_depsgraph_get())
                result = bpy.data.meshes.new_from_object(evaluated)
            meshes.append(result)
            bm = bmesh.new()
            try:
                bm.from_mesh(result)
                return *self._finish(bm, origin, minimum_width), True
            finally:
                bm.free()
        finally:
            for obj in reversed(objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            for mesh in reversed(meshes):
                if mesh.users == 0:
                    bpy.data.meshes.remove(mesh)
            bpy.data.scenes.remove(scene)

    @staticmethod
    def _finish(bm, origin, minimum_width):
        if any(not e.is_manifold or not e.is_contiguous for e in bm.edges):
            raise ValueError('Tree road trimming did not produce closed, consistently wound solids')
        # Every surviving shell must have a printable contact with the base.
        pending = set(bm.verts)
        while pending:
            seed = pending.pop()
            shell, stack = {seed}, [seed]
            while stack:
                for edge in stack.pop().link_edges:
                    for vertex in edge.verts:
                        if vertex in pending:
                            pending.remove(vertex)
                            shell.add(vertex)
                            stack.append(vertex)
            contact = [tuple(v.co[:2]) for v in shell if abs(v.co.z) < 1e-5]
            if len(contact) < 3 or tree_base_width(contact) < max(1e-4, minimum_width) - 1e-5:
                bmesh.ops.delete(bm, geom=list(shell), context='VERTS')
        # Quantize at the final model coordinates before checking tiny edges.
        # Float32 storage can collapse a local Boolean's near-tangent slivers.
        # Dissolve only connected degeneracies within this tree, never weld
        # nearby independent shells or trees by coordinate.
        for vertex in bm.verts:
            vertex.co = tuple(vertex.co[i]+origin[i] for i in range(3))
        if any(f.calc_area() == 0 for f in bm.faces) or any(e.calc_length() < EPSILON for e in bm.edges):
            bmesh.ops.dissolve_degenerate(bm, dist=EPSILON, edges=list(bm.edges))
        if (any(not e.is_manifold or not e.is_contiguous for e in bm.edges)
                or any(f.calc_area() == 0 for f in bm.faces)):
            raise ValueError('Tree road trimming lost closed geometry at model precision')
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        return ([tuple(v.co) for v in bm.verts],
                [tuple(v.index for v in f.verts) for f in bm.faces])

    def _clip_planes(self, vertices, faces, ring, bottom, minimum_width):
        origin = (ring[0][0], ring[0][1], bottom)
        bm = bmesh.new()
        try:
            verts = [bm.verts.new(tuple(p[i]-origin[i] for i in range(3))) for p in vertices]
            for face in faces:
                bm.faces.new([verts[i] for i in face])
            for a, b in zip(ring, ring[1:]+ring[:1]):
                dx, dy = b[0]-a[0], b[1]-a[1]
                # The retained hull also includes original crown edges. Test
                # these in double precision before BMesh's float conversion;
                # shaving a coincident original edge creates zero-width faces.
                if all(dy*(p[0]-a[0])-dx*(p[1]-a[1]) <= 1e-9 for p in vertices):
                    continue
                point = Vector((a[0]-origin[0], a[1]-origin[1], 0))
                normal = Vector((b[1]-a[1], a[0]-b[0], 0)).normalized()
                if all((v.co-point).dot(normal) <= 1e-7 for v in bm.verts):
                    continue
                bmesh.ops.bisect_plane(bm, geom=list(bm.verts)+list(bm.edges)+list(bm.faces),
                                       dist=1e-7, plane_co=point, plane_no=normal,
                                       clear_outer=True, clear_inner=False)
                edges = [e for e in bm.edges if e.is_boundary]
                if edges:
                    bmesh.ops.holes_fill(bm, edges=edges, sides=0)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            return self._finish(bm, origin, minimum_width)
        except (ValueError, RuntimeError):
            # Unexpected plane topology retries the original tree with Exact.
            return None
        finally:
            bm.free()
