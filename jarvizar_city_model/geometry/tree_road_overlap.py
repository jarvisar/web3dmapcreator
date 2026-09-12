"""Index printed ground roads for tree placement; no tree mesh operations."""

from mathutils import Vector

from .footprint_cut import FootprintIndex
from .surface_priority import _road_outline_triangles


TREE_ROAD_CLEARANCE_MM = 0.005


def tree_road_footprints(roads):
    mask = FootprintIndex(clearance=TREE_ROAD_CLEARANCE_MM)
    if roads is not None:
        for obj in roads.objects:
            if obj.type == 'MESH' and obj.get('feature_type') == 'surface_road':
                for triangle in _road_outline_triangles(obj.data):
                    mask.add([tuple(obj.matrix_world @ Vector((*p[:2], 0))) for p in triangle])
    return mask
