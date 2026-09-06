"""Water masking and the terrain solid it cuts holes in."""

from __future__ import annotations

import math
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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

    def test_crossings_land_on_the_real_boundary(self):
        self.mask.add_polygon([[(2.5, 2.5), (7.5, 2.5), (7.5, 7.5), (2.5, 7.5)]])
        # Node (2, 5) is dry and (3, 5) is wet, so the shore is at x = 2.5.
        self.assertAlmostEqual(self.mask.row_crossing(5, 2, wet_on_left=False), 2.5)
        # Node (5, 2) is dry and (5, 3) is wet, so the shore is at y = 2.5.
        self.assertAlmostEqual(self.mask.column_crossing(2, 5, wet_below=False), 2.5)

    def test_a_crossing_is_never_placed_on_a_grid_node(self):
        self.mask.add_polygon([[(2.0, 2.0), (8.0, 2.0), (8.0, 8.0), (2.0, 8.0)]])
        for column in range(10):
            for row in range(11):
                x = self.mask.row_crossing(row, column, True)
                self.assertGreater(x, column)
                self.assertLess(x, column + 1)

    def test_a_deck_takes_its_footprint_back_out_of_the_water(self):
        self.mask.add_polygon([[(2.5, 2.5), (7.5, 2.5), (7.5, 7.5), (2.5, 7.5)]])
        before = self.mask.wet_nodes
        self.mask.remove_polygon([[(4.5, 4.5), (6.5, 4.5), (6.5, 6.5), (4.5, 6.5)]])
        self.assertEqual(self.mask.wet_nodes, before - 4)
        self.assertFalse(self.mask.is_wet(5, 5))
        self.assertTrue(self.mask.is_wet(3, 3), "the rest of the water is untouched")

    def test_a_knockout_clear_of_the_water_records_no_shoreline(self):
        """A building on dry land must not offer the river a false bank."""
        self.mask.add_polygon([[(2.5, 2.5), (4.5, 2.5), (4.5, 4.5), (2.5, 4.5)]])
        before = dict(self.mask._row_crossings)
        self.assertEqual(
            self.mask.remove_polygon([[(7.2, 7.2), (8.8, 7.2), (8.8, 8.8), (7.2, 8.8)]]),
            0,
        )
        self.assertEqual(self.mask._row_crossings, before)

    def test_a_polygon_outside_the_grid_changes_nothing(self):
        self.assertEqual(
            self.mask.add_polygon([[(50.0, 50.0), (60.0, 50.0), (60.0, 60.0)]]), 0
        )
        self.assertFalse(self.mask.any_wet)

    def test_cell_lookup_reports_water_at_the_bank(self):
        self.mask.add_polygon([[(2.5, 2.5), (7.5, 2.5), (7.5, 7.5), (2.5, 7.5)]])
        self.assertTrue(self.mask.cell_touches_water(5.0, 5.0))
        self.assertTrue(
            self.mask.cell_touches_water(2.9, 5.0), "the bank cell counts as water"
        )
        self.assertFalse(self.mask.cell_touches_water(0.5, 0.5))

    def test_the_dry_polygon_of_a_shore_cell_is_the_terrain_solid_top_face(self):
        """The exact void test must judge against the surface that is printed."""
        self.mask.add_polygon([[(2.5, 2.5), (7.5, 2.5), (7.5, 7.5), (2.5, 7.5)]])
        vertices, _faces, _stats = terrain_solid_geometry(
            flat_grid(11, 11), 0.0, 0.0, 10.0, 10.0, 1.0, self.mask
        )
        tops = {(round(x, 6), round(y, 6)) for x, y, _z in vertices}
        # Cell (2, 5): nodes x=2 dry, x=3 wet, so the shore runs at x = 2.5.
        polygon = {(round(x, 6), round(y, 6)) for x, y in self.mask.cell_dry_polygon(2, 5)}
        self.assertEqual(polygon, {(2.0, 5.0), (2.5, 5.0), (2.5, 6.0), (2.0, 6.0)})
        self.assertTrue(polygon <= tops, "the polygon's vertices are the terrain's own")
        self.assertEqual(self.mask.cell_of(2.4, 5.5), (2, 5))
        self.assertEqual(len(self.mask.cell_dry_polygon(0, 0)), 4, "a dry cell is whole")
        self.assertEqual(self.mask.cell_dry_polygon(5, 5), [], "a wet cell is gone")

    def test_a_slab_clipped_to_the_land_stops_at_the_water_not_at_its_own_outline(self):
        """Where a slab outline and the shore cross one grid edge, the slab ends at the shore.

        The slab outline out over the water is internal to the final wet
        region. It must disappear before either crossing policy is applied.
        """
        slab = [[(1.2, 1.5), (4.8, 1.5), (4.8, 8.5), (1.2, 8.5)]]
        water = [[(4.3, -1.0), (12.0, -1.0), (12.0, 12.0), (4.3, 12.0)]]
        for prefer_dry_end, expected in ((True, 4.3), (False, 4.3)):
            mask = WaterMask(11, 11, 0.0, 0.0, 1.0, 1.0, prefer_dry_end=prefer_dry_end)
            mask.fill_wet()
            mask.remove_polygon(slab)
            mask.add_polygon(water)
            self.assertFalse(mask.is_wet(4, 5))
            self.assertTrue(mask.is_wet(5, 5))
            self.assertAlmostEqual(mask.row_crossing(5, 4, wet_on_left=False), expected)
        # Mirrored: the slab's dry node on the right, the water ending at 5.7.
        slab = [[(5.2, 1.5), (9.5, 1.5), (9.5, 8.5), (5.2, 8.5)]]
        water = [[(-1.0, -1.0), (5.7, -1.0), (5.7, 12.0), (-1.0, 12.0)]]
        for prefer_dry_end, expected in ((True, 5.7), (False, 5.7)):
            mask = WaterMask(11, 11, 0.0, 0.0, 1.0, 1.0, prefer_dry_end=prefer_dry_end)
            mask.fill_wet()
            mask.remove_polygon(slab)
            mask.add_polygon(water)
            self.assertTrue(mask.is_wet(5, 5))
            self.assertFalse(mask.is_wet(6, 5))
            self.assertAlmostEqual(mask.row_crossing(5, 5, wet_on_left=True), expected)


class ComposedShorelineTests(unittest.TestCase):
    def test_overlapping_water_uses_only_union_boundaries_in_both_axes_and_orders(self):
        for mirror in (False, True):
            first = [(4.2, -1), (12, -1), (12, 12), (4.2, 12)]
            second = [(4.8, -1), (12, -1), (12, 12), (4.8, 12)]
            if mirror:
                first = [(10 - x, y) for x, y in first]
                second = [(10 - x, y) for x, y in second]
            for transpose in (False, True):
                rings = [first, second]
                if transpose:
                    rings = [[(y, x) for x, y in ring] for ring in rings]
                for ordered in (rings, rings[::-1]):
                    mask = WaterMask(11, 11, 0, 0, 1, 1)
                    for ring in ordered:
                        mask.add_polygon([ring])
                    edge = 5 if mirror else 4
                    actual = (
                        mask.column_crossing(edge, 5, mirror)
                        if transpose else mask.row_crossing(5, edge, mirror)
                    )
                    self.assertAlmostEqual(actual, 5.8 if mirror else 4.2)

    def test_an_overlapping_water_polygon_fills_part_of_a_hole_in_either_order(self):
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
            self.assertAlmostEqual(mask.row_crossing(5, 6, False), 6.3)

    def test_overlapping_dry_footprints_remove_internal_boundaries(self):
        for reverse in (False, True):
            mask = WaterMask(11, 11, 0, 0, 1, 1, prefer_dry_end=True)
            mask.fill_wet()
            footprints = [
                [[(-1, -1), (4.2, -1), (4.2, 12), (-1, 12)]],
                [[(-1, -1), (4.8, -1), (4.8, 12), (-1, 12)]],
            ]
            for footprint in reversed(footprints) if reverse else footprints:
                mask.remove_polygon(footprint)
            self.assertAlmostEqual(mask.row_crossing(5, 4, False), 4.8)

    def test_genuine_subcell_water_and_land_transitions_keep_resolution_policy(self):
        for prefer_dry_end, expected in ((False, 4.6), (True, 4.2)):
            mask = WaterMask(11, 11, 0, 0, 1, 1, prefer_dry_end=prefer_dry_end)
            mask.add_polygon([[(4.2, -1), (4.4, -1), (4.4, 12), (4.2, 12)]])
            mask.add_polygon([[(4.6, -1), (12, -1), (12, 12), (4.6, 12)]])
            self.assertAlmostEqual(mask.row_crossing(5, 4, False), expected)

    def test_fill_wet_discards_previous_boundaries_before_a_new_subtraction(self):
        mask = WaterMask(11, 11, 0, 0, 1, 1, prefer_dry_end=True)
        mask.add_polygon([[(4.2, -1), (12, -1), (12, 12), (4.2, 12)]])
        mask.fill_wet()
        self.assertEqual(mask._row_crossings, {})
        self.assertEqual(mask._column_crossings, {})
        mask.remove_polygon([[(-1, -1), (4.8, -1), (4.8, 12), (-1, 12)]])
        self.assertAlmostEqual(mask.row_crossing(5, 4, False), 4.8)


class TerrainSolidTests(unittest.TestCase):
    def test_an_uncut_solid_is_closed(self):
        vertices, faces, stats = terrain_solid_geometry(
            flat_grid(9, 7, 2.0), 0.0, 0.0, 8.0, 6.0, 1.0
        )
        bad, degenerate = manifold_report(vertices, faces)
        self.assertEqual((bad, degenerate), (0, 0))
        self.assertEqual(stats["cells_removed"], 0)
        self.assertEqual(stats["duplicate_edges"], 0)

    def test_a_cut_solid_is_still_closed(self):
        mask = WaterMask(21, 17, 0.0, 0.0, 1.0, 1.0)
        mask.add_polygon([[(4.3, 3.7), (15.6, 4.2), (15.1, 11.8), (4.9, 12.4)]])
        vertices, faces, stats = terrain_solid_geometry(
            flat_grid(21, 17, 2.0), 0.0, 0.0, 20.0, 16.0, 1.0, mask
        )
        bad, degenerate = manifold_report(vertices, faces)
        self.assertEqual((bad, degenerate), (0, 0))
        self.assertGreater(stats["cells_removed"], 0)
        self.assertGreater(stats["cells_clipped"], 0)

    def test_a_ragged_cut_is_still_closed(self):
        """A shoreline with concave bays and islands must not open the solid."""
        mask = WaterMask(31, 31, 0.0, 0.0, 1.0, 1.0)
        river = []
        for step in range(41):
            t = step / 40.0
            x = 2.0 + t * 26.0
            river.append((x, 12.0 + 4.0 * math.sin(t * 7.0)))
        for step in range(41):
            t = 1.0 - step / 40.0
            x = 2.0 + t * 26.0
            river.append((x, 18.0 + 3.0 * math.sin(t * 5.0 + 1.0)))
        mask.add_polygon([river])
        mask.add_polygon([[(6.0, 3.0), (11.0, 3.0), (11.0, 8.0), (6.0, 8.0)]])
        mask.remove_polygon([[(14.0, 13.0), (18.0, 13.0), (18.0, 17.0), (14.0, 17.0)]])
        samples = [
            [float(row) * 0.1 + float(column) * 0.05 for column in range(31)]
            for row in range(31)
        ]
        vertices, faces, stats = terrain_solid_geometry(
            samples, 0.0, 0.0, 30.0, 30.0, 2.0, mask
        )
        bad, degenerate = manifold_report(vertices, faces)
        self.assertEqual((bad, degenerate), (0, 0))
        self.assertGreater(stats["cells_clipped"], 20)

    def test_the_cut_follows_the_shore_rather_than_the_grid(self):
        """A bank between two nodes must produce a vertex at the bank."""
        mask = WaterMask(11, 11, 0.0, 0.0, 1.0, 1.0)
        mask.add_polygon([[(3.4, 3.4), (7.6, 3.4), (7.6, 7.6), (3.4, 7.6)]])
        vertices, _faces, _stats = terrain_solid_geometry(
            flat_grid(11, 11), 0.0, 0.0, 10.0, 10.0, 1.0, mask
        )
        off_grid = [
            vertex
            for vertex in vertices
            if abs(vertex[0] - round(vertex[0])) > 1.0e-9
            or abs(vertex[1] - round(vertex[1])) > 1.0e-9
        ]
        self.assertTrue(off_grid, "no shoreline vertex was placed between nodes")
        self.assertTrue(
            any(abs(vertex[0] - 3.4) < 1.0e-6 for vertex in off_grid),
            "the west bank was not placed at its real position",
        )

    def test_water_covering_everything_is_refused_rather_than_emptied(self):
        mask = WaterMask(5, 5, 0.0, 0.0, 1.0, 1.0)
        mask.add_polygon([[(-5.0, -5.0), (9.0, -5.0), (9.0, 9.0), (-5.0, 9.0)]])
        with self.assertRaises(ValueError):
            terrain_solid_geometry(flat_grid(5, 5), 0.0, 0.0, 4.0, 4.0, 1.0, mask)

    def test_the_base_sits_exactly_below_the_lowest_surviving_land(self):
        """The bed a cut removes must not decide how thick the base is."""
        mask = WaterMask(11, 11, 0.0, 0.0, 1.0, 1.0)
        mask.add_polygon([[(3.5, 3.5), (7.5, 3.5), (7.5, 7.5), (3.5, 7.5)]])
        samples = flat_grid(11, 11, 5.0)
        for row in range(3, 8):
            for column in range(3, 8):
                samples[row][column] = -20.0  # a deep channel that is cut away
        vertices, _faces, stats = terrain_solid_geometry(
            samples, 0.0, 0.0, 10.0, 10.0, 1.3, mask
        )
        surviving = [z for _x, _y, z in vertices if z > stats["bottom_z"] + 1.0e-9]
        self.assertAlmostEqual(min(surviving) - stats["bottom_z"], 1.3, places=9)

    def test_a_mismatched_mask_is_rejected(self):
        mask = WaterMask(4, 4, 0.0, 0.0, 1.0, 1.0)
        with self.assertRaises(ValueError):
            terrain_solid_geometry(flat_grid(9, 7), 0.0, 0.0, 8.0, 6.0, 1.0, mask)


if __name__ == "__main__":
    unittest.main()
