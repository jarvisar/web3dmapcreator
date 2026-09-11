"""Closure and shared topology of the continuous cap, independent of Blender."""
import unittest
from collections import Counter
from jarvizar_city_model.geometry.lidar_envelope import envelope_solid
from jarvizar_city_model.geometry.planar import faces_are_consistent


class EnvelopeMeshTests(unittest.TestCase):
    outline = [[[(0, 0), (4, 0), (4, 4), (0, 4)]]]

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
