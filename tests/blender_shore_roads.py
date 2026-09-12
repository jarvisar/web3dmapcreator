"""Waterfront surface roads share their supports' continuous terrain grade.

Run with background Blender and --python-exit-code 1.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))

from blender_ground_support import collection, rectangle, tree, top, assert_closed, FixtureTransform
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.roads import generate_roads, RoadSettings
from jarvizar_city_model.geometry.support import SupportBuilder
from jarvizar_city_model.geometry.surfaces import solve_water_bodies, cut_water_from_terrain


class Transform(FixtureTransform):
    metric_bounds = SimpleNamespace(min_east_m=0, min_north_m=0,
                                   max_east_m=20/.07, max_north_m=20/.07)
    projection = SimpleNamespace(forward=lambda x, y, z: (x/.07, y/.07, z))

    def vertical_meters_to_model_mm(self, z):
        return z*.07


def feature(points):
    return {'type': 'Feature', 'properties': {'subtype': 'road', 'class': 'footway'},
            'geometry': {'type': 'LineString', 'coordinates': points}}


def make_roads(field, points, support=None, enabled=True):
    target = collection('shore_roads')
    counts = generate_roads([feature(points)], Transform(), field, target,
                            collection('decks'), collection('piers'), {},
                            RoadSettings(include_bridges=False, support_over_water=enabled),
                            ground_support=support)
    assert counts['surface_roads'] == 1, counts
    obj = target.objects[0]
    assert_closed(obj)
    return obj


def snapshot(obj):
    return ([v.co[:] for v in obj.data.vertices], [p.vertices[:] for p in obj.data.polygons])


def test_road_crossing_irregular_shore_has_no_height_steps_or_support_gaps():
    # A sloping bank and a low water bed. A straight path crosses back and
    # forth over the shoreline; nearest-bank sampling would jump at each cut.
    field = ModelHeightField(0, 0, 20, 20, 11, 11,
                             [3+.1*y if x <= 10 else 1 for y in range(0, 21, 2)
                              for x in range(0, 21, 2)])
    shore = [(10.2, 1), (19, 1), (19, 19), (10.2, 19), (10.8, 16),
             (10.2, 13), (10.8, 10), (10.2, 7), (10.8, 4)]
    water = {'type': 'Feature', 'properties': {'class': 'lake'},
             'geometry': {'type': 'Polygon', 'coordinates': [shore+[shore[0]]]}}
    bodies, _ = solve_water_bodies([water], Transform(), field)
    cut_water_from_terrain(field, bodies)
    support = SupportBuilder(field, -1.3, water_bodies=bodies)
    points = [(10.5, 2), (10.5, 4), (10.5, 18)]
    obj = make_roads(field, points, support)
    foundation = support.build(collection('shore_foundation'))
    assert foundation is not None
    assert_closed(foundation)
    road_tree, support_tree = tree(obj), tree(foundation)
    wet = set()
    for i in range(1, 160):
        x, y = 10.5, 2+i*.1
        wet.add(field.in_cut_water(x, y))
        road_top = top(road_tree, x, y)
        # Preserve the real slope instead of flattening the waterfront road.
        assert abs(road_top-(field.height_mm(x, y)+.6)) < .015, (x, y, road_top)
        assert road_top-.75 < top(support_tree, x, y), ('Gap under road', x, y)
    assert wet == {False, True}, 'Fixture must cross both sides of the shore'
    assert top(road_tree, 10.5, 17) > top(road_tree, 10.5, 3)+.5
    assert top(support_tree, 15, 10) is None, 'Unrelated open water filled'

    # Ordinary inland geometry and the support-disabled option stay identical.
    dry = [(2, 2), (2, 18)]
    support_count = field.support_count
    assert snapshot(make_roads(field, dry)) == snapshot(make_roads(field, dry, support))
    assert field.support_count == support_count, 'Inland road registered unnecessary ground'
    assert snapshot(make_roads(field, points)) == snapshot(
        make_roads(field, points, support, enabled=False))


def test_cut_ground_gets_support_without_an_explicit_water_minimum():
    # Supports can be needed by the actual terrain cut even without overlap
    # with a water-level footprint (e.g. the grid approximates a narrow bank).
    field = ModelHeightField(0, 0, 20, 20, 11, 11, [2.0]*121)
    mask = field.new_void_mask()
    mask.add_polygon([rectangle(10.4, 1, 19, 19)])
    support = SupportBuilder(field, -1.3)
    obj = make_roads(field, [(10.3, 2), (10.3, 18)], support)
    foundation = support.build(collection('cut_only_foundation'))
    assert foundation is not None, 'Cut edge of the built road was left unsupported'
    assert_closed(foundation)
    assert abs(top(tree(obj), 10.45, 10)-top(tree(foundation), 10.45, 10)-.65) < 1e-4


test_road_crossing_irregular_shore_has_no_height_steps_or_support_gaps()
test_cut_ground_gets_support_without_an_explicit_water_minimum()
print('JARVIZAR_SHORE_ROADS_OK')
