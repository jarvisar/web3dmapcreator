"""Necessary water supports follow the terrain across their cap interiors.

Run: blender --background --factory-startup --python-exit-code 1
             --python tests/blender_ground_support.py
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
from jarvizar_city_model.geometry.surfaces import cut_water_from_terrain, solve_water_bodies


class FixtureTransform:
    model_bounds = ModelBounds(0.0, 20.0, 0.0, 20.0)
    scale_x_mm_per_m = 0.07
    scale_y_mm_per_m = 0.07

    def geographic_to_model(self, x, y, z):
        return x, y, z


def rectangle(left, bottom, right, top):
    return [(left, bottom), (right, bottom), (right, top), (left, top)]


def feature(class_name, ring):
    return {
        "type": "Feature",
        "properties": {"class": class_name},
        "geometry": {"type": "Polygon", "coordinates": [ring + [ring[0]]]},
    }


def collection(name):
    target = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(target)
    return target


def field():
    return ModelHeightField(0, 0, 20, 20, 41, 41, [0.0] * (41 * 41))


def cut(heightfield, water, decks=()):
    bodies, counts = solve_water_bodies(water, FixtureTransform(), heightfield)
    assert len(bodies) == len(water) and all(body.cut for body in bodies), counts
    return cut_water_from_terrain(
        heightfield, bodies, [("infrastructure", decks)], FixtureTransform(),
    )


def terrain(heightfield, name):
    target = collection(name)
    counts = generate_terrain_solid(heightfield, 1.3, target)
    return target.objects[0], counts["terrain_bottom_z_mm"]


def tree(obj):
    return BVHTree.FromPolygons(
        [tuple(vertex.co) for vertex in obj.data.vertices],
        [tuple(face.vertices) for face in obj.data.polygons],
    )


def top(bvh, x, y):
    hit = bvh.ray_cast((x, y, 10.0), (0.0, 0.0, -1.0))[0]
    return hit.z if hit is not None else None


def assert_closed(obj):
    edges = Counter(edge for face in obj.data.polygons for edge in face.edge_keys)
    assert edges and all(count == 2 for count in edges.values()), obj.name
    assert faces_are_consistent([tuple(face.vertices) for face in obj.data.polygons]), obj.name


def test_existing_dry_ground_needs_no_pedestal():
    heightfield = field()
    lake = feature("lake", rectangle(10.4, 2.4, 18.0, 17.6))
    # The first candidate's generous grid window touches water even though
    # its own footprint lies wholly on the dry side of the shore.
    dry = feature("pier", rectangle(9.65, 5.0, 10.3, 8.0))
    # A node-aligned deck connecting both dry banks is already retained
    # completely in the terrain, including its ends.
    resolved = feature("pier", rectangle(12.0, 1.0, 15.0, 19.0))
    counts = cut(heightfield, [lake], [dry, resolved])
    assert counts["water_cut_decks_over_water"] == 2, counts
    obj, bottom = terrain(heightfield, "already_grounded_terrain")
    bvh = tree(obj)
    assert top(bvh, 10.1, 6.25) is not None
    assert top(bvh, 13.25, 8.25) is not None

    supports = SupportBuilder(heightfield, bottom)
    for rings in heightfield.restored_footprints:
        assert not supports.footprint(rings, "mapped_deck"), "Dry ground gained a pedestal"
    assert supports.build(collection("unneeded_supports")) is None
    assert supports.summary()["terrain_supports"] == 0
    # Bridge pier placement uses the conservative whole-cell ground query.
    # A dry mapped deck must keep that ground classification even when its
    # nearshore terrain needs no additional pedestal mesh.
    assert heightfield.has_ground(10.1, 6.25), "Skipped mapped deck lost its ground"
    assert heightfield.has_ground(13.25, 8.25)
    assert heightfield.over_open_water(16.2, 8.25), "Unrelated lake gained ground"

    no_water = field()
    empty = SupportBuilder(no_water, -1.3)
    assert not empty.footprint([rectangle(3.2, 3.2, 7.8, 7.8)], "building")
    assert empty.build(collection("dry_supports")) is None


def test_necessary_support_drapes_its_interior_and_keeps_its_hole():
    heightfield = field()
    # A broad, flat-bottomed depression lies wholly inside the footprint;
    # all footprint boundary vertices are on the higher surrounding ground.
    for row in range(heightfield.rows):
        for column in range(heightfield.columns):
            if 8.0 <= column * 0.5 <= 12.0 and 8.0 <= row * 0.5 <= 12.0:
                heightfield.values[row * heightfield.columns + column] = -1.0
    cut(heightfield, [feature("lake", rectangle(14.4, 2.4, 18.0, 17.6))])
    obj, bottom = terrain(heightfield, "draped_support_terrain")
    terrain_tree = tree(obj)
    supports = SupportBuilder(heightfield, bottom)
    outline = rectangle(4.2, 4.2, 16.8, 16.8)
    hole = list(reversed(rectangle(5.5, 5.5, 7.5, 7.5)))
    assert supports.footprint([outline, hole], "building")
    assert supports.builder.solids == 1
    assert not supports.footprint([outline, hole], "building")
    assert supports.builder.solids == 1, "Existing support gained a duplicate solid"
    support_obj = supports.build(collection("draped_supports"))
    assert support_obj is not None
    assert_closed(support_obj)
    support_tree = tree(support_obj)

    # These cap-interior probes lie at least one default 1.5 mm drape step
    # inside the flat trough. They can be compared with the actual mesh to
    # float32 tolerance without assuming that bilinear grid sampling exactly
    # matches Blender's triangles along the sloping transition cells.
    for x in (9.6, 10.2, 10.4):
        for y in (9.6, 10.2, 10.4):
            land_z = top(terrain_tree, x, y)
            support_z = top(support_tree, x, y)
            assert land_z is not None and support_z is not None
            assert abs(support_z - (land_z - 0.05)) < 1.0e-4, (
                "Support cap spans the terrain depression", x, y, support_z, land_z,
            )
    # Its wet end remains a real foundation, sharing the terrain's underside.
    assert top(terrain_tree, 16.1, 10.2) is None
    assert abs(top(support_tree, 16.1, 10.2) + 0.05) < 1.0e-4
    assert heightfield.is_supported(16.1, 10.2)
    assert top(support_tree, 6.3, 6.4) is None, "Support filled its mapped hole"
    assert not heightfield.is_supported(6.3, 6.4)
    assert abs(min(vertex.co.z for vertex in support_obj.data.vertices) - bottom) < 1.0e-4
    assert supports.summary()["terrain_supports"] == 1


def main():
    test_existing_dry_ground_needs_no_pedestal()
    test_necessary_support_drapes_its_interior_and_keeps_its_hole()
    print("JARVIZAR_GROUND_SUPPORT_OK")


if __name__ == "__main__":
    main()
