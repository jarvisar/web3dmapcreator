"""Geometric difference, overlap queries and preserved slopes."""

import unittest

from jarvizar_city_model.geometry.footprint_cut import FootprintIndex, area_xy


def square(x0, y0, x1, y1):
    return [(x, y, 3+x*.1+y*.2) for x, y in
            ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]


class FootprintCutTests(unittest.TestCase):
    def test_overlap_handles_crossings_enclosure_and_tangency(self):
        mask = FootprintIndex(clearance=0)
        mask.add(square(4, -1, 6, 11))
        for poly in (square(0, 4, 10, 6), square(4.5, 4, 5.5, 6), square(0, -2, 10, 12)):
            self.assertTrue(mask.overlaps(poly))
        self.assertFalse(mask.overlaps(square(0, 0, 4, 1)))
        self.assertFalse(mask.overlaps(square(8, 0, 9, 1)))
        triangle = FootprintIndex(clearance=0)
        triangle.add([(0, 0), (10, 0), (0, 10)])
        self.assertFalse(triangle.overlaps(square(8, 8, 9, 9)))
        self.assertFalse(FootprintIndex().overlaps(square(0, 0, 1, 1)))
        buffered = FootprintIndex(clearance=.005)
        buffered.add(square(4, -1, 6, 11))
        self.assertTrue(buffered.overlaps(square(0, 0, 4, 1)))

    def test_road_splits_surface_without_changing_slope(self):
        mask = FootprintIndex(clearance=0)
        mask.add(square(4, -1, 6, 11))
        pieces = mask.difference(square(0, 0, 10, 10))
        self.assertAlmostEqual(sum(area_xy(p) for p in pieces), 80)
        for piece in pieces:
            for x, y, z in piece:
                self.assertAlmostEqual(z, 3+x*.1+y*.2)

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
