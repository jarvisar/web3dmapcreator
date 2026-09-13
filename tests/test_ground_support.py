"""The height field's view of cut water, and the solids built back into it."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.linework import split_segment
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.watermask import WaterMask


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

    def test_the_exact_test_is_judged_against_the_outline_itself(self):
        """The terrain is cut along the outline, so the query uses it too."""
        self.assertFalse(self.field.in_cut_water(5.0, 8.49))
        self.assertTrue(self.field.in_cut_water(5.0, 8.51))
        self.assertTrue(self.field.in_cut_water(5.0, 11.49))
        self.assertFalse(self.field.in_cut_water(5.0, 11.51))

    def test_a_channel_between_nodes_has_no_ground(self):
        field = ModelHeightField.flat(_Frame(), height_mm=5.0, resolution=21)
        field.new_void_mask().add_polygon([[(6.2, -1.0), (6.7, -1.0), (6.7, 21.0), (6.2, 21.0)]])
        self.assertTrue(field.over_open_water(6.45, 3.3))
        self.assertFalse(field.has_ground(6.9, 3.3), "piers stay a cell clear of the channel")
        self.assertTrue(field.has_ground(8.5, 3.3))
        self.assertAlmostEqual(field.ground_height_mm(6.45, 3.3), 5.0)

    def test_without_a_cut_nothing_is_void(self):
        field = ModelHeightField.flat(_Frame(), height_mm=2.0, resolution=5)
        self.assertFalse(field.in_cut_water(5.0, 5.0))
        self.assertTrue(field.has_ground(5.0, 5.0))
        self.assertAlmostEqual(field.ground_height_mm(5.0, 5.0), 2.0)


class MaskHelperTests(unittest.TestCase):
    def test_touches_water_looks_only_at_the_polygon_window(self):
        mask = WaterMask(11, 11, 0.0, 0.0, 1.0, 1.0)
        mask.add_polygon([[(2.5, 2.5), (4.5, 2.5), (4.5, 4.5), (2.5, 4.5)]])
        self.assertTrue(mask.touches_water([[(4.0, 4.0), (6.0, 4.0), (6.0, 6.0), (4.0, 6.0)]]))
        self.assertFalse(mask.touches_water([[(7.5, 7.5), (9.5, 7.5), (9.5, 9.5), (7.5, 9.5)]]))


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
