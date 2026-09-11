"""Tests for planar geometry: buffering, ring cleanup, and containment."""

from __future__ import annotations

import math
import unittest

from jarvizar_city_model.geometry.planar import (
    buffer_polyline,
    ear_clip,
    effective_width,
    interior_grid_points,
    point_in_triangle,
    buffer_polyline_convex_pieces,
    clean_ring,
    clip_ring_to_rectangle,
    densify_ring,
    offset_is_safe,
    oriented_ring,
    parametric_ribbon,
    point_in_polygon,
    point_in_ring,
    refine_triangles,
    ring_bounds,
    signed_area,
)


def segments_cross(p, q, r, s) -> bool:
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    d1, d2 = cross(r, s, p), cross(r, s, q)
    d3, d4 = cross(p, q, r), cross(p, q, s)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def is_simple(ring) -> bool:
    count = len(ring)
    for i in range(count):
        for j in range(i + 2, count):
            if i == 0 and j == count - 1:
                continue
            if segments_cross(ring[i], ring[(i + 1) % count], ring[j], ring[(j + 1) % count]):
                return False
    return True


class RingTests(unittest.TestCase):
    def test_signed_area_sign_follows_winding(self):
        square = [(0, 0), (10, 0), (10, 10), (0, 10)]
        self.assertAlmostEqual(signed_area(square), 100.0)
        self.assertAlmostEqual(signed_area(list(reversed(square))), -100.0)

    def test_clean_ring_drops_duplicate_and_closing_vertices(self):
        ring = clean_ring([(0, 0), (0, 0), (10, 0), (10, 10), (0, 10), (0, 0)])
        self.assertEqual(len(ring), 4)

    def test_clean_ring_rejects_degenerate_input(self):
        self.assertEqual(clean_ring([(0, 0), (1, 0)]), [])
        self.assertEqual(clean_ring([(0, 0), (1, 0), (2, 0)]), [])

    def test_oriented_ring_enforces_requested_winding(self):
        clockwise = [(0, 0), (0, 10), (10, 10), (10, 0)]
        self.assertGreater(signed_area(oriented_ring(clockwise, True)), 0.0)
        self.assertLess(signed_area(oriented_ring(clockwise, False)), 0.0)

    def test_clip_ring_to_rectangle(self):
        ring = [(-5, -5), (15, -5), (15, 15), (-5, 15)]
        clipped = clip_ring_to_rectangle(ring, 0, 0, 10, 10)
        self.assertAlmostEqual(abs(signed_area(clipped)), 100.0)

    def test_ring_entirely_outside_clips_away(self):
        self.assertEqual(clip_ring_to_rectangle([(20, 20), (30, 20), (30, 30)], 0, 0, 10, 10), [])

    def test_densify_ring_bounds_edge_length(self):
        dense = densify_ring([(0, 0), (10, 0), (10, 10), (0, 10)], 2.0)
        count = len(dense)
        for index in range(count):
            a, b = dense[index], dense[(index + 1) % count]
            self.assertLessEqual(math.dist(a, b), 2.0 + 1e-9)

    def test_densify_ring_preserves_area(self):
        square = [(0, 0), (10, 0), (10, 10), (0, 10)]
        self.assertAlmostEqual(signed_area(densify_ring(square, 1.5)), 100.0, places=6)


class ContainmentTests(unittest.TestCase):
    def setUp(self):
        self.square = [(0, 0), (10, 0), (10, 10), (0, 10)]
        self.hole = [(3, 3), (3, 7), (7, 7), (7, 3)]

    def test_point_in_ring(self):
        self.assertTrue(point_in_ring((5, 5), self.square))
        self.assertFalse(point_in_ring((15, 5), self.square))

    def test_hole_excludes_interior_points(self):
        self.assertFalse(point_in_polygon((5, 5), [self.square, self.hole]))
        self.assertTrue(point_in_polygon((1, 1), [self.square, self.hole]))

    def test_empty_polygon_contains_nothing(self):
        self.assertFalse(point_in_polygon((0, 0), []))


class InteriorSamplingTests(unittest.TestCase):
    """Water levels are solved from these points, so they must be inside."""

    def setUp(self):
        self.square = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]
        self.hole = [(30.0, 30.0), (30.0, 70.0), (70.0, 70.0), (70.0, 30.0)]

    def test_every_sample_is_inside_the_polygon(self):
        samples = interior_grid_points([self.square], 10.0)
        self.assertTrue(samples)
        for sample in samples:
            self.assertTrue(point_in_ring(sample, self.square))

    def test_samples_avoid_holes(self):
        samples = interior_grid_points([self.square, self.hole], 5.0)
        self.assertTrue(samples)
        for sample in samples:
            self.assertFalse(point_in_ring(sample, self.hole))

    def test_samples_cover_the_whole_shape_when_thinned(self):
        # A big polygon must not pile every sample into its first few rows,
        # which would bias a solved water level toward one bank.
        samples = interior_grid_points([self.square], 0.05, limit=200)
        self.assertLessEqual(len(samples), 200)
        ys = [point[1] for point in samples]
        self.assertGreater(max(ys) - min(ys), 50.0)

    def test_respects_the_sample_limit(self):
        self.assertLessEqual(len(interior_grid_points([self.square], 0.5, limit=50)), 50)

    def test_degenerate_input_returns_nothing(self):
        self.assertEqual(interior_grid_points([], 1.0), [])
        self.assertEqual(interior_grid_points([self.square], 0.0), [])
        self.assertEqual(interior_grid_points([[(0.0, 0.0), (1.0, 1.0)]], 1.0), [])


class BufferTests(unittest.TestCase):
    def test_straight_ribbon_area_matches_rectangle_plus_caps(self):
        ring = buffer_polyline([(0, 0), (100, 0)], 5.0, arc_segments=32)
        expected = 100 * 10 + math.pi * 25
        self.assertAlmostEqual(signed_area(ring), expected, delta=expected * 0.01)

    def test_caps_extend_beyond_both_endpoints(self):
        # A cap swept the wrong way folds back through the ribbon instead of
        # rounding its end, which this bound catches directly.
        min_x, min_y, max_x, max_y = ring_bounds(
            buffer_polyline([(0, 0), (100, 0)], 5.0, arc_segments=16)
        )
        self.assertAlmostEqual(min_x, -5.0, places=6)
        self.assertAlmostEqual(max_x, 105.0, places=6)
        self.assertAlmostEqual(min_y, -5.0, places=6)
        self.assertAlmostEqual(max_y, 5.0, places=6)

    def test_buffer_ring_is_counter_clockwise(self):
        self.assertGreater(signed_area(buffer_polyline([(0, 0), (50, 20), (90, 0)], 4.0)), 0.0)

    def test_gentle_corner_produces_a_simple_ring(self):
        ring = buffer_polyline([(0, 0), (100, 0), (200, 40)], 5.0)
        self.assertTrue(is_simple(ring))

    def test_degenerate_input_returns_no_ring(self):
        self.assertEqual(buffer_polyline([(0, 0)], 5.0), [])
        self.assertEqual(buffer_polyline([(0, 0), (1, 0)], 0.0), [])


class OffsetSafetyTests(unittest.TestCase):
    def test_straight_and_gentle_lines_are_safe(self):
        self.assertTrue(offset_is_safe([(0, 0), (100, 0)], 5.0))
        self.assertTrue(offset_is_safe([(0, 0), (100, 0), (200, 30)], 5.0))

    def test_tight_corner_relative_to_width_is_unsafe(self):
        # A hairpin whose segments are shorter than the ribbon is wide.
        self.assertFalse(offset_is_safe([(0, 0), (10, 0), (0, 2)], 20.0))

    def test_self_approaching_polyline_is_unsafe(self):
        # A loop that returns close to its own start: every corner is gentle,
        # but the two sides of the ribbon would still overlap.
        points = [
            (math.cos(math.radians(angle)) * 30.0, math.sin(math.radians(angle)) * 30.0)
            for angle in range(0, 360, 15)
        ]
        self.assertTrue(offset_is_safe(points, 1.0))
        self.assertFalse(offset_is_safe(points, 25.0))

    def test_unsafe_polyline_still_yields_simple_convex_pieces(self):
        points = [(0, 0), (10, 0), (0, 2)]
        pieces = buffer_polyline_convex_pieces(points, 20.0, arc_segments=4)
        self.assertGreaterEqual(len(pieces), len(points))
        for piece in pieces:
            self.assertTrue(is_simple(piece))
            self.assertGreater(signed_area(piece), 0.0)


class ParametricRibbonTests(unittest.TestCase):
    def test_ring_and_parameters_stay_aligned(self):
        ring, parameters = parametric_ribbon([(0, 0), (100, 0), (100, 100)], 5.0)
        self.assertEqual(len(ring), len(parameters))
        self.assertAlmostEqual(min(parameters), 0.0)
        self.assertAlmostEqual(max(parameters), 1.0)

    def test_straight_ribbon_has_expected_area(self):
        ring, _ = parametric_ribbon([(0, 0), (100, 0)], 5.0)
        self.assertAlmostEqual(signed_area(ring), 1000.0, places=6)

    def test_result_is_counter_clockwise(self):
        ring, _ = parametric_ribbon([(0, 0), (60, 25), (120, 0)], 4.0)
        self.assertGreater(signed_area(ring), 0.0)

    def test_degenerate_input_returns_nothing(self):
        self.assertEqual(parametric_ribbon([(0, 0)], 5.0), ([], []))


if __name__ == "__main__":
    unittest.main()


class EarClipTests(unittest.TestCase):
    def test_export_contacts_keep_distinct_indices_and_exact_area(self):
        rings = [
            [(0,0),(4,0),(4,4),(2,4),(2,2),(2,2),(2,3),(2,2),(2,4),(0,4)],
            [(-1,-1),(0,-1),(0,0),(1,0),(1,1),(0,1),(0,0),(-1,0)],
        ]
        for ring in rings:
            for points in (ring, list(reversed(ring))):
                with self.subTest(points=points):
                    triangles = ear_clip(points, allow_touching=True)
                    self.assertEqual(len(triangles), len(points)-2)
                    self.assertEqual({i for t in triangles for i in t}, set(range(len(points))))
                    self.assertAlmostEqual(sum(abs(signed_area([points[i] for i in t]))
                                               for t in triangles), abs(signed_area(points)))
                    edges = {}
                    for triangle in triangles:
                        for a,b in zip(triangle, triangle[1:]+triangle[:1]):
                            edge = tuple(sorted((a,b)))
                            edges[edge] = edges.get(edge,0)+1
                    boundary = {tuple(sorted((i,(i+1)%len(points)))) for i in range(len(points))}
                    self.assertTrue(all(count == (1 if edge in boundary else 2)
                                        for edge,count in edges.items()))

    """Ear clipping is the fallback when Blender's triangulator will not close.

    Its contract is stricter than Blender's: use every vertex, and never
    overlap.  Draped surfaces depend on the first, watertightness on the second.
    """

    @staticmethod
    def _triangulate(points):
        return ear_clip([(x, y, 0.0, 1.0) for x, y in points])

    def test_square_yields_two_triangles(self):
        self.assertEqual(len(self._triangulate([(0, 0), (10, 0), (10, 10), (0, 10)])), 2)

    def test_triangle_count_is_always_two_less_than_vertices(self):
        for count in (3, 4, 5, 8, 16, 33):
            points = [
                (
                    math.cos(2 * math.pi * index / count) * 10.0,
                    math.sin(2 * math.pi * index / count) * 10.0,
                )
                for index in range(count)
            ]
            with self.subTest(count=count):
                self.assertEqual(len(self._triangulate(points)), count - 2)

    def test_every_vertex_is_used(self):
        # A run of collinear vertices is exactly what densifying produces, and
        # dropping one would flatten a draped edge and open the solid.
        points = [(x, 0.0) for x in range(0, 11, 2)] + [(10.0, 5.0), (0.0, 5.0)]
        triangles = self._triangulate(points)
        used = {index for triangle in triangles for index in triangle}
        self.assertEqual(used, set(range(len(points))))

    def test_triangulation_covers_the_polygon_area(self):
        points = [(0, 0), (10, 0), (10, 4), (4, 4), (4, 8), (0, 8)]
        triangles = self._triangulate(points)
        total = 0.0
        for a, b, c in triangles:
            pa, pb, pc = points[a], points[b], points[c]
            total += abs(
                (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
            ) * 0.5
        self.assertAlmostEqual(total, abs(signed_area(points)), places=6)

    def test_concave_polygon_triangulates(self):
        points = [(0, 0), (10, 0), (10, 10), (5, 3), (0, 10)]
        triangles = self._triangulate(points)
        self.assertEqual(len(triangles), 3)

    def test_winding_is_independent_of_input_order(self):
        points = [(0, 0), (10, 0), (10, 10), (0, 10)]
        self.assertEqual(
            len(self._triangulate(points)), len(self._triangulate(list(reversed(points))))
        )

    def test_degenerate_input_returns_nothing(self):
        self.assertEqual(self._triangulate([(0, 0), (1, 1)]), [])


class EffectiveWidthTests(unittest.TestCase):
    def test_sliver_width_converges_on_its_true_width(self):
        self.assertAlmostEqual(
            effective_width([(0, 0), (50, 0), (50, 0.1), (0, 0.1)]), 0.0998, places=3
        )

    def test_a_wall_fragment_reads_narrower_than_a_house_of_equal_area(self):
        wall = effective_width([(0, 0), (50, 0), (50, 0.1), (0, 0.1)])
        house = effective_width([(0, 0), (2.236, 0), (2.236, 2.236), (0, 2.236)])
        self.assertLess(wall, house)

    def test_degenerate_ring_has_no_width(self):
        self.assertEqual(effective_width([(0, 0), (1, 1)]), 0.0)


class PointInTriangleTests(unittest.TestCase):
    def test_inside_and_outside(self):
        a, b, c = (0.0, 0.0), (10.0, 0.0), (0.0, 10.0)
        self.assertTrue(point_in_triangle((1.0, 1.0), a, b, c))
        self.assertFalse(point_in_triangle((9.0, 9.0), a, b, c))


class RefineTrianglesTests(unittest.TestCase):
    """Cap refinement: shorter edges, no T-junctions, draped new vertices."""

    square = [
        (0.0, 0.0, -1.0, 1.0),
        (10.0, 0.0, -1.0, 1.0),
        (10.0, 10.0, -1.0, 1.0),
        (0.0, 10.0, -1.0, 1.0),
    ]
    diagonal = [(0, 1, 2), (0, 2, 3)]

    @staticmethod
    def _edge_usage(triangles):
        usage = {}
        for a, b, c in triangles:
            for i, j in ((a, b), (b, c), (c, a)):
                key = (i, j) if i < j else (j, i)
                usage[key] = usage.get(key, 0) + 1
        return usage

    def test_no_edge_is_left_longer_than_the_spacing(self):
        points, triangles = refine_triangles(
            self.square, self.diagonal, 1.5, lambda x, y: (-1.0, 1.0)
        )
        self.assertGreater(len(triangles), 2)
        for a, b, c in triangles:
            for i, j in ((a, b), (b, c), (c, a)):
                self.assertLessEqual(
                    math.dist(points[i][:2], points[j][:2]), 1.5 + 1.0e-9
                )

    def test_refinement_preserves_area_and_creates_no_t_junctions(self):
        points, triangles = refine_triangles(
            self.square, self.diagonal, 1.5, lambda x, y: (-1.0, 1.0)
        )
        area = 0.0
        for a, b, c in triangles:
            (ax, ay), (bx, by), (cx, cy) = (points[i][:2] for i in (a, b, c))
            area += abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) * 0.5
        self.assertAlmostEqual(area, 100.0)
        # An edge used once is a wall edge and must lie on the outline; every
        # interior edge is shared by exactly two triangles.
        for (i, j), uses in self._edge_usage(triangles).items():
            self.assertIn(uses, (1, 2))
            if uses == 1:
                (x0, y0), (x1, y1) = points[i][:2], points[j][:2]
                on_outline = (
                    (x0 == x1 and x0 in (0.0, 10.0)) or (y0 == y1 and y0 in (0.0, 10.0))
                )
                self.assertTrue(on_outline, f"hanging edge {points[i][:2]}-{points[j][:2]}")

    def test_inserted_vertices_are_draped_through_the_sample(self):
        points, _triangles = refine_triangles(
            self.square, self.diagonal, 4.0, lambda x, y: (x + y, x - y)
        )
        self.assertEqual(points[:4], self.square, "original vertices keep their indices")
        self.assertGreater(len(points), 4)
        for x, y, bottom, top in points[4:]:
            self.assertAlmostEqual(bottom, x + y)
            self.assertAlmostEqual(top, x - y)

    def test_short_triangles_are_returned_unchanged(self):
        small = [(0.0, 0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0)]
        points, triangles = refine_triangles(small, [(0, 1, 2)], 5.0, lambda x, y: (0.0, 0.0))
        self.assertEqual(points, small)
        self.assertEqual(triangles, [(0, 1, 2)])

    def test_a_degenerate_triangle_terminates(self):
        collinear = [(0.0, 0.0, 0.0, 0.0), (10.0, 0.0, 0.0, 0.0), (5.0, 0.0, 0.0, 0.0)]
        points, triangles = refine_triangles(
            collinear, [(0, 1, 2)], 2.0, lambda x, y: (0.0, 0.0)
        )
        for a, b, c in triangles:
            for i, j in ((a, b), (b, c), (c, a)):
                self.assertLessEqual(math.dist(points[i][:2], points[j][:2]), 2.0 + 1.0e-9)
