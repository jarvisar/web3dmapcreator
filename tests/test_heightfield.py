"""Tests for the shared model-space terrain height field and deck profiles."""

from __future__ import annotations

import math
import unittest

from jarvizar_city_model.data.projection import create_miniature_transform
from jarvizar_city_model.data.terrain import FlatTerrain, TerrainSampler
from jarvizar_city_model.geometry.deck_profile import (
    interpolate_profile,
    point_and_direction,
    support_stations,
)
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.planar import point_in_polygon


class RampTerrain(TerrainSampler):
    """Elevation rising linearly from west to east across a bbox."""

    def __init__(self, west, east, relief_m=100.0):
        self.west = west
        self.east = east
        self.relief_m = relief_m

    def sample_m(self, lon, lat):
        fraction = (lon - self.west) / (self.east - self.west)
        return self.relief_m * min(max(fraction, 0.0), 1.0)


def make_transform():
    return create_miniature_transform(
        -84.5337, 39.08554, -84.47422, 39.11094, 170.5, 119.5, True
    )


class HeightFieldTests(unittest.TestCase):
    def setUp(self):
        self.transform = make_transform()
        self.field = ModelHeightField.build(
            self.transform, RampTerrain(-84.5337, -84.47422), resolution=48
        )

    def test_flat_field_is_uniformly_zero(self):
        flat = ModelHeightField.flat(self.transform)
        self.assertTrue(flat.is_flat)
        self.assertEqual(flat.height_mm(0.0, 0.0), 0.0)
        self.assertEqual(flat.minimum_mm, 0.0)

    def test_grid_keeps_the_model_aspect_ratio(self):
        bounds = self.transform.model_bounds
        expected = bounds.height_mm / bounds.width_mm
        actual = self.field.rows / self.field.columns
        self.assertAlmostEqual(actual, expected, delta=0.05)

    def test_ramp_increases_from_west_to_east(self):
        bounds = self.transform.model_bounds
        west = self.field.height_mm(bounds.min_x_mm, 0.0)
        east = self.field.height_mm(bounds.max_x_mm, 0.0)
        self.assertLess(west, east)
        self.assertAlmostEqual(west, 0.0, delta=0.05)

    def test_relief_matches_the_shared_vertical_scale(self):
        expected = self.transform.vertical_meters_to_model_mm(100.0)
        self.assertAlmostEqual(self.field.maximum_mm - self.field.minimum_mm, expected, delta=0.05)

    def test_sampling_outside_the_frame_clamps(self):
        bounds = self.transform.model_bounds
        self.assertAlmostEqual(
            self.field.height_mm(bounds.min_x_mm - 500.0, 0.0),
            self.field.height_mm(bounds.min_x_mm, 0.0),
            places=6,
        )

    def test_minimum_over_a_footprint_picks_the_downhill_corner(self):
        footprint = [(-40.0, 0.0), (-20.0, 0.0), (-20.0, 10.0), (-40.0, 10.0)]
        corners = [self.field.height_mm(x, y) for x, y in footprint]
        self.assertAlmostEqual(self.field.minimum_over(footprint), min(corners), places=9)
        self.assertLess(self.field.minimum_over(footprint), self.field.maximum_over(footprint))

    def test_percentile_ignores_a_single_low_outlier(self):
        field = ModelHeightField(0.0, 0.0, 10.0, 10.0, 2, 2, [5.0, 5.0, 5.0, 5.0])
        samples = [(1.0, 1.0)] * 20
        self.assertAlmostEqual(field.percentile_over(samples, 0.1), 5.0)

    def test_rows_2d_shape_matches_the_grid(self):
        rows = self.field.rows_2d()
        self.assertEqual(len(rows), self.field.rows)
        self.assertEqual(len(rows[0]), self.field.columns)

    def test_flatten_inside_carves_only_within_the_polygon(self):
        field = ModelHeightField(
            0.0, 0.0, 10.0, 10.0, 11, 11, [5.0] * 121
        )
        square = [(1.5, 1.5), (8.5, 1.5), (8.5, 8.5), (1.5, 8.5)]
        lowered = field.flatten_inside([square], 1.0)
        self.assertEqual(lowered, 49)
        self.assertAlmostEqual(field.height_mm(5.0, 5.0), 1.0, places=6)
        self.assertAlmostEqual(field.height_mm(0.5, 0.5), 5.0, places=6)

    def test_flatten_inside_only_raises_when_asked(self):
        # A polygon that overlaps a bank must not flood it.
        field = ModelHeightField(0.0, 0.0, 10.0, 10.0, 11, 11, [1.0] * 121)
        square = [(1.5, 1.5), (8.5, 1.5), (8.5, 8.5), (1.5, 8.5)]
        self.assertEqual(field.flatten_inside([square], 5.0), 0)
        self.assertAlmostEqual(field.height_mm(5.0, 5.0), 1.0, places=6)
        # Cut water raises a seabed to its level.
        self.assertEqual(field.flatten_inside([square], 5.0, raise_nodes=True), 49)
        self.assertAlmostEqual(field.height_mm(5.0, 5.0), 5.0, places=6)
        self.assertAlmostEqual(field.height_mm(0.5, 0.5), 1.0, places=6)

    def test_flatten_inside_respects_holes(self):
        field = ModelHeightField(0.0, 0.0, 10.0, 10.0, 21, 21, [5.0] * 441)
        outer = [(1.0, 1.0), (9.0, 1.0), (9.0, 9.0), (1.0, 9.0)]
        hole = [(4.0, 4.0), (4.0, 6.0), (6.0, 6.0), (6.0, 4.0)]
        field.flatten_inside([outer, hole], 0.0)
        self.assertAlmostEqual(field.height_mm(2.0, 2.0), 0.0, places=6)
        self.assertAlmostEqual(field.height_mm(5.0, 5.0), 5.0, places=6)

    def test_nodes_inside_matches_point_in_polygon_away_from_edges(self):
        field = ModelHeightField(0.0, 0.0, 10.0, 10.0, 21, 21, [0.0] * 441)
        rings = [[(0.71, 1.23), (8.83, 0.37), (9.61, 7.13), (5.27, 9.71), (1.13, 6.37)],
                 [(3.33, 3.21), (3.43, 5.61), (6.13, 5.43), (5.83, 3.17)]]
        expected = [row * 21 + column for row in range(21) for column in range(21)
                    if point_in_polygon((column * 0.5, row * 0.5), rings)]
        self.assertEqual(field.nodes_inside(rings), expected)

    def test_flatten_inside_ignores_a_degenerate_polygon(self):
        field = ModelHeightField(0.0, 0.0, 10.0, 10.0, 11, 11, [5.0] * 121)
        self.assertEqual(field.flatten_inside([], 1.0), 0)
        self.assertEqual(field.flatten_inside([[(0.0, 0.0), (1.0, 1.0)]], 1.0), 0)

    def test_rejects_a_malformed_grid(self):
        with self.assertRaises(ValueError):
            ModelHeightField(0.0, 0.0, 10.0, 10.0, 2, 2, [1.0, 2.0])
        with self.assertRaises(ValueError):
            ModelHeightField(0.0, 0.0, 0.0, 10.0, 2, 2, [1.0] * 4)


class SmoothingTests(unittest.TestCase):
    def _field(self, values):
        return ModelHeightField(0.0, 0.0, 4.0, 4.0, 5, 5, values)

    def test_a_spike_is_spread_over_its_neighbourhood(self):
        values = [0.0] * 25
        values[12] = 9.0
        field = self._field(values)
        field.smooth(1)
        self.assertAlmostEqual(field.values[12], 1.0)
        self.assertAlmostEqual(field.values[7], 1.0, msg="an edge neighbour")
        self.assertAlmostEqual(field.values[6], 1.0, msg="a corner neighbour")
        self.assertAlmostEqual(field.values[0], 0.0, msg="two cells away is untouched")
        self.assertAlmostEqual(sum(field.values), 9.0, msg="the filter conserves height")

    def test_a_linear_ramp_is_unchanged_away_from_the_frame(self):
        values = [float(column) for _row in range(5) for column in range(5)]
        field = self._field(values)
        field.smooth(1)
        for row in range(1, 4):
            for column in range(1, 4):
                self.assertAlmostEqual(field.values[row * 5 + column], float(column))

    def test_the_window_is_clipped_at_the_frame(self):
        values = [1.0] * 25
        field = self._field(values)
        field.smooth(2)
        self.assertTrue(all(abs(value - 1.0) < 1.0e-12 for value in field.values))

    def test_zero_radius_is_a_no_op_and_build_accepts_it(self):
        transform = make_transform()
        plain = ModelHeightField.build(transform, RampTerrain(-84.5337, -84.47422), 24)
        smoothed = ModelHeightField.build(
            transform, RampTerrain(-84.5337, -84.47422), 24, smoothing=1
        )
        self.assertEqual(plain.columns, smoothed.columns)
        # The ramp is linear, so interior nodes keep their value exactly.
        middle = (plain.rows // 2) * plain.columns + plain.columns // 2
        self.assertAlmostEqual(plain.values[middle], smoothed.values[middle], places=6)


class SupportPlacementTests(unittest.TestCase):
    def test_short_spans_get_no_supports(self):
        self.assertEqual(support_stations([(0.0, 0.0), (10.0, 0.0)], 30.0, 12.0), [])

    def test_supports_stay_inside_the_end_exclusions(self):
        points = [(0.0, 0.0), (300.0, 0.0)]
        stations = support_stations(points, 60.0, 30.0)
        self.assertTrue(stations)
        for station in stations:
            self.assertGreater(station, 30.0 / 300.0)
            self.assertLess(station, 1.0 - 30.0 / 300.0)

    def test_support_count_tracks_the_requested_spacing(self):
        points = [(0.0, 0.0), (600.0, 0.0)]
        self.assertGreater(
            len(support_stations(points, 30.0, 20.0)),
            len(support_stations(points, 120.0, 20.0)),
        )

    def test_zero_length_span_is_safe(self):
        self.assertEqual(support_stations([(0.0, 0.0), (0.0, 0.0)], 30.0, 5.0), [])


class ProfileInterpolationTests(unittest.TestCase):
    def test_interpolates_between_samples(self):
        self.assertAlmostEqual(interpolate_profile([0.0, 1.0], [10.0, 20.0], 0.25), 12.5)

    def test_clamps_outside_the_range(self):
        self.assertEqual(interpolate_profile([0.0, 1.0], [10.0, 20.0], -1.0), 10.0)
        self.assertEqual(interpolate_profile([0.0, 1.0], [10.0, 20.0], 5.0), 20.0)

    def test_direction_is_a_unit_vector_along_the_line(self):
        points = [(0.0, 0.0), (0.0, 100.0)]
        centre, direction = point_and_direction(points, [0.0, 1.0], 0.5)
        self.assertAlmostEqual(centre[1], 50.0)
        self.assertAlmostEqual(math.hypot(*direction), 1.0, places=9)
        self.assertAlmostEqual(direction[1], 1.0, places=9)


class FlatTerrainTests(unittest.TestCase):
    def test_flat_terrain_ignores_position(self):
        terrain = FlatTerrain(12.5)
        self.assertEqual(terrain.sample_m(-84.5, 39.1), 12.5)
        self.assertEqual(terrain.sample_m(0.0, 0.0), 12.5)


if __name__ == "__main__":
    unittest.main()
