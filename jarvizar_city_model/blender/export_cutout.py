"""Temporary, shell-aware export cropping against a frame's through opening.

Convex openings (including rectangles) use linear BMesh plane cuts. Only
crossing shells are cut; separate/overlapping map solids must never be welded
or filled together. Concave openings use an opening prism, one crossing shell
at a time, with Boolean self intersection disabled.
"""

from collections import Counter, defaultdict
from contextlib import contextmanager
from itertools import product
import math
import time

import bpy
import bmesh
from mathutils import Matrix, Vector

from ..geometry.planar import ear_clip, point_in_ring, signed_area
from .mesh_utils import _prism_geometry


class CutoutError(ValueError):
    pass


def _geometry(bm):
    return list(bm.verts) + list(bm.edges) + list(bm.faces)


def _edge_loops(edges):
    adjacency = defaultdict(list)
    for edge in edges:
        a, b = edge.verts
        adjacency[a].append(b)
        adjacency[b].append(a)
    if not adjacency or any(len(v) != 2 for v in adjacency.values()):
        raise CutoutError("cutout must have a closed, unambiguous inner opening")
    pending = set(adjacency)
    loops = []
    while pending:
        start = next(iter(pending))
        loop, previous, current = [], None, start
        while current in pending:
            pending.remove(current)
            loop.append(current)
            following = adjacency[current]
            previous, current = current, following[0] if following[0] != previous else following[1]
        if current != start:
            raise CutoutError("cutout contains a branching opening")
        loops.append(loop)
    return loops


def _loops(edges):
    return [[(v.co.x, v.co.y) for v in loop] for loop in _edge_loops(edges)]


def _simplify(ring, tolerance):
    """Remove only collinear section vertices, including triangulated STL seams."""
    ring = list(ring)
    changed = True
    while changed and len(ring) > 3:
        changed = False
        for i, b in enumerate(ring):
            a, c = ring[i - 1], ring[(i + 1) % len(ring)]
            dx, dy = c[0] - a[0], c[1] - a[1]
            length = math.hypot(dx, dy)
            if length and abs(dx * (b[1] - a[1]) - dy * (b[0] - a[0])) <= tolerance * length:
                if (b[0] - a[0]) * (b[0] - c[0]) + (b[1] - a[1]) * (b[1] - c[1]) <= tolerance ** 2:
                    ring.pop(i)
                    changed = True
                    break
    if signed_area(ring) < 0:
        ring.reverse()
    return ring


def _section(bm, z, tolerance):
    section = bm.copy()
    try:
        result = bmesh.ops.bisect_plane(section, geom=_geometry(section), dist=tolerance * 0.01,
                                       plane_co=(0, 0, z), plane_no=(0, 0, 1))
        edges = [e for e in result['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
        rings = [_simplify(r, tolerance) for r in _loops(edges)]
        # A ring is an opening only when nested inside the frame's outer ring.
        holes = [r for r in rings if sum(point_in_ring(r[0], other)
                                        for other in rings if other is not r) % 2]
        if len(holes) != 1:
            raise CutoutError("cutout must contain exactly one closed inner opening")
        return holes[0]
    finally:
        section.free()


class Opening:
    def __init__(self, ring, matrix_world, tolerance):
        self.ring = ring
        self.matrix_world = matrix_world
        self.inverse = matrix_world.inverted()
        self.tolerance = tolerance
        self.planes = []
        for a, b in zip(ring, ring[1:] + ring[:1]):
            normal = Vector((b[1] - a[1], a[0] - b[0], 0)).normalized()
            self.planes.append((Vector((*a, 0)), normal))
        self.convex = all((Vector((*p, 0)) - co).dot(no) <= tolerance
                          for co, no in self.planes for p in ring)

    @classmethod
    def from_object(cls, obj, depsgraph):
        if obj.type != 'MESH':
            raise CutoutError("cutout must be a mesh frame with a closed inner opening")
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        bm = bmesh.new()
        try:
            bm.from_mesh(mesh)
            if not bm.faces:
                raise CutoutError("cutout has no frame faces")
            # Aggregate cap triangles, so triangulated imports and applied
            # rotations work just as well as a frame made from quads.
            directions = defaultdict(float)
            normals = {}
            for face in bm.faces:
                n = face.normal.copy()
                axis = max(range(3), key=lambda i: abs(n[i]))
                if n[axis] < 0:
                    n.negate()
                key = tuple(round(v, 5) for v in n)
                directions[key] += face.calc_area()
                normals[key] = n
            normal = normals[max(directions, key=directions.get)]
            u = Vector((1, 0, 0))
            if abs(normal.dot(u)) > 0.9:
                u = Vector((0, 1, 0))
            u = (u - normal * u.dot(normal)).normalized()
            v = normal.cross(u)
            basis = Matrix((u, v, normal)).transposed().to_4x4()
            # Centre before cutting to retain precision in imported meshes.
            basis.translation = sum((v.co for v in bm.verts), Vector()) / len(bm.verts)
            bm.transform(basis.inverted())
            lo = [min(v.co[i] for v in bm.verts) for i in range(3)]
            hi = [max(v.co[i] for v in bm.verts) for i in range(3)]
            tolerance = max(hi[i] - lo[i] for i in range(3)) * 1e-7
            if tolerance <= 0 or hi[2] - lo[2] <= tolerance:
                raise CutoutError("cutout must be a solid frame with nonzero thickness")
            bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=tolerance)
            # Sample either side of every profile change. This includes the
            # narrow part of bevelled/tapered openings, not the flared mouth.
            levels = sorted({round(vertex.co.z / tolerance) * tolerance for vertex in bm.verts})
            samples = []
            for low, high in zip(levels, levels[1:]):
                if high - low > tolerance * 4:
                    samples.extend((low + tolerance * 2, (low + high) / 2, high - tolerance * 2))
            if not samples or len(samples) > 192:
                raise CutoutError("cutout needs a planar frame with a consistent through opening")
            ring = None
            for z in samples:
                candidate = _section(bm, z, tolerance * 4)
                if ring is None:
                    ring = candidate
                    continue
                # Nested profiles (e.g. bevels) have a single restrictive
                # opening. Do not guess at incompatible/twisted profiles.
                a = cls(ring, Matrix.Identity(4), tolerance * 8)
                b = cls(candidate, Matrix.Identity(4), tolerance * 8)
                if all(a.contains(p) for p in candidate):
                    ring = candidate
                elif not all(b.contains(p) for p in ring):
                    raise CutoutError("cutout's opening changes shape through its thickness")
            world = evaluated.matrix_world @ basis
            if abs(world.to_3x3().determinant()) < 1e-15:
                raise CutoutError("cutout has a zero scale")
            return cls(ring, world, tolerance * 8)
        finally:
            bm.free()
            evaluated.to_mesh_clear()

    def contains(self, point):
        x, y = point[:2]
        if self.convex:
            return all((Vector((x, y, 0)) - co).dot(no) <= self.tolerance for co, no in self.planes)
        if point_in_ring((x, y), self.ring):
            return True
        for i, (co, no) in enumerate(self.planes):
            if abs((Vector((x, y, 0)) - co).dot(no)) <= self.tolerance:
                a, b = self.ring[i], self.ring[(i + 1) % len(self.ring)]
                if min(a[0], b[0]) - self.tolerance <= x <= max(a[0], b[0]) + self.tolerance and min(a[1], b[1]) - self.tolerance <= y <= max(a[1], b[1]) + self.tolerance:
                    return True
        return False

    def classify(self, corners, transform):
        points = [transform @ Vector(p) for p in corners]
        if self.convex:
            inside = True
            for co, no in self.planes:
                distances = [(p - co).dot(no) for p in points]
                if min(distances) > self.tolerance:
                    return 'OUTSIDE'
                if max(distances) > 0:
                    inside = False
            return 'INSIDE' if inside else 'CROSSING'
        # A conservative rectangle in opening space also catches a concavity
        # crossing a box whose eight corners all happen to be inside.
        x0, y0 = min(p.x for p in points), min(p.y for p in points)
        x1, y1 = max(p.x for p in points), max(p.y for p in points)
        t = self.tolerance
        for a, b in zip(self.ring, self.ring[1:] + self.ring[:1]):
            if max(a[0], b[0]) >= x0 - t and min(a[0], b[0]) <= x1 + t and max(a[1], b[1]) >= y0 - t and min(a[1], b[1]) <= y1 + t:
                return 'CROSSING'
        return 'INSIDE' if self.contains((x0, y0)) else 'OUTSIDE'


def _shells(bm):
    # Keep only seed references, not every shell's full edge/face sets. The
    # caller may delete this shell or append a concave intersection result.
    # BMesh operations reuse .tag, so it cannot store traversal state here.
    pending = set(bm.verts)
    while pending:
        start = pending.pop()
        vertices, edges, faces = [], set(), set()
        stack = [start]
        while stack:
            vertex = stack.pop()
            vertices.append(vertex)
            faces.update(vertex.link_faces)
            for edge in vertex.link_edges:
                edges.add(edge)
                other = edge.other_vert(vertex)
                if other in pending:
                    pending.remove(other)
                    stack.append(other)
        yield vertices, list(edges), list(faces)


def _corners(vertices):
    return list(product(*[(min(v.co[i] for v in vertices), max(v.co[i] for v in vertices))
                          for i in range(3)]))


def _fill_section(bm, edges, normal):
    """Triangulate with holes, then restore collinear contour subdivisions.

    Blender's scan fill may omit collinear vertices. Split its spanning cap
    triangle at those *existing* wall vertices, avoiding both T-junctions and
    zero-area filler triangles. Never weld different source shells.
    """
    result = bmesh.ops.triangle_fill(bm, edges=edges, normal=normal, use_beauty=False)
    caps = {f for f in result['geom'] if isinstance(f, bmesh.types.BMFace)}
    used = {v for f in caps for v in f.verts}
    adjacency = defaultdict(list)
    for edge in edges:
        a, b = edge.verts
        adjacency[a].append(b)
        adjacency[b].append(a)
    if any(len(neighbors) != 2 for neighbors in adjacency.values()):
        raise CutoutError("The new cut boundary branches or touches itself")
    visited = set()
    for start in used:
        for next_vertex in adjacency.get(start, ()):
            if next_vertex in used or next_vertex in visited:
                continue
            chain = [start, next_vertex]
            while chain[-1] not in used:
                visited.add(chain[-1])
                neighbors = adjacency[chain[-1]]
                chain.append(neighbors[0] if neighbors[0] != chain[-2] else neighbors[1])
            edge = bm.edges.get((chain[0], chain[-1]))
            face = next((f for f in edge.link_faces if f in caps), None) if edge else None
            if face is None or len(face.verts) != 3:
                raise CutoutError("Could not preserve vertices along the new cut cap")
            opposite = next(v for v in face.verts if v not in (chain[0], chain[-1]))
            caps.remove(face)
            bm.faces.remove(face)
            if not edge.link_faces:
                bm.edges.remove(edge)
            for a, b in zip(chain, chain[1:]):
                caps.add(bm.faces.new((a, b, opposite)))
    cap_edges = {e for f in caps for e in f.edges}
    if any(len(e.link_faces) != 2 for e in cap_edges | set(edges)):
        # Scan fill can also overlap itself on almost-collinear contours. The
        # existing double-precision ear clipper preserves every boundary vertex.
        # Use it only when needed: quadratic work on long terrain sections is
        # otherwise needless, and independent hole loops must not be filled in.
        for face in caps:
            bm.faces.remove(face)
        for edge in cap_edges:
            if edge.is_valid and not edge.link_faces:
                bm.edges.remove(edge)
        loops = _edge_loops(edges)
        axis = max(range(3), key=lambda i: abs(normal[i]))
        axes = [i for i in range(3) if i != axis]
        projected = [[(float(v.co[axes[0]]), float(v.co[axes[1]])) for v in loop] for loop in loops]
        if any(point_in_ring(r[0], other) for r in projected for other in projected if other is not r):
            raise CutoutError("Could not triangulate the cut cap's inner holes")
        caps = set()
        for loop, points in zip(loops, projected):
            triangles = ear_clip(points)
            if len(triangles) != len(loop) - 2:
                raise CutoutError("Could not triangulate the cut cap without overlaps")
            for triangle in triangles:
                caps.add(bm.faces.new([loop[i] for i in triangle]))
    return list(caps)


def _clip_convex(bm, geom, opening, transform):
    """Cut one closed shell and fill all its section loops together (holes)."""
    inverse = transform.inverted()
    for co, no in opening.planes:
        plane_co = inverse @ co
        plane_no = transform.to_3x3().transposed() @ no
        length = plane_no.length
        plane_no.normalize()
        vertices = [e for e in geom if isinstance(e, bmesh.types.BMVert)]
        if not vertices:
            return
        distances = [(v.co - plane_co).dot(plane_no) for v in vertices]
        if max(distances) <= 0:
            continue
        if min(distances) >= 0:
            bmesh.ops.delete(bm, geom=vertices, context='VERTS')
            return
        tolerance = opening.tolerance / length
        # Snap only vertices belonging to this crossing shell. Plane cuts use
        # zero distance afterwards so retained vertices never protrude outside.
        for vertex, distance in zip(vertices, distances):
            if abs(distance) <= tolerance:
                vertex.co -= distance * plane_no
        result = bmesh.ops.bisect_plane(bm, geom=geom, dist=0,
                                       plane_co=plane_co, plane_no=plane_no, clear_outer=True)
        geom = result['geom']
        cut_vertices = [v for v in result['geom_cut'] if isinstance(v, bmesh.types.BMVert)]
        for vertex in cut_vertices:
            vertex.co -= (vertex.co - plane_co).dot(plane_no) * plane_no
        bmesh.ops.remove_doubles(bm, verts=cut_vertices, dist=tolerance)
        remaining = {v for v in geom if v.is_valid and isinstance(v, bmesh.types.BMVert)}
        geom = list(remaining) + list({e for v in remaining for e in v.link_edges}) + list({f for v in remaining for f in v.link_faces})
        edges = [e for e in geom if isinstance(e, bmesh.types.BMEdge) and e.is_boundary]
        if edges:
            material = Counter(e.link_faces[0].material_index for e in edges).most_common(1)[0][0]
            caps = _fill_section(bm, edges, plane_no)
            for face in caps:
                face.material_index = material
            geom += caps + list({e for f in caps for e in f.edges})
            # Orient only new caps by propagation from their existing walls.
            pending = set(caps)
            while pending:
                advanced = False
                for face in list(pending):
                    for loop in face.loops:
                        other = loop.link_loop_radial_next
                        if other.face != face and other.face not in pending:
                            if loop.vert == other.vert:
                                face.normal_flip()
                            pending.remove(face)
                            advanced = True
                            break
                if not advanced:
                    raise CutoutError("Could not orient a cut cap")
        geom = list({e for e in geom if e.is_valid})
        if any(not e.is_manifold or not e.is_contiguous for e in geom if isinstance(e, bmesh.types.BMEdge)):
            raise CutoutError("A cut boundary could not be capped as a closed solid")


def _clip_concave(bm, vertices, edges, faces, opening, transform, collection, materials):
    """Bounded fallback: intersect an individual shell with the opening volume."""
    objects, meshes = [], []
    try:
        local = [transform @ v.co for v in vertices]
        z0, z1 = min(p.z for p in local), max(p.z for p in local)
        margin = max(z1 - z0, opening.tolerance * 100)
        geometry = _prism_geometry([[(x, y, z0 - margin, z1 + margin) for x, y in opening.ring]])
        if not geometry[1]:
            raise CutoutError("Could not build the concave cutout's opening volume")
        cutter_mesh = bpy.data.meshes.new('_CUTOUT_VOLUME')
        meshes.append(cutter_mesh)
        inverse = transform.inverted()
        cutter_mesh.from_pydata([inverse @ Vector(v) for v in geometry[0]], [], geometry[1])
        cutter = bpy.data.objects.new('_CUTOUT_VOLUME', cutter_mesh)
        objects.append(cutter)
        collection.objects.link(cutter)
        work_mesh = bpy.data.meshes.new('_CUTOUT_SHELL')
        meshes.append(work_mesh)
        indices = {v: i for i, v in enumerate(vertices)}
        work_mesh.from_pydata([v.co[:] for v in vertices], [], [[indices[v] for v in f.verts] for f in faces])
        for material in materials:
            work_mesh.materials.append(material)
        for dest, source in zip(work_mesh.polygons, faces):
            dest.material_index = source.material_index
        work = bpy.data.objects.new('_CUTOUT_SHELL', work_mesh)
        objects.append(work)
        collection.objects.link(work)
        modifier = work.modifiers.new('Opening intersection', 'BOOLEAN')
        modifier.operation = 'INTERSECT'
        modifier.solver = 'EXACT'
        modifier.use_self = False
        modifier.object = cutter
        bpy.context.view_layer.update()
        evaluated = work.evaluated_get(bpy.context.evaluated_depsgraph_get())
        result = bpy.data.meshes.new_from_object(evaluated)
        meshes.append(result)
        check = bmesh.new()
        try:
            check.from_mesh(result)
            if any(not e.is_manifold or not e.is_contiguous for e in check.edges):
                raise CutoutError("Concave cutout intersection did not produce a closed solid")
            if any(not opening.contains(transform @ v.co) for v in check.verts):
                raise CutoutError("Concave cutout intersection left geometry outside the opening")
        finally:
            check.free()
        bmesh.ops.delete(bm, geom=vertices, context='VERTS')
        bm.from_mesh(result)
    finally:
        for obj in reversed(objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        for mesh in reversed(meshes):
            if mesh.users == 0:
                bpy.data.meshes.remove(mesh)


def clip_mesh(mesh, matrix_world, opening, collection, stats):
    transform = opening.inverse @ matrix_world
    bm = bmesh.new()
    additions = []
    try:
        bm.from_mesh(mesh)
        removed = []
        for vertices, edges, faces in _shells(bm):
            state = opening.classify(_corners(vertices), transform)
            if not faces:
                state = 'OUTSIDE'
            stats[state.lower() + '_shells'] += 1
            if state == 'OUTSIDE':
                removed.extend(vertices)
            elif state == 'CROSSING':
                if any(not e.is_manifold or not e.is_contiguous for e in edges):
                    raise CutoutError("Boundary-crossing source geometry is not a closed, consistently wound solid")
                # BMesh operator setup scans its entire mesh, even when geom
                # names only one shell. Isolate crossing shells first or many
                # tiny cuts/deletions become quadratic on merged city objects.
                work = bmesh.new()
                try:
                    copied = {v: work.verts.new(v.co) for v in vertices}
                    for face in faces:
                        copy = work.faces.new([copied[v] for v in face.verts])
                        copy.material_index = face.material_index
                        copy.smooth = face.smooth
                    if opening.convex:
                        _clip_convex(work, _geometry(work), opening, transform)
                    else:
                        _clip_concave(work, list(work.verts), list(work.edges), list(work.faces),
                                      opening, transform, collection, mesh.materials)
                    if work.faces:
                        addition = bpy.data.meshes.new('_CUTOUT_RESULT')
                        additions.append(addition)
                        work.to_mesh(addition)
                finally:
                    work.free()
                removed.extend(vertices)
        if removed:
            bmesh.ops.delete(bm, geom=removed, context='VERTS')
        for addition in additions:
            bm.from_mesh(addition)
        bm.to_mesh(mesh)
        mesh.update()
    finally:
        bm.free()
        for addition in additions:
            bpy.data.meshes.remove(addition)


@contextmanager
def export_geometry(context, sources):
    """Yield export-only objects; evaluated meshes and helpers have one owner."""
    temporary, meshes = [], []
    stats = defaultdict(int)
    try:
        depsgraph = context.evaluated_depsgraph_get()
        cutout = context.scene.objects.get('cutout')
        opening = Opening.from_object(cutout, depsgraph) if cutout is not None else None
        for source in sources:
            if source == cutout:
                continue
            evaluated = source.evaluated_get(depsgraph)
            state = opening.classify(evaluated.bound_box, opening.inverse @ evaluated.matrix_world) if opening else 'INSIDE'
            stats[state.lower() + '_objects'] += 1
            if state == 'OUTSIDE':
                continue
            # Copies preserve custom metadata and object-linked material slots.
            # Bake evaluation only when cutting; inside meshes stay shared.
            obj = source.copy()
            temporary.append(obj)
            obj.parent = None
            obj.matrix_world = evaluated.matrix_world.copy()
            obj.animation_data_clear()
            obj.constraints.clear()
            obj.hide_viewport = False
            obj.hide_select = False
            if state == 'CROSSING':
                started = time.perf_counter()
                mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
                meshes.append(mesh)
                obj.data = mesh
                obj.modifiers.clear()
                try:
                    clip_mesh(mesh, obj.matrix_world, opening, context.scene.collection, stats)
                except CutoutError as exc:
                    raise CutoutError(f"{source.name}: {exc}") from exc
                print(f"3MF crop {source.name}: {len(mesh.polygons):,} faces, "
                      f"{time.perf_counter() - started:.2f} s", flush=True)
                if not mesh.polygons:
                    bpy.data.objects.remove(obj, do_unlink=True)
                    temporary.pop()
                    continue
            context.scene.collection.objects.link(obj)
        yield temporary, stats, opening
    finally:
        for obj in reversed(temporary):
            bpy.data.objects.remove(obj, do_unlink=True)
        for mesh in meshes:
            if mesh.users == 0:
                bpy.data.meshes.remove(mesh)
