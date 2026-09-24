"""Non-bridge foundations clear water while bridge causeways stay unchanged."""

import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/'tests'))
from blender_basin_support import Transform, polygon, road, field, collection, rectangle, tree, top, assert_closed, meshes
from jarvizar_city_model.geometry.support import SupportBuilder, SUPPORT_WATER_CLEARANCE_MM
from jarvizar_city_model.geometry.surfaces import (
    solve_water_bodies, cut_water_from_terrain, flatten_terrain_under_water,
)
from jarvizar_city_model.geometry.building_generation import generate_buildings
from jarvizar_city_model.geometry.roads import generate_roads, RoadSettings


def water(heights):
    bodies,_=solve_water_bodies([polygon('water',[rectangle(2,2,18,18)],**{'class':'lake'})],Transform(),heights)
    return bodies


def test_support_kinds_and_bridge_identity():
    for kind in ('building','road','mapped_deck','bridge_causeway'):
        snapshots=[]
        for with_water in (False,True):
            heights=field()
            bodies=water(heights)
            # As generation does: cut water's terrain and shore are set to its
            # level, which is what keeps a foundation over it above the water.
            flatten_terrain_under_water(heights,bodies)
            cut_water_from_terrain(heights,bodies)
            support=SupportBuilder(heights,-1.3,water_bodies=bodies if with_water else ())
            assert support.footprint([rectangle(5,5,7,7)],kind)
            obj=support.build(collection('support_'+kind))
            assert_closed(obj)
            snapshots.append(meshes(obj.users_collection[0]))
            if with_water and kind!='bridge_causeway':
                assert top(tree(obj),6,6) >= bodies[0].top_mm+SUPPORT_WATER_CLEARANCE_MM-1e-4
                assert abs(min(v.co.z for v in obj.data.vertices)+1.3)<1e-5
        if kind=='bridge_causeway':
            assert snapshots[0]==snapshots[1], 'Bridge causeway changed'

    # An earlier submerged bridge support must not suppress a building's
    # visible foundation at the same outline.
    heights=field()
    bodies=water(heights)
    flatten_terrain_under_water(heights,bodies)
    cut_water_from_terrain(heights,bodies)
    support=SupportBuilder(heights,-1.3,water_bodies=bodies)
    rings=[rectangle(5,5,7,7)]
    assert support.footprint(rings,'bridge_causeway')
    assert support.footprint(rings,'building')
    assert not support.footprint(rings,'building')


def test_raised_structures_remain_seated_and_keep_heights():
    heights=field()
    bodies=water(heights)
    # Retained water well above the original terrain: no buried road/roof.
    # Only a sheet laid on kept terrain lifts foundations; cut water sits
    # under its bank.
    bodies[0].top_mm=2
    bodies[0].cut=False
    supports=SupportBuilder(heights,-1.3,water_bodies=bodies)
    parent=polygon('parent',[rectangle(5,5,9,9)],height=20,has_parts=True)
    part=polygon('part',[rectangle(7,5,9,7)],height=30,building_id='parent')
    buildings,parts=collection('raised_buildings'),collection('raised_parts')
    counts=generate_buildings([parent],[part],Transform(),heights,3,10,buildings,parts,
                              ground_support=supports)
    assert counts['buildings']==1 and counts['building_parts']==1,counts
    grade=2+SUPPORT_WATER_CLEARANCE_MM+supports.top_offset_mm
    for target,height in ((buildings,20*.07),(parts,30*.07)):
        for obj in target.objects:
            assert_closed(obj)
            assert abs(max(v.co.z for v in obj.data.vertices)-(grade+height))<1e-4
            assert abs(min(v.co.z for v in obj.data.vertices)-(grade-.15))<1e-4
    roads=collection('raised_roads')
    generate_roads([road('wet',[(3,12),(15,12)])],Transform(),heights,roads,
                   collection('decks'),collection('piers'),{},RoadSettings(),ground_support=supports)
    for obj in roads.objects:
        assert_closed(obj)
        assert abs(top(tree(obj),10,12)-(grade+.6))<1e-4
        assert abs(min(v.co.z for v in obj.data.vertices)-(grade-.15))<1e-4
    obj=supports.build(collection('raised_foundations'))
    assert_closed(obj)
    for x,y in ((6,6),(8,6),(10,12)):
        assert abs(top(tree(obj),x,y)-(2+SUPPORT_WATER_CLEARANCE_MM))<1e-4
    assert top(tree(obj),12,10) is None, 'Unrelated water filled'


def test_islands_and_dry_footprints_have_no_lift():
    heights=field()
    bodies,_=solve_water_bodies([polygon('lake',[rectangle(2,2,18,18),rectangle(5,5,9,9)],
                                        **{'class':'lake'})],Transform(),heights)
    supports=SupportBuilder(heights,-1.3,water_bodies=bodies)
    assert supports.minimum_ground([rectangle(6,6,8,8)],'building') is None
    assert supports.minimum_ground([rectangle(19,19,20,20)],'building') is None
    assert not supports.footprint([rectangle(6,6,8,8)],'building')
    assert not supports.footprint([rectangle(19,19,20,20)],'building')


test_support_kinds_and_bridge_identity()
test_raised_structures_remain_seated_and_keep_heights()
test_islands_and_dry_footprints_have_no_lift()
print('JARVIZAR_VISIBLE_SUPPORTS_OK')
