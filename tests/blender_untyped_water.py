"""Small unclassified water recesses without reclassifying explicit or cropped water."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
from blender_basin_support import Transform, field, polygon, rectangle, collection, tree, top, assert_closed
from jarvizar_city_model.geometry.surfaces import SurfaceSettings, solve_water_bodies, generate_water
from jarvizar_city_model.geometry.dem_terrain import generate_terrain_solid
from jarvizar_city_model.geometry.basins import recess_terrain_basins
from jarvizar_city_model.geometry.support import SupportBuilder


def solve(feature, **settings):
    return solve_water_bodies([feature], Transform(), field(), SurfaceSettings(**settings))[0]


small = polygon('generic', [rectangle(2,2,4,4)], **{'class':'water','subtype':'water',
                                                               'source_tags':[['natural','water']]})
bodies = solve(small)
assert len(bodies) == 1 and bodies[0].basin_kind == 'untyped_water'
assert not bodies[0].cut
assert abs(bodies[0].top_mm - (.06-.2)) < 1e-7
assert not solve(small,recess_ponds_and_fountains=False)[0].basin_kind
assert solve(small,cut_from_terrain=False)[0].basin_kind
# A cropped fragment and a small component of a large MultiPolygon do not
# acquire a shallow floor just because this viewport sees little of the water.
large = polygon('large', [rectangle(-100,-100,2,2)], **{'class':'water'})
assert not solve(large)[0].basin_kind
multi = {**small,'geometry':{'type':'MultiPolygon','coordinates':[
    small['geometry']['coordinates'], large['geometry']['coordinates']]}}
assert all(not body.basin_kind for body in solve(multi))
for kind in ('river','lake','reservoir','canal'):
    explicit = polygon(kind,[rectangle(2,2,4,4)],**{'class':kind})
    assert not solve(explicit)[0].basin_kind
tagged = {**small,'properties':{'class':'water','source_tags':[['natural','water'],['water','lake']]}}
assert not solve(tagged)[0].basin_kind

heights = field()
terrain = collection('generic_terrain')
generate_terrain_solid(heights,1.3,terrain)
recess_terrain_basins(heights,bodies,terrain,1.3)
water = collection('generic_water')
generate_water(bodies,water,None)
for obj in (terrain.objects[0],water.objects[0]):
    assert_closed(obj)
assert abs(top(tree(water.objects[0]),3,3) - top(tree(terrain.objects[0]),3,3) - .8) < 1e-4
assert top(tree(water.objects[0]),3,3) < top(tree(terrain.objects[0]),3,1.99) - .19
supports = SupportBuilder(heights,-2.3,water_bodies=bodies)
supports.footprint([rectangle(2.2,2.2,3,3)],'building')
support = supports.build(collection('generic_support'))
assert_closed(support)
assert top(tree(support),2.5,2.5) <= field().height_mm(2.5,2.5) + 1e-4
print('JARVIZAR_UNTYPED_WATER_OK')
