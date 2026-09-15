"""Closure and shared topology of the continuous cap, independent of Blender."""
import unittest
from collections import Counter
from types import SimpleNamespace
from jarvizar_city_model.geometry.lidar_envelope import clip_cap, envelope_solid
from jarvizar_city_model.geometry.planar import faces_are_consistent


class EnvelopeMeshTests(unittest.TestCase):
    outline = [[[(0, 0), (4, 0), (4, 4), (0, 4)]]]

    def test_cap_corners_rounded_off_the_outline_join_within_precision(self):
        # A published cap is rounded to nine decimals in degrees, about a
        # tenth of a millimetre on the ground. Near the model centre that is
        # more than float32 rounding, so the outline test takes a precision.
        off = 4-5e-6
        caps = [[(0, 0, 2), (off, 0, 6), (0, 4, 2)], [(off, 0, 6), (off, 4, 6), (0, 4, 2)]]
        self.assertIsNone(envelope_solid(caps, 0, self.outline))
        vertices, faces = envelope_solid(caps, 0, self.outline, precision=1e-5)
        self.assertTrue(faces_are_consistent(faces))
        self.assertEqual(sum(len(f) == 4 for f in faces), 4)

    def test_clip_cap_carries_heights_through_the_frame(self):
        bounds = SimpleNamespace(min_x_mm=0, min_y_mm=0, max_x_mm=4, max_y_mm=10)
        # A wall facet a hundred units tall across the frame edge: a plane
        # refitted through rounded corners would miss; the heights are carried.
        wall = [(2, 0, 10), (6, 0, 10), (6, 2, 110), (2, 2, 110)]
        self.assertEqual(clip_cap(wall, bounds), [(2, 0, 10), (4, 0, 10), (4, 2, 110), (2, 2, 110)])
        slope = [(0, 0, 0), (8, 0, 0), (8, 8, 80)]
        clipped = clip_cap(slope, bounds)
        self.assertEqual(len(clipped), 3)
        for x, y, z in clipped:
            self.assertLessEqual(x, 4)
            self.assertAlmostEqual(z, 10*y)
        self.assertEqual(clip_cap([(5, 0, 1), (6, 0, 1), (6, 1, 1)], bounds), [])
        wide = SimpleNamespace(min_x_mm=-1, min_y_mm=-1, max_x_mm=9, max_y_mm=9)
        self.assertEqual(clip_cap(slope, wide), slope)

    def test_clipped_shared_edge_split_has_no_internal_wall(self):
        caps = [[(0, 0, 2), (4, 0, 6), (0, 4, 2)],
                [(4, 0, 6), (4, 4, 6), (2, 2, 4)],
                [(2, 2, 4), (4, 4, 6), (0, 4, 2)]]
        vertices, faces = envelope_solid(caps, 0, self.outline)
        self.assertTrue(faces_are_consistent(faces))
        uses = Counter(tuple(sorted((a, b))) for f in faces for a, b in zip(f, (*f[1:], f[0])))
        self.assertEqual(set(uses.values()), {2})
        walls = [f for f in faces if len(f) == 4]
        self.assertEqual(len(walls), 4)
        self.assertTrue(all(len({vertices[i][2] for i in f}) > 1 for f in walls))

    def test_missing_cap_and_inconsistent_shared_heights_are_rejected(self):
        triangle = [(0, 0, 2), (4, 0, 6), (0, 4, 2)]
        self.assertIsNone(envelope_solid([triangle], 0, self.outline))
        other = [(4, 0, 8), (4, 4, 6), (0, 4, 2)]
        self.assertIsNone(envelope_solid([triangle, other], 0, self.outline))

    def test_courtyard_is_open_and_has_only_its_exterior_walls(self):
        outer = [(0, 0), (4, 0), (4, 4), (0, 4)]
        inner = [(1, 1), (3, 1), (3, 3), (1, 3)]
        caps = [[(*outer[i], 3), (*outer[(i+1)%4], 3),
                 (*inner[(i+1)%4], 3), (*inner[i], 3)] for i in range(4)]
        vertices, faces = envelope_solid(caps, 0, [[outer, list(reversed(inner))]])
        self.assertTrue(faces_are_consistent(faces))
        self.assertEqual(sum(len(f) == 4 for f in faces), 8)


if __name__ == '__main__':
    unittest.main()
