"""Water masking and the uncut terrain solid."""

from __future__ import annotations

import math
import random
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.geometry.planar import point_in_polygon
from jarvizar_city_model.geometry.terrain_mesh import terrain_solid_geometry
from jarvizar_city_model.geometry.watermask import WaterMask


def flat_grid(columns: int, rows: int, height: float = 0.0):
    return [[height] * columns for _ in range(rows)]


def manifold_report(vertices, faces):
    """Return (non_manifold_edges, degenerate_faces) for a closed solid.

    A closed solid uses every undirected edge exactly twice, and every directed
    edge exactly once.  Counting both catches a hole and a doubled face, which
    a plain undirected count would confuse for each other.
    """
    undirected = Counter()
    directed = Counter()
    degenerate = 0
    for face in faces:
        if len(set(face)) != len(face):
            degenerate += 1
        count = len(face)
        for index in range(count):
            a, b = face[index], face[(index + 1) % count]
            directed[(a, b)] += 1
            undirected[(a, b) if a < b else (b, a)] += 1
    bad = sum(1 for uses in undirected.values() if uses != 2)
    bad += sum(1 for uses in directed.values() if uses != 1)
    return bad, degenerate


class WaterMaskTests(unittest.TestCase):
    def setUp(self):
        self.mask = WaterMask(11, 11, 0.0, 0.0, 1.0, 1.0)

    def test_a_square_marks_only_the_nodes_inside_it(self):
        self.mask.add_polygon([[(2.5, 2.5), (7.5, 2.5), (7.5, 7.5), (2.5, 7.5)]])
        self.assertEqual(self.mask.wet_nodes, 25)
        self.assertTrue(self.mask.is_wet(5, 5))
        self.assertFalse(self.mask.is_wet(2, 5))
        self.assertFalse(self.mask.is_wet(8, 5))

    def test_a_hole_stays_dry(self):
        outer = [(1.5, 1.5), (8.5, 1.5), (8.5, 8.5), (1.5, 8.5)]
        hole = [(3.5, 3.5), (3.5, 6.5), (6.5, 6.5), (6.5, 3.5)]
        self.mask.add_polygon([outer, hole])
        self.assertTrue(self.mask.is_wet(2, 5))
        self.assertFalse(self.mask.is_wet(5, 5), "the hole must not be flooded")
        self.assertTrue(self.mask.contains(2.2, 5.0))
        self.assertFalse(self.mask.contains(3.7, 5.0), "the island between nodes is kept")

    def test_the_exact_test_follows_the_outline_between_nodes(self):
        self.mask.add_polygon([[(2.5, 2.5), (7.5, 2.5), (7.5, 7.5), (2.5, 7.5)]])
        self.assertTrue(self.mask.contains(2.51, 5.3))
        self.assertFalse(self.mask.contains(2.49, 5.3))
        self.assertTrue(self.mask.contains(5.0, 5.0), "a cell no outline crosses reads its corners")
        self.assertFalse(self.mask.contains(0.5, 0.5))

    def test_a_channel_narrower_than_a_cell_is_still_cut(self):
        """No grid node lies in it, but it is a hole in the print all the same."""
        self.mask.add_polygon([[(4.2, -1.0), (4.8, -1.0), (4.8, 12.0), (4.2, 12.0)]])
        self.assertFalse(self.mask.any_wet)
        self.assertTrue(self.mask.contains(4.5, 5.5))
        self.assertFalse(self.mask.contains(4.1, 5.5))
        self.assertFalse(self.mask.contains(4.9, 5.5))
        self.assertTrue(self.mask.cell_touches_water(4.05, 5.5), "the cell test sees the channel")
        self.assertFalse(self.mask.cell_touches_water(2.5, 5.5))
        self.assertTrue(self.mask.touches_water([[(3.1, 3.1), (3.9, 3.1), (3.9, 3.9), (3.1, 3.9)]]))

    def test_a_deck_keeps_its_ground_exactly(self):
        self.mask.add_polygon([[(2.5, 2.5), (7.5, 2.5), (7.5, 7.5), (2.5, 7.5)]])
        before = self.mask.wet_nodes
        self.assertTrue(self.mask.remove_polygon([[(4.5, 4.5), (6.5, 4.5), (6.5, 6.5), (4.5, 6.5)]]))
        self.assertEqual(self.mask.wet_nodes, before - 4)
        self.assertFalse(self.mask.is_wet(5, 5))
        self.assertTrue(self.mask.is_wet(3, 3), "the rest of the water is untouched")
        # A pier narrower than a cell holds no node, and still keeps its ground.
        self.assertTrue(self.mask.remove_polygon([[(3.2, 2.0), (3.4, 2.0), (3.4, 4.0), (3.2, 4.0)]]))
        self.assertFalse(self.mask.contains(3.3, 3.5))
        self.assertTrue(self.mask.contains(3.6, 3.5))
        self.assertEqual(len(self.mask.ground_polygons), 2)
        for point in ((3.2, 3.0), (3.4, 3.0), (3.3, 4.0), (6.5, 5.25), (4.5, 5.5)):
            self.assertFalse(self.mask.contains(*point), f"kept ground includes its outline at {point}")

    def test_a_footprint_clear_of_the_water_is_ignored(self):
        """A building on dry land must not add outline edges to the queries."""
        self.mask.add_polygon([[(2.5, 2.5), (4.5, 2.5), (4.5, 4.5), (2.5, 4.5)]])
        self.assertFalse(self.mask.remove_polygon([[(7.2, 7.2), (8.8, 7.2), (8.8, 8.8), (7.2, 8.8)]]))
        self.assertEqual(self.mask.ground_polygons, [])

    def test_ground_must_follow_all_of_the_water(self):
        self.mask.add_polygon([[(2.5, 2.5), (7.5, 2.5), (7.5, 7.5), (2.5, 7.5)]])
        self.mask.remove_polygon([[(4.5, 4.5), (6.5, 4.5), (6.5, 6.5), (4.5, 6.5)]])
        with self.assertRaises(ValueError):
            self.mask.add_polygon([[(0.5, 0.5), (1.5, 0.5), (1.5, 1.5)]])

    def test_overlapping_water_is_united_in_either_order(self):
        lake = [
            [(1.2, 1.2), (9.8, 1.2), (9.8, 9.8), (1.2, 9.8)],
            [(3.2, 3.2), (6.8, 3.2), (6.8, 6.8), (3.2, 6.8)],
        ]
        overlap = [[(6.3, 2.2), (9.2, 2.2), (9.2, 8.8), (6.3, 8.8)]]
        for polygons in ((lake, overlap), (overlap, lake)):
            mask = WaterMask(11, 11, 0, 0, 1, 1)
            for polygon in polygons:
                mask.add_polygon(polygon)
            self.assertFalse(mask.is_wet(5, 5), "the remaining island stays dry")
            self.assertTrue(mask.is_wet(7, 5))
            self.assertFalse(mask.contains(6.2, 5.1))
            self.assertTrue(mask.contains(6.4, 5.1))
            self.assertTrue(mask.contains(9.5, 5.1), "inside both polygons is still water")

    def test_a_polygon_outside_the_grid_changes_nothing(self):
        self.assertEqual(
            self.mask.add_polygon([[(50.0, 50.0), (60.0, 50.0), (60.0, 60.0)]]), 0
        )
        self.assertFalse(self.mask.any_wet)
        self.assertEqual(self.mask.water_polygons, [])

    def test_cell_lookup_reports_water_at_the_bank(self):
        self.mask.add_polygon([[(2.5, 2.5), (7.5, 2.5), (7.5, 7.5), (2.5, 7.5)]])
        self.assertTrue(self.mask.cell_touches_water(5.0, 5.0))
        self.assertTrue(
            self.mask.cell_touches_water(2.1, 5.0), "the bank cell counts as water"
        )
        self.assertFalse(self.mask.cell_touches_water(0.5, 0.5))
        self.assertEqual(self.mask.cell_of(2.4, 5.5), (2, 5))

    def test_the_exact_test_matches_point_in_polygon_everywhere(self):
        """Ragged water with an island and a pier, against the plain definition."""
        rng = random.Random(11)
        mask = WaterMask(21, 17, 0.0, 0.0, 1.0, 1.0)
        # Offset from the grid lines, where a node on the outline has no defined side.
        river = [(2.05 + 0.39 * step, 5.5 + 1.5 * math.sin(step * 0.7)) for step in range(41)]
        river += [(2.05 + 0.39 * step, 11.0 + 1.5 * math.sin(step * 0.5 + 1.0)) for step in reversed(range(41))]
        lake = [[(3.3, 1.2), (17.7, 1.4), (18.2, 5.1), (2.9, 4.6)], [(8.1, 2.1), (8.9, 3.9), (9.4, 2.0)]]
        pier = [[(12.05, 0.5), (12.35, 0.5), (12.35, 12.5), (12.05, 12.5)]]
        mask.add_polygon([river])
        mask.add_polygon(lake)
        mask.remove_polygon(pier)
        for _ in range(3000):
            x, y = rng.uniform(0.0, 20.0), rng.uniform(0.0, 16.0)
            expected = (point_in_polygon((x, y), [river]) or point_in_polygon((x, y), lake)) and not \
                point_in_polygon((x, y), pier)
            self.assertEqual(mask.contains(x, y), expected, (x, y))
        for row in range(17):
            for column in range(21):
                x, y = float(column), float(row)
                inside = (point_in_polygon((x, y), [river]) or point_in_polygon((x, y), lake)) and not \
                    point_in_polygon((x, y), pier)
                self.assertEqual(mask.is_wet(column, row), inside, (column, row))


class TerrainSolidTests(unittest.TestCase):
    def test_an_uncut_solid_is_closed(self):
        vertices, faces, stats = terrain_solid_geometry(
            flat_grid(9, 7, 2.0), 0.0, 0.0, 8.0, 6.0, 1.0
        )
        bad, degenerate = manifold_report(vertices, faces)
        self.assertEqual((bad, degenerate), (0, 0))
        self.assertEqual(stats["duplicate_edges"], 0)

    def test_the_base_sits_exactly_below_the_lowest_land(self):
        samples = [[0.1 * row - 0.05 * column for column in range(9)] for row in range(7)]
        vertices, _faces, stats = terrain_solid_geometry(samples, 0.0, 0.0, 8.0, 6.0, 1.3)
        surviving = [z for _x, _y, z in vertices if z > stats["bottom_z"] + 1.0e-9]
        self.assertAlmostEqual(min(surviving) - stats["bottom_z"], 1.3, places=9)


if __name__ == "__main__":
    unittest.main()
