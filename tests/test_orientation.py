"""Face-winding repair for closed shells."""

import unittest

from jarvizar_city_model.geometry.planar import (
    faces_are_consistent,
    orient_faces_outward,
    shell_volume,
)


def _unit_cube():
    """A unit cube wound outward, as quads."""
    vertices = [
        (0.0, 0.0, 0.0),
        (1.0, 0.0, 0.0),
        (1.0, 1.0, 0.0),
        (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
        (1.0, 0.0, 1.0),
        (1.0, 1.0, 1.0),
        (0.0, 1.0, 1.0),
    ]
    faces = [
        (0, 3, 2, 1),  # bottom, normal -Z
        (4, 5, 6, 7),  # top, normal +Z
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    return vertices, faces


class ShellVolumeTests(unittest.TestCase):
    def test_outward_cube_has_positive_volume(self):
        vertices, faces = _unit_cube()
        self.assertAlmostEqual(shell_volume(vertices, faces), 1.0, places=9)

    def test_volume_is_independent_of_position(self):
        vertices, faces = _unit_cube()
        moved = [(x + 500.0, y - 250.0, z + 17.0) for x, y, z in vertices]
        self.assertAlmostEqual(shell_volume(moved, faces), 1.0, places=6)

    def test_reversed_cube_has_negative_volume(self):
        vertices, faces = _unit_cube()
        flipped = [tuple(reversed(face)) for face in faces]
        self.assertAlmostEqual(shell_volume(vertices, flipped), -1.0, places=9)


class ConsistencyTests(unittest.TestCase):
    def test_cube_is_consistent(self):
        _vertices, faces = _unit_cube()
        self.assertTrue(faces_are_consistent(faces))

    def test_one_flipped_face_is_not_consistent(self):
        _vertices, faces = _unit_cube()
        faces = list(faces)
        faces[2] = tuple(reversed(faces[2]))
        self.assertFalse(faces_are_consistent(faces))

    def test_wholly_reversed_shell_is_still_consistent(self):
        _vertices, faces = _unit_cube()
        self.assertTrue(faces_are_consistent([tuple(reversed(f)) for f in faces]))


class OrientFacesOutwardTests(unittest.TestCase):
    def test_leaves_a_correct_shell_alone(self):
        vertices, faces = _unit_cube()
        self.assertEqual(orient_faces_outward(vertices, faces), faces)

    def test_repairs_a_single_flipped_wall(self):
        vertices, faces = _unit_cube()
        broken = list(faces)
        broken[3] = tuple(reversed(broken[3]))
        fixed = orient_faces_outward(vertices, broken)
        self.assertTrue(faces_are_consistent(fixed))
        self.assertAlmostEqual(shell_volume(vertices, fixed), 1.0, places=9)

    def test_repairs_several_flipped_faces(self):
        vertices, faces = _unit_cube()
        broken = [
            tuple(reversed(face)) if index in (0, 2, 5) else face
            for index, face in enumerate(faces)
        ]
        fixed = orient_faces_outward(vertices, broken)
        self.assertTrue(faces_are_consistent(fixed))
        self.assertAlmostEqual(shell_volume(vertices, fixed), 1.0, places=9)

    def test_turns_a_wholly_inward_shell_outward(self):
        vertices, faces = _unit_cube()
        inward = [tuple(reversed(face)) for face in faces]
        fixed = orient_faces_outward(vertices, inward)
        self.assertAlmostEqual(shell_volume(vertices, fixed), 1.0, places=9)

    def test_keeps_every_face_and_its_vertex_set(self):
        vertices, faces = _unit_cube()
        broken = list(faces)
        broken[1] = tuple(reversed(broken[1]))
        fixed = orient_faces_outward(vertices, broken)
        self.assertEqual(len(fixed), len(faces))
        self.assertEqual(
            sorted(sorted(face) for face in fixed),
            sorted(sorted(face) for face in faces),
        )

    def test_orients_two_separate_shells_independently(self):
        vertices, faces = _unit_cube()
        offset = len(vertices)
        far = [(x + 10.0, y, z) for x, y, z in vertices]
        second = [tuple(index + offset for index in face) for face in faces]
        # The second shell arrives inside out, the first one flipped in part.
        broken = list(faces)
        broken[4] = tuple(reversed(broken[4]))
        broken += [tuple(reversed(face)) for face in second]
        fixed = orient_faces_outward(vertices + far, broken)
        self.assertTrue(faces_are_consistent(fixed))
        self.assertAlmostEqual(shell_volume(vertices + far, fixed), 2.0, places=6)

    def test_returns_input_when_not_edge_manifold(self):
        vertices, faces = _unit_cube()
        # A dangling flap gives one edge three faces.
        broken = list(faces) + [(0, 1, 2)]
        self.assertEqual(orient_faces_outward(vertices, broken), broken)

    def test_handles_a_shell_pinched_at_one_vertex(self):
        """Two cubes meeting at a single shared vertex still orient."""
        vertices, faces = _unit_cube()
        second_vertices = [(x + 1.0, y + 1.0, z + 1.0) for x, y, z in vertices]
        # Weld the far corner of the first cube to the near corner of the second.
        offset = len(vertices)
        remap = {0: 6}
        second = [
            tuple(remap.get(index, index + offset) for index in face)
            for face in faces
        ]
        merged_vertices = vertices + second_vertices
        broken = list(faces) + [tuple(reversed(face)) for face in second]
        fixed = orient_faces_outward(merged_vertices, broken)
        self.assertTrue(faces_are_consistent(fixed))
        self.assertAlmostEqual(shell_volume(merged_vertices, fixed), 2.0, places=6)


if __name__ == "__main__":
    unittest.main()
