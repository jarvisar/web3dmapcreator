"""Exact road/landcover separation and untouched terrain in Blender.

Run: blender --background --factory-startup --python-exit-code 1
             --python tests/blender_road_cut.py
"""

import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvizar_city_model.blender.mesh_utils import MeshBuilder
from jarvizar_city_model.geometry.surface_priority import (
    cut_road_footprints, _top_triangles, _road_outline_triangles,
)
from jarvizar_city_model.geometry.footprint_cut import area_xy
from jarvizar_city_model.geometry.planar import faces_are_consistent


def make(collection, name, ring, bottom, top, kind):
    builder = MeshBuilder(name)
    assert builder.add_flat_prism(ring, bottom, top)
    obj = builder.build(collection)
    obj['feature_type'] = kind
    return obj


def snapshot(obj):
    return ([tuple(v.co) for v in obj.data.vertices],
            [tuple(p.vertices) for p in obj.data.polygons])


def main():
    surfaces = bpy.data.collections.new('cut_test_surfaces')
    roads = bpy.data.collections.new('cut_test_roads')
    base = bpy.data.collections.new('cut_test_base')
    ring = [(0, 0), (10, 0), (10, 10), (0, 10)]
    land = make(surfaces, 'grass', ring, -.15, .4, 'land_surface')
    # Full-height road channel: its footprint, not a 3D intersection, owns XY.
    road = make(roads, 'road', [(4,-1), (6,-1), (6,11), (4,11)], -.15, .6, 'surface_road')
    terrain = make(base, 'terrain', ring, -1.3, 0, 'terrain')
    bridge = make(roads, 'bridge', [(1,-1), (2,-1), (2,11), (1,11)], 2, 2.6, 'bridge_deck')
    originals = [snapshot(o) for o in (road, terrain, bridge)]
    counts = cut_road_footprints(surfaces, roads, .55)
    assert counts['land_surface_road_cut_objects'] == 1
    assert abs(counts['land_surface_road_cut_area_mm2']-20.1) < 1e-5
    assert [snapshot(o) for o in (road, terrain, bridge)] == originals
    assert faces_are_consistent([tuple(p.vertices) for p in land.data.polygons])
    triangles = list(_top_triangles(land.data))
    assert abs(sum(area_xy(p) for p in triangles)-79.9) < 1e-5
    # Independent check: every retained triangle lies wholly on one side of
    # the road, with its tiny clearance. There is no interior under the road.
    for triangle in triangles:
        xs = [p[0] for p in triangle]
        assert max(xs) <= 3.995001 or min(xs) >= 6.004999
    # A second pass must not continue eating the surface.
    counts = cut_road_footprints(surfaces, roads, .55)
    assert counts['land_surface_road_cut_area_mm2'] < 1e-5
    covered = bpy.data.collections.new('fully_covered')
    make(covered, 'tiny_grass', [(4.5,1), (5.5,1), (5.5,2), (4.5,2)], -.15, .4, 'land_surface')
    counts = cut_road_footprints(covered, roads, .55)
    assert len(covered.objects) == 0, 'Fully covered surface should disappear'
    empty_roads = bpy.data.collections.new('no_roads')
    saved = snapshot(land)
    assert cut_road_footprints(surfaces, empty_roads, .55)['land_surface_road_cut_objects'] == 0
    assert snapshot(land) == saved
    # Interior drape refinement must not multiply footprint cutters. This is
    # the Milwaukee regression: >1.5 million cap triangles previously became
    # individual cutters and sat at 50% before any progress was reported.
    refined = MeshBuilder('refined_road')
    outline = [(0, 0), (4, 0), (4, 1), (1, 1), (1, 4), (0, 4)]
    assert refined.add_prism([[(x, y, -.15, .6) for x, y in outline]],
                             refine=(.1, lambda x, y: (-.15, .6)))
    obj = refined.build(roads)
    obj['feature_type'] = 'surface_road'
    triangles = _road_outline_triangles(obj.data)
    assert len(list(_top_triangles(obj.data))) > 1000
    assert len(triangles) == 4, len(triangles)
    assert abs(sum(area_xy(t) for t in triangles)-7) < 1e-5
    progress = []
    cut_road_footprints(surfaces, roads, .55, progress_callback=progress.append)
    assert progress[-1] == 1 and progress == sorted(progress), progress
    assert any(0 < f < .2 for f in progress), 'No progress while preparing footprints'
    assert any(.2 < f < 1 for f in progress), 'No progress during clipping'
    print('JARVIZAR_ROAD_CUT_OK')


main()
