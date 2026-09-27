"""Resolve landcover overlap and cut ground-road footprints from its slabs."""

import bpy
import math
from array import array
from collections import defaultdict

from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform, delaunay_2d_cdt

from ..blender.collections import GENERATED_KEY
from ..data.land import DEFAULT_SURFACE_PRIORITY
from .footprint_cut import area_xy
from .planar import EPSILON, clean_ring, densify_ring, ear_clip


ROAD_SURFACE_CLEARANCE_MM = 0.005
# Generate left these slabs whole under the ground roads; Export cuts the
# roads there are then from its copies (cut_roads_at_export).
ROAD_CUT_AT_EXPORT_KEY = 'road_cut_at_export'
# A cut edge gets vertices at the slab drape spacing, so a long straight road
# or bank edge still follows the ground instead of bridging a slope.
CUT_EDGE_SPACING_MM = 1.5
# Below the geometry epsilon, so cutter clearances survive the triangulation.
_CDT_EPSILON = EPSILON * .1


def cut_surface_overlaps(surface_collection, thickness, priority_order=DEFAULT_SURFACE_PRIORITY,
                         progress_callback=None):
    """Make different surface categories exclusive, highest priority first.

    Use the built footprints, including holes and water cuts, and subtract
    their full XY area from every lower-priority slab. The existing geometry
    epsilon keeps cut edges disjoint after Blender's float32 conversion;
    otherwise rounded edges can leave thin overlaps. Slopes and thickness survive.
    Same-category pieces share a material and do not cut one another.
    """
    categories = tuple(priority_order)
    if len(categories) != len(DEFAULT_SURFACE_PRIORITY) or set(categories) != set(DEFAULT_SURFACE_PRIORITY):
        raise ValueError("Surface priority must include each category exactly once")
    higher = []
    removed_area = 0.0
    clipped_objects = 0
    fragments = 0
    for rank, category in enumerate(categories):
        objects = [obj for obj in surface_collection.objects
                   if obj.type == 'MESH' and obj.get('feature_type') == 'land_surface'
                   and obj.get('surface_category') == category]
        footprints = []
        for index, obj in enumerate(objects):
            # Save the original footprint before replacing this mesh.
            # Its overlap with earlier categories is already in *higher*.
            outline = _outline_loops(obj.data)
            if rank < len(categories)-1:
                footprints.extend(outline)
            def report(fraction):
                if progress_callback:
                    progress_callback((rank + .9*(index+fraction)/len(objects))/len(categories))
            name = obj.name
            removed, shells = _rebuild_surface(obj, higher, thickness, outline, report)
            if removed > 1e-8:
                if name in surface_collection.objects:
                    obj['surface_overlap_cut_area_mm2'] = removed
                removed_area += removed
                clipped_objects += 1
                fragments += shells
            report(1.0)
        higher.extend(_cutter(ring, EPSILON) for ring in footprints)
        if progress_callback:
            progress_callback((rank+1)/len(categories))
    return {'land_surface_priority': list(categories),
            'land_surface_overlap_cut_objects': clipped_objects,
            'land_surface_overlap_cut_area_mm2': round(removed_area, 4),
            'land_surface_overlap_clearance_mm': EPSILON,
            'land_surface_overlap_cut_fragments': fragments}


def _top_triangles(mesh, progress_callback=None):
    # Every draped prism pairs its top and underside at identical XY. Tiny
    # cap slivers can have an unreliable XY winding after float32 conversion;
    # identify the top by height too, so they cannot extrude a second bottom.
    tops = {}
    for vertex in mesh.vertices:
        x, y, z = vertex.co
        tops[x, y] = max(tops.get((x, y), z), z)
    mesh.calc_loop_triangles()
    total = max(1, len(mesh.loop_triangles))
    for index, triangle in enumerate(mesh.loop_triangles):
        if progress_callback and index % 2048 == 0:
            progress_callback(index / total)
        points = [tuple(mesh.vertices[i].co) for i in triangle.vertices]
        if area_xy(points) > 1e-12 and all(p[2] >= tops[p[0], p[1]]-1e-6 for p in points):
            yield points
    if progress_callback:
        progress_callback(1.0)


def _drop_collinear(ring):
    # Drape refinement inserts many collinear boundary points. Their Z
    # matters to the road, but not to its XY footprint. Keep bends within
    # 0.0001 mm, fifty times smaller than the cutting clearance.
    ring = clean_ring(ring)
    changed = True
    while changed and len(ring) > 3:
        changed = False
        for i in range(len(ring)):
            a, b, c = ring[i-1], ring[i], ring[(i+1) % len(ring)]
            length = math.dist(a, c)
            if length and abs(area_xy([a, b, c]))*2 <= length*1e-4 and (
                (b[0]-a[0])*(b[0]-c[0])+(b[1]-a[1])*(b[1]-c[1]) <= 0
            ):
                ring.pop(i)
                changed = True
                break
    return ring


def _road_outline_triangles(mesh):
    """Recover footprint rings from prism walls, skipping interior refinement.

    Road caps are triangles and walls are quads. The top edge of each wall
    follows the actual built footprint. Vertices remain keyed by mesh index,
    so overlapping road solids never get welded together. An unexpected wall
    graph or failed triangulation uses the original cap triangles instead.
    """
    adjacent = defaultdict(list)
    for face in mesh.polygons:
        if len(face.vertices) != 4:
            continue
        columns = {}
        for index in face.vertices:
            x, y, z = mesh.vertices[index].co
            previous = columns.get((x, y))
            if previous is None or z > mesh.vertices[previous].co.z:
                columns[x, y] = index
        if len(columns) != 2:
            return list(_top_triangles(mesh))
        a, b = columns.values()
        adjacent[a].append(b)
        adjacent[b].append(a)
    if not adjacent or any(len(neighbors) != 2 for neighbors in adjacent.values()):
        return list(_top_triangles(mesh))
    result = []
    unseen = set(adjacent)
    while unseen:
        start = next(iter(unseen))
        previous, current = None, start
        ring = []
        while current in unseen:
            unseen.remove(current)
            ring.append(tuple(mesh.vertices[current].co[:2]))
            neighbors = adjacent[current]
            following = neighbors[0] if neighbors[0] != previous else neighbors[1]
            previous, current = current, following
        if current != start:
            return list(_top_triangles(mesh))
        ring = _drop_collinear(ring)
        if area_xy(ring) < 0:
            ring.reverse()
        triangles = ear_clip(ring)
        if not triangles:
            return list(_top_triangles(mesh))
        result.extend([ring[i] for i in triangle] for triangle in triangles)
    return result


def _outline_loops(mesh):
    """Footprint rings of merged prisms, read from their walls.

    A wall quad joins two XY columns; its top edge, reversed, runs with the
    filled area on its left. Outer rings therefore come out counter-clockwise
    and holes clockwise, however many solids overlap. Vertices stay keyed by
    mesh index while chaining, so coincident solids never merge. Without a
    closed wall graph, the top triangles are used as rings instead.
    """
    coords = [v.co[:] for v in mesh.vertices]
    successors = defaultdict(list)
    for face in mesh.polygons:
        indices = face.vertices[:]
        if len(indices) != 4:
            continue
        columns = defaultdict(list)
        for index in indices:
            columns[coords[index][:2]].append(coords[index][2])
        if len(columns) != 2 or any(len(z) != 2 or z[0] == z[1] for z in columns.values()):
            continue
        top = [coords[i][2] == max(columns[coords[i][:2]]) for i in indices]
        for i in range(4):
            if top[i] and top[(i+1) % 4]:
                successors[indices[(i+1) % 4]].append(indices[i])
    loops = []
    for start in list(successors):
        path, seen, current = [], {}, start
        while True:
            if current in seen:
                # Split pinched outlines into simple loops at repeated vertices.
                cut = seen[current]
                loops.append(path[cut:])
                for index in path[cut:]:
                    del seen[index]
                del path[cut:]
            following = successors.get(current)
            if not following:
                if path:
                    loops = None
                break
            seen[current] = len(path)
            path.append(current)
            current = following.pop()
        if loops is None:
            break
    rings = [[coords[i][:2] for i in loop] for loop in loops or () if len(loop) > 2]
    if loops is None or not rings:
        rings = []
        for triangle in _top_triangles(mesh):
            ring = [p[:2] for p in triangle]
            rings.append(ring if area_xy(ring) > 0 else ring[::-1])
    return rings


def _grow(ring, distance):
    """Offset a ring toward its right-hand side, growing its filled area."""
    if distance <= 0:
        return ring
    normals = []
    for a, b in zip(ring, ring[1:] + ring[:1]):
        length = math.dist(a, b)
        normals.append(((b[1]-a[1])/length, (a[0]-b[0])/length))
    grown = []
    for i, (x, y) in enumerate(ring):
        (ax, ay), (bx, by) = normals[i-1], normals[i]
        # Miter join, limited on hairpins to a few times the clearance.
        scale = distance / max(1 + ax*bx + ay*by, .25)
        grown.append((x + (ax+bx)*scale, y + (ay+by)*scale))
    return grown


def _cutter(ring, clearance, hole=None):
    """Grow a cutter ring by *clearance* and give it drape-spaced vertices.

    Rings keep their filled area on the left; *hole* orients a ring of
    unknown winding first (clockwise when true).
    """
    ring = clean_ring(ring)
    if ring and hole is not None and (area_xy(ring) < 0) != hole:
        ring.reverse()
    return densify_ring(_grow(ring, clearance), CUT_EDGE_SPACING_MM) if ring else []


def _find(parents, i):
    while parents[i] != i:
        parents[i] = parents[parents[i]]
        i = parents[i]
    return i


def _lattice(anchors, bounds, spacing=CUT_EDGE_SPACING_MM):
    """Regular interior drape points, kept clear of ring vertices.

    Ring vertices are at most *spacing* apart, so the clearance radius also
    keeps points half a spacing from ring edges, where they would only make
    slivers. The lattice is fixed in model space: a later rebuild finds the
    same points already on the surface and reads their heights back exactly.
    """
    left, low, right, high = bounds
    radius = .6 * spacing
    blocked = set()
    for x, y in anchors:
        for i in range(math.ceil((x-radius)/spacing), math.floor((x+radius)/spacing)+1):
            for j in range(math.ceil((y-radius)/spacing), math.floor((y+radius)/spacing)+1):
                if (i*spacing-x)**2 + (j*spacing-y)**2 < radius*radius:
                    blocked.add((i, j))
    return [(i*spacing, j*spacing)
            for i in range(math.ceil(left/spacing), math.floor(right/spacing)+1)
            for j in range(math.ceil(low/spacing), math.floor(high/spacing)+1)
            if (i, j) not in blocked]


def _triangulate(points, loops, groups, epsilon=_CDT_EPSILON):
    """Triangulate points and closed rings, with a winding number per ring group.

    *loops* pairs a group index below *groups* with a ring of point indices,
    each ring with its filled area on its left. Returns the output points,
    triangles and point origins of Blender's constrained Delaunay
    triangulation, plus one tuple of *groups* winding numbers per triangle.
    They are walked in from the hull: entering the left side of a ring edge
    adds one. Rings that collapse under the epsilon cancel out instead of
    leaking, and holes need no special case.
    """
    points = [Vector(p) for p in points]
    edges, owners = [], []
    for group, ring in loops:
        edges.extend(zip(ring, ring[1:] + ring[:1]))
        owners.extend([group] * len(ring))
    out_points, out_edges, out_faces, out_origins, edge_origins, _faces = delaunay_2d_cdt(
        points, edges, [], 0, epsilon, True)
    zero = (0,) * groups
    # Direct each ring edge's output pieces by walking them from the output
    # vertex of its start to that of its end. Reading the direction from the
    # coordinates instead fails on the tiny pieces left where the
    # triangulation splits an edge beside a nearly coincident vertex.
    vertex_of = {}
    for index, origins in enumerate(out_origins):
        for i in origins:
            vertex_of[i] = index
    pieces = defaultdict(list)
    for (u, v), origins in zip(out_edges, edge_origins):
        for i in origins:
            pieces[i].append((u, v))
    counts = defaultdict(lambda: [0] * groups)
    for i, chain in pieces.items():
        a, b = edges[i]
        start, end = vertex_of.get(a), vertex_of.get(b)
        following = defaultdict(list)
        for u, v in chain:
            following[u].append(v)
            following[v].append(u)
        steps = []
        previous, current = None, start
        while current != end and current is not None and len(steps) < len(chain):
            ahead = [w for w in following[current] if w != previous]
            if len(ahead) != 1:
                break
            steps.append((current, ahead[0]))
            previous, current = current, ahead[0]
        if current != end or len(steps) != len(chain):
            direction = points[b] - points[a]
            steps = [(u, v) if (out_points[v] - out_points[u]).dot(direction) > 0 else (v, u) for u, v in chain]
        for u, v in steps:
            counts[u, v][owners[i]] += 1
            counts[v, u][owners[i]] -= 1
    crossing = {edge: tuple(n) for edge, n in counts.items() if any(n)}
    owner = {}
    for t, (a, b, c) in enumerate(out_faces):
        owner[a, b] = owner[b, c] = owner[c, a] = t
    winding = [None] * len(out_faces)
    queue = []
    for (a, b), t in owner.items():
        if (b, a) not in owner and winding[t] is None:
            winding[t] = crossing.get((a, b), zero)
            queue.append(t)
    while queue:
        t = queue.pop()
        a, b, c = out_faces[t]
        for edge in ((a, b), (b, c), (c, a)):
            u = owner.get(edge[::-1])
            if u is not None and winding[u] is None:
                winding[u] = tuple(w + d for w, d in zip(winding[t], crossing.get(edge[::-1], zero)))
                queue.append(u)
    return out_points, out_faces, out_origins, winding


def _solid(out_points, kept, height, thickness, flat=False):
    """Weld kept triangles into one closed solid, returning ``(vertices, faces, shells)``.

    The top follows *height* at each output point. The underside is
    *thickness* below it, or with *flat* that far below the lowest top vertex.
    Walls stand only on boundary edges. Corners join across interior edges
    only, so outlines pinched at a vertex get separate vertices and every
    wall edge stays manifold. Those vertices are also moved apart by the
    geometry epsilon, into their own triangles: Blender's Exact Boolean, like
    a slicer, welds coincident vertices and would pinch the solid again.
    """
    corner_sets = list(range(3*len(kept)))
    shells = list(range(len(kept)))
    adjacent = defaultdict(list)
    for t, face in enumerate(kept):
        for c in range(3):
            a, b = face[c], face[(c+1) % 3]
            adjacent[(a, b) if a < b else (b, a)].append((t, c))
    for uses in adjacent.values():
        if len(uses) == 2:
            (t, c), (u, d) = uses
            same = kept[t][c] == kept[u][d]
            corner_sets[_find(corner_sets, 3*t + c)] = _find(corner_sets, 3*u + (d if same else (d+1) % 3))
            corner_sets[_find(corner_sets, 3*t + (c+1) % 3)] = _find(corner_sets, 3*u + ((d+1) % 3 if same else d))
            shells[_find(shells, t)] = _find(shells, u)

    corner_vertex = {}
    tops = []
    splits = defaultdict(list)
    for t, face in enumerate(kept):
        for c in range(3):
            key = _find(corner_sets, 3*t + c)
            if key not in corner_vertex:
                corner_vertex[key] = len(tops)
                splits[face[c]].append((len(tops), t))
                x, y = out_points[face[c]]
                tops.append((x, y, height(face[c])))
    for point, copies in splits.items():
        if len(copies) < 2:
            continue
        x, y = out_points[point]
        for index, t in copies:
            dx = sum(out_points[i][0] for i in kept[t]) / 3 - x
            dy = sum(out_points[i][1] for i in kept[t]) / 3 - y
            length = math.hypot(dx, dy) or 1.0
            tops[index] = (x + dx / length * EPSILON, y + dy / length * EPSILON, tops[index][2])
    corners = [[corner_vertex[_find(corner_sets, 3*t + c)] for c in range(3)] for t in range(len(kept))]

    base = min(z for _x, _y, z in tops) - thickness if flat else None
    vertices = []
    for x, y, z in tops:
        vertices.extend(((x, y, z-thickness if base is None else base), (x, y, z)))
    polygons = []
    for a, b, c in corners:
        polygons.append((2*a+1, 2*b+1, 2*c+1))
        polygons.append((2*c, 2*b, 2*a))
    for uses in adjacent.values():
        if len(uses) == 1:
            t, c = uses[0]
            a, b = corners[t][c], corners[t][(c+1) % 3]
            polygons.append((2*a, 2*b, 2*b+1, 2*a+1))
    return vertices, polygons, len({_find(shells, t) for t in range(len(kept))})


def _rebuild_surface(obj, cutters, thickness, outline=None, progress_callback=None, bounds=None):
    """Subtract cutter rings from a slab and rebuild it as welded shells.

    The slab outlines, the cutter rings and a regular lattice of interior
    points go into one constrained Delaunay triangulation. A triangle is kept
    where the slab rings' winding is positive and the cutters' is not, so
    overlapping solids of the same category merge and holes stay open.
    Outline vertices keep their exact draped height; the others interpolate
    the previous top. The result is one top sheet with a matching underside
    *thickness* below it and walls only on its boundary, rather than a shell
    per cap fragment.

    Returns ``(removed_area, shells)``. An object with nothing to remove is
    left unchanged; one with nothing left is deleted. *bounds* replaces the
    object's cached bounding box, which a copy given a new mesh still has
    from its source.
    """
    mesh = obj.data
    report = progress_callback or (lambda fraction: None)
    left, low, right, high = bounds or (min(p[0] for p in obj.bound_box), min(p[1] for p in obj.bound_box),
                                        max(p[0] for p in obj.bound_box), max(p[1] for p in obj.bound_box))
    cutters = [ring for ring in cutters if ring
               and min(p[0] for p in ring) < right and left < max(p[0] for p in ring)
               and min(p[1] for p in ring) < high and low < max(p[1] for p in ring)]
    if not cutters:
        return 0.0, 0
    if outline is None:
        outline = _outline_loops(mesh)
    if not outline:
        return 0.0, 0
    report(.2)

    coords = [v.co[:] for v in mesh.vertices]
    tops = {}
    for x, y, z in coords:
        if z > tops.get((x, y), -math.inf):
            tops[x, y] = z
    keys = list({p for ring in outline for p in ring})
    lookup = {key: index for index, key in enumerate(keys)}
    points = list(keys)
    loops = [(0, [lookup[p] for p in ring]) for ring in outline]
    for ring in cutters:
        loops.append((1, list(range(len(points), len(points)+len(ring)))))
        points.extend(ring)
    points.extend(_lattice(points, (left, low, right, high)))

    out_points, out_faces, out_origins, winding = _triangulate(points, loops, 2)
    report(.6)
    kept = []
    removed = 0.0
    for face, (slab, cut) in zip(out_faces, winding):
        if slab <= 0:
            continue
        if cut > 0:
            removed += abs(area_xy([out_points[i] for i in face]))
        else:
            kept.append(tuple(face))
    if removed <= 1e-8:
        return 0.0, 0
    if not kept:
        bpy.data.objects.remove(obj, do_unlink=True)
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)
        return removed, 0

    sampler = []

    def height(index):
        known = [tops[keys[i]] for i in out_origins[index] if i < len(keys)]
        if known:
            return max(known)
        if not sampler:
            mesh.calc_loop_triangles()
            triangles = [t.vertices[:] for t in mesh.loop_triangles
                         if all(coords[i][2] >= tops[coords[i][:2]]-1e-6 for i in t.vertices)
                         and abs(area_xy([coords[i] for i in t.vertices])) > 1e-12]
            flat = [Vector((x, y, 0.0)) for x, y, _z in coords]
            sampler.extend((triangles, flat, BVHTree.FromPolygons(flat, triangles, all_triangles=True)))
        triangles, flat, tree = sampler
        x, y = out_points[index]
        location, _normal, nearest, _distance = tree.find_nearest((x, y, 0.0))
        if nearest is None:
            return max(tops.values())
        a, b, c = triangles[nearest]
        return barycentric_transform(location, flat[a], flat[b], flat[c],
                                     Vector(coords[a]), Vector(coords[b]), Vector(coords[c])).z

    vertices, polygons, count = _solid(out_points, kept, height, thickness)
    replacement = bpy.data.meshes.new(mesh.name + '_CUT')
    replacement[GENERATED_KEY] = True
    replacement.from_pydata(vertices, [], polygons)
    for material in mesh.materials:
        replacement.materials.append(material)
    replacement.validate(clean_customdata=False)
    replacement.update(calc_edges=True)
    obj.data = replacement
    obj['solid_count'] = count
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)
    report(1.0)
    return removed, count


def cut_road_footprints(surface_collection, road_collection, thickness, progress_callback=None):
    """Subtract XY footprints, preserving each cap's Z and slab thickness.

    Reading built ground roads includes final widths, end caps, tight-curve
    pieces and demoted bridges, while excluding skipped roads and elevated
    decks. No terrain, water, support or road mesh is modified.
    """
    cutters = []
    roads = list(road_collection.objects)
    for index, obj in enumerate(roads):
        if obj.type == 'MESH' and obj.get('feature_type') == 'surface_road':
            cutters.extend(_road_cutters(obj.data))
        if progress_callback:
            progress_callback(.2 * ((index+1) / max(1, len(roads))))
    objects = [obj for obj in surface_collection.objects
               if obj.type == 'MESH' and obj.get('feature_type') == 'land_surface']
    counts, _kept = _cut_slabs(objects, cutters, lambda obj: thickness, progress_callback)
    return counts


def defer_road_cut(surface_collection, thickness):
    """Leave the slabs whole under ground roads, for Export to cut instead.

    Roads and paths can then be deleted or moved in Blender without leaving
    holes; the roads stand above the slabs, so the model looks the same.
    """
    objects = [obj for obj in surface_collection.objects
               if obj.type == 'MESH' and obj.get('feature_type') == 'land_surface']
    for obj in objects:
        obj[ROAD_CUT_AT_EXPORT_KEY] = True
        obj['slab_thickness_mm'] = thickness
    return {'land_surface_road_cut': 'at export',
            'land_surface_road_cut_deferred_objects': len(objects)}


def cut_roads_at_export(slabs, road_meshes, progress_callback=None):
    """Cut the ground roads there are now from slabs Generate left whole.

    *slabs* are Export's own copies, rebuilt in place exactly as Generate
    would have, and *road_meshes* share their coordinates. Bounds come from
    the vertices, as a copy's cached bounding box is still its source's.
    Returns the counts and the slabs left, in order; a slab the roads cover
    entirely is deleted.
    """
    cutters = [ring for mesh in road_meshes for ring in _road_cutters(mesh)]
    return _cut_slabs(slabs, cutters, lambda obj: obj['slab_thickness_mm'], progress_callback,
                      exact_bounds=True)


def _road_cutters(mesh):
    return [_cutter(_drop_collinear(ring), ROAD_SURFACE_CLEARANCE_MM) for ring in _outline_loops(mesh)]


def _mesh_bounds(mesh):
    if not mesh.vertices:
        return 0.0, 0.0, 0.0, 0.0
    coords = array('f', [0.0]) * (3*len(mesh.vertices))
    mesh.vertices.foreach_get('co', coords)
    return min(coords[0::3]), min(coords[1::3]), max(coords[0::3]), max(coords[1::3])


def _cut_slabs(objects, cutters, thickness, progress_callback=None, exact_bounds=False):
    removed_area = 0.0
    clipped_objects = 0
    fragments = 0
    kept = []
    for index, obj in enumerate(objects):
        if not cutters:
            kept.append(obj)
            continue

        def report(fraction):
            if progress_callback:
                progress_callback(.2 + .8*(index+fraction)/len(objects))
        bounds = _mesh_bounds(obj.data) if exact_bounds else None
        removed, shells = _rebuild_surface(obj, cutters, thickness(obj), progress_callback=report,
                                           bounds=bounds)
        if removed > 1e-8:
            # No shells: nothing was left, and the slab has been deleted.
            if shells:
                obj['road_cut_area_mm2'] = removed
                obj['road_clearance_mm'] = ROAD_SURFACE_CLEARANCE_MM
            removed_area += removed
            clipped_objects += 1
            fragments += shells
        if removed <= 1e-8 or shells:
            kept.append(obj)
        report(1.0)
    if progress_callback:
        progress_callback(1.0)
    return ({'land_surface_road_cut_objects': clipped_objects,
             'land_surface_road_cut_area_mm2': round(removed_area, 4),
             'land_surface_road_cut_fragments': fragments,
             'land_surface_road_clearance_mm': ROAD_SURFACE_CLEARANCE_MM}, kept)
