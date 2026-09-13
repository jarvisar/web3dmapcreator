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
from blender_ground_support import feature as feature_polygon
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.roads import generate_roads, RoadSettings
from jarvizar_city_model.geometry.support import CUT_WATER_DROP_MM, SupportBuilder
from jarvizar_city_model.geometry.surfaces import (
    cut_water_from_terrain, flatten_terrain_under_water, solve_water_bodies,
)


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
    # As generation does: the low bed is raised to the bank before roads read it.
    flatten_terrain_under_water(field, bodies)
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


def test_bathymetric_water_is_levelled_to_its_shore():
    # Land west of x=9 at about 3 mm; a seabed falling away to the east, as
    # elevation data with bathymetry reports a bay. Two touching bodies with no
    # shore of their own apart from the land must share one level.
    field = ModelHeightField(0, 0, 20, 20, 21, 21,
                             [3+.01*y if x <= 9 else 1-.1*x for y in range(21) for x in range(21)])
    water = [feature_polygon('lake', rectangle(9.5, -1, 15, 21)),
             feature_polygon('lake', rectangle(15, -1, 21, 21))]
    bodies, _ = solve_water_bodies(water, Transform(), field)
    assert len(bodies) == 2 and all(body.cut for body in bodies)
    for body in bodies:
        # The low tenth of the interior shore nodes (3.01 .. 3.19 mm), not the
        # seabed, and not the cropped seabed along the frame edge.
        assert abs(body.bed_mm-3.02) < 1e-9, body.bed_mm
        assert abs(body.top_mm-(3.02-CUT_WATER_DROP_MM)) < 1e-9, body.top_mm
    flatten_terrain_under_water(field, bodies)
    pier = feature_polygon('pier', rectangle(12, 7.5, 14, 9.5))
    cut_water_from_terrain(field, bodies, transform=Transform(), footprints=[pier])
    assert abs(field.height_mm(12.5, 3)-3.02) < 1e-9, 'Seabed left under the cut'
    assert min(field.height_mm(9+i*.05, 3) for i in range(21)) >= 3.02-1e-9, 'Shore wedge'

    support = SupportBuilder(field, -1.3, water_bodies=bodies)
    # Kept ground already stands at the foundation grade: no second solid.
    assert abs(support.minimum_ground([rectangle(12, 7.5, 14, 9.5)], 'building')-3.02) < 1e-9
    assert not support.footprint([rectangle(12, 7.5, 14, 9.5)], 'building')
    assert support.footprint([rectangle(16, 4, 17, 6)], 'bridge_causeway')
    obj = make_roads(field, [(6, 12), (14, 12)], support)
    road_tree = tree(obj)
    for x in (7, 9.3, 10, 12):
        assert abs(top(road_tree, x, 12)-(field.height_mm(x, 12)+.6)) < .015, ('Road lifted', x)
    foundation = support.build(collection('bay_foundation'))
    assert_closed(foundation)
    support_tree = tree(foundation)
    assert abs(top(support_tree, 12, 12)-(bodies[0].top_mm+.2)) < 1e-4
    assert abs(top(support_tree, 16.5, 5)-(bodies[1].top_mm-.05)) < 1e-4, 'Causeway not submerged'
    assert top(support_tree, 13, 8.5) is None


test_road_crossing_irregular_shore_has_no_height_steps_or_support_gaps()
test_cut_ground_gets_support_without_an_explicit_water_minimum()
test_bathymetric_water_is_levelled_to_its_shore()
print('JARVIZAR_SHORE_ROADS_OK')
