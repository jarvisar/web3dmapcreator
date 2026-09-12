"""Printable tier topology and efficient clearance against a brute-force oracle."""

import math
import random
import unittest
from collections import Counter

from jarvizar_city_model.geometry.planar import faces_are_consistent, shell_volume
from jarvizar_city_model.geometry.tree_geometry import (
    TreeClearance, tree_solid_geometry,
)


class TreeGeometryTests(unittest.TestCase):
    def test_closed_outward_supported_solids_at_varied_proportions(self):
        for sides in (3, 4, 6, 8):
            for radius, height in ((.635, 1.6), (1, 3), (2.5, .05)):
                for embed in (0, .15):
                    with self.subTest(sides=sides, radius=radius, height=height, embed=embed):
                        vertices, faces = tree_solid_geometry(radius, height, sides, embed)
                        edges = Counter(tuple(sorted((a, b))) for f in faces
                                        for a, b in zip(f, f[1:] + f[:1]))
                        self.assertEqual(set(edges.values()), {2})
                        self.assertTrue(faces_are_consistent(faces))
                        self.assertGreater(shell_volume(vertices, faces), 0)
                        self.assertEqual(min(v[2] for v in vertices), -embed)
                        self.assertEqual(max(v[2] for v in vertices), height)
                        profile = [(math.hypot(x, y), z) for x, y, z in vertices[:-1:sides]]
                        self.assertEqual(profile[0][0], radius)  # foliage base, no trunk
                        for (r0, z0), (r1, z1) in zip(profile, profile[1:]):
                            self.assertGreater(z1, z0)
                            self.assertLessEqual(r1 - r0, z1 - z0 + 1e-9)
                        self.assertLessEqual(len(vertices), 6 * sides + 1)

    def test_three_readable_tiers_at_default_size(self):
        vertices, _ = tree_solid_geometry(1.1 / (2 * math.cos(math.pi / 6)), 1.6)
        profile = [(math.hypot(x, y), z) for x, y, z in vertices[::6]]
        peaks = [i for i in range(len(profile) - 1)
                 if (i == 0 or profile[i][0] > profile[i - 1][0])
                 and profile[i][0] > profile[i + 1][0]]
        self.assertEqual(len(peaks), 3)
        self.assertGreater(profile[2][0] - profile[1][0], .1)
        self.assertGreater(profile[4][0] - profile[3][0], .1)


class TreeClearanceTests(unittest.TestCase):
    def test_hash_matches_exact_clearance_with_varied_radii(self):
        randomizer = random.Random(92)
        clearance = TreeClearance(1.8, .2)
        kept = []
        for _ in range(3000):
            x, y = randomizer.uniform(-30, 30), randomizer.uniform(-30, 30)
            radius = randomizer.uniform(.3, 1.8)
            expected = all(math.hypot(x - px, y - py) >= radius + pr + .2
                           for px, py, pr in kept)
            self.assertEqual(clearance.accept(x, y, radius), expected)
            if expected:
                kept.append((x, y, radius))
        self.assertGreater(len(kept), 200)

    def test_duplicate_and_exact_clearance(self):
        clearance = TreeClearance(1, .2)
        self.assertTrue(clearance.accept(0, 0, .5))
        self.assertFalse(clearance.accept(0, 0, .5))
        self.assertFalse(clearance.accept(-1.699, 0, 1))
        self.assertTrue(clearance.accept(-1.7, 0, 1))


if __name__ == '__main__':
    unittest.main()
