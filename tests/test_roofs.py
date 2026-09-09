"""Roof shapes: semantics of the source fields and closure of the solids."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.linework import printable_width_m
from jarvizar_city_model.geometry.buildings import resolve_vertical_profile
from jarvizar_city_model.geometry.planar import signed_area
from jarvizar_city_model.geometry.roofs import (
    apex_levels,
    apex_solid_geometry,
    clip_ring_linear,
    planar_roof_regions,
    resolve_roof,
    ridge_frame,
    roof_kind,
    skillion_heights,
)
from test_terrain_cut import manifold_report

SQUARE = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)]
HOUSE = [(0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (0.0, 4.0)]
OCTAGON = [
    (math.cos(math.tau * i / 8) * 3.0, math.sin(math.tau * i / 8) * 3.0) for i in range(8)
]
L_SHAPE = [(0.0, 0.0), (6.0, 0.0), (6.0, 2.0), (2.0, 2.0), (2.0, 6.0), (0.0, 6.0)]


class RoofSemanticsTests(unittest.TestCase):
    def test_shapes_fold_onto_constructions(self):
        self.assertEqual(roof_kind("pyramidal"), "pyramid")
        self.assertEqual(roof_kind("onion"), "dome")
        self.assertEqual(roof_kind("Gabled "), "gabled")
        self.assertEqual(roof_kind(None), "flat")
        self.assertEqual(roof_kind("hyperbolic-paraboloid"), "unsupported")

    def test_a_part_roof_sits_on_top_of_its_height(self):
        """The Great American Tower crown: 140 -> 162.7 walls, 40 m dome above."""
        properties = {"height": 162.7, "min_height": 140.0, "roof_shape": "dome", "roof_height": 40.0}
        profile = resolve_vertical_profile(properties, 3.0, 10.0)
        roof = resolve_roof(properties, profile, is_part=True, parent_top_m=202.7, footprint_width_m=20.0)
        self.assertEqual(roof.kind, "dome")
        self.assertAlmostEqual(roof.wall_top_m, 162.7)
        self.assertAlmostEqual(roof.roof_top_m, 202.7)
        self.assertEqual(roof.source, "roof_height+parent_corroborated_walls")

    def test_a_part_roof_is_inside_its_own_total(self):
        properties = {"height": 30.0, "roof_shape": "pyramidal", "roof_height": 20.0}
        profile = resolve_vertical_profile(properties, 3.0, 10.0)
        roof = resolve_roof(properties, profile, is_part=True, parent_top_m=40.0, footprint_width_m=10.0)
        self.assertAlmostEqual(roof.roof_top_m, 30.0)
        self.assertEqual(roof.source, "roof_height")

    def test_chicago_roof_height_is_not_counted_twice(self):
        properties = {"height": 177.4, "roof_height": 73, "roof_shape": "skillion"}
        for parent in (177, 177.4, None):
            roof = resolve_roof(properties, resolve_vertical_profile(properties, 3, 10), True, parent, 30)
            self.assertAlmostEqual(roof.roof_top_m, 177.4)
            self.assertAlmostEqual(roof.wall_top_m, 104.4)

    def test_default_part_roof_cannot_increase_explicit_height(self):
        properties = {"height": 184, "roof_shape": "hipped"}
        roof = resolve_roof(properties, resolve_vertical_profile(properties, 3, 10), True, 184, 20)
        self.assertEqual(roof.roof_top_m, 184)

    def test_roof_is_added_once_to_floor_derived_walls(self):
        properties = {"num_floors": 3, "roof_shape": "gabled", "roof_height": 2}
        for is_part in (False, True):
            roof = resolve_roof(properties, resolve_vertical_profile(properties, 3, 10), is_part, None, 10)
            self.assertEqual((roof.wall_top_m, roof.roof_top_m), (9, 11))

    def test_ambiguous_crown_does_not_get_legacy_addition(self):
        properties = {"height": 162.7, "min_height": 140, "roof_shape": "dome", "roof_height": 40}
        roof = resolve_roof(properties, resolve_vertical_profile(properties, 3, 10), True, None, 20)
        self.assertEqual(roof.roof_top_m, 162.7)

    def test_a_whole_building_keeps_its_roof_inside_its_height(self):
        properties = {"height": 8.0, "roof_shape": "gabled", "roof_height": 3.0}
        profile = resolve_vertical_profile(properties, 3.0, 10.0)
        roof = resolve_roof(properties, profile, is_part=False, parent_top_m=None, footprint_width_m=8.0)
        self.assertAlmostEqual(roof.wall_top_m, 5.0)
        self.assertAlmostEqual(roof.roof_top_m, 8.0)

    def test_an_oversized_roof_leaves_some_wall(self):
        properties = {"height": 6.0, "roof_shape": "gabled", "roof_height": 9.0}
        profile = resolve_vertical_profile(properties, 3.0, 10.0)
        roof = resolve_roof(properties, profile, is_part=False, parent_top_m=None, footprint_width_m=8.0)
        self.assertGreater(roof.wall_top_m, 0.0)
        self.assertAlmostEqual(roof.roof_top_m, 6.0)

    def test_a_missing_roof_height_is_a_recorded_default(self):
        properties = {"height": 8.0, "roof_shape": "hipped"}
        profile = resolve_vertical_profile(properties, 3.0, 10.0)
        roof = resolve_roof(properties, profile, is_part=False, parent_top_m=None, footprint_width_m=8.0)
        self.assertEqual(roof.source, "default")
        self.assertGreater(roof.height_m, 0.0)

    def test_flat_and_unsupported_shapes_add_nothing(self):
        profile = resolve_vertical_profile({"height": 8.0}, 3.0, 10.0)
        flat = resolve_roof({"roof_shape": "flat", "roof_height": 3.0}, profile, False, None, 8.0)
        self.assertEqual((flat.kind, flat.wall_top_m, flat.roof_top_m), ("flat", 8.0, 8.0))
        odd = resolve_roof({"roof_shape": "hyperbolic-paraboloid"}, profile, False, None, 8.0)
        self.assertEqual(odd.kind, "unsupported")
        self.assertFalse(odd.is_shaped)


class SkillionTests(unittest.TestCase):
    def test_the_low_edge_faces_the_roof_direction(self):
        # Bearing 90 is east: the east edge is at the wall top, the west at the ridge.
        heights = skillion_heights(SQUARE, 90.0, wall_top=10.0, roof_top=13.0)
        by_x = {x: z for (x, _y), z in zip(SQUARE, heights)}
        self.assertAlmostEqual(by_x[4.0], 10.0)
        self.assertAlmostEqual(by_x[0.0], 13.0)

    def test_without_a_direction_the_slope_runs_across_the_short_axis(self):
        frame = ridge_frame(HOUSE)
        heights = skillion_heights(HOUSE, None, 10.0, 13.0, frame)
        self.assertIsNotNone(heights)
        self.assertAlmostEqual(min(heights), 10.0)
        self.assertAlmostEqual(max(heights), 13.0)


class PlanarRegionTests(unittest.TestCase):
    def test_half_plane_clip_is_exact(self):
        values = [x - 1.0 for x, _y in SQUARE]
        kept = clip_ring_linear(SQUARE, values)
        self.assertAlmostEqual(abs(signed_area(kept)), 12.0)
        self.assertTrue(all(x >= 1.0 - 1e-9 for x, _y in kept))

    def test_gable_regions_cover_the_house_and_peak_on_the_ridge(self):
        frame = ridge_frame(HOUSE)
        self.assertAlmostEqual(frame.half_length, 5.0)
        self.assertAlmostEqual(frame.half_width, 2.0)
        regions = planar_roof_regions(HOUSE, "gabled", frame, wall_top=5.0, roof_top=8.0)
        self.assertEqual(len(regions), 2)
        covered = sum(abs(signed_area([(x, y) for x, y, _z in region])) for region in regions)
        self.assertAlmostEqual(covered, 40.0)
        tops = [z for region in regions for _x, _y, z in region]
        self.assertAlmostEqual(min(tops), 5.0)
        self.assertAlmostEqual(max(tops), 8.0)
        # The ridge vertices lie on the long axis at y = 2.
        ridge = [(x, y) for region in regions for x, y, z in region if abs(z - 8.0) < 1e-9]
        self.assertTrue(all(abs(y - 2.0) < 1e-9 for _x, y in ridge))

    def test_hip_regions_are_four_planes_that_tile_the_house(self):
        frame = ridge_frame(HOUSE)
        regions = planar_roof_regions(HOUSE, "hipped", frame, wall_top=5.0, roof_top=8.0)
        self.assertEqual(len(regions), 4)
        covered = sum(abs(signed_area([(x, y) for x, y, _z in region])) for region in regions)
        self.assertAlmostEqual(covered, 40.0)
        # Every eave corner sits at the wall top and the ridge runs 2 m in from each end.
        corners = {(x, y): z for region in regions for x, y, z in region if (x, y) in set(HOUSE)}
        self.assertTrue(all(abs(z - 5.0) < 1e-9 for z in corners.values()))
        ridge = sorted({round(x, 6) for region in regions for x, y, z in region if abs(z - 8.0) < 1e-9})
        self.assertEqual(ridge, [2.0, 8.0])

    def test_a_square_hip_is_a_pyramid(self):
        frame = ridge_frame(SQUARE)
        regions = planar_roof_regions(SQUARE, "hipped", frame, wall_top=5.0, roof_top=8.0)
        self.assertEqual(len(regions), 4)
        peaks = {(round(x, 6), round(y, 6)) for region in regions for x, y, z in region if abs(z - 8.0) < 1e-9}
        self.assertEqual(peaks, {(2.0, 2.0)})

    def test_an_l_shape_still_tiles(self):
        frame = ridge_frame(L_SHAPE)
        regions = planar_roof_regions(L_SHAPE, "gabled", frame, wall_top=5.0, roof_top=8.0)
        self.assertIsNotNone(regions)
        covered = sum(abs(signed_area([(x, y) for x, y, _z in region])) for region in regions)
        self.assertAlmostEqual(covered, abs(signed_area(L_SHAPE)))


class ApexSolidTests(unittest.TestCase):
    def test_a_pyramid_is_closed(self):
        levels, apex = apex_levels(OCTAGON, "pyramid", wall_top=10.0, roof_top=14.0)
        self.assertEqual(levels, [])
        self.assertAlmostEqual(apex[2], 14.0)
        vertices, faces = apex_solid_geometry(OCTAGON, 0.0, 10.0, levels, apex)
        self.assertEqual(manifold_report(vertices, faces), (0, 0))
        self.assertEqual(max(v[2] for v in vertices), 14.0)

    def test_a_dome_is_closed_and_curves_inward(self):
        levels, apex = apex_levels(OCTAGON, "dome", wall_top=10.0, roof_top=14.0)
        self.assertEqual(len(levels), 3)
        radii = [max(math.hypot(x, y) for x, y in ring) for ring, _z in levels]
        self.assertEqual(radii, sorted(radii, reverse=True))
        self.assertLess(radii[0], 3.0)
        vertices, faces = apex_solid_geometry(OCTAGON, 0.0, 10.0, levels, apex)
        self.assertEqual(manifold_report(vertices, faces), (0, 0))

    def test_a_concave_base_is_closed_too(self):
        levels, apex = apex_levels(L_SHAPE, "pyramid", 3.0, 5.0)
        vertices, faces = apex_solid_geometry(L_SHAPE, 0.0, 3.0, levels, apex)
        self.assertEqual(manifold_report(vertices, faces), (0, 0))

    def test_a_degenerate_ring_is_refused(self):
        self.assertIsNone(apex_solid_geometry([(0.0, 0.0), (1.0, 0.0)], 0.0, 1.0, [], (0.5, 0.0, 2.0)))


class WidthClampTests(unittest.TestCase):
    def test_widths_are_held_inside_the_printable_band(self):
        scale = 0.07
        self.assertAlmostEqual(printable_width_m(14.0, 0.45, 0.7, scale) * scale, 0.7)
        self.assertAlmostEqual(printable_width_m(2.0, 0.45, 0.7, scale) * scale, 0.45)
        self.assertAlmostEqual(printable_width_m(9.0, 0.45, 0.7, scale), 9.0)

    def test_no_maximum_means_no_cap(self):
        self.assertAlmostEqual(printable_width_m(14.0, 0.45, 0.0, 0.07), 14.0)


if __name__ == "__main__":
    unittest.main()
