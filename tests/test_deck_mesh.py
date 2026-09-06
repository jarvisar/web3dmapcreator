"""Deck caps must preserve crests, cross-sections and closed-shell geometry."""

import unittest
from collections import Counter

from jarvizar_city_model.geometry.deck_mesh import deck_strip_geometry
from jarvizar_city_model.geometry.planar import faces_are_consistent, shell_volume


class DeckMeshTests(unittest.TestCase):
    def check_strip(self, points, heights):
        vertices, faces = deck_strip_geometry(points, .35, heights, .6)
        self.assertTrue(vertices)
        edges = Counter(tuple(sorted((a, b))) for face in faces
                        for a, b in zip(face, face[1:] + face[:1]))
        self.assertEqual(set(edges.values()), {2})
        self.assertTrue(faces_are_consistent(faces))
        self.assertGreater(shell_volume(vertices, faces), 0)
        for bottom, top in zip(vertices[::2], vertices[1::2]):
            self.assertAlmostEqual(top[2] - bottom[2], .6)
        # Every centerline station is the midpoint of an actual cap edge.
        # An unconstrained polygon triangulation can omit these crest edges.
        top_edges = {tuple(sorted((a, b))) for face in faces if len(face) == 3
                     and all(i % 2 for i in face)
                     for a, b in zip(face, face[1:] + face[:1])}
        for (x, y), z in zip(points, heights):
            self.assertTrue(any(all(abs((vertices[a][j]+vertices[b][j])/2-v) < 1e-8
                                    for j, v in enumerate((x, y, z)))
                                for a, b in top_edges))
        return vertices, faces

    def test_straight_crest_and_dip(self):
        vertices, faces = self.check_strip([(0, 0), (5, 0), (10, 0), (15, 0)],
                                          [1, 1.4, 1.1, 1.3])
        for face in faces:
            if len(face) == 3:
                xs = [vertices[i][0] for i in face]
                self.assertLessEqual(max(xs)-min(xs), 5)

    def test_curved_profile_both_directions(self):
        points = [(0, 0), (5, 0), (9, 3), (10, 8)]
        heights = [1, 1.4, 1.2, 1.6]
        self.check_strip(points, heights)
        self.check_strip(points[::-1], heights[::-1])

    def test_flat_and_two_point_decks(self):
        self.check_strip([(0, 0), (5, 0), (9, 3)], [2, 2, 2])
        self.check_strip([(0, 0), (5, 0)], [1, 1.4])

    def test_empty_ribbon(self):
        self.assertEqual(deck_strip_geometry([], .35, [], .6), ([], []))
        self.assertEqual(deck_strip_geometry([(0, 0), (5, 0)], 0, [1, 1], .6), ([], []))
