"""Measured sub-cell boundaries: geometry accuracy, support and bounded cost."""
import unittest
from unittest.mock import patch

try:
    import numpy as np
    from shapely import contains_xy
    from shapely.affinity import rotate, scale
    from shapely.geometry import Point, Polygon, box, shape
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_boundaries import measured_tier_boundary
    from jarvizar_city_model.external.lidar_contours import regularize_grid_contours
    from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building
    import test_lidar_contours as contour_fixtures
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class MeasuredBoundaryTests(unittest.TestCase):
    cell = 1.5
    width = .1/.07

    def cloud(self, actual):
        xx, yy = np.meshgrid(np.arange(.25, 60, .45), np.arange(.25, 60, .45))
        xy = np.column_stack((xx.ravel(), yy.ravel()))
        z = np.where(contains_xy(actual, xy[:, 0], xy[:, 1]), 50, 20)
        return np.column_stack((xy, z))

    def raster(self, actual):
        return contour_fixtures.GridContourTests().raster(actual)

    def refine(self, raster, points):
        return measured_tier_boundary(raster, points, 35, self.cell, self.width)

    def test_circle_and_oblique_ellipse_recover_shape_below_cell_size(self):
        circle = Point(30, 30).buffer(23, quad_segs=96)
        ellipse = rotate(scale(circle, xfact=1, yfact=.55), 31)
        for actual in (circle, ellipse):
            with self.subTest(shape=actual.bounds):
                raster = self.raster(actual)
                old = regularize_grid_contours(raster, self.cell)
                result = self.refine(raster, self.cloud(actual))
                self.assertTrue(result.is_valid)
                self.assertFalse(result.has_z, 'Membership is not an output elevation')
                self.assertLess(result.symmetric_difference(actual).area,
                                old.symmetric_difference(actual).area*.7)
                self.assertLess(abs(result.length-actual.length), abs(old.length-actual.length)*.5)
                self.assertLess(len(result.exterior.coords), 100)
                self.assertLess(result.boundary.hausdorff_distance(raster.boundary), self.cell*.8)

    def test_irregular_arc_keeps_deep_recess_and_sharp_corners(self):
        actual = Point(30, 30).buffer(23, quad_segs=96).difference(box(30, 30, 60, 60))
        raster = self.raster(actual)
        result = self.refine(raster, self.cloud(actual))
        self.assertTrue(result.is_valid)
        self.assertLess(result.symmetric_difference(actual).area,
                        regularize_grid_contours(raster, self.cell).symmetric_difference(actual).area*.8)
        self.assertFalse(result.contains(Point(35, 35)))
        self.assertTrue(result.contains(Point(28, 28)))
        self.assertLess(result.boundary.distance(Point(30, 30)), .5)

    def test_known_courtyard_is_not_filled_as_sampling_noise(self):
        actual = Point(30, 30).buffer(23, quad_segs=64).difference(box(21, 21, 39, 39))
        raster = self.raster(actual)
        result = self.refine(raster, self.cloud(actual))
        self.assertEqual(len(result.interiors), 1)
        self.assertFalse(result.contains(Point(30, 30)))
        old_hole, new_hole = Polygon(raster.interiors[0]), Polygon(result.interiors[0])
        self.assertAlmostEqual(new_hole.area, old_hole.area, delta=old_hole.area*.05)

    def test_missing_observations_keep_that_boundary_section(self):
        actual = Point(30, 30).buffer(23, quad_segs=64)
        raster = self.raster(actual)
        points = self.cloud(actual)
        result = self.refine(raster, points[points[:, 0] > 24])
        unknown = box(0, 0, 21, 60)
        self.assertLess(result.intersection(unknown).symmetric_difference(raster.intersection(unknown)).area, 1e-7)
        self.assertGreater(result.symmetric_difference(raster).area, 1)

    def test_one_sided_conflicting_or_over_budget_samples_keep_previous_mass(self):
        actual = Point(30, 30).buffer(23, quad_segs=64)
        raster, points = self.raster(actual), self.cloud(actual)
        self.assertTrue(self.refine(raster, points[points[:, 2] > 35]).equals(raster))
        conflicts = np.vstack((np.column_stack((points[:, :2], np.full(len(points), 20))),
                               np.column_stack((points[:, :2], np.full(len(points), 50)))))
        self.assertTrue(self.refine(raster, conflicts).equals(raster))
        with patch('jarvizar_city_model.external.lidar_boundaries.MAX_BOUNDARY_SAMPLES', 12):
            self.assertTrue(self.refine(raster, points).equals(raster))

    def test_rectangular_mass_and_point_order_remain_stable(self):
        rectangle = box(9, 12, 51, 48)
        self.assertTrue(self.refine(rectangle, self.cloud(rectangle)).equals(rectangle))
        actual = Point(30, 30).buffer(23, quad_segs=64)
        raster, points = self.raster(actual), self.cloud(actual)
        expected = self.refine(raster, points)
        np.random.default_rng(71).shuffle(points)
        self.assertEqual(self.refine(raster, points).wkb, expected.wkb)

    def test_coverage_union_matches_general_overlay_for_measured_boundaries(self):
        circle = Point(30, 30).buffer(23, quad_segs=64)
        cases = (circle, rotate(scale(circle, xfact=1, yfact=.55), 31),
                 circle.difference(box(21, 21, 39, 39)),
                 circle.difference(box(30, 30, 60, 60)))
        exercised = 0
        for actual in cases:
            with self.subTest(shape=actual.wkt[:80]):
                raster, points = self.raster(actual), self.cloud(actual)
                with patch('jarvizar_city_model.external.lidar_boundaries.coverage_union_all',
                           side_effect=unary_union) as general_overlay:
                    before = self.refine(raster, points)
                exercised += general_overlay.call_count >= 2
                after = self.refine(raster, points)
                self.assertLess(before.symmetric_difference(after).area, 1e-7)
                self.assertLess(before.boundary.hausdorff_distance(after.boundary), 1e-7)
        self.assertGreaterEqual(exercised, 3)

    def test_ring_fitting_ignores_overlay_start_vertex_and_winding(self):
        from jarvizar_city_model.external.lidar_boundaries import _fit_ring
        ring = self.raster(Point(30, 30).buffer(23, quad_segs=64)).exterior
        points = list(ring.coords)[:-1]
        expected = Polygon(_fit_ring(ring, self.cell))
        for offset, reverse in ((11, False), (27, True), (44, False)):
            shifted = points[offset:] + points[:offset]
            if reverse:
                shifted.reverse()
            actual = Polygon(_fit_ring(Polygon(shifted).exterior, self.cell))
            self.assertLess(actual.symmetric_difference(expected).area, 1e-7)

    def test_envelope_preserves_curved_upper_mass_and_complete_fallback(self):
        from lidar_envelope_test_utils import height_at, height_contour
        actual = Point(30, 30).buffer(23, quad_segs=96)
        cloud = self.cloud(actual)
        points = np.column_stack((cloud, np.full(len(cloud), 6), np.ones(len(cloud))))
        options = dict(min_width_m=self.width, min_step_m=.05/.077, ground_m=0, roof_mode='FACETED')
        index = PointIndex(points)
        after, why = measure_building(box(0, 0, 60, 60), index, **options)
        self.assertEqual(why, 'faceted_roof')
        self.assertEqual(after['surface_reconstruction'], 'roof_envelope')
        roofs = [shape(s['geometry']) for s in after['roof_surfaces']]
        self.assertLess(unary_union(roofs).symmetric_difference(box(0,0,60,60)).area, .05)
        upper = height_contour(after, 35)
        self.assertLess(upper.boundary.hausdorff_distance(actual.boundary), 3.5)
        self.assertAlmostEqual(height_at(after, 30, 30), 50, delta=.04/.077)
        self.assertAlmostEqual(height_at(after, 2, 2), 20, delta=.04/.077)
        # A forced surface-budget failure must retain the whole building,
        # including its major upper mass, through the conservative fallback.
        with patch('jarvizar_city_model.external.lidar_envelope.MAX_ENVELOPE_FACETS', 3):
            fallback, why = measure_building(box(0, 0, 60, 60), index, **options)
        self.assertIsNotNone(fallback, why)
        self.assertEqual(why, 'tiers')
        self.assertIn('budget', fallback['faceted_fallback'])
        self.assertAlmostEqual(fallback['height_m'], 20)
        self.assertEqual([round(t['top_m']) for t in fallback['tiers']], [50])
        upper = shape(fallback['tiers'][0]['geometry'])
        self.assertTrue(box(0, 0, 60, 60).covers(upper))
        self.assertLess(upper.symmetric_difference(actual).area, actual.area*.1)


if __name__ == '__main__':
    unittest.main()
