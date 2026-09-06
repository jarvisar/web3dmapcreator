"""Water voids, mapped structures, and land slabs through Blender geometry.

Run: blender --background --factory-startup --python-exit-code 1
             --python tests/blender_water_cut.py

Fixtures use model millimetres directly so their expected footprints are
independent of geographic projection and do not require downloaded data.
"""

import sys
from collections import Counter
from pathlib import Path

import bpy
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.projection import ModelBounds
from jarvizar_city_model.geometry.dem_terrain import generate_terrain_solid
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.planar import faces_are_consistent
from jarvizar_city_model.geometry.support import SupportBuilder
from jarvizar_city_model.geometry.surfaces import (
    SurfaceSettings,
    cut_water_from_terrain,
    generate_land_surfaces,
    solve_water_bodies,
)


class FixtureTransform:
    model_bounds = ModelBounds(0.0, 20.0, 0.0, 20.0)
    scale_x_mm_per_m = 0.07
    scale_y_mm_per_m = 0.07

    def geographic_to_model(self, x, y, z):
        return x, y, z


def rectangle(left, bottom, right, top):
    return [(left, bottom), (right, bottom), (right, top), (left, top)]


def feature(class_name, *rings):
    return {
        "type": "Feature",
        "properties": {"class": class_name},
        "geometry": {
            "type": "Polygon",
            "coordinates": [list(ring) + [ring[0]] for ring in rings],
        },
    }


def collection(name):
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def flat_field():
    return ModelHeightField(0, 0, 20, 20, 41, 41, [0.0] * (41 * 41))


def mesh_tree(obj):
    return BVHTree.FromPolygons(
        [tuple(vertex.co) for vertex in obj.data.vertices],
        [tuple(face.vertices) for face in obj.data.polygons],
    )


def hits(tree, point):
    """Check the built geometry, independently of the mask's query helpers."""
    return tree.ray_cast((point[0], point[1], 10.0), (0.0, 0.0, -1.0))[0] is not None


def assert_closed(obj):
    edges = Counter(edge for face in obj.data.polygons for edge in face.edge_keys)
    assert edges and all(count == 2 for count in edges.values()), obj.name
    assert faces_are_consistent([tuple(face.vertices) for face in obj.data.polygons]), obj.name
    assert all(face.area > 1.0e-9 for face in obj.data.polygons), obj.name


def solve(field, water):
    bodies, counts = solve_water_bodies(water, FixtureTransform(), field)
    assert counts["water_rejected"] == 0, counts
    assert len(bodies) == len(water) and all(body.cut for body in bodies)
    return bodies


def build_terrain(field, name):
    target = collection(name)
    counts = generate_terrain_solid(field, 1.3, target)
    obj = target.objects[0]
    assert_closed(obj)
    return obj, counts["terrain_bottom_z_mm"]


def build_park(field, name):
    target = collection(name)
    counts = generate_land_surfaces(
        [("land_use", [feature("park", rectangle(0.6, 0.6, 19.4, 19.4))])],
        FixtureTransform(), field, target, {}, SurfaceSettings(),
    )
    assert counts["land_surfaces_clipped_to_land"] == 1, counts
    assert len(target.objects) == 1
    assert_closed(target.objects[0])
    return target.objects[0]


def test_marina_does_not_refill_the_harbor():
    field = flat_field()
    lake = feature(
        "lake", rectangle(2.4, 2.4, 17.6, 17.6),
        rectangle(6.4, 6.4, 9.6, 9.6),
    )
    # A marina is an area of use containing open water and individual decks.
    marina = feature("marina", rectangle(11.2, 4.2, 17.2, 15.8))
    # These actual structures are narrower than the 0.5 mm terrain grid;
    # their pedestals must survive even when no grid node can be restored.
    pier = feature("pier", rectangle(12.3, 1.5, 12.5, 7.5))
    breakwater = feature("breakwater", rectangle(15.3, 10.5, 15.5, 18.5))
    bodies = solve(field, [lake])
    counts = cut_water_from_terrain(
        field, bodies,
        [("land_use", [marina]), ("infrastructure", [pier, breakwater])],
        FixtureTransform(),
    )
    assert counts["water_cut_bodies"] == 1, counts

    terrain, bottom = build_terrain(field, "marina_terrain")
    supports = SupportBuilder(field, bottom)
    for rings in field.restored_footprints:
        assert supports.footprint(rings, "mapped_deck")
    support_obj = supports.build(collection("marina_supports"))
    assert support_obj is not None
    terrain_tree, support_tree = mesh_tree(terrain), mesh_tree(support_obj)

    # Probe a grid through the harbor interior, clear of both narrow decks.
    harbor = [(x, y) for x in (11.6, 13.1, 14.2, 16.4)
              for y in (4.7, 8.3, 11.7, 15.1)]
    for point in harbor:
        assert not hits(terrain_tree, point), ("Terrain refilled marina water", point)
        assert not hits(support_tree, point), ("Support refilled marina water", point)
        assert field.over_open_water(*point), point
    assert supports.summary()["terrain_supports"] == 2, supports.summary()
    assert counts["water_cut_decks_over_water"] == 2, counts
    assert_closed(support_obj)
    for point in ((12.4, 5.3), (15.4, 13.3)):
        assert hits(support_tree, point), ("Mapped structure lost its support", point)
        assert field.is_supported(*point), point
        assert not field.over_open_water(*point), point
    for point in ((8.2, 8.1), (1.2, 8.3), (18.4, 8.3)):
        assert hits(terrain_tree, point), ("Island or bank was removed", point)
        assert not field.in_cut_water(*point), point

    park_tree = mesh_tree(build_park(field, "marina_park"))
    for point in harbor + [(4.3, 8.1), (8.2, 11.3)]:
        assert not hits(park_tree, point), ("Land slab remains over water", point)
    for point in ((8.2, 8.1), (1.2, 8.3), (18.4, 8.3)):
        assert hits(park_tree, point), ("Dry park or island was removed", point)


def test_overlapping_water_uses_the_complete_union():
    # Both western boundaries cross the same terrain edge. Taking the inner
    # boundary leaves a strip of terrain inside the first water polygon.
    west = feature("lake", rectangle(2.1, 2.3, 15.2, 17.7))
    east = feature("lake", rectangle(2.4, 4.4, 17.7, 15.6))
    for index, water in enumerate(([west, east], [east, west])):
        field = flat_field()
        cut_water_from_terrain(field, solve(field, water))
        terrain, _bottom = build_terrain(field, "overlap_terrain_" + str(index))
        park = build_park(field, "overlap_park_" + str(index))
        for obj in (terrain, park):
            tree = mesh_tree(obj)
            for point in ((2.2, 8.25), (2.2, 12.25), (16.3, 8.25), (8.3, 16.3)):
                assert not hits(tree, point), ("Overlapping water left land", obj.name, point)
            assert hits(tree, (1.9, 8.25)), ("Union removed the dry bank", obj.name)


def main():
    test_marina_does_not_refill_the_harbor()
    test_overlapping_water_uses_the_complete_union()
    print("JARVIZAR_WATER_CUT_OK")


main()
