"""Live city road-cut audit: independent BVH rays and unchanged core meshes.

Run like blender_live_full.py with --cache <cache-root>.
"""

import hashlib
import runpy
import sys
from array import array
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from jarvizar_city_model import operators
from jarvizar_city_model.geometry.surface_priority import _top_triangles


def fingerprint(obj):
    mesh = obj.data
    xyz = array('f', [0]) * (3*len(mesh.vertices))
    indices = array('i', [0]) * len(mesh.loops)
    mesh.vertices.foreach_get('co', xyz)
    mesh.loops.foreach_get('vertex_index', indices)
    return hashlib.sha256(xyz.tobytes()+indices.tobytes()).hexdigest()


original = operators.cut_road_footprints


def audited(surfaces, roads, thickness, **kwargs):
    protected = [obj for obj in bpy.data.objects if obj.type == 'MESH'
                 and obj.get('jarvizar_generated') and obj not in list(surfaces.objects)]
    before = [fingerprint(obj) for obj in protected]
    vertices, faces = [], []
    for obj in roads.objects:
        offset = len(vertices)
        vertices.extend(tuple(v.co) for v in obj.data.vertices)
        faces.extend(tuple(i+offset for i in p.vertices) for p in obj.data.polygons)
    tree = BVHTree.FromPolygons(vertices, faces)
    result = original(surfaces, roads, thickness, **kwargs)
    assert [fingerprint(obj) for obj in protected] == before, 'A protected mesh changed'
    hits = checked = 0
    for obj in surfaces.objects:
        for triangle in _top_triangles(obj.data):
            # Centroid and inset corners detect remaining cap area beneath a
            # ground road using Blender's independent triangle intersection.
            center = Vector(tuple(sum(p[i] for p in triangle)/3 for i in range(3)))
            for point in [center] + [center*.1+Vector(p)*.9 for p in triangle]:
                checked += 1
                hit = tree.ray_cast(Vector((point.x, point.y, 1000)), Vector((0, 0, -1)))[0]
                hits += hit is not None
    print('ROAD_CUT_LIVE', result, 'overlap rays', hits, '/', checked,
          'unchanged meshes', len(protected), flush=True)
    assert hits == 0, 'Landcover still overlaps a generated ground road'
    return result


operators.cut_road_footprints = audited
runpy.run_path(str(root/'tests/blender_live_full.py'), run_name='__main__')
