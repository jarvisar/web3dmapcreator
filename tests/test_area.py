"""Area sizes, boxes around a point, bed fitting and size hints."""

import math
import unittest
from urllib.parse import parse_qs, urlsplit

from jarvizar_city_model.data import area
from jarvizar_city_model.data.projection import (
    WGS84Bounds,
    create_fixed_scale_transform,
    create_miniature_transform,
    format_degrees,
    parse_bounds_text,
)


def relative(actual, expected):
    return abs(actual - expected) / expected


class RealSizeTests(unittest.TestCase):
    def test_small_equatorial_box_matches_wgs84_arc_lengths(self):
        width, height = area.real_size_m(WGS84Bounds(-0.005, -0.005, 0.005, 0.005))
        # A degree of longitude on the equator is a * pi / 180; a degree of
        # latitude there is the meridian radius a * (1 - e^2) * pi / 180.
        self.assertAlmostEqual(width, 1113.195, delta=0.01)
        self.assertAlmostEqual(height, 1105.743, delta=0.01)

    def test_matches_the_fixed_scale_transform(self):
        bounds = WGS84Bounds(-87.64575, 41.87052, -87.60627, 41.89397)
        width, height = area.real_size_m(bounds)
        transform = create_fixed_scale_transform(-87.64575, 41.87052, -87.60627, 41.89397, 0.07)
        self.assertAlmostEqual(width * 0.07, transform.model_bounds.width_mm, places=9)
        self.assertAlmostEqual(height * 0.07, transform.model_bounds.height_mm, places=9)
        self.assertAlmostEqual(area.real_area_km2(bounds), width * height / 1e6)

    def test_fit_mode_size_matches_the_fit_transform(self):
        bounds = (-87.64575, 41.87052, -87.60627, 41.89397)
        width, height = area.real_size_m(WGS84Bounds(*bounds))
        for preserve in (True, False):
            transform = create_miniature_transform(*bounds, 170.5, 119.5, preserve_aspect=preserve)
            width_mm, height_mm, scale = area.model_size_mm(
                width, height, target_mm=(170.5, 119.5), preserve_aspect=preserve)
            self.assertAlmostEqual(width_mm, transform.model_bounds.width_mm, places=6)
            self.assertAlmostEqual(height_mm, transform.model_bounds.height_mm, places=6)
            self.assertAlmostEqual(scale, transform.scale_x_mm_per_m, places=12)


class BoundsAroundTests(unittest.TestCase):
    LATITUDES = (0.0, 1.3, 41.88, 60.0, -33.8568, -54.8, 78.2)

    def test_round_trips_at_several_latitudes(self):
        for latitude in self.LATITUDES:
            for longitude in (-122.4, 0.0, 151.2):
                for width, height in ((2857.14, 2857.14), (5000.0, 1200.0), (300.0, 900.0)):
                    with self.subTest(latitude=latitude, longitude=longitude, size=(width, height)):
                        bounds = area.bounds_around(latitude, longitude, width, height)
                        actual_width, actual_height = area.real_size_m(bounds)
                        self.assertLess(relative(actual_width, width), 1e-8)
                        self.assertLess(relative(actual_height, height), 1e-8)
                        self.assertAlmostEqual(bounds.center_latitude, latitude, places=9)
                        self.assertAlmostEqual(bounds.center_longitude, longitude, places=9)

    def test_print_size_survives_the_text_fields_and_the_transform(self):
        # Equator, 60 N and the southern hemisphere: the transform built from
        # the rounded fields prints at the requested size.
        for latitude, longitude in ((0.0, 10.0), (60.0, 24.9), (-33.8568, 151.2153), (41.88, -87.63)):
            for width_mm, height_mm in ((200.0, 200.0), (230.0, 150.0), (40.0, 25.0)):
                with self.subTest(latitude=latitude, size=(width_mm, height_mm)):
                    bounds = area.bounds_around(latitude, longitude, width_mm / 0.07, height_mm / 0.07)
                    fields = [float(format_degrees(value)) for value in
                              (bounds.west, bounds.south, bounds.east, bounds.north)]
                    model = create_fixed_scale_transform(*fields, 0.07).model_bounds
                    self.assertLess(relative(model.width_mm, width_mm), 0.001)
                    self.assertLess(relative(model.height_mm, height_mm), 0.001)
                    self.assertEqual(f"{model.width_mm:.0f} x {model.height_mm:.0f}",
                                     f"{width_mm:.0f} x {height_mm:.0f}")

    def test_five_decimal_presets_stay_within_half_a_percent(self):
        for latitude in (0.0, 60.0, -33.8568):
            bounds = area.rounded(area.bounds_around(latitude, 20.0, 200 / 0.07, 200 / 0.07), 5)
            model = create_fixed_scale_transform(
                bounds.west, bounds.south, bounds.east, bounds.north, 0.07).model_bounds
            self.assertLess(relative(model.width_mm, 200.0), 0.005)
            self.assertLess(relative(model.height_mm, 200.0), 0.005)

    def test_refuses_the_antimeridian(self):
        for longitude in (179.99, -179.99):
            with self.assertRaisesRegex(ValueError, "180th meridian"):
                area.bounds_around(-17.8, longitude, 5000.0, 5000.0)
        bounds = area.bounds_around(-17.8, 179.9, 5000.0, 5000.0)
        self.assertLess(bounds.east, 180.0)

    def test_holds_the_edge_at_the_latitude_limit_and_keeps_the_size(self):
        bounds = area.bounds_around(85.04, 10.0, 3000.0, 3000.0)
        self.assertEqual(bounds.north, area.MAX_LATITUDE)
        width, height = area.real_size_m(bounds)
        self.assertLess(relative(width, 3000.0), 1e-6)
        self.assertLess(relative(height, 3000.0), 1e-6)
        self.assertTrue(bounds.south <= 85.04 <= bounds.north)
        bounds = area.bounds_around(-85.04, 10.0, 3000.0, 3000.0)
        self.assertEqual(bounds.south, -area.MAX_LATITUDE)

    def test_rejects_unusable_input(self):
        cases = ((86.0, 0.0, 100.0, 100.0), (0.0, 181.0, 100.0, 100.0), (math.nan, 0.0, 100.0, 100.0),
                 (0.0, 0.0, 0.0, 100.0), (0.0, 0.0, 100.0, -5.0), (0.0, 0.0, 2e6, 100.0),
                 (True, 0.0, 100.0, 100.0), ("north", 0.0, 100.0, 100.0))
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                area.bounds_around(*case)


class BedTests(unittest.TestCase):
    def test_bed_fit_leaves_a_margin_in_whole_centimetres(self):
        self.assertEqual(area.bed_fit_mm(256, 256), (200.0, 200.0))
        self.assertEqual(area.bed_fit_mm(180, 180), (120.0, 120.0))
        self.assertEqual(area.bed_fit_mm(350, 320), (290.0, 260.0))
        self.assertEqual(area.bed_fit_mm(330, 320), (270.0, 260.0))

    def test_a_model_may_be_turned_to_fit(self):
        self.assertTrue(area.fits_bed(256.0, 256.0, 256, 256))
        self.assertFalse(area.fits_bed(256.5, 100.0, 256, 256))
        self.assertTrue(area.fits_bed(300.0, 330.0, 330, 320))
        self.assertFalse(area.fits_bed(340.0, 330.0, 330, 320))


class TextTests(unittest.TestCase):
    def test_sizes_use_fewer_decimals_as_they_grow(self):
        self.assertEqual(area.format_size(850.0, 600.4), "850 x 600 m")
        self.assertEqual(area.format_size(3275.0, 2604.0), "3.27 x 2.60 km")
        self.assertEqual(area.format_size(14857.0, 17530.0), "14.9 x 17.5 km")
        self.assertEqual(area.format_size(150000.0, 90000.0), "150 x 90 km")

    def test_areas(self):
        self.assertEqual(area.format_area(60.0, 60.0), "3,600 m²")
        self.assertEqual(area.format_area(700.0, 700.0), "0.49 km²")
        self.assertEqual(area.format_area(3275.0, 2604.0), "8.5 km²")
        self.assertEqual(area.format_area(14857.0, 17530.0), "260 km²")
        self.assertEqual(area.size_line(3275.0, 2604.0), "3.27 x 2.60 km, 8.5 km²")

    def test_print_line_matches_the_scale_summary(self):
        self.assertEqual(area.print_line(229.4, 182.3, 0.07), "229 x 182 mm at 1:14,286")


class NoteTests(unittest.TestCase):
    BED = (256.0, 256.0)

    def notes(self, width_m, height_m, scale=0.07, **options):
        model = (width_m * scale, height_m * scale)
        return area.size_notes(width_m, height_m, model, self.BED, "P1S", **options)

    def test_an_area_that_fits_needs_no_note(self):
        self.assertEqual(self.notes(2857.0, 2857.0), [])

    def test_larger_than_the_bed(self):
        icon, text = self.notes(5000.0, 3000.0)[0]
        self.assertEqual(icon, "ERROR")
        self.assertEqual(text, "Larger than the P1S bed: use a cutout frame and/or Multi-Plate "
                               "Export, or a smaller area or scale")
        self.assertEqual(self.notes(5000.0, 3000.0, cutout=True)[0][0], "INFO")
        self.assertIn("cropped to the cutout", self.notes(5000.0, 3000.0, cutout=True)[0][1])
        self.assertEqual(self.notes(5000.0, 3000.0, cutout=True, multi_plate=True), [])
        icon, text = self.notes(5000.0, 3000.0, multi_plate=True)[0]
        self.assertEqual((icon, text), ("ERROR", "Larger than the P1S bed: Multi-Plate Export needs a cutout frame"))

    def test_large_and_small_areas(self):
        texts = [text for _, text in self.notes(8000.0, 7000.0)]
        self.assertIn("Large area: download and generation can take a long time and a lot of memory", texts)
        # 200 m prints 14 mm wide at the default scale.
        self.assertEqual(self.notes(200.0, 1000.0), [("INFO", "Very small area: check the coordinates")])
        # The same area at a large scale is an ordinary print.
        self.assertEqual(self.notes(200.0, 200.0, scale=0.5), [])


class LinkTests(unittest.TestCase):
    BOUNDS = WGS84Bounds(-87.64575, 41.87052, -87.60627, 41.89397)

    def test_openstreetmap_link_fits_the_box_with_a_centre_marker(self):
        url = area.osm_url(self.BOUNDS)
        parts = urlsplit(url)
        self.assertEqual(f"{parts.scheme}://{parts.netloc}{parts.path}", "https://www.openstreetmap.org/")
        query = {key: value[0] for key, value in parse_qs(parts.query).items()}
        self.assertEqual(query["minlon"], "-87.64575")
        self.assertEqual(query["minlat"], "41.87052")
        self.assertEqual(query["maxlon"], "-87.60627")
        self.assertEqual(query["maxlat"], "41.89397")
        self.assertAlmostEqual(float(query["mlat"]), 41.882245)
        self.assertAlmostEqual(float(query["mlon"]), -87.62601)

    def test_bboxfinder_hash_is_south_west_north_east(self):
        self.assertEqual(area.bboxfinder_url(self.BOUNDS),
                         "https://bboxfinder.com/#41.87052,-87.64575,41.89397,-87.60627")
        self.assertEqual(area.bboxfinder_url(None), "https://bboxfinder.com/")

    def test_bboxfinder_box_value_pastes(self):
        # Its Box row in the default Lng / Lat order, with and without the GDAL option.
        for text in ("-87.645750,41.870520,-87.606270,41.893970",
                     "-87.645750 41.870520 -87.606270 41.893970"):
            self.assertEqual(parse_bounds_text(text), self.BOUNDS)


if __name__ == "__main__":
    unittest.main()
