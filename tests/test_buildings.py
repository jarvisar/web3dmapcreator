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

    def test_inverted_interval_does_not_invent_a_taller_top(self):
        broken = resolve_vertical_profile({"height": 5.0, "min_height": 9.0}, 3.0, 10.0)
        self.assertEqual(broken.bottom_m, 9.0)
        self.assertEqual(broken.top_m, 5.0)
        self.assertLess(broken.thickness_m, 0.0)
        self.assertIn("invalid_interval", broken.height_source)

    def test_finite_values_and_explicit_units(self):
        for value in (float("inf"), float("nan"), True, "20;40"):
            self.assertEqual(resolve_vertical_profile({"height": value}, 3, 10).top_m, 10)
        self.assertAlmostEqual(resolve_vertical_profile({"height": "100 ft"}, 3, 10).top_m, 30.48)
        self.assertAlmostEqual(resolve_vertical_profile({"height": "7'4\""}, 3, 10).top_m, 2.2352)

    def test_osm_levels_are_top_levels_not_added_to_minimum(self):
        profile = resolve_vertical_profile({"building:levels": 10, "building:min_level": 8}, 3, 10)
        self.assertEqual((profile.bottom_m, profile.top_m), (24, 30))

    def test_minimum_only_part_does_not_suppress_parent(self):
        parent = feature("parent", has_parts=True, height=20)
        selection = select_building_geometry([parent], [feature("part", building_id="parent", min_height=200)])
        self.assertEqual(selection.buildings, (parent,))
        self.assertFalse(selection.parts)


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
    def rectangle(self, identifier, bounds=(0, 0, 10, 10), **properties):
        result = feature(identifier, **properties)
        x0, y0, x1, y1 = bounds
        result["geometry"]["coordinates"] = [
            [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
        ]
        return result

    def test_partial_upper_roof_keeps_explicit_main_mass(self):
        parent = self.rectangle("parent", has_parts=True, height=340)
        roof = self.rectangle("roof", (2, 2, 8, 8), building_id="parent", height=346)
        selection = select_building_geometry([parent], [roof])
        self.assertEqual(selection.buildings, (parent,))
        self.assertEqual(selection.parts, (roof,))
        self.assertFalse(selection.suppressed_parent_ids)

    def test_complete_upper_parts_already_supply_main_mass(self):
        parent = self.rectangle("parent", has_parts=True, height=340)
        parts = [
            self.rectangle("west", (0, 0, 5, 10), building_id="parent", height=346),
            self.rectangle("east", (5, 0, 10, 10), building_id="parent", height=346),
        ]
        selection = select_building_geometry([parent], parts)
        self.assertFalse(selection.buildings)
        self.assertEqual(selection.parts, tuple(parts))

    def test_lower_setback_prevents_filling_parent_to_total_height(self):
        parent = self.rectangle("parent", has_parts=True, height=100)
        parts = [
            self.rectangle("roof", (3, 3, 7, 7), building_id="parent", height=105),
            self.rectangle("podium", (0, 0, 3, 10), building_id="parent", height=20),
        ]
        selection = select_building_geometry([parent], parts)
        self.assertFalse(selection.buildings)
        self.assertEqual(selection.parts, tuple(parts))

    def test_incomplete_heights_do_not_infer_a_parent_main_mass(self):
        roof = self.rectangle("roof", (2, 2, 8, 8), building_id="parent", height=346)
        for props in ({}, {"num_floors": 83}):
            parent = self.rectangle("parent", has_parts=True, **props)
            self.assertFalse(select_building_geometry([parent], [roof]).buildings)

    def test_heightless_detail_does_not_erase_recorded_podium(self):
        parent = self.rectangle("parent", has_parts=True, height=10, num_floors=2)
        tower = self.rectangle("tower", (0, 0, 4, 10), building_id="parent", height=100)
        unknown = self.rectangle("unknown", (5, 5, 7, 7), building_id="parent")
        selection = select_building_geometry([parent], [tower, unknown])
        self.assertEqual(selection.buildings, (parent,))
        self.assertEqual(selection.parts, (tower, unknown))
        self.assertFalse(selection.suppressed_parent_ids)
        self.assertNotIn("height", unknown["properties"])

    def test_heightless_coverage_cannot_replace_recorded_mass(self):
        parent = self.rectangle("parent", has_parts=True, height=100)
        tower = self.rectangle("tower", (0, 0, 4, 10), building_id="parent", height=100)
        unknown = self.rectangle("unknown", (4, 0, 10, 10), building_id="parent")
        self.assertEqual(select_building_geometry([parent], [tower, unknown]).buildings, (parent,))
        # Complete known-height coverage still replaces the redundant parent.
        unknown["properties"]["height"] = 100
        self.assertFalse(select_building_geometry([parent], [tower, unknown]).buildings)

    def test_known_lower_or_invalid_part_still_blocks_parent_infill(self):
        parent = self.rectangle("parent", has_parts=True, height=100)
        tower = self.rectangle("tower", (0, 0, 4, 10), building_id="parent", height=110)
        unknown = self.rectangle("unknown", (5, 5, 7, 7), building_id="parent")
        for props in ({"height": 20}, {"num_floors": 6}, {"height": 20, "min_height": 25}):
            with self.subTest(props=props):
                lower = self.rectangle("lower", (4, 0, 10, 4), building_id="parent", **props)
                selection = select_building_geometry([parent], [tower, unknown, lower])
                self.assertFalse(selection.buildings)
                self.assertEqual(selection.parts, (tower, unknown, lower))

    def test_derived_parent_height_does_not_supply_missing_main_mass(self):
        roof = self.rectangle("roof", (2, 2, 8, 8), building_id="parent", height=346)
        for dataset in ("Microsoft ML Buildings", "USGS Lidar"):
            parent = self.rectangle("parent", has_parts=True, height=12, sources=[{
                "property": "/properties/height", "dataset": dataset,
            }])
            self.assertFalse(select_building_geometry([parent], [roof]).buildings)
        # The footprint's provider does not imply that its height was estimated.
        parent["properties"]["sources"][0]["property"] = ""
        self.assertEqual(select_building_geometry([parent], [roof]).buildings, (parent,))

    def test_equal_height_partial_part_keeps_recorded_parent_extent(self):
        parent = self.rectangle("parent", has_parts=True, height=100)
        part = self.rectangle("part", (2, 2, 8, 8), building_id="parent", height=100)
        selection = select_building_geometry([parent], [part])
        self.assertEqual(selection.buildings, (parent,))
        self.assertEqual(selection.parts, (part,))

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
