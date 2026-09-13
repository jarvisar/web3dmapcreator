"""Exact shallow water basins, including footprints smaller than a grid cell.

These are finite-depth differences of the built terrain. They never enter the
open-water mask, so a river's cut and bridge/support policy stay independent.
The prepared water prism supplies both the basin cutter and the water fill.
"""

from collections import Counter

import bpy
from mathutils.bvhtree import BVHTree

from ..blender.mesh_utils import MeshBuilder, _prism_geometry
from .footprint_cut import FootprintIndex, area_xy
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
            a, b = bounds[i], bounds[j]
            if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                if any(area_xy(cap) - sum(area_xy(p) for p in other.difference(cap)) > 1e-7 for cap in caps):
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
        if any(area_xy(cap) - sum(area_xy(p) for p in open_water.difference(cap)) > 1e-7
               for cap in _caps(body)):
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
    result["jarvizar_generated"] = True
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


def cut_water_land_surfaces(collection, bodies, thickness, *, preserve_paved=False):
    """Clear all land-cover slabs from validated water footprints.

    The same exact polygons supply water fills and surface exclusions, with
    islands preserved. Apply to both recessed basins and ordinary water,
    regardless of terrain-cut thresholds or water-fill visibility. Removing
    the full slab thickness prevents buried fragments reappearing at banks.
    Supported paving can be retained; callers must build its foundations.
    Structure supports, roads and buildings have separate ownership.
    """
    if not bodies:
        return {"land_surface_water_cuts": 0}
    cutters = [_cutter(ring, EPSILON, hole=index > 0)
               for body in bodies for index, ring in enumerate(body.rings)]
    changed = 0
    for obj in list(collection.objects):
        if obj.type != 'MESH' or obj.get('feature_type') != 'land_surface':
            continue
        if preserve_paved and obj.get('surface_category') == 'paved':
            continue
        removed, _shells = _rebuild_surface(obj, cutters, thickness)
        changed += removed > 1e-8
    return {"land_surface_water_cuts": changed}
