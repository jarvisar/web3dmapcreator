"""Tests for Overture linear-referencing rule resolution and polyline geometry."""

from __future__ import annotations

import math
import unittest

from jarvizar_city_model.data.linework import (
    DEFAULT_ROAD_WIDTH_M,
    active_flag_values,
    clip_polyline_to_rectangle,
    collect_boundaries,
    cumulative_positions,
    densify_polyline,
    linestring_coordinates,
    polyline_length,
    resolve_level,
    resolve_width_m,
    simplify_polyline,
    slice_polyline,
    split_segment,
)


class LineStringParsingTests(unittest.TestCase):
    def test_reads_only_linestrings(self):
        self.assertEqual(
            linestring_coordinates({"type": "LineString", "coordinates": [[1, 2], [3, 4]]}),
            [(1.0, 2.0), (3.0, 4.0)],
        )
        self.assertEqual(linestring_coordinates({"type": "Polygon", "coordinates": []}), [])
        self.assertEqual(linestring_coordinates({}), [])

    def test_skips_malformed_positions(self):
        geometry = {"type": "LineString", "coordinates": [[1, 2], [3], "bad", [5, 6]]}
        self.assertEqual(linestring_coordinates(geometry), [(1.0, 2.0), (5.0, 6.0)])


class PositionTests(unittest.TestCase):
    def test_cumulative_positions_are_normalized(self):
        positions = cumulative_positions([(0, 0), (10, 0), (10, 30)])
        self.assertEqual(positions[0], 0.0)
        self.assertEqual(positions[-1], 1.0)
        self.assertAlmostEqual(positions[1], 0.25)

    def test_zero_length_polyline_does_not_divide_by_zero(self):
        self.assertEqual(cumulative_positions([(1, 1), (1, 1)]), [0.0, 0.0])

    def test_slice_interpolates_both_ends(self):
        piece = slice_polyline([(0, 0), (100, 0)], 0.25, 0.75)
        self.assertEqual(piece[0], (25.0, 0.0))
        self.assertEqual(piece[-1], (75.0, 0.0))

    def test_slice_keeps_interior_vertices(self):
        piece = slice_polyline([(0, 0), (50, 0), (100, 0)], 0.0, 1.0)
        self.assertEqual(len(piece), 3)


class ScopedRuleTests(unittest.TestCase):
    def test_boundaries_are_the_union_of_every_rule(self):
        properties = {
            "road_flags": [{"values": ["is_bridge"], "between": [0.25, 0.5]}],
            "level_rules": [{"value": 1, "between": [0.4, 0.9]}],
            "width_rules": [{"value": 8.0, "between": None}],
        }
        boundaries = collect_boundaries(
            properties, ("road_flags", "level_rules", "width_rules")
        )
        self.assertEqual(boundaries, [0.0, 0.25, 0.4, 0.5, 0.9, 1.0])

    def test_unscoped_rule_applies_to_the_whole_segment(self):
        boundaries = collect_boundaries(
            {"road_flags": [{"values": ["is_bridge"], "between": None}]}, ("road_flags",)
        )
        self.assertEqual(boundaries, [0.0, 1.0])

    def test_flag_values_union_active_rules(self):
        rules = [
            {"values": ["is_bridge"], "between": [0.0, 0.6]},
            {"values": ["is_covered"], "between": [0.4, 1.0]},
        ]
        self.assertEqual(active_flag_values(rules, 0.5), frozenset({"is_bridge", "is_covered"}))
        self.assertEqual(active_flag_values(rules, 0.9), frozenset({"is_covered"}))

    def test_width_precedence_prefers_explicit_rule(self):
        width, source = resolve_width_m(
            {"width_rules": [{"value": 7.5, "between": None}]}, 0.5, "residential"
        )
        self.assertEqual((width, source), (7.5, "width_rules"))

    def test_width_falls_back_to_class_default(self):
        width, source = resolve_width_m({}, 0.5, "motorway")
        self.assertEqual(width, DEFAULT_ROAD_WIDTH_M["motorway"])
        self.assertEqual(source, "class_default")

    def test_unknown_class_uses_the_documented_fallback(self):
        width, source = resolve_width_m({}, 0.5, "not_a_real_class")
        self.assertEqual(source, "class_default")
        self.assertGreater(width, 0.0)

    def test_width_rule_without_a_usable_value_is_ignored(self):
        width, source = resolve_width_m(
            {"width_rules": [{"value": None, "between": None}]}, 0.5, "service"
        )
        self.assertEqual(source, "class_default")
        self.assertEqual(width, DEFAULT_ROAD_WIDTH_M["service"])

    def test_level_defaults_to_zero_and_reads_negatives(self):
        self.assertEqual(resolve_level({}, 0.5), 0)
        self.assertEqual(
            resolve_level({"level_rules": [{"value": -1, "between": [0.0, 1.0]}]}, 0.5),
            -1,
        )


class SplitSegmentTests(unittest.TestCase):
    def test_partial_bridge_is_split_into_two_pieces(self):
        points = [(0.0, 0.0), (100.0, 0.0)]
        properties = {
            "class": "primary",
            "road_flags": [{"values": ["is_bridge"], "between": [0.5, 1.0]}],
        }
        pieces = split_segment("segment-1", points, properties)
        self.assertEqual(len(pieces), 2)
        self.assertFalse(pieces[0].is_bridge)
        self.assertTrue(pieces[1].is_bridge)
        self.assertAlmostEqual(pieces[1].points[0][0], 50.0)

    def test_pieces_cover_the_whole_original_length(self):
        points = [(0.0, 0.0), (100.0, 0.0)]
        properties = {
            "class": "primary",
            "road_flags": [{"values": ["is_bridge"], "between": [0.3, 0.6]}],
        }
        pieces = split_segment("segment-1", points, properties)
        total = sum(polyline_length(piece.points) for piece in pieces)
        self.assertAlmostEqual(total, 100.0, places=6)

    def test_tunnel_flag_is_reported_per_piece(self):
        pieces = split_segment(
            "segment-1",
            [(0.0, 0.0), (100.0, 0.0)],
            {
                "class": "residential",
                "road_flags": [{"values": ["is_tunnel"], "between": [0.0, 0.4]}],
            },
        )
        self.assertTrue(pieces[0].is_tunnel)
        self.assertFalse(pieces[1].is_tunnel)

    def test_degenerate_input_produces_nothing(self):
        self.assertEqual(split_segment("x", [(1.0, 1.0)], {}), [])
        self.assertEqual(split_segment("x", [(1.0, 1.0), (1.0, 1.0)], {}), [])


class ClippingTests(unittest.TestCase):
    def test_polyline_entering_and_leaving_yields_two_pieces(self):
        points = [(-10, 5), (5, 5), (15, 5), (25, 5), (5, 5), (-5, 5)]
        pieces = clip_polyline_to_rectangle(points, 0, 0, 10, 10)
        self.assertEqual(len(pieces), 2)
        for piece in pieces:
            for x, y in piece:
                self.assertGreaterEqual(x, -1e-9)
                self.assertLessEqual(x, 10 + 1e-9)

    def test_fully_outside_polyline_is_dropped(self):
        self.assertEqual(clip_polyline_to_rectangle([(20, 20), (30, 30)], 0, 0, 10, 10), [])

    def test_fully_inside_polyline_is_preserved(self):
        pieces = clip_polyline_to_rectangle([(1, 1), (5, 5), (9, 2)], 0, 0, 10, 10)
        self.assertEqual(len(pieces), 1)
        self.assertEqual(len(pieces[0]), 3)


class ResamplingTests(unittest.TestCase):
    def test_simplify_keeps_both_endpoints(self):
        points = [(0, 0), (1, 0), (2, 0), (3, 0), (100, 0)]
        result = simplify_polyline(points, 10.0)
        self.assertEqual(result[0], (0, 0))
        self.assertEqual(result[-1], (100, 0))

    def test_simplify_removes_closely_spaced_vertices(self):
        points = [(index, 0.0) for index in range(50)]
        result = simplify_polyline(points, 10.0)
        self.assertLess(len(result), len(points))
        for index in range(len(result) - 2):
            self.assertGreaterEqual(math.dist(result[index], result[index + 1]), 10.0)

    def test_densify_bounds_every_span(self):
        result = densify_polyline([(0, 0), (100, 0)], 10.0)
        self.assertEqual(len(result), 11)
        for index in range(len(result) - 1):
            self.assertLessEqual(math.dist(result[index], result[index + 1]), 10.0 + 1e-9)

    def test_densify_preserves_total_length(self):
        points = [(0, 0), (30, 40), (60, 0)]
        self.assertAlmostEqual(
            polyline_length(densify_polyline(points, 7.0)),
            polyline_length(points),
            places=6,
        )


if __name__ == "__main__":
    unittest.main()
