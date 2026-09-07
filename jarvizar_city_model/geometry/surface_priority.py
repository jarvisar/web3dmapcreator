"""Resolve landcover overlap and cut ground-road footprints from its slabs."""

import bpy
import math
from collections import defaultdict

from ..blender.mesh_utils import MeshBuilder
from ..data.land import DEFAULT_SURFACE_PRIORITY
from .footprint_cut import FootprintIndex, area_xy, fragment_solid
from .planar import EPSILON, clean_ring, ear_clip


ROAD_SURFACE_CLEARANCE_MM = 0.005


def cut_surface_overlaps(surface_collection, thickness, priority_order=DEFAULT_SURFACE_PRIORITY,
                         progress_callback=None):
    """Make different surface categories exclusive, highest priority first.

    Use the built cap footprints, including holes and water cuts, and subtract
    their full XY area from every lower-priority slab. The existing geometry
    epsilon keeps cut edges disjoint after Blender's float32 conversion;
    otherwise rounded edges can leave thin overlaps. Slopes and thickness survive.
    Same-category pieces share a material and do not cut one another.
    """
    categories = tuple(priority_order)
    if len(categories) != len(DEFAULT_SURFACE_PRIORITY) or set(categories) != set(DEFAULT_SURFACE_PRIORITY):
        raise ValueError("Surface priority must include each category exactly once")
    mask = FootprintIndex(clearance=EPSILON)
    removed_area = 0.0
    clipped_objects = 0
    fragments = 0
    for rank, category in enumerate(categories):
        objects = [obj for obj in surface_collection.objects
                   if obj.type == 'MESH' and obj.get('feature_type') == 'land_surface'
                   and obj.get('surface_category') == category]
        cutters = []
        for index, obj in enumerate(objects):
            def report(fraction):
                if progress_callback:
                    progress_callback((rank + .9*(index+fraction)/len(objects))/len(categories))
            builder = MeshBuilder(obj.name)
            removed = 0.0
            for triangle in _top_triangles(obj.data, report):
                # Save the original footprint before replacing this mesh.
                # Its overlap with earlier categories is already in the mask.
                if rank < len(categories)-1:
                    cutters.append(triangle)
                if not mask.cutters:
                    continue
                pieces = mask.difference(triangle)
                removed += max(0.0, area_xy(triangle)-sum(area_xy(p) for p in pieces))
                for piece in pieces:
                    builder.add_raw(*fragment_solid(piece, thickness))
            if removed <= 1e-8:
                continue
            old = obj.data
            if builder.is_empty:
                bpy.data.objects.remove(obj, do_unlink=True)
            else:
                mesh = bpy.data.meshes.new(old.name + '_SURFACE_CUT')
                mesh['jarvizar_generated'] = True
                mesh.from_pydata(builder.vertices, [], builder.faces)
                for material in old.materials:
                    mesh.materials.append(material)
                mesh.validate(clean_customdata=False)
                mesh.update(calc_edges=True)
                obj.data = mesh
                obj['solid_count'] = builder.solids
                obj['surface_overlap_cut_area_mm2'] = removed
            if old.users == 0:
                bpy.data.meshes.remove(old)
            removed_area += removed
            clipped_objects += 1
            fragments += builder.solids
        for index, triangle in enumerate(cutters):
            mask.add(triangle)
            if progress_callback and index % 2048 == 0:
                progress_callback((rank + .9 + .1*(index+1)/len(cutters))/len(categories))
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
        ring = clean_ring(ring)
        # Drape refinement inserts many collinear boundary points. Their Z
        # matters to the road, but not to its XY footprint. Keep bends within
        # 0.0001 mm, fifty times smaller than the cutting clearance.
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
        if area_xy(ring) < 0:
            ring.reverse()
        triangles = ear_clip(ring)
        if not triangles:
            return list(_top_triangles(mesh))
        result.extend([ring[i] for i in triangle] for triangle in triangles)
    return result


def cut_road_footprints(surface_collection, road_collection, thickness, progress_callback=None):
    """Subtract XY footprints, preserving each cap's Z and slab thickness.

    Reading built ground roads includes final widths, end caps, tight-curve
    pieces and demoted bridges, while excluding skipped roads and elevated
    decks. No terrain, water, support or road mesh is modified.
    """
    mask = FootprintIndex(clearance=ROAD_SURFACE_CLEARANCE_MM)
    roads = list(road_collection.objects)
    for index, obj in enumerate(roads):
        if obj.type == 'MESH' and obj.get('feature_type') == 'surface_road':
            for triangle in _road_outline_triangles(obj.data):
                mask.add(triangle)
        if progress_callback:
            progress_callback(.2 * ((index+1) / max(1, len(roads))))
    removed_area = 0.0
    clipped_objects = 0
    fragments = 0
    objects = list(surface_collection.objects)
    total_faces = max(1, sum(len(obj.data.polygons) for obj in objects if obj.type == 'MESH'))
    completed_faces = 0
    if mask.cutters:
        for index, obj in enumerate(objects):
            if obj.type != 'MESH' or obj.get('feature_type') != 'land_surface':
                continue
            builder = MeshBuilder(obj.name)
            removed = 0.0
            object_faces = len(obj.data.polygons)
            def report(fraction):
                if progress_callback:
                    progress_callback(.2 + .8*((completed_faces + object_faces*fraction)/total_faces))
            for triangle in _top_triangles(obj.data, lambda f: report(f*.9)):
                pieces = mask.difference(triangle)
                removed += max(0.0, area_xy(triangle)-sum(area_xy(p) for p in pieces))
                for piece in pieces:
                    builder.add_raw(*fragment_solid(piece, thickness))
            if removed > 1e-8:
                old = obj.data
                if builder.is_empty:
                    bpy.data.objects.remove(obj, do_unlink=True)
                else:
                    mesh = bpy.data.meshes.new(old.name + '_ROAD_CUT')
                    mesh['jarvizar_generated'] = True
                    mesh.from_pydata(builder.vertices, [], builder.faces)
                    for material in old.materials:
                        mesh.materials.append(material)
                    mesh.validate(clean_customdata=False)
                    mesh.update(calc_edges=True)
                    obj.data = mesh
                    obj['solid_count'] = builder.solids
                    obj['road_cut_area_mm2'] = removed
                    obj['road_clearance_mm'] = ROAD_SURFACE_CLEARANCE_MM
                if old.users == 0:
                    bpy.data.meshes.remove(old)
                removed_area += removed
                clipped_objects += 1
                fragments += builder.solids
            completed_faces += object_faces
            report(0.0)
    if progress_callback:
        progress_callback(1.0)
    return {'land_surface_road_cut_objects': clipped_objects,
            'land_surface_road_cut_area_mm2': round(removed_area, 4),
            'land_surface_road_cut_fragments': fragments,
            'land_surface_road_clearance_mm': ROAD_SURFACE_CLEARANCE_MM}
