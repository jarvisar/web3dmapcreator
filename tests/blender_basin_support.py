"""Structures retain their terrain grade and solid foundations over recesses."""

import sys
from pathlib import Path
from types import SimpleNamespace

import bpy

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
from blender_ground_support import collection, rectangle, tree, top, assert_closed, FixtureTransform
from jarvizar_city_model.geometry.basins import recess_terrain_basins
from jarvizar_city_model.geometry.building_generation import generate_buildings
from jarvizar_city_model.geometry.dem_terrain import generate_terrain_solid
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.roads import generate_roads, RoadSettings
from jarvizar_city_model.geometry.support import SupportBuilder
from jarvizar_city_model.geometry.surfaces import solve_water_bodies, generate_water


class Transform(FixtureTransform):
    metric_bounds = SimpleNamespace(min_east_m=0, min_north_m=0,
                                   max_east_m=20/.07, max_north_m=20/.07)
    projection = SimpleNamespace(forward=lambda x,y,z: (x/.07, y/.07, z))

    def vertical_meters_to_model_mm(self, z):
        return z * .07


def polygon(identifier, rings, **properties):
    return {'type':'Feature', 'id':identifier, 'properties':properties,
            'geometry':{'type':'Polygon','coordinates':[r + [r[0]] for r in rings]}}


def road(identifier, points, **properties):
    return {'type':'Feature', 'id':identifier,
            'properties':{'subtype':'road','class':'footway',**properties},
            'geometry':{'type':'LineString','coordinates':points}}


def field():
    return ModelHeightField(0,0,20,20,3,3,
                            [.02*x + .01*y for y in (0,10,20) for x in (0,10,20)])


def meshes(target):
    return [(list(v.co[:] for v in o.data.vertices), list(p.vertices[:] for p in o.data.polygons))
            for o in target.objects]


def test_road_and_building_grade_and_supports():
    original, physical = field(), field()
    pond = polygon('pond', [rectangle(8,10,14,14)], **{'class':'pond'})
    bodies, _ = solve_water_bodies([pond], Transform(), physical)
    terrain = collection('basin_structure_terrain')
    generate_terrain_solid(physical,1.3,terrain)
    stats = recess_terrain_basins(physical,bodies,terrain,1.3)
    support = SupportBuilder(physical,stats['terrain_bottom_z_mm'])
    roads = [road('shore',[(2,9.9),(18,9.9)]),
             road('crossing',[(2,12),(18,12)]),
             road('bent',[(6,13),(7,13),(8,13.5),(10,13.5)])]
    baseline, result = collection('baseline_roads'), collection('basin_roads')
    for heights, target, supports in ((original,baseline,None),(physical,result,support)):
        stats = generate_roads(roads,Transform(),heights,target,collection('bridges'),
                               collection('piers'),{},RoadSettings(),ground_support=supports)
        assert stats['surface_roads'] == 3 and stats['roads_rejected_geometry'] == 0, stats
    assert meshes(result) == meshes(baseline), 'Basin changed road widths, caps or grade'
    for obj in result.objects:
        assert_closed(obj)
    for x,y in ((8.01,10.02),(10,12),(13.99,12)):
        assert abs(top(tree(result.objects[0]),x,y) - (original.height_mm(x,y)+.6)) < 1e-4

    buildings = [polygon('inside',[rectangle(11,10.5,12,11.5)],height=20),
                 polygon('shore-building',[rectangle(13.5,12.5,14.5,13.5)],height=20)]
    baseline, result = collection('baseline_buildings'), collection('basin_buildings')
    for heights, target, supports in ((original,baseline,None),(physical,result,support)):
        stats = generate_buildings(buildings,[],Transform(),heights,3,10,target,
                                   collection('parts'),ground_support=supports)
        assert stats['buildings'] == 2, stats
    assert meshes(result) == meshes(baseline), 'Basin submerged a building or changed its mass'
    assert stats['buildings_grounded_over_water'] == 2, stats
    for obj in result.objects:
        assert_closed(obj)
    built = support.build(collection('basin_structure_supports'))
    assert_closed(built)
    support_tree = tree(built)
    for x,y in ((8.01,10.02),(10,12),(11.5,11),(13.7,13)):
        assert abs(top(support_tree,x,y) - (original.height_mm(x,y)-.05)) < 1e-4
        assert physical.is_supported(x,y)
    assert top(support_tree,12.7,13.7) is None, 'Support flooded unrelated basin water'
    assert physical.height_mm(12.7,13.7) == bodies[0].bed_mm
    assert physical.void_mask is None and len(physical.basins) == 1
    water = collection('basin_structure_water')
    generate_water(bodies,water,None)
    assert abs(top(tree(water.objects[0]),12.7,13.7) - bodies[0].top_mm) < 1e-4


def test_exact_overlap_and_holes():
    physical = field()
    basin = rectangle(8,8,12,12)
    island = list(reversed(rectangle(9,9,11,11)))
    physical.register_basin([basin,island],-1)
    support = SupportBuilder(physical,-2.3)
    assert not support.overlaps_basin([rectangle(9.2,9.2,10.8,10.8)])
    assert not support.overlaps_basin([rectangle(12,8,13,12)]), 'Touching bank is dry'
    assert support.overlaps_basin([rectangle(11.999,8.2,12.8,8.8)])
    assert support.overlaps_basin([rectangle(7,7,13,13)]), 'Enclosed basin missed'
    assert not support.overlaps_basin([rectangle(7,7,13,13),
                                       list(reversed(rectangle(7.5,7.5,12.5,12.5)))])
    rings = [rectangle(7.8,7.8,12.2,12.2),island]
    assert support.footprint(rings,'building')
    assert not support.footprint(rings,'building'), 'Duplicate support'
    obj = support.build(collection('basin_support_hole'))
    assert_closed(obj)
    assert top(tree(obj),10,10) is None


def test_bridge_over_basin_and_support_toggle():
    original, physical = field(), field()
    physical.register_basin([rectangle(8,10,14,14)],-1)
    support = SupportBuilder(physical,-2.3)
    features = [road('bridge',[(2,12),(18,12)],
                     road_flags=[{'values':['is_bridge'],'between':None}]),
                road('underpass',[(10,2),(10,18)])]
    built_decks = []
    for heights, supports in ((original,None),(physical,support)):
        decks = collection('basin_bridge')
        counts = generate_roads(features,Transform(),heights,collection('bridge_roads'),
                                decks,collection('bridge_piers'),{},RoadSettings(),
                                ground_support=supports)
        assert counts['bridge_decks'] == 1, counts
        for obj in decks.objects:
            assert_closed(obj)
        built_decks.append(meshes(decks))
    assert built_decks[0] == built_decks[1], 'Basin changed solved bridge geometry'
    assert support.counts['bridge_causeway'] > 0
    obj = support.build(collection('basin_bridge_ground'))
    assert_closed(obj)
    assert abs(top(tree(obj),12,12) - (original.height_mm(12,12)-.05)) < 1e-4
    disabled = SupportBuilder(physical,-2.3)
    target = collection('support_disabled_road')
    generate_roads([road('crossing',[(2,12),(18,12)])],Transform(),physical,target,
                   collection('disabled_bridges'),collection('disabled_piers'),{},
                   RoadSettings(support_over_water=False),ground_support=disabled)
    assert disabled.builder.is_empty, 'Support toggle ignored'
    assert top(tree(target.objects[0]),10,12) < 0, 'Disabled support changed legacy placement'


if __name__ == '__main__':
    test_road_and_building_grade_and_supports()
    test_exact_overlap_and_holes()
    test_bridge_over_basin_and_support_toggle()
    print('JARVIZAR_BASIN_SUPPORT_OK')
