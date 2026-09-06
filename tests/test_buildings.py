"""Tests for deterministic height fallback and parent/part selection."""

import unittest

from jarvizar_city_model.geometry.buildings import (
    class_default_height_m,
    footprint_admits_minimum_height,
    resolve_vertical_profile,
    select_building_geometry,
)


def feature(identifier, **properties):
    return {
        "type": "Feature",
        "id": identifier,
        "properties": properties,
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        },
    }


class VerticalProfileTests(unittest.TestCase):
    def test_prefers_explicit_height(self):
        profile = resolve_vertical_profile(
            {"height": 12, "num_floors": 20}, 3.0, 10.0
        )
        self.assertEqual(profile.height_m, 12.0)
        self.assertEqual(profile.height_source, "height")

    def test_uses_floor_count_then_default_without_randomness(self):
        floors = resolve_vertical_profile({"num_floors": 4}, 3.2, 9.0)
        missing_a = resolve_vertical_profile({}, 3.2, 9.0)
        missing_b = resolve_vertical_profile({}, 3.2, 9.0)
        self.assertEqual(floors.height_m, 12.8)
        self.assertEqual(floors.height_source, "num_floors")
        self.assertEqual(missing_a, missing_b)
        self.assertEqual(missing_a.height_m, 9.0)
        self.assertEqual(missing_a.height_source, "default")

    def test_min_height_then_min_floor(self):
        explicit = resolve_vertical_profile(
            {"min_height": 4, "min_floor": 3}, 3.0, 10.0
        )
        floors = resolve_vertical_profile({"min_floor": 2}, 3.0, 10.0)
        self.assertEqual((explicit.bottom_m, explicit.min_height_source), (4.0, "min_height"))
        self.assertEqual((floors.bottom_m, floors.min_height_source), (6.0, "min_floor"))


class AbsoluteHeightTests(unittest.TestCase):
    """Overture measures height from the ground, not from ``min_height``."""

    def test_an_elevated_part_ends_at_its_stated_height(self):
        # Great American Tower is 202.7 m and its crown section is published as
        # min_height 140 / height 162.7.  Adding those gives a 302.7 m spire.
        crown = resolve_vertical_profile({"height": 162.7, "min_height": 140.0}, 3.0, 10.0)
        self.assertAlmostEqual(crown.top_m, 162.7)
        self.assertAlmostEqual(crown.bottom_m, 140.0)
        self.assertAlmostEqual(crown.thickness_m, 22.7)

    def test_a_ground_founded_mass_is_as_thick_as_it_is_tall(self):
        block = resolve_vertical_profile({"height": 40.0}, 3.0, 10.0)
        self.assertEqual((block.bottom_m, block.top_m, block.thickness_m), (0.0, 40.0, 40.0))

    def test_a_mass_that_ends_below_where_it_starts_still_gets_substance(self):
        broken = resolve_vertical_profile({"height": 5.0, "min_height": 9.0}, 3.0, 10.0)
        self.assertEqual(broken.bottom_m, 9.0)
        self.assertEqual(broken.top_m, 12.0)
        self.assertIn("inverted", broken.height_source)


class ClassDefaultHeightTests(unittest.TestCase):
    def test_a_heightless_stadium_is_not_a_single_storey(self):
        stadium = resolve_vertical_profile({"class": "stadium"}, 3.0, 10.0)
        self.assertEqual(stadium.top_m, 30.0)
        self.assertEqual(stadium.height_source, "class_default:stadium")

    def test_a_heightless_shed_is_not_a_stadium(self):
        self.assertEqual(resolve_vertical_profile({"class": "shed"}, 3.0, 10.0).top_m, 3.0)

    def test_an_explicit_height_always_wins_over_the_class(self):
        profile = resolve_vertical_profile({"class": "stadium", "height": 21.0}, 3.0, 10.0)
        self.assertEqual((profile.top_m, profile.height_source), (21.0, "height"))

    def test_an_unknown_class_falls_back_to_the_configured_default(self):
        self.assertEqual(class_default_height_m({"class": "spaceport"}, 9.0), (9.0, "default"))

    def test_subtype_is_consulted_when_class_says_nothing(self):
        height, source = class_default_height_m({"subtype": "residential"}, 9.0)
        self.assertEqual((height, source), (12.0, "class_default:residential"))


class SelectionTests(unittest.TestCase):
    def test_useful_parts_replace_advertised_parent(self):
        parent = feature("parent", has_parts=True, height=20)
        parts = [
            feature("p1", building_id="parent", height=8),
            feature("p2", building_id="parent"),
        ]
        selection = select_building_geometry([parent], parts)
        self.assertEqual(selection.buildings, ())
        self.assertEqual({item["id"] for item in selection.parts}, {"p1", "p2"})
        self.assertEqual(selection.suppressed_parent_ids, frozenset({"parent"}))

    def test_uninformative_parts_do_not_replace_parent(self):
        parent = feature("parent", has_parts=True)
        part = feature("p1", building_id="parent")
        selection = select_building_geometry([parent], [part])
        self.assertEqual([item["id"] for item in selection.buildings], ["parent"])
        self.assertEqual(selection.parts, ())

    def test_does_not_emit_underground_geometry(self):
        parent = feature("parent", is_underground=True)
        orphan = feature(
            "orphan", building_id="outside", height=5, is_underground=True
        )
        selection = select_building_geometry([parent], [orphan])
        self.assertEqual(selection.buildings, ())
        self.assertEqual(selection.parts, ())


class MinimumHeightFootprintTests(unittest.TestCase):
    """The size gate on stretching a mass to the minimum printed height."""

    def square(self, side):
        return [(0.0, 0.0), (side, 0.0), (side, side), (0.0, side)]

    def rectangle(self, width, length):
        return [(0.0, 0.0), (length, 0.0), (length, width), (0.0, width)]

    def test_square_of_exactly_the_threshold_qualifies(self):
        self.assertTrue(footprint_admits_minimum_height(self.square(0.6), 0.6))

    def test_larger_square_qualifies(self):
        self.assertTrue(footprint_admits_minimum_height(self.square(2.4), 0.6))

    def test_shed_below_the_threshold_is_left_alone(self):
        # A garden shed: big enough to print, too small to stretch.
        self.assertFalse(footprint_admits_minimum_height(self.square(0.4), 0.6))

    def test_ribbon_with_enough_area_is_left_alone(self):
        # A wall fragment or a row of garages: 0.1 x 4.0 has more than twice
        # the area of the threshold square and would stretch into a fin.
        ribbon = self.rectangle(0.1, 4.0)
        self.assertGreater(abs(_area(ribbon)), 0.6 * 0.6)
        self.assertFalse(footprint_admits_minimum_height(ribbon, 0.6))

    def test_wide_low_building_qualifies(self):
        # A warehouse: short in real life, and exactly what the minimum is for.
        self.assertTrue(footprint_admits_minimum_height(self.rectangle(1.2, 6.0), 0.6))

    def test_winding_does_not_matter(self):
        clockwise = list(reversed(self.square(1.0)))
        self.assertTrue(footprint_admits_minimum_height(clockwise, 0.6))

    def test_zero_threshold_admits_everything(self):
        self.assertTrue(footprint_admits_minimum_height(self.square(0.01), 0.0))

    def test_degenerate_ring_is_rejected(self):
        self.assertFalse(footprint_admits_minimum_height([(0.0, 0.0), (1.0, 1.0)], 0.6))


def _area(ring):
    count = len(ring)
    return 0.5 * sum(
        ring[i][0] * ring[(i + 1) % count][1] - ring[(i + 1) % count][0] * ring[i][1]
        for i in range(count)
    )


if __name__ == "__main__":
    unittest.main()

