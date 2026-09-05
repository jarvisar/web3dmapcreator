"""Tests for elevation tile decoding, tile arithmetic, and grid sampling."""

from __future__ import annotations

import array
import json
import math
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

from jarvizar_city_model.data.dem import DEMTerrain, ElevationGrid, ElevationGridError
from jarvizar_city_model.external.download_dem import (
    DemError,
    choose_zoom,
    decode_png_rgb,
    ground_resolution_m,
    tile_fraction,
)


def encode_png_rgb(width, height, pixels, filter_type=0):
    """Build a minimal 8-bit truecolour PNG using a single filter type."""
    raw = bytearray()
    stride = width * 3
    previous = bytearray(stride)
    for row in range(height):
        line = bytearray(pixels[row * stride : (row + 1) * stride])
        raw.append(filter_type)
        if filter_type == 0:
            raw.extend(line)
        elif filter_type == 1:
            encoded = bytearray(line)
            for index in range(stride - 1, 2, -1):
                encoded[index] = (line[index] - line[index - 3]) & 0xFF
            raw.extend(encoded)
        elif filter_type == 2:
            raw.extend(bytes((line[i] - previous[i]) & 0xFF for i in range(stride)))
        else:
            raise ValueError("unsupported test filter")
        previous = line

    def chunk(tag, body):
        return (
            struct.pack(">I", len(body))
            + tag
            + body
            + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw)))
        + chunk(b"IEND", b"")
    )


class PngDecodingTests(unittest.TestCase):
    def _round_trip(self, filter_type):
        width, height = 4, 3
        pixels = bytes((value * 7 + 3) % 256 for value in range(width * height * 3))
        decoded_width, decoded_height, decoded = decode_png_rgb(
            encode_png_rgb(width, height, pixels, filter_type)
        )
        self.assertEqual((decoded_width, decoded_height), (width, height))
        self.assertEqual(bytes(decoded), pixels)

    def test_decodes_unfiltered_rows(self):
        self._round_trip(0)

    def test_decodes_sub_filtered_rows(self):
        self._round_trip(1)

    def test_decodes_up_filtered_rows(self):
        self._round_trip(2)

    def test_rejects_non_png_payload(self):
        with self.assertRaises(DemError):
            decode_png_rgb(b"not a png at all")

    def test_rejects_unsupported_colour_type(self):
        header = struct.pack(">IIBBBBB", 4, 4, 8, 6, 0, 0, 0)
        payload = bytearray(encode_png_rgb(4, 4, bytes(48)))
        payload[16:16 + len(header)] = header
        with self.assertRaises(DemError):
            decode_png_rgb(bytes(payload))

    def test_terrarium_encoding_round_trips_to_metres(self):
        # 137 m, the approximate Ohio River surface, encoded as terrarium RGB.
        elevation = 137.5
        raw = int(round((elevation + 32768.0) * 256.0))
        red, green, blue = (raw >> 16) & 0xFF, (raw >> 8) & 0xFF, raw & 0xFF
        decoded = red * 256.0 + green + blue / 256.0 - 32768.0
        self.assertAlmostEqual(decoded, elevation, places=3)


class TileArithmeticTests(unittest.TestCase):
    def test_tile_fraction_matches_known_slippy_tile(self):
        x, y = tile_fraction(-84.50396, 39.09824, 12)
        self.assertEqual((int(x), int(y)), (1086, 1563))

    def test_origin_maps_to_the_middle_of_the_world(self):
        x, y = tile_fraction(0.0, 0.0, 1)
        self.assertAlmostEqual(x, 1.0)
        self.assertAlmostEqual(y, 1.0)

    def test_ground_resolution_halves_each_zoom_level(self):
        coarse = ground_resolution_m(39.0, 12)
        fine = ground_resolution_m(39.0, 13)
        self.assertAlmostEqual(coarse / fine, 2.0, places=6)

    def test_choose_zoom_respects_the_requested_spacing(self):
        bounds = (-84.5337, 39.08554, -84.47422, 39.11094)
        coarse = choose_zoom(*bounds, target_spacing_m=120.0)
        fine = choose_zoom(*bounds, target_spacing_m=15.0)
        self.assertLess(coarse, fine)
        self.assertLessEqual(ground_resolution_m(39.1, fine), 15.0)

    def test_choose_zoom_respects_the_tile_budget(self):
        bounds = (-84.6, 39.0, -84.4, 39.2)
        self.assertLessEqual(choose_zoom(*bounds, target_spacing_m=1.0, maximum_tiles=4), 12)


class ElevationGridTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="jcm_dem_"))
        self.columns, self.rows = 5, 3
        # A pure west-to-east ramp from 100 m to 300 m.
        values = array.array("f")
        for _row in range(self.rows):
            for column in range(self.columns):
                values.append(100.0 + 200.0 * column / (self.columns - 1))
        with (self.directory / "terrain.f32").open("wb") as handle:
            values.tofile(handle)
        (self.directory / "terrain.json").write_text(
            json.dumps(
                {
                    "format": "jcm_elevation_grid",
                    "version": 1,
                    "west": -1.0,
                    "south": -1.0,
                    "east": 1.0,
                    "north": 1.0,
                    "columns": self.columns,
                    "rows": self.rows,
                    "source": "unit-test",
                    "zoom": 12,
                    "ground_resolution_m": 30.0,
                }
            ),
            encoding="utf-8",
        )
        self.grid = ElevationGrid.load(self.directory)

    def test_corners_sample_exactly(self):
        self.assertAlmostEqual(self.grid.sample_raw_m(-1.0, -1.0), 100.0, places=4)
        self.assertAlmostEqual(self.grid.sample_raw_m(1.0, 1.0), 300.0, places=4)

    def test_bilinear_midpoint(self):
        self.assertAlmostEqual(self.grid.sample_raw_m(0.0, 0.0), 200.0, places=4)

    def test_sampling_outside_bounds_clamps_to_the_edge(self):
        self.assertAlmostEqual(self.grid.sample_raw_m(-9.0, 0.0), 100.0, places=4)
        self.assertAlmostEqual(self.grid.sample_raw_m(9.0, 0.0), 300.0, places=4)

    def test_minimum_and_maximum(self):
        self.assertAlmostEqual(self.grid.minimum_m, 100.0, places=4)
        self.assertAlmostEqual(self.grid.maximum_m, 300.0, places=4)

    def test_matches_reports_coverage(self):
        self.assertTrue(self.grid.matches(-0.5, -0.5, 0.5, 0.5))
        self.assertFalse(self.grid.matches(-5.0, -0.5, 0.5, 0.5))

    def test_rejects_a_foreign_header(self):
        (self.directory / "terrain.json").write_text(
            json.dumps({"format": "something-else", "version": 1}), encoding="utf-8"
        )
        with self.assertRaises(ElevationGridError):
            ElevationGrid.load(self.directory)

    def test_rejects_a_missing_grid(self):
        with self.assertRaises(ElevationGridError):
            ElevationGrid.load(self.directory / "nowhere")


class DEMTerrainTests(unittest.TestCase):
    def setUp(self):
        values = array.array("f", [100.0, 300.0, 100.0, 300.0])
        self.grid = ElevationGrid(
            west=-1.0, south=-1.0, east=1.0, north=1.0,
            columns=2, rows=2, values=values,
        )

    def test_reference_normalizes_to_the_grid_minimum(self):
        terrain = DEMTerrain(self.grid)
        self.assertAlmostEqual(terrain.sample_m(-1.0, 0.0), 0.0, places=4)
        self.assertAlmostEqual(terrain.sample_m(1.0, 0.0), 200.0, places=4)

    def test_exaggeration_scales_relief_only(self):
        terrain = DEMTerrain(self.grid, exaggeration=2.5)
        self.assertAlmostEqual(terrain.sample_m(-1.0, 0.0), 0.0, places=4)
        self.assertAlmostEqual(terrain.sample_m(1.0, 0.0), 500.0, places=4)
        self.assertAlmostEqual(terrain.relief_m, 500.0, places=4)

    def test_minimum_over_finds_the_lowest_footprint_corner(self):
        terrain = DEMTerrain(self.grid)
        lowest = terrain.minimum_over([(-1.0, 0.0), (0.0, 0.0), (1.0, 0.0)])
        self.assertAlmostEqual(lowest, 0.0, places=4)

    def test_minimum_over_empty_input_is_zero(self):
        self.assertEqual(DEMTerrain(self.grid).minimum_over([]), 0.0)

    def test_negative_exaggeration_is_rejected(self):
        with self.assertRaises(ValueError):
            DEMTerrain(self.grid, exaggeration=-1.0)


if __name__ == "__main__":
    unittest.main()
