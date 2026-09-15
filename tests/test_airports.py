"""Airport paving: which features count, and centerline widening."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.land import classify_surface
from jarvizar_city_model.data.projection import LocalENUProjection, WGS84Bounds
from jarvizar_city_model.geometry.airports import (
    airport_line_width_m,
    airport_surface_features,
    airport_surface_polygons,
    is_airport_area,
)
from jarvizar_city_model.geometry.planar import signed_area

BOUNDS = WGS84Bounds(west=-115.17, south=36.07, east=-115.13, north=36.10)
PROJECTION = LocalENUProjection(BOUNDS)


def line(class_name, coordinates, subtype="airport", **properties):
    return {
        "type": "Feature",
        "id": f"{class_name}-1",
        "properties": {"subtype": subtype, "class": class_name, **properties},
        "geometry": {"type": "LineString", "coordinates": coordinates},
    }


def area(class_name, subtype="airport"):
    return {
        "type": "Feature",
        "id": f"{class_name}-area",
        "properties": {"subtype": subtype, "class": class_name},
        "geometry": {"type": "Polygon", "coordinates": [[
            [-115.151, 36.081], [-115.149, 36.081], [-115.149, 36.083], [-115.151, 36.081]]]},
    }


def metric_rings(feature):
    return [[PROJECTION.forward(lon, lat, 0.0)[:2] for lon, lat in polygon[0][:-1]]
            for polygon in feature["geometry"]["coordinates"]]


def centerline(length_m=1000.0):
    """A north-south centerline of *length_m* through the middle of BOUNDS."""
    south = PROJECTION.inverse(0.0, -length_m / 2.0, 0.0)
    north = PROJECTION.inverse(0.0, length_m / 2.0, 0.0)
    return [[south[0], south[1]], [north[0], north[1]]]


class SelectionTests(unittest.TestCase):
    def test_aprons_and_helipads_are_areas(self):
        self.assertTrue(is_airport_area(area("apron")))
        self.assertTrue(is_airport_area(area("helipad")))

    def test_airport_grounds_and_other_infrastructure_are_not(self):
        self.assertFalse(is_airport_area(area("international_airport")))
        self.assertFalse(is_airport_area(area("airport")))
        self.assertFalse(is_airport_area(area("pier", subtype="pier")))

    def test_airport_paving_is_not_a_land_surface(self):
        # It prints with the roads, so land cover never doubles it.
        self.assertIsNone(classify_surface("infrastructure", area("apron")))

    def test_features_combine_areas_and_widened_lines(self):
        result = airport_surface_features(
            [area("apron"), line("runway", centerline()), area("international_airport"),
             line("pier", centerline(), subtype="pier")],
            PROJECTION,
        )
        self.assertEqual([f["properties"]["class"] for f in result], ["apron", "runway"])


class WidthTests(unittest.TestCase):
    def test_width_tag_wins(self):
        properties = {"subtype": "airport", "class": "runway",
                      "source_tags": [["aeroway", "runway"], ["width", "46"]]}
        self.assertEqual(airport_line_width_m(properties), 46.0)

    def test_width_in_feet_is_converted(self):
        properties = {"subtype": "airport", "class": "taxiway", "source_tags": [["width", "75 ft"]]}
        self.assertAlmostEqual(airport_line_width_m(properties), 75 * 0.3048)

    def test_untagged_lines_use_class_defaults(self):
        self.assertEqual(airport_line_width_m({"subtype": "airport", "class": "runway"}), 45.0)
        self.assertEqual(airport_line_width_m({"subtype": "airport", "class": "taxiway"}), 23.0)
        self.assertEqual(airport_line_width_m({"subtype": "airport", "class": "taxilane"}), 15.0)

    def test_malformed_width_falls_back_to_the_default(self):
        properties = {"subtype": "airport", "class": "runway", "source_tags": [["width", "wide"]]}
        self.assertEqual(airport_line_width_m(properties), 45.0)

    def test_non_airport_lines_have_no_width(self):
        self.assertIsNone(airport_line_width_m({"subtype": "airport", "class": "airport_gate"}))
        self.assertIsNone(airport_line_width_m({"subtype": "pier", "class": "runway"}))


class PolygonTests(unittest.TestCase):
    def test_runway_becomes_a_square_ended_strip_of_its_width(self):
        runway = line("runway", centerline(1000.0), source_tags=[["width", "46"]])
        (feature,) = airport_surface_polygons([runway], PROJECTION)
        self.assertEqual(feature["properties"]["class"], "runway")
        self.assertEqual(feature["id"], "runway-1")
        (ring,) = metric_rings(feature)
        xs = [x for x, _y in ring]
        ys = [y for _x, y in ring]
        self.assertAlmostEqual(max(xs) - min(xs), 46.0, delta=0.05)
        self.assertAlmostEqual(max(ys) - min(ys), 1000.0, delta=0.05)
        # Square ends: the area is the full rectangle, not rounded off.
        self.assertAlmostEqual(abs(signed_area(ring)), 46.0 * 1000.0, delta=5.0)

    def test_taxiway_gets_round_ends(self):
        (feature,) = airport_surface_polygons([line("taxiway", centerline(200.0))], PROJECTION)
        (ring,) = metric_rings(feature)
        ys = [y for _x, y in ring]
        self.assertAlmostEqual(max(ys) - min(ys), 200.0 + 23.0, delta=0.1)

    def test_polygons_points_and_other_lines_are_ignored(self):
        gate = {"type": "Feature", "properties": {"subtype": "airport", "class": "airport_gate"},
                "geometry": {"type": "Point", "coordinates": [0, 0]}}
        pier = line("pier", centerline(100.0), subtype="pier")
        self.assertEqual(airport_surface_polygons([area("apron"), gate, pier], PROJECTION), [])

    def test_a_degenerate_centerline_produces_nothing(self):
        self.assertEqual(airport_surface_polygons([line("runway", centerline(0.0))], PROJECTION), [])


if __name__ == "__main__":
    unittest.main()
