"""Whole-tree road avoidance, intact shared meshes and the UI toggle."""
import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_tree_printability import closed, collection, point, forest
from jarvizar_city_model.blender.mesh_utils import MeshBuilder
from jarvizar_city_model.geometry.tree_road_overlap import tree_road_footprints
from jarvizar_city_model.geometry.vegetation import TreeSettings, generate_trees
from jarvizar_city_model.geometry.footprint_cut import FootprintIndex, area_xy


def snapshot(obj):
    return ([tuple(v.co) for v in obj.data.vertices],
            [tuple(p.vertices) for p in obj.data.polygons])


def make_road(roads, name, ring, kind='surface_road'):
    builder = MeshBuilder(name)
    assert builder.add_prism([[(x, y, x*.02-.15, x*.02+.6) for x, y in ring]],
                             refine=(.2, lambda x, y: (x*.02-.15, x*.02+.6)))
    obj = builder.build(roads)
    obj['feature_type'] = kind
    return obj


def main():
    transform = SimpleNamespace(
        scale_x_mm_per_m=.07, vertical_meters_to_model_mm=lambda h: h*.07,
        geographic_to_model=lambda x, y, z: (x, y, z),
        model_bounds=SimpleNamespace(min_x_mm=0, min_y_mm=0, max_x_mm=40, max_y_mm=30))
    field = SimpleNamespace(height_mm=lambda x, y: x*.02, over_open_water=lambda x, y: False)
    roads = collection('roads')
    make_road(roads, 'street', [(0,4.7),(40,4.7),(40,5.3),(0,5.3)])
    make_road(roads, 'footway', [(14.775,0),(15.225,0),(15.225,30),(14.775,30)])
    make_road(roads, 'bend', [(20,8),(25,8),(25,12),(24.55,12),(24.55,8.45),(20,8.45)])
    make_road(roads, 'covered', [(29,1),(33,1),(33,4),(29,4)])
    # A high deck must not erase ground trees under it.
    make_road(roads, 'bridge', [(34,1),(36,1),(36,4),(34,4)], 'bridge_deck')
    originals = [snapshot(obj) for obj in roads.objects]
    features = [point('edge', 3, 5.5), point('center', 7, 5),
                point('touch', 11, 6.2), point('junction', 15.4, 5.5),
                point('path', 15.5, 10), point('bend', 24.5, 8.5),
                point('covered', 31, 2), point('under-bridge', 35, 2),
                point('untouched', 3, 2), forest('wood', 14, 29)]
    results = {}
    for avoid in (False, True):
        for merge in (False, True):
            trees = collection('trees')
            settings = TreeSettings(avoid_roads=avoid)
            counts = generate_trees(features, [], transform, field, trees, None, settings,
                                    merge=merge, road_collection=roads)
            bpy.context.view_layer.update()
            assert counts['tree_avoid_roads'] == avoid
            assert (counts['trees_skipped_roads'] > 0) == avoid
            geometry = []
            for obj in trees.objects:
                vertices = [tuple(obj.matrix_world @ v.co) for v in obj.data.vertices]
                faces = [tuple(p.vertices) for p in obj.data.polygons]
                closed(vertices, faces)
                if not merge:
                    assert len(vertices) == 37, 'Every tree must keep the original complete mesh'
                    assert min(p[2] for p in vertices) < obj.location.z
                    if avoid:
                        # Independent slab-difference oracle, rather than the
                        # early-exit overlap method used for placement.
                        base = [p for p in vertices if abs(p[2]-min(v[2] for v in vertices)) < 1e-6]
                        mask = tree_road_footprints(roads)
                        assert abs(area_xy(base)-sum(area_xy(p) for p in mask.difference(base))) < 1e-6
                geometry.extend(vertices)
            if not merge:
                assert len({obj.data for obj in trees.objects}) == 1
                locations = {(round(obj.location.x, 3), round(obj.location.y, 3)) for obj in trees.objects}
                assert (35, 2) in locations and (3, 2) in locations
                assert ((3, 5.5) in locations) != avoid
                assert ((7, 5) in locations) != avoid
                assert ((15.5, 10) in locations) != avoid
            results[avoid, merge] = counts, geometry
            assert [snapshot(obj) for obj in roads.objects] == originals
        assert results[avoid, False][0] == results[avoid, True][0]
        assert max(math.dist(a, b) for a, b in zip(results[avoid, False][1], results[avoid, True][1])) < 1e-5
    assert results[True, False][0]['trees'] < results[False, False][0]['trees']
    # Toggle off must bypass even preparation of the road index.
    with patch('jarvizar_city_model.geometry.vegetation.tree_road_footprints', side_effect=AssertionError):
        generate_trees(features, [], transform, field, collection('disabled'), None,
                       TreeSettings(avoid_roads=False), road_collection=roads, merge=True)
    # Rejected trees must reserve neither the tree cap nor crown spacing.
    adjacent = [point('blocked', 3, 5.5), point('valid', 3, 6.5), point('later', 10, 2)]
    accepted = collection('cap')
    capped = generate_trees(adjacent, [], transform, field, accepted, None,
                            TreeSettings(maximum_trees=1), road_collection=roads)
    assert capped['trees'] == 1 and capped['trees_skipped_roads'] == 1
    assert tuple(accepted.objects[0].location[:2]) == (3, 6.5)
    # The previous near-tangent trimming failure now requires only an overlap query.
    fixture = json.loads((Path(__file__).parent/'fixtures/tree_road_tangent.json').read_text())
    mask = FootprintIndex()
    for box, planes in fixture['cutters']:
        index = len(mask.cutters)
        mask.cutters.append((box, planes))
        for cell in mask._cells(box):
            mask.cells[cell].append(index)
    bottom = min(p[2] for p in fixture['vertices'])
    assert mask.overlaps([p for p in fixture['vertices'] if p[2] == bottom])
    import jarvizar_city_model as addon
    from jarvizar_city_model.blender.generation_modal import settings_snapshot
    from jarvizar_city_model.ui import JARVIZAR_PT_trees
    addon.register()
    settings = bpy.context.scene.jarvizar_city_model
    assert settings.tree_avoid_roads is True
    assert settings_snapshot(settings)['tree_avoid_roads'] is True
    settings.tree_avoid_roads = False
    assert settings_snapshot(settings)['tree_avoid_roads'] is False
    drawn = []
    class Layout:
        def prop(self, settings, name, **kwargs): drawn.append(name)
        def __getattr__(self, name): return lambda *args, **kwargs: self
    JARVIZAR_PT_trees.draw(SimpleNamespace(layout=Layout()), bpy.context)
    assert 'tree_avoid_roads' in drawn
    addon.unregister()
    assert not any(obj.modifiers for obj in bpy.data.objects if obj.get('feature_type') == 'trees')
    print('TREE_ROAD_CLEARANCE_OK', {str(key): value[0] for key, value in results.items()})


main()
