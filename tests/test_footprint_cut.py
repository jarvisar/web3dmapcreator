"""Geometric difference, preserved slopes and closed printable fragments."""

import unittest

from jarvizar_city_model.geometry.footprint_cut import (
    FootprintIndex, area_xy, fragment_solid,
)
from jarvizar_city_model.geometry.planar import faces_are_consistent, shell_volume


def square(x0, y0, x1, y1):
    return [(x, y, 3+x*.1+y*.2) for x, y in
            ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]


class FootprintCutTests(unittest.TestCase):
    def test_road_splits_surface_without_changing_slope(self):
        mask = FootprintIndex(clearance=0)
        mask.add(square(4, -1, 6, 11))
        pieces = mask.difference(square(0, 0, 10, 10))
        self.assertAlmostEqual(sum(area_xy(p) for p in pieces), 80)
        for piece in pieces:
            for x, y, z in piece:
                self.assertAlmostEqual(z, 3+x*.1+y*.2)
            vertices, faces = fragment_solid(piece, .55)
            self.assertTrue(faces_are_consistent(faces))
            self.assertAlmostEqual(shell_volume(vertices, faces), area_xy(piece)*.55)

    def test_junction_union_and_overlapping_cutters(self):
        mask = FootprintIndex(clearance=0)
        mask.add(square(4, -1, 6, 11))
        mask.add(square(-1, 4, 11, 6))
        mask.add(square(4, -1, 6, 11))
        pieces = mask.difference(square(0, 0, 10, 10))
        self.assertAlmostEqual(sum(area_xy(p) for p in pieces), 64)
        for p in pieces:
            self.assertAlmostEqual(sum(area_xy(q) for q in mask.difference(p)), area_xy(p))

    def test_enclosed_road_creates_hole(self):
        mask = FootprintIndex(clearance=0)
        mask.add(square(4, 4, 6, 6))
        self.assertAlmostEqual(sum(area_xy(p) for p in mask.difference(square(0, 0, 10, 10))), 96)

    def test_complete_removal_empty_index_and_tangent(self):
        original = square(0, 0, 1, 1)
        mask = FootprintIndex(clearance=0)
        self.assertEqual(mask.difference(original), [original])
        mask.add(square(1, 0, 2, 1))
        self.assertEqual(mask.difference(original), [original])
        mask.add(square(-1, -1, 2, 2))
        self.assertEqual(mask.difference(original), [])

    def test_clearance_stays_small_at_acute_corners(self):
        mask = FootprintIndex(clearance=.005)
        mask.add([(0, 0), (10, 0), (.01, .001)])
        self.assertEqual(mask.cutters[0][0], (-.005, -.005, 10.005, .006))

    def test_negative_coordinates_and_multiple_cells(self):
        mask = FootprintIndex(clearance=0, cell_size=.7)
        mask.add(square(-6, -11, -4, 1))
        self.assertAlmostEqual(sum(area_xy(p) for p in mask.difference(square(-10, -10, 0, 0))), 80)
