import unittest

from jarvizar_city_model.data.export_sections import section_grid, plate_origin
from jarvizar_city_model.data.export_plates import _paint


class SectionGridTests(unittest.TestCase):
    def test_fit_exact_limits_and_uneven_grid(self):
        self.assertEqual(len(section_grid((-105, -105, 105, 105))), 1)
        self.assertEqual(len(section_grid((0, 0, 420, 210))), 2)
        cells = section_grid((-237.3, -123.8, 237.3, 123.8))
        self.assertEqual([(c.row, c.column) for c in cells],
                         [(1, 1), (1, 2), (1, 3), (2, 1), (2, 2), (2, 3)])
        for cell in cells:
            w, s, e, n = cell.bounds
            self.assertLessEqual(e - w, 210)
            self.assertLessEqual(n - s, 210)
        for left, right in ((cells[0], cells[1]), (cells[1], cells[2])):
            self.assertEqual(left.bounds[2], right.bounds[0])
        self.assertEqual(cells[0].bounds[1], cells[3].bounds[3])
        self.assertEqual(len({c.tolerance for c in cells}), 1)
        self.assertEqual(cells[0].name, 'Section R1 C1')

    def test_custom_limits_and_bad_inputs(self):
        self.assertEqual(len(section_grid((0, 0, 400, 200), 100, 50)), 16)
        for bounds, width, height in [((0, 0, 0, 1), 210, 210),
                                      ((0, 0, 1, float('nan')), 210, 210),
                                      ((0, 0, 1, 1), 0, 210),
                                      ((0, 0, 1, 1), 257, 210),
                                      ((0, 0, 1, 1), 210, float('inf')),
                                      ((0, 0, 10000, 10000), 210, 210)]:
            with self.assertRaises(ValueError):
                section_grid(bounds, width, height)

    def test_bambu_layout_and_paint_leaf_encoding(self):
        self.assertEqual(plate_origin(1, 2), (307.2, 0))
        self.assertEqual(plate_origin(3, 6), (0, -307.2))
        self.assertEqual([_paint(i) for i in (1, 2, 3, 4, 17, 18)],
                         ['4', '8', '0C', '1C', 'EC', '0FC'])
