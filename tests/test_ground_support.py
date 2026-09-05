"""The height field's view of cut water, and the solids built back into it."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.linework import split_segment
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.terrain_mesh import terrain_solid_geometry
from jarvizar_city_model.geometry.watermask import WaterMask
from test_terrain_cut import flat_grid, manifold_report


class _Frame:
    """The little a height field needs from a transform to be built flat."""

    class _Bounds:
        min_x_mm = 0.0
        max_x_mm = 20.0
        min_y_mm = 0.0
        max_y_mm = 20.0
        width_mm = 20.0
        height_mm = 20.0

    model_bounds = _Bounds()


def field_with_river():
    """A 21x21 unit grid with a river across the middle rows, cut out."""
    field = ModelHeightField.flat(_Frame(), height_mm=5.0, resolution=21)
    river = [[(-1.0, 8.5), (21.0, 8.5), (21.0, 11.5), (-1.0, 11.5)]]
    for row in range(9, 12):
        for column in range(field.columns):
            field.values[row * field.columns + column] = 1.0
    mask = field.new_void_mask()
    mask.add_polygon(river)
    field.void_rings = [river]
    return field, river


class VoidQueryTests(unittest.TestCase):
    def setUp(self):
        self.field, self.river = field_with_river()

    def test_exact_test_agrees_with_the_outline_in_shore_cells(self):
        # Between the bank (8.5) and the first wet node row (9) the cell is
        # mixed: the outline decides.
        self.assertTrue(self.field.in_cut_water(5.0, 8.7))
        self.assertFalse(self.field.in_cut_water(5.0, 8.3))
        self.assertTrue(self.field.is_void(5.0, 8.3), "the cell test errs wet at the bank")

    def test_deep_water_and_dry_land_answer_without_the_outline(self):
        self.assertTrue(self.field.in_cut_water(5.0, 10.0))
        self.assertFalse(self.field.in_cut_water(5.0, 3.0))

    def test_a_support_footprint_counts_as_ground(self):
        self.assertFalse(self.field.has_ground(10.0, 10.0))
        self.field.add_support([[(9.0, 8.0), (11.0, 8.0), (11.0, 12.0), (9.0, 12.0)]])
        self.assertTrue(self.field.has_ground(10.0, 10.0))
        self.assertFalse(self.field.over_open_water(10.0, 10.0))
        self.assertTrue(self.field.over_open_water(15.0, 10.0), "the rest stays open")

    def test_ground_height_over_the_cut_is_the_nearest_bank(self):
        self.assertAlmostEqual(self.field.height_mm(10.0, 10.0), 1.0)
        self.assertAlmostEqual(self.field.ground_height_mm(10.0, 10.0), 5.0)
        self.assertAlmostEqual(self.field.ground_height_mm(10.0, 3.0), 5.0)

    def test_ground_height_follows_the_bank_on_the_dry_side_of_a_shore_cell(self):
        """A road running down the bank into the water follows the bank."""
        # Between the bank row (5.0) and the flattened bed row (1.0) the printed
        # surface slopes, and a point on its dry side is on that slope.
        self.assertAlmostEqual(self.field.height_mm(5.0, 8.3), 5.0 - 0.3 * 4.0)
        self.assertAlmostEqual(
            self.field.ground_height_mm(5.0, 8.3), self.field.height_mm(5.0, 8.3)
        )
        # Past the shore there is no surface, and the nearest bank stands in.
        self.assertAlmostEqual(self.field.ground_height_mm(5.0, 8.7), 5.0)

    def test_the_exact_test_matches_the_terrain_solid_at_the_shore(self):
        """Points are judged against the shore the terrain solid actually builds."""
        vertices, _faces, _stats = terrain_solid_geometry(
            self.field.rows_2d(),
            self.field.min_x,
            self.field.min_y,
            self.field.max_x,
            self.field.max_y,
            1.0,
            self.field.void_mask,
        )
        shore = sorted({round(y, 6) for _x, y, _z in vertices if 8.0 < y < 9.0})
        self.assertEqual(shore, [8.5])
        self.assertFalse(self.field.in_cut_water(5.0, 8.49))
        self.assertTrue(self.field.in_cut_water(5.0, 8.51))

    def test_without_a_cut_nothing_is_void(self):
        field = ModelHeightField.flat(_Frame(), height_mm=2.0, resolution=5)
        self.assertFalse(field.in_cut_water(5.0, 5.0))
        self.assertTrue(field.has_ground(5.0, 5.0))
        self.assertAlmostEqual(field.ground_height_mm(5.0, 5.0), 2.0)


class MaskHelperTests(unittest.TestCase):
    def test_fill_wet_marks_every_node(self):
        mask = WaterMask(6, 6, 0.0, 0.0, 1.0, 1.0)
        mask.fill_wet()
        self.assertEqual(mask.wet_nodes, 36)
        self.assertEqual(mask.cell_wet_corners(2.5, 2.5), 4)

    def test_touches_water_looks_only_at_the_polygon_window(self):
        mask = WaterMask(11, 11, 0.0, 0.0, 1.0, 1.0)
        mask.add_polygon([[(2.5, 2.5), (4.5, 2.5), (4.5, 4.5), (2.5, 4.5)]])
        self.assertTrue(mask.touches_water([[(4.0, 4.0), (6.0, 4.0), (6.0, 6.0), (4.0, 6.0)]]))
        self.assertFalse(mask.touches_water([[(7.5, 7.5), (9.5, 7.5), (9.5, 9.5), (7.5, 9.5)]]))


class DrapedSlabTests(unittest.TestCase):
    def test_a_clipped_slab_is_closed_and_follows_the_ground(self):
        """A park clipped to the land beside a river must still be watertight."""
        mask = WaterMask(21, 21, 0.0, 0.0, 1.0, 1.0)
        mask.fill_wet()
        park = [[(3.3, 3.3), (16.6, 3.3), (16.6, 14.2), (3.3, 14.2)]]
        self.assertGreater(mask.remove_polygon(park), 0)
        mask.add_polygon([[(-1.0, 8.5), (21.0, 8.5), (21.0, 11.5), (-1.0, 11.5)]])
        samples = [[0.1 * row + 0.05 * column for column in range(21)] for row in range(21)]
        vertices, faces, stats = terrain_solid_geometry(
            samples, 0.0, 0.0, 20.0, 20.0, 0.6, mask, draped_bottom=True
        )
        bad, degenerate = manifold_report(vertices, faces)
        self.assertEqual((bad, degenerate), (0, 0))
        # Every bottom vertex sits exactly 0.6 under its top twin.
        half = len(vertices) // 2
        for index in range(half):
            self.assertAlmostEqual(vertices[index][2] - vertices[half + index][2], 0.6)
        # Nothing was built over the river rows.
        for x, y, _z in vertices:
            self.assertFalse(8.6 < y < 11.4, f"vertex at y={y} lies in the river")
        # And nothing outside the park's outline.
        for x, y, _z in vertices:
            self.assertTrue(3.29 <= x <= 16.61 and 3.29 <= y <= 14.21)
        self.assertGreater(stats["cells_clipped"], 0)


class RailFlagTests(unittest.TestCase):
    def test_rail_bridge_flags_split_and_mark_the_piece(self):
        properties = {
            "subtype": "rail",
            "class": "standard_gauge",
            "rail_flags": [{"values": ["is_bridge", "is_freight"], "between": [0.0, 0.5]}],
        }
        pieces = split_segment(
            "rail-1",
            [(0.0, 0.0), (100.0, 0.0)],
            properties,
            class_defaults={"rail": 4.0},
            road_class="rail",
        )
        self.assertEqual(len(pieces), 2)
        self.assertTrue(pieces[0].is_bridge)
        self.assertFalse(pieces[1].is_bridge)
        self.assertEqual(pieces[0].road_class, "rail")
        self.assertEqual(pieces[0].width_m, 4.0)


if __name__ == "__main__":
    unittest.main()
