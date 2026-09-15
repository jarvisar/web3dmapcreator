import math
import unittest

from jarvizar_city_model.data.export_sections import grid_angle, plate_origin, section_grid
from jarvizar_city_model.data.export_plates import _paint


RECTANGLE = [(-155, -120), (155, -120), (155, 120), (-155, 120)]


def rotated(ring, angle):
    c, s = math.cos(angle), math.sin(angle)
    return [(x * c - y * s, x * s + y * c) for x, y in ring]


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
            self.assertEqual(cell.angle, 0.0)
        for left, right in ((cells[0], cells[1]), (cells[1], cells[2])):
            self.assertEqual(left.bounds[2], right.bounds[0])
        self.assertEqual(cells[0].bounds[1], cells[3].bounds[3])
        self.assertEqual(len({c.tolerance for c in cells}), 1)
        self.assertEqual(cells[0].name, 'Section R1 C1')

    def test_custom_limits_bed_sizes_and_bad_inputs(self):
        self.assertEqual(len(section_grid((0, 0, 400, 200), 100, 50)), 16)
        # The A1 mini bed is 180 mm: the default 210 mm maxima do not fit it.
        with self.assertRaisesRegex(ValueError, '180 x 180'):
            section_grid((0, 0, 400, 200), plate_width=180, plate_depth=180)
        cells = section_grid((0, 0, 400, 200), 180, 180, plate_width=180, plate_depth=180, angle=0.3)
        self.assertEqual(len(cells), 6)
        self.assertTrue(all(c.angle == 0.3 for c in cells))
        # An H2D section may be wider than the 256 mm beds.
        self.assertEqual(len(section_grid((0, 0, 700, 300), 350, 320, plate_width=350, plate_depth=320)), 2)
        for bounds, width, height in [((0, 0, 0, 1), 210, 210),
                                      ((0, 0, 1, float('nan')), 210, 210),
                                      ((0, 0, 1, 1), 0, 210),
                                      ((0, 0, 1, 1), 257, 210),
                                      ((0, 0, 1, 1), 210, float('inf')),
                                      ((0, 0, 10000, 10000), 210, 210)]:
            with self.assertRaises(ValueError):
                section_grid(bounds, width, height)
        with self.assertRaises(ValueError):
            section_grid((0, 0, 1, 1), angle=float('nan'))
        with self.assertRaises(ValueError):
            section_grid((0, 0, 1, 1), plate_width=0)

    def test_grid_angle_follows_the_dominant_edge_direction(self):
        self.assertEqual(grid_angle(RECTANGLE), 0.0)
        self.assertEqual(grid_angle(list(reversed(RECTANGLE))), 0.0)
        for angle in (0.05, 0.25, math.radians(17), -0.4):
            self.assertAlmostEqual(grid_angle(rotated(RECTANGLE, angle)), angle, places=9)
        # Headings fold modulo a quarter turn onto the nearest axis.
        self.assertAlmostEqual(grid_angle(rotated(RECTANGLE, math.radians(80))), math.radians(-10), places=9)
        self.assertAlmostEqual(abs(grid_angle(rotated(RECTANGLE, math.radians(45)))), math.radians(45), places=9)
        # Bevelled corners do not outvote the long sides.
        bevelled = [(-150, -120), (150, -120), (155, -115), (155, 115),
                    (150, 120), (-150, 120), (-155, 115), (-155, -115)]
        self.assertAlmostEqual(grid_angle(rotated(bevelled, 0.3)), 0.3, places=9)
        # Axis-aligned concave outlines keep their axes; round outlines have
        # no dominant direction and keep world east/north.
        self.assertEqual(grid_angle([(-200, -200), (200, -200), (200, 0), (0, 0), (0, 200), (-200, 200)]), 0.0)
        for radii in ((150, 150), (180, 140)):
            ring = [(radii[0] * math.cos(i * math.tau / 24), radii[1] * math.sin(i * math.tau / 24))
                    for i in range(24)]
            self.assertEqual(grid_angle(ring), 0.0)
            self.assertEqual(grid_angle(rotated(ring, 0.3)), 0.0)
        self.assertEqual(grid_angle([(0, 0), (0, 0), (0, 0)]), 0.0)

    def test_bambu_layout_and_paint_leaf_encoding(self):
        self.assertEqual(plate_origin(1, 2), (307.2, 0))
        self.assertEqual(plate_origin(3, 6), (0, -307.2))
        self.assertEqual(plate_origin(1, 2, 180, 180), (216, 0))
        self.assertEqual(plate_origin(2, 4, 350, 320), (0, -384))
        self.assertEqual([_paint(i) for i in (1, 2, 3, 4, 17, 18)],
                         ['4', '8', '0C', '1C', 'EC', '0FC'])


if __name__ == '__main__':
    unittest.main()
