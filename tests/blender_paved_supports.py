"""Only paving retains land-cover foundations above water, including hidden fill."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
from blender_basin_support import Transform, polygon, field, rectangle, collection, tree, top, assert_closed
from jarvizar_city_model.geometry.support import SupportBuilder
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.surfaces import (
    SurfaceSettings, solve_water_bodies, generate_land_surfaces, cut_water_from_terrain,
    flatten_terrain_under_water,
)
from jarvizar_city_model.geometry.basins import cut_water_land_surfaces, recess_terrain_basins
from jarvizar_city_model.geometry.dem_terrain import generate_terrain_solid
from jarvizar_city_model.geometry.roads import generate_roads, RoadSettings
from blender_basin_support import road


def test_paving_and_natural_cover(kind, enabled):
    heights = ModelHeightField(0,0,20,20,21,21,[.02*x+.01*y for y in range(21) for x in range(21)])
    settings = SurfaceSettings(cut_from_terrain=kind != 'uncut')
    bodies, _ = solve_water_bodies([polygon('water', [rectangle(2,2,18,18)],
                                          **{'class':'lake' if kind == 'uncut' else kind})],
                                   Transform(), heights, settings)
    if kind == 'pond':
        terrain = collection('terrain')
        generate_terrain_solid(heights, 1.3, terrain)
        recess_terrain_basins(heights, bodies, terrain, 1.3)
    else:
        # As generation does: the terrain under cut water is set to its level.
        flatten_terrain_under_water(heights, bodies)
        cut_water_from_terrain(heights, bodies)
    supports = SupportBuilder(heights, -2, water_bodies=bodies) if enabled else None
    surfaces = collection('surfaces')
    features = [('land_use', [polygon('paving', [rectangle(1,1,10,10), list(reversed(rectangle(4,4,6,6)))], **{'class':'plaza'})])]
    for i, category in enumerate(('grass','forest','sand','rock')):
        features.append(('land', [polygon(category, [rectangle(11,3+i*3,17,5+i*3)], **{'class':category})]))
    generate_land_surfaces(features, Transform(), heights, surfaces, {}, settings, ground_support=supports)
    cut_water_land_surfaces(surfaces, bodies, .55, preserve_paved=enabled)
    paving = next(o for o in surfaces.objects if o.get('surface_category') == 'paved')
    assert_closed(paving)
    assert top(tree(paving), 5,5) is None, 'Paving courtyard filled'
    for obj in surfaces.objects:
        assert_closed(obj)
        if obj != paving:
            assert all(not (2.001 < v.co.x < 17.999 and 2.001 < v.co.y < 17.999) for v in obj.data.vertices), obj.name
    # A pond or fountain is set into the paving, never under a deck: the
    # plaza is cut around it even where supports keep paving over a river.
    if not enabled or kind == 'pond':
        assert top(tree(paving), 3,3) is None
        return
    supports.support_paved_surfaces(surfaces, .4, .15)
    assert set(supports.counts) == {'paved'}, supports.counts
    obj = supports.build(collection('foundations'))
    assert_closed(obj)
    foundation = top(tree(obj), 3,3)
    assert foundation >= bodies[0].top_mm + .2 - 1e-4
    assert abs(top(tree(paving), 3,3) - foundation - .45) < 1e-4
    for point in ((5,5),(12,4),(12,7),(12,10),(12,13)):
        assert top(tree(obj), *point) is None, ('Unwanted foundation', point)
    roads = collection('roads')
    generate_roads([road('crossing', [(2,3),(8,3)])], Transform(), heights, roads,
                   collection('bridges'), collection('piers'), {}, RoadSettings(), ground_support=supports)
    for obj in roads.objects:
        assert_closed(obj)
    assert top(tree(roads.objects[0]),3,3) >= foundation + .65 - 1e-4
    road_support = supports.build(collection('road_foundations'))
    assert abs(top(tree(roads.objects[0]),3,3) - top(tree(road_support),3,3) - .65) < 1e-4


for kind in ('pond','lake','uncut'):
    for enabled in (False, True):
        test_paving_and_natural_cover(kind, enabled)
print('JARVIZAR_PAVED_SUPPORTS_OK')
