"""Audit real surface ownership with independent Blender BVH probes."""
import hashlib
import runpy
import sys
import time
from array import array
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from jarvizar_city_model.geometry import surfaces
from jarvizar_city_model.geometry.surface_priority import _top_triangles


def fingerprint(obj):
    xyz = array('f', [0]) * (3*len(obj.data.vertices))
    indices = array('i', [0]) * len(obj.data.loops)
    obj.data.vertices.foreach_get('co', xyz)
    obj.data.loops.foreach_get('vertex_index', indices)
    return hashlib.sha256(xyz.tobytes()+indices.tobytes()).hexdigest()


original = surfaces.cut_surface_overlaps


def audited(collection, thickness, order, **kwargs):
    protected = [obj for obj in bpy.data.objects if obj.type == 'MESH'
                 and obj.get('feature_type') != 'land_surface']
    before = [fingerprint(obj) for obj in protected]
    started = time.perf_counter()
    result = original(collection, thickness, order, **kwargs)
    print('SURFACE_PRIORITY_CUT', result, 'seconds', time.perf_counter()-started, flush=True)
    assert [fingerprint(obj) for obj in protected] == before, 'A protected mesh changed'
    higher = []
    hits = checked = 0
    for category in order:
        objects = [obj for obj in collection.objects if obj.get('surface_category') == category]
        trees = []
        for obj in objects:
            trees.append((BVHTree.FromPolygons([tuple(v.co) for v in obj.data.vertices],
                                               [tuple(p.vertices) for p in obj.data.polygons]), obj))
            for triangle in _top_triangles(obj.data):
                center = Vector(tuple(sum(p[i] for p in triangle)/3 for i in range(3)))
                for point in [center] + [center*.2+Vector(p)*.8 for p in triangle]:
                    for tree, above in higher:
                        checked += 1
                        hit, normal, face, _distance = tree.ray_cast(Vector((point.x, point.y, 1000)), Vector((0, 0, -1)))
                        if hit is not None:
                            hits += 1
                            if hits <= 5:
                                print('OVERLAP_SAMPLE', category, above.name, tuple(point),
                                      [tuple(above.data.vertices[i].co) for i in above.data.polygons[face].vertices], flush=True)
        higher.extend(trees)
    print('SURFACE_PRIORITY_LIVE', 'overlap rays', hits, '/', checked,
          'unchanged protected meshes', len(protected), flush=True)
    assert hits == 0, 'Different surface types still overlap'
    return result


surfaces.cut_surface_overlaps = audited
runpy.run_path(str(root/'tests/blender_live_full.py'), run_name='__main__')
