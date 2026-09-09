"""Water clipping keeps land holes, including those that meet the map frame."""

import math
import unittest

from jarvizar_city_model.data.projection import ModelBounds
from jarvizar_city_model.geometry.planar import point_in_polygon, signed_area
from jarvizar_city_model.geometry.water_geometry import projected_water_polygons


class Transform:
    model_bounds = ModelBounds(0, 20, 0, 20)

    def geographic_to_model(self, x, y, z):
        return x, y, z


def rectangle(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def polygon(*rings):
    return {'type': 'Polygon', 'coordinates': [list(r) + [r[0]] for r in rings]}


class WaterGeometryTests(unittest.TestCase):
    def project(self, geometry):
        polygons, rejected = projected_water_polygons(geometry, Transform())
        self.assertEqual(rejected, 0)
        for rings in polygons:
            self.assertGreater(signed_area(rings[0]), 0)
            self.assertTrue(all(signed_area(h) < 0 for h in rings[1:]))
            self.assertTrue(all(0 <= x <= 20 and 0 <= y <= 20 for r in rings for x, y in r))
        return polygons

    def assertArea(self, polygons, area):
        self.assertAlmostEqual(sum(sum(signed_area(r) for r in p) for p in polygons), area)

    def test_each_frame_edge_turns_a_hole_into_a_notch(self):
        holes = [rectangle(4, -2, 8, 5), rectangle(15, 4, 22, 8),
                 rectangle(4, 15, 8, 22), rectangle(-2, 4, 5, 8)]
        for hole in holes:
            with self.subTest(hole=hole):
                clipped = self.project(polygon(rectangle(-5, -5, 25, 25), hole))
                self.assertEqual(len(clipped), 1)
                self.assertEqual(len(clipped[0]), 1)
                self.assertArea(clipped, 380)
                for x in (1, 6, 11, 16, 19):
                    for y in (1, 6, 11, 16, 19):
                        self.assertEqual(point_in_polygon((x, y), clipped[0]),
                                         point_in_polygon((x, y), [rectangle(-5, -5, 25, 25), hole]))

    def test_hole_crossing_two_edges_can_split_the_water(self):
        clipped = self.project(polygon(rectangle(-5, -5, 25, 25),
                                       rectangle(8, -2, 12, 22), rectangle(2, 6, 4, 8)))
        self.assertEqual(len(clipped), 2)
        self.assertEqual(sorted(len(p) for p in clipped), [1, 2])
        self.assertArea(clipped, 316)
        for point in ((10, 2), (10, 19), (3, 7)):
            self.assertFalse(any(point_in_polygon(point, p) for p in clipped))

    def test_hole_crossing_a_corner(self):
        clipped = self.project(polygon(rectangle(-5, -5, 25, 25), rectangle(-2, -2, 6, 6)))
        self.assertArea(clipped, 364)
        self.assertFalse(point_in_polygon((2, 2), clipped[0]))

    def test_frame_fully_inside_a_land_hole_has_no_water(self):
        self.assertEqual(self.project(polygon(rectangle(-10, -10, 30, 30),
                                              rectangle(-5, -5, 25, 25))), [])

    def test_concave_shell_splits_without_a_return_edge_on_the_frame(self):
        shell = [(2, 2), (6, 2), (6, 24), (14, 24), (14, 2), (18, 2), (18, 28), (2, 28)]
        clipped = self.project(polygon(shell))
        self.assertEqual(len(clipped), 2)
        self.assertArea(clipped, 144)
        self.assertFalse(any(point_in_polygon((10, 18), p) for p in clipped))

    def test_hole_wholly_outside_the_frame_does_not_affect_water(self):
        self.assertArea(self.project(polygon(rectangle(-10, -10, 30, 30),
                                             rectangle(-8, -8, -2, -2))), 400)

    def test_outside_lobe_touching_frame_leaves_no_self_intersecting_spur(self):
        # A single-ring clip walks down x=0 and back up it, even though that
        # entire lobe has zero area inside the frame (the San Francisco bug).
        shell = [(0, 2), (0, 24), (14, 24), (14, 2),
                 (18, 2), (18, 28), (-4, 28), (-4, 2)]
        clipped = self.project(polygon(shell))
        self.assertEqual(len(clipped), 1)
        self.assertArea(clipped, 72)
        self.assertTrue(all(x >= 14 for x, y in clipped[0][0]))

    def test_source_edges_coincident_with_frame(self):
        for shell, area in ((rectangle(0, 0, 20, 20), 400),
                            (rectangle(-10, 0, 0, 20), 0),
                            (rectangle(0, 0, 8, 20), 160)):
            self.assertArea(self.project(polygon(shell)), area)

    def test_hole_edge_coincident_with_frame_opens_a_notch(self):
        self.assertArea(self.project(polygon(rectangle(-5, -5, 25, 25),
                                             rectangle(0, 4, 6, 8))), 376)

    def test_closed_island_and_reversed_winding(self):
        shell, hole = rectangle(-5, -5, 25, 25), rectangle(4, 4, 8, 8)
        for rings in ((shell, hole), (shell[::-1], hole[::-1])):
            clipped = self.project(polygon(*rings))
            self.assertEqual(len(clipped[0]), 2)
            self.assertArea(clipped, 384)

    def test_bad_hole_never_disappears_while_its_shell_is_kept(self):
        for hole in ([], [[2, 2], [5, 2], [5, 5]],
                     [[2, 2], [5, 2], None, [5, 5], [2, 2]],
                     [[2, 2], [5, 2], [math.nan, 5], [2, 2]],
                     [[2, 2], [5, 2], [math.inf, 5], [2, 2]],
                     [[2, 2], [3, 3], [4, 4], [2, 2]]):
            with self.subTest(hole=hole):
                geometry = polygon(rectangle(0, 0, 20, 20))
                geometry['coordinates'].append(hole)
                self.assertEqual(projected_water_polygons(geometry, Transform()), ([], 1))

    def test_incomplete_shell_is_not_closed_by_a_chord(self):
        geometry = polygon(rectangle(1, 1, 19, 19))
        geometry['coordinates'][0].pop()
        self.assertEqual(projected_water_polygons(geometry, Transform()), ([], 1))

    def test_self_intersections_orphan_and_overlapping_holes_are_rejected(self):
        shell = rectangle(1, 1, 19, 19)
        cases = [polygon([(1, 1), (19, 19), (1, 19), (15, 1)]),
                 polygon(shell, rectangle(15, 5, 25, 10)),
                 polygon(shell, rectangle(21, 5, 25, 10)),
                 polygon(shell, rectangle(3, 3, 10, 10), rectangle(5, 5, 12, 12)),
                 polygon(shell, rectangle(3, 3, 15, 15), rectangle(5, 5, 12, 12))]
        for geometry in cases:
            self.assertEqual(projected_water_polygons(geometry, Transform()), ([], 1))

    def test_multipolygon_retains_independent_valid_members(self):
        valid = polygon(rectangle(1, 1, 4, 4), rectangle(2, 2, 3, 3))['coordinates']
        invalid = polygon(rectangle(10, 10, 19, 19))['coordinates']
        invalid[0].pop()
        result, rejected = projected_water_polygons({'type': 'MultiPolygon', 'coordinates': [invalid, valid]}, Transform())
        self.assertEqual(rejected, 1)
        self.assertArea(result, 8)
        self.assertEqual(len(result[0]), 2)


if __name__ == '__main__':
    unittest.main()
