"""Exact shallow water basins, including footprints smaller than a grid cell.

These are finite-depth differences of the built terrain. They never enter the
open-water mask, so a river's cut and bridge/support policy stay independent.
The prepared water prism supplies both the basin cutter and the water fill.
"""

from collections import Counter

import bpy
from mathutils.bvhtree import BVHTree

from ..blender.collections import GENERATED_KEY
from ..blender.mesh_utils import MeshBuilder, _prism_geometry
from .footprint_cut import FootprintIndex, area_xy, bounds_overlap
from .planar import EPSILON, ring_bounds
from .surface_priority import _cutter, _grow, _rebuild_surface


def _caps(body):
    vertices, faces = body.geometry
    for face in faces:
        if all(vertices[i][2] == 1.0 for i in face):
            points = [vertices[i] for i in face]
            if area_xy(points) > 1e-12:
                yield points


def _closed(mesh):
    directed = Counter((a, b) for face in mesh.polygons
                       for a, b in zip(face.vertices, list(face.vertices[1:]) + [face.vertices[0]]))
    return bool(directed) and all(n == 1 and directed.get((b, a)) == 1
                                  for (a, b), n in directed.items())


def _floors_match(mesh, basins, upper):
    """A closed but unchanged Boolean result must not hide the water fill."""
    tree = BVHTree.FromPolygons([v.co[:] for v in mesh.vertices],
                               [p.vertices[:] for p in mesh.polygons])
    for body in basins:
        for cap in _caps(body):
            x = sum(p[0] for p in cap) / len(cap)
            y = sum(p[1] for p in cap) / len(cap)
            hit = tree.ray_cast((x, y, upper), (0, 0, -1))[0]
            if hit is None or abs(hit.z - body.bed_mm) > 1e-4:
                return False
    return True


def _discard_object(obj):
    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)


def _align_overlapping_basins(basins):
    """Overlapping mapped parts of one basin share a floor and water level."""
    indexes, bounds = [], []
    parents = list(range(len(basins)))

    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for i, body in enumerate(basins):
        bounds.append(ring_bounds(body.rings[0]))
        index = FootprintIndex(clearance=0)
        caps = list(_caps(body))
        for j, other in enumerate(indexes):
            if bounds_overlap(bounds[i], bounds[j]):
                if any(other.covered_area(cap) > 1e-7 for cap in caps):
                    parents[root(i)] = root(j)
        for cap in caps:
            index.add(cap)
        indexes.append(index)
    floors = {}
    for i, body in enumerate(basins):
        key = root(i)
        floors[key] = min(floors.get(key, body.bed_mm), body.bed_mm)
    for i, body in enumerate(basins):
        thickness = body.top_mm - body.bed_mm
        body.bed_mm = floors[root(i)]
        body.top_mm = body.bed_mm + thickness
    return len(floors)


def _recessed_mesh(terrain, basins, collection, original_bottom, bottom, upper, clearance):
    """Return the terrain mesh with basins subtracted, or None if it is not valid."""
    cutter_builder = MeshBuilder("_BASIN_CUTTER")
    for body in basins:
        vertices, faces = body.geometry
        if clearance:
            vertices, faces = _prism_geometry([
                [(x, y, 0.0, 1.0) for x, y in _grow(ring if (area_xy(ring) < 0) == (index > 0) else ring[::-1],
                                                    clearance)]
                for index, ring in enumerate(body.rings)])
            if not faces:
                return None
        cutter_builder.add_raw([(x, y, upper if z else body.bed_mm) for x, y, z in vertices], faces)
    cutter = cutter_builder.build(collection)
    work = terrain.copy()
    work.data = terrain.data.copy()
    collection.objects.link(work)
    result = None
    try:
        # The add-on promises base_thickness beneath the lowest built surface,
        # including the new basin floor. Do not turn a deep setting into a hole.
        for vertex in work.data.vertices:
            if abs(vertex.co.z - original_bottom) < 1e-6:
                vertex.co.z = bottom
        modifier = work.modifiers.new("Pond and fountain recesses", "BOOLEAN")
        modifier.operation = "DIFFERENCE"
        modifier.solver = "EXACT"
        modifier.use_self = True
        modifier.object = cutter
        bpy.context.view_layer.update()
        evaluated = work.evaluated_get(bpy.context.evaluated_depsgraph_get())
        result = bpy.data.meshes.new_from_object(evaluated)
        result.validate(clean_customdata=False)
        result.update(calc_edges=True)
        if not _closed(result) or not _floors_match(result, basins, upper):
            bpy.data.meshes.remove(result)
            result = None
        return result
    finally:
        _discard_object(work)
        _discard_object(cutter)


def recess_terrain_basins(heightfield, bodies, collection, base_thickness_mm):
    """Cut closed basins transactionally; retain a solid base beneath floors.

    A basin overlapping another water type is omitted. This preserves that
    water's existing cut/slab policy and avoids a second surface hiding a basin.
    """
    basins = [body for body in bodies if body.basin_kind]
    if not basins:
        return {"water_recesses_built": 0}
    open_water = FootprintIndex(clearance=0.0)
    for body in bodies:
        if not body.basin_kind:
            for cap in _caps(body):
                open_water.add(cap)
    rejected = []
    for body in basins:
        if any(open_water.covered_area(cap) > 1e-7 for cap in _caps(body)):
            rejected.append(body)
    basins = [body for body in basins if body not in rejected]
    if rejected:
        bodies[:] = [body for body in bodies if body not in rejected]
    counts = {"water_recesses_built": 0, "water_basins": len(basins),
              "water_bodies": len(bodies), "water_basin_other_water_skipped": len(rejected)}
    if not basins:
        return counts
    counts['water_basin_groups'] = _align_overlapping_basins(basins)
    terrain = next(obj for obj in collection.objects if obj.get("feature_type") == "terrain")
    original_bottom = min(v.co.z for v in terrain.data.vertices)
    bottom = min(original_bottom, min(body.bed_mm for body in basins) - base_thickness_mm)
    upper = max(v.co.z for v in terrain.data.vertices) + 1.0
    # The terrain is cut along exact water outlines, so a basin mapped against
    # cut water can share that edge within float32 rounding. The Boolean then
    # welds the nearly coincident walls; clearing them by the geometry epsilon
    # keeps the recess exact to within that epsilon.
    for clearance in (0.0, EPSILON):
        result = _recessed_mesh(terrain, basins, collection, original_bottom, bottom, upper, clearance)
        if result is not None:
            break
    else:
        raise ValueError("Pond/fountain recess could not produce closed terrain with the requested floors")
    old_mesh = terrain.data
    terrain.data = result
    result[GENERATED_KEY] = True
    if old_mesh.users == 0:
        bpy.data.meshes.remove(old_mesh)
    if clearance:
        counts["water_basin_recess_clearance_mm"] = clearance
    for body in basins:
        heightfield.register_basin(body.rings, body.bed_mm)
    terrain["bottom_z_mm"] = round(bottom, 4)
    terrain["water_recesses"] = len(basins)
    counts.update(water_recesses_built=len(basins), terrain_bottom_z_mm=bottom,
                  terrain_bottom_mm=round(bottom, 4))
    return counts


# A beach runs down into the sea; a slab ending in a wall at the waterline
# reads as a kerb. Sand is mapped from explicit beach/sand/shingle/dune classes
# only, so sand beside water cut from the terrain is a beach. Its top slopes
# from the full rise down to this much above the ground at the waterline.
BEACH_WATERLINE_RISE_MM = 0.1
# The ground bulges between slab vertices, and did show through sand thinned
# this far. Every tapered triangle keeps this much over the ground it covers.
BEACH_GROUND_CLEARANCE_MM = 0.05
_CLEARANCE_SAMPLES = ((1, 0, 0), (0, 1, 0), (0, 0, 1),
                      (1/3, 1/3, 1/3), (.5, .5, 0), (0, .5, .5), (.5, 0, .5),
                      (2/3, 1/6, 1/6), (1/6, 2/3, 1/6), (1/6, 1/6, 2/3))


def _taper_beach(obj, bodies, drop, width, ground=None):
    """Slope a sand slab's top down to cut water. Returns the vertices lowered.

    Only top vertices move, by less than the rise, so the slab stays a closed
    solid over its embedded underside. Later road cuts interpolate this top.
    With *ground*, a height query, vertices of a triangle left too close to
    the ground are raised again, at most back to where they were.
    """
    corners, walls = [], []
    for body in bodies:
        for ring in body.rings:
            for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
                walls.append(tuple(range(len(corners), len(corners) + 4)))
                corners.extend(((ax, ay, -1.0), (bx, by, -1.0), (bx, by, 1.0), (ax, ay, 1.0)))
    if not walls:
        return 0
    shore = BVHTree.FromPolygons(corners, walls)
    mesh = obj.data
    tops = {}
    for vertex in mesh.vertices:
        key = (vertex.co.x, vertex.co.y)
        tops[key] = max(tops.get(key, vertex.co.z), vertex.co.z)
    lowered = {}
    for vertex in mesh.vertices:
        x, y, z = vertex.co
        if z < tops[x, y] - 1e-6:
            continue
        distance = shore.find_nearest((x, y, 0.0), width)[3]
        if distance is not None and distance < width:
            lowered[vertex.index] = drop * (1.0 - distance / width)
    if not lowered:
        return 0
    heights = {index: mesh.vertices[index].co.z - amount for index, amount in lowered.items()}
    if ground is not None:
        for face in mesh.polygons:
            if len(face.vertices) != 3 or not any(index in lowered for index in face.vertices):
                continue
            points = [mesh.vertices[index].co for index in face.vertices]
            if any(z < tops[x, y] - 1e-6 for x, y, z in points):
                continue
            need = 0.0
            for weights in _CLEARANCE_SAMPLES:
                x = sum(w * p.x for w, p in zip(weights, points))
                y = sum(w * p.y for w, p in zip(weights, points))
                z = sum(w * heights.get(index, p.z)
                        for w, index, p in zip(weights, face.vertices, points))
                share = sum(w for w, index in zip(weights, face.vertices) if index in lowered)
                if share > 0.0:
                    need = max(need, (ground(x, y) + BEACH_GROUND_CLEARANCE_MM - z) / share)
            if need > 0.0:
                for index in face.vertices:
                    if index in lowered:
                        heights[index] = min(mesh.vertices[index].co.z, heights[index] + need)
    for index, z in heights.items():
        mesh.vertices[index].co.z = z
    mesh.update()
    return len(lowered)


def cut_water_land_surfaces(collection, bodies, thickness, *, preserve_paved=False,
                            beach_rise_mm=0.0, beach_width_mm=1.5, ground=None):
    """Clear all land-cover slabs from validated water footprints.

    With *beach_rise_mm*, the slabs' rise, sand then slopes down to cut water
    over *beach_width_mm*, staying clear of the *ground* height query.

    The same exact polygons supply water fills and surface exclusions, with
    islands preserved. Apply to both recessed basins and ordinary water,
    regardless of terrain-cut thresholds or water-fill visibility. Removing
    the full slab thickness prevents buried fragments reappearing at banks.
    Supported paving can be retained over ordinary water; callers must build
    its foundations. A basin is a fountain or pond set into the paving around
    it, never a deck, so paving is cut from it like every other cover: kept,
    it buried Piazza Navona's fountains under a supported plaza.
    Structure supports, roads and buildings have separate ownership.
    """
    if not bodies:
        return {"land_surface_water_cuts": 0}
    cutters = [_cutter(ring, EPSILON, hole=index > 0)
               for body in bodies for index, ring in enumerate(body.rings)]
    basin_cutters = [_cutter(ring, EPSILON, hole=index > 0)
                     for body in bodies if body.basin_kind
                     for index, ring in enumerate(body.rings)]
    changed = 0
    for obj in list(collection.objects):
        if obj.type != 'MESH' or obj.get('feature_type') != 'land_surface':
            continue
        own = cutters
        if preserve_paved and obj.get('surface_category') == 'paved':
            own = basin_cutters
            if not own:
                continue
        removed, _shells = _rebuild_surface(obj, own, thickness)
        changed += removed > 1e-8
    counts = {"land_surface_water_cuts": changed}
    drop = beach_rise_mm - BEACH_WATERLINE_RISE_MM
    if drop > 0.0 and beach_width_mm > 0.0:
        cut = [body for body in bodies if body.cut]
        counts["beach_vertices_tapered"] = sum(
            _taper_beach(obj, cut, drop, beach_width_mm, ground) for obj in collection.objects
            if obj.type == 'MESH' and obj.get('feature_type') == 'land_surface'
            and obj.get('surface_category') == 'sand')
    return counts
