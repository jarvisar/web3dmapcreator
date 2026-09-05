"""Crossing recovery, causeway corridors, and joint naming."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.linework import split_polyline_at_distances
from jarvizar_city_model.geometry.bridge_network import (
    node_key,
    open_water_corridors,
    open_water_runs,
    split_at_open_water,
)


def river(x: float, y: float) -> bool:
    """Open water between x = 10 and x = 20."""
    return 10.0 < x < 20.0


def straight(x0: float, x1: float, step: float = 1.0, y: float = 0.0):
    count = int(round((x1 - x0) / step))
    return [(x0 + step * index, y) for index in range(count + 1)]


class SplitPolylineTests(unittest.TestCase):
    def test_pieces_share_their_cut_vertex(self):
        pieces = split_polyline_at_distances([(0.0, 0.0), (10.0, 0.0)], [4.0])
        self.assertEqual(len(pieces), 2)
        self.assertEqual(pieces[0][-1], pieces[1][0])
        self.assertAlmostEqual(pieces[0][-1][0], 4.0)

    def test_cuts_outside_the_line_are_ignored(self):
        pieces = split_polyline_at_distances([(0.0, 0.0), (10.0, 0.0)], [-1.0, 0.0, 10.0, 25.0])
        self.assertEqual(len(pieces), 1)

    def test_a_cut_on_a_vertex_does_not_make_a_zero_length_piece(self):
        pieces = split_polyline_at_distances([(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)], [5.0])
        self.assertEqual([len(piece) for piece in pieces], [2, 2])


class CrossingRecoveryTests(unittest.TestCase):
    def test_runs_report_inclusive_vertex_indices(self):
        points = straight(0.0, 30.0)
        self.assertEqual(open_water_runs(points, river), [(11, 19)])

    def test_a_crossing_becomes_a_deck_with_land_at_both_ends(self):
        parts = split_at_open_water(straight(0.0, 30.0), river, minimum_length=5.0, extension=2.0)
        kinds = [crossing for _points, crossing in parts]
        self.assertEqual(kinds, [False, True, False])
        deck = parts[1][0]
        # The deck begins two units short of the water on each side.
        self.assertAlmostEqual(deck[0][0], 9.0)
        self.assertAlmostEqual(deck[-1][0], 21.0)
        self.assertFalse(river(*deck[0]))
        self.assertFalse(river(*deck[-1]))

    def test_mapping_slop_shorter_than_the_minimum_is_left_alone(self):
        def puddle(x, y):
            return 14.5 < x < 15.5

        parts = split_at_open_water(straight(0.0, 30.0), puddle, minimum_length=5.0, extension=2.0)
        self.assertEqual(len(parts), 1)
        self.assertFalse(parts[0][1])

    def test_a_line_entirely_over_water_is_one_crossing(self):
        parts = split_at_open_water(straight(12.0, 18.0), river, minimum_length=1.0, extension=2.0)
        self.assertEqual(len(parts), 1)
        self.assertTrue(parts[0][1])

    def test_corridors_overlap_the_bank_by_the_requested_amount(self):
        # Runs are measured between vertices, so the corridor extends from the
        # outermost wet vertex (11 and 19), not from the bank itself.  Callers
        # sample finely enough that the difference is below a terrain cell.
        corridors = open_water_corridors(straight(0.0, 30.0), river, overlap=1.5)
        self.assertEqual(len(corridors), 1)
        self.assertAlmostEqual(corridors[0][0][0], 9.5)
        self.assertAlmostEqual(corridors[0][-1][0], 20.5)

    def test_a_deck_over_dry_land_needs_no_corridor(self):
        self.assertEqual(open_water_corridors(straight(0.0, 8.0), river, overlap=1.5), [])


class NodeKeyTests(unittest.TestCase):
    def test_coordinates_within_tolerance_share_a_key(self):
        self.assertEqual(node_key((15.0, 0.0)), node_key((15.0 + 1.0e-7, -1.0e-7)))
        self.assertNotEqual(node_key((15.0, 0.0)), node_key((15.01, 0.0)))


if __name__ == "__main__":
    unittest.main()
