"""Unit tests for the dependency-free WGS84/local/model transform."""

import json
import math
import unittest

from jarvizar_city_model.data.projection import (
    create_fixed_scale_transform,
    format_degrees,
    LocalENUProjection,
    MiniatureTransform,
    WGS84Bounds,
    create_miniature_transform,
    parse_bounds_text,
)


CINCINNATI_BOUNDS = WGS84Bounds(
    west=-84.53370,
    south=39.08554,
    east=-84.47422,
    north=39.11094,
)
CINCINNATI_CORNERS = (-84.53370, 39.08554, -84.47422, 39.11094)


class WGS84BoundsTests(unittest.TestCase):
    def test_valid_bounds_expose_center_and_containment(self):
        bounds = WGS84Bounds(-84.6, 39.0, -84.4, 39.2)

        self.assertAlmostEqual(bounds.center_longitude, -84.5)
        self.assertAlmostEqual(bounds.center_latitude, 39.1)
        self.assertTrue(bounds.contains(-84.5, 39.1))
        self.assertFalse(bounds.contains(-85.0, 39.1))

    def test_rejects_invalid_or_antimeridian_crossing_bounds(self):
        invalid_values = (
            (-181.0, 0.0, 1.0, 1.0),
            (-1.0, -91.0, 1.0, 1.0),
            (1.0, 0.0, -1.0, 1.0),
            (-1.0, 1.0, 1.0, 0.0),
            (-1.0, 0.0, -1.0, 1.0),
            (-1.0, 0.0, 1.0, math.nan),
        )
        for values in invalid_values:
            with self.subTest(values=values):
                with self.assertRaises(ValueError):
                    WGS84Bounds(*values)


class BoundsTextTests(unittest.TestCase):
    """The one-line paste the blender-osm Copy button produces."""

    def test_parses_the_blender_osm_clipboard_line(self):
        bounds = parse_bounds_text("-84.53576,39.08541,-84.48473,39.11475")

        self.assertAlmostEqual(bounds.west, -84.53576)
        self.assertAlmostEqual(bounds.south, 39.08541)
        self.assertAlmostEqual(bounds.east, -84.48473)
        self.assertAlmostEqual(bounds.north, 39.11475)

    def test_reads_loose_separators_and_decoration(self):
        variants = (
            " -84.53576, 39.08541, -84.48473, 39.11475\n",
            "-84.53576 39.08541 -84.48473 39.11475",
            "-84.53576;39.08541;-84.48473;39.11475",
            "[-84.53576, 39.08541, -84.48473, 39.11475]",
            "bbox=-84.53576,39.08541,-84.48473,39.11475",
            "-84.53576\t39.08541\n-84.48473\t39.11475",
        )
        for text in variants:
            with self.subTest(text=text):
                bounds = parse_bounds_text(text)
                self.assertAlmostEqual(bounds.west, -84.53576)
                self.assertAlmostEqual(bounds.north, 39.11475)

    def test_rejects_text_that_is_not_four_numbers_in_order(self):
        invalid = (
            "",
            "-84.53576,39.08541,-84.48473",
            "-84.53576,39.08541,-84.48473,39.11475,17.0",
            "-84.53576,39.08541,-84.48473,north",
            # east west of west: a lat/lon swap of a real box does not
            # accidentally become a legal one.
            "-84.48473,39.08541,-84.53576,39.11475",
            "-184.0,39.08541,-84.48473,39.11475",
        )
        for text in invalid:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    parse_bounds_text(text)

    def test_rejects_a_non_string(self):
        with self.assertRaises(ValueError):
            parse_bounds_text(None)

    def test_formatting_round_trips_through_the_text_fields(self):
        text = ",".join(str(value) for value in CINCINNATI_CORNERS)
        bounds = parse_bounds_text(text)
        formatted = tuple(
            format_degrees(value)
            for value in (bounds.west, bounds.south, bounds.east, bounds.north)
        )

        self.assertEqual(
            formatted, ("-84.5337", "39.08554", "-84.47422", "39.11094")
        )
        self.assertEqual(
            tuple(float(value) for value in formatted), CINCINNATI_CORNERS
        )

    def test_formatting_has_no_trailing_noise_or_negative_zero(self):
        self.assertEqual(format_degrees(0.0), "0")
        self.assertEqual(format_degrees(-0.0), "0")
        self.assertEqual(format_degrees(12.0), "12")
        self.assertEqual(format_degrees(-84.53576), "-84.53576")
        with self.assertRaises(ValueError):
            format_degrees(math.inf)


class LocalENUProjectionTests(unittest.TestCase):
    def test_bbox_center_is_the_local_origin(self):
        projection = LocalENUProjection(CINCINNATI_BOUNDS)

        east, north, up = projection.forward(
            CINCINNATI_BOUNDS.center_longitude,
            CINCINNATI_BOUNDS.center_latitude,
            0.0,
        )

        self.assertAlmostEqual(east, 0.0, places=8)
        self.assertAlmostEqual(north, 0.0, places=8)
        self.assertAlmostEqual(up, 0.0, places=8)

    def test_forward_uses_wgs84_metric_distances(self):
        bounds = WGS84Bounds(-0.01, -0.01, 0.01, 0.01)
        projection = LocalENUProjection(bounds)

        east, north, up = projection.forward(0.001, 0.0, 0.0)

        # One-thousandth degree of longitude at the equator is 111.31949 m.
        self.assertAlmostEqual(east, 111.31949, places=4)
        self.assertAlmostEqual(north, 0.0, places=6)
        # The point lies slightly below the origin's tangent plane because of
        # Earth curvature; importantly it is not silently treated as planar.
        self.assertLess(up, 0.0)

    def test_height_at_origin_maps_to_local_up(self):
        projection = LocalENUProjection(CINCINNATI_BOUNDS)

        east, north, up = projection.forward(
            projection.origin_longitude,
            projection.origin_latitude,
            123.45,
        )

        self.assertAlmostEqual(east, 0.0, places=8)
        self.assertAlmostEqual(north, 0.0, places=8)
        self.assertAlmostEqual(up, 123.45, places=7)

    def test_horizontal_bounds_cover_all_bbox_corners(self):
        projection = LocalENUProjection(CINCINNATI_BOUNDS)
        bounds = projection.horizontal_bounds()

        for lon in (CINCINNATI_BOUNDS.west, CINCINNATI_BOUNDS.east):
            for lat in (CINCINNATI_BOUNDS.south, CINCINNATI_BOUNDS.north):
                east, north, _up = projection.forward(lon, lat)
                self.assertLessEqual(bounds.min_east_m, east)
                self.assertGreaterEqual(bounds.max_east_m, east)
                self.assertLessEqual(bounds.min_north_m, north)
                self.assertGreaterEqual(bounds.max_north_m, north)


class MiniatureTransformTests(unittest.TestCase):
    def test_preserve_aspect_uses_one_uniform_fit_scale(self):
        transform = MiniatureTransform(
            LocalENUProjection(CINCINNATI_BOUNDS),
            target_width_mm=170.5,
            target_height_mm=119.5,
            preserve_aspect=True,
        )

        self.assertAlmostEqual(
            transform.scale_x_mm_per_m, transform.scale_y_mm_per_m
        )
        self.assertAlmostEqual(
            transform.scale_z_mm_per_m, transform.scale_x_mm_per_m
        )
        self.assertLessEqual(transform.model_bounds.width_mm, 170.5 + 1e-10)
        self.assertLessEqual(transform.model_bounds.height_mm, 119.5 + 1e-10)
        self.assertTrue(
            math.isclose(transform.model_bounds.width_mm, 170.5)
            or math.isclose(transform.model_bounds.height_mm, 119.5)
        )

    def test_non_preserve_mode_fills_both_axes_and_uses_conservative_z(self):
        transform = MiniatureTransform(
            LocalENUProjection(CINCINNATI_BOUNDS),
            target_width_mm=170.5,
            target_height_mm=119.5,
            preserve_aspect=False,
        )

        self.assertAlmostEqual(transform.model_bounds.width_mm, 170.5)
        self.assertAlmostEqual(transform.model_bounds.height_mm, 119.5)
        self.assertAlmostEqual(
            transform.scale_z_mm_per_m,
            min(transform.scale_x_mm_per_m, transform.scale_y_mm_per_m),
        )
        self.assertNotAlmostEqual(
            transform.scale_x_mm_per_m, transform.scale_y_mm_per_m
        )

    def test_forward_converts_lon_lat_and_height_to_model_mm(self):
        transform = create_miniature_transform(
            *CINCINNATI_BOUNDS.as_dict().values(),
            target_width_mm=170.5,
            target_height_mm=119.5,
        )
        x, y, z = transform.forward(
            CINCINNATI_BOUNDS.center_longitude,
            CINCINNATI_BOUNDS.center_latitude,
            10.0,
        )

        self.assertAlmostEqual(x, 0.0, places=8)
        self.assertAlmostEqual(y, 0.0, places=8)
        self.assertAlmostEqual(
            z, transform.vertical_meters_to_model_mm(10.0), places=8
        )

    def test_bounds_metadata_is_complete_and_json_serializable(self):
        transform = MiniatureTransform(
            LocalENUProjection(CINCINNATI_BOUNDS),
            target_width_mm=170.5,
            target_height_mm=119.5,
        )

        metadata = transform.bounds_metadata
        json.dumps(metadata)
        self.assertEqual(
            metadata["geographic_wgs84"], CINCINNATI_BOUNDS.as_dict()
        )
        self.assertEqual(metadata["target_mm"]["width"], 170.5)
        self.assertEqual(metadata["target_mm"]["height"], 119.5)
        self.assertEqual(
            metadata["scale_mm_per_m"]["z"], transform.scale_z_mm_per_m
        )

    def test_rejects_invalid_target_dimensions(self):
        projection = LocalENUProjection(CINCINNATI_BOUNDS)
        for width, height in ((0.0, 10.0), (10.0, -1.0), (math.inf, 10.0)):
            with self.subTest(width=width, height=height):
                with self.assertRaises(ValueError):
                    MiniatureTransform(projection, width, height)


class InverseProjectionTests(unittest.TestCase):
    """The inverse lets generators go from model space back to a terrain query.

    Roads, water outlines, and scatter points are all built in model or metric
    coordinates and then need their real longitude and latitude to ask an
    elevation provider for a height, so a drift here would tilt every draped
    feature away from the terrain it is supposed to sit on.
    """

    def setUp(self):
        self.projection = LocalENUProjection(CINCINNATI_BOUNDS)
        self.transform = MiniatureTransform(
            projection=self.projection,
            target_width_mm=170.5,
            target_height_mm=119.5,
        )

    def test_local_enu_round_trip_is_exact(self):
        samples = (
            (CINCINNATI_BOUNDS.west, CINCINNATI_BOUNDS.south),
            (CINCINNATI_BOUNDS.east, CINCINNATI_BOUNDS.north),
            (CINCINNATI_BOUNDS.center_longitude, CINCINNATI_BOUNDS.center_latitude),
            (-84.49, 39.0925),
        )
        for longitude, latitude in samples:
            with self.subTest(longitude=longitude, latitude=latitude):
                east, north, up = self.projection.forward(longitude, latitude, 123.4)
                back = self.projection.inverse(east, north, up)
                self.assertAlmostEqual(back[0], longitude, places=9)
                self.assertAlmostEqual(back[1], latitude, places=9)
                self.assertAlmostEqual(back[2], 123.4, places=6)

    def test_model_millimetres_round_trip_to_geographic(self):
        longitude, latitude = -84.51, 39.10
        x, y, z = self.transform.geographic_to_model(longitude, latitude, 50.0)
        back = self.transform.model_to_geographic(x, y, z)
        self.assertAlmostEqual(back[0], longitude, places=9)
        self.assertAlmostEqual(back[1], latitude, places=9)

    def test_origin_maps_to_the_bbox_centre(self):
        longitude, latitude, height = self.transform.model_to_geographic(0.0, 0.0, 0.0)
        self.assertAlmostEqual(longitude, CINCINNATI_BOUNDS.center_longitude, places=9)
        self.assertAlmostEqual(latitude, CINCINNATI_BOUNDS.center_latitude, places=9)
        self.assertAlmostEqual(height, 0.0, places=6)

    def test_model_to_local_undoes_the_millimetre_scaling(self):
        east, north, up = self.transform.model_to_local(85.25, 46.73, 1.0)
        again = self.transform.local_to_model(east, north, up)
        self.assertAlmostEqual(again[0], 85.25, places=9)
        self.assertAlmostEqual(again[1], 46.73, places=9)
        self.assertAlmostEqual(again[2], 1.0, places=9)

    def test_local_to_geographic_matches_the_projection(self):
        east, north, up = self.projection.forward(-84.50, 39.10, 0.0)
        self.assertEqual(
            self.transform.local_to_geographic(east, north, up),
            self.projection.inverse(east, north, up),
        )

    def test_inverse_rejects_non_finite_input(self):
        for value in (math.inf, math.nan):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    self.projection.inverse(value, 0.0, 0.0)


class FixedScaleTests(unittest.TestCase):
    """A printable map is designed around real feature sizes.

    At a fixed scale a 6.5 m residential street lands on a known printed width,
    and the finished model is whatever size that implies.  Fitting a bbox into
    a target rectangle inverts that: the scale becomes an accident of the
    bounding box, and the same minimum printable ribbon then stands for a very
    different amount of real street.
    """

    def setUp(self):
        self.transform = create_fixed_scale_transform(
            *CINCINNATI_CORNERS, mm_per_metre=0.07
        )

    def test_scale_is_exactly_as_requested_on_every_axis(self):
        self.assertAlmostEqual(self.transform.scale_x_mm_per_m, 0.07, places=12)
        self.assertAlmostEqual(self.transform.scale_y_mm_per_m, 0.07, places=12)
        self.assertAlmostEqual(self.transform.scale_z_mm_per_m, 0.07, places=12)

    def test_ratio_matches_the_scale(self):
        self.assertAlmostEqual(self.transform.scale_ratio, 1000.0 / 0.07, places=6)

    def test_a_metre_becomes_the_requested_millimetres(self):
        east_a, _n, _u = self.transform.local_to_model(0.0, 0.0, 0.0)
        east_b, _n2, _u2 = self.transform.local_to_model(1000.0, 0.0, 0.0)
        self.assertAlmostEqual(east_b - east_a, 70.0, places=9)

    def test_minimum_printable_width_maps_to_a_real_street_width(self):
        # 0.45 mm is the printable floor; at this scale that is a residential
        # street, which is the whole reason the scale was chosen.
        self.assertAlmostEqual(
            self.transform.real_metres_for_model_mm(0.45), 6.43, places=2
        )

    def test_model_size_follows_from_the_scale(self):
        bounds = self.transform.model_bounds
        metric = self.transform.metric_bounds
        self.assertAlmostEqual(bounds.width_mm, metric.width_m * 0.07, places=6)
        self.assertAlmostEqual(bounds.height_mm, metric.height_m * 0.07, places=6)

    def test_halving_the_scale_halves_the_model(self):
        smaller = create_fixed_scale_transform(
            *CINCINNATI_CORNERS, mm_per_metre=0.035
        )
        self.assertAlmostEqual(
            smaller.model_bounds.width_mm,
            self.transform.model_bounds.width_mm * 0.5,
            places=6,
        )

    def test_metadata_records_the_scale_and_mode(self):
        metadata = self.transform.bounds_metadata
        json.dumps(metadata)
        self.assertEqual(metadata["scale_mode"], "fixed")
        self.assertAlmostEqual(metadata["scale_mm_per_m"]["x"], 0.07, places=12)

    def test_fit_mode_still_reports_its_own_scale(self):
        fitted = MiniatureTransform(
            projection=LocalENUProjection(CINCINNATI_BOUNDS),
            target_width_mm=170.5,
            target_height_mm=119.5,
        )
        self.assertEqual(fitted.bounds_metadata["scale_mode"], "fit")
        self.assertGreater(fitted.scale_ratio, 0.0)

    def test_rejects_a_nonsensical_scale(self):
        for scale in (0.0, -1.0, math.inf):
            with self.subTest(scale=scale):
                with self.assertRaises(ValueError):
                    create_fixed_scale_transform(
                        *CINCINNATI_CORNERS, mm_per_metre=scale
                    )

    def test_fixed_scale_ignores_target_dimensions(self):
        transform = MiniatureTransform(
            projection=LocalENUProjection(CINCINNATI_BOUNDS),
            fixed_scale_mm_per_m=0.07,
        )
        self.assertAlmostEqual(transform.scale_x_mm_per_m, 0.07, places=12)


if __name__ == "__main__":
    unittest.main()
