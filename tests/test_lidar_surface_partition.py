"""Spatial cleanup must change noisy regions, never the complete envelope."""
import unittest
from unittest import mock

try:
    import numpy as np
    from shapely import contains_xy
    from shapely.geometry import box, Point, GeometryCollection, LineString
    from shapely.geometry.base import BaseGeometry
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_surface_partition import clean_partition, _local_height
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class SurfacePartitionTests(unittest.TestCase):
    def support(self, region, height):
        x, y = np.meshgrid(np.arange(.5, 40, 1.), np.arange(.5, 30, 1.))
        mask = contains_xy(region, x, y)
        return np.column_stack((x[mask], y[mask], np.full(mask.sum(), height)))

    def check_partition(self, patches, footprint):
        polys = [g for g, _s in patches]
        self.assertTrue(all(g.is_valid for g in polys))
        self.assertLess(unary_union(polys).symmetric_difference(footprint).area, 1e-6)
        self.assertAlmostEqual(sum(g.area for g in polys), footprint.area, places=6)

    def test_attached_finger_moves_to_neighbor_without_tilting_its_samples(self):
        footprint = box(0, 0, 40, 30)
        crown = box(10, 10, 20, 20)
        upper = crown.union(box(19, 14, 35, 16))
        lower = footprint.difference(upper)
        patches, diagnostics = clean_partition([
            (upper, self.support(upper, 45)),
            (lower, self.support(lower, 20))], 1.5, .1/.07)
        self.check_partition(patches, footprint)
        self.assertTrue(patches[0][0].covers(Point(15, 15)))
        self.assertFalse(patches[0][0].covers(Point(30, 15)))
        self.assertTrue(patches[1][0].covers(Point(30, 15)))
        self.assertTrue(np.all(patches[1][1][:, 2] == 20))
        self.assertTrue(np.all(patches[0][1][:, 0] < 22))
        self.assertGreater(diagnostics['surface_removed_finger_area_m2'], 20)

    def test_large_setback_and_courtyard_stay_exact(self):
        footprint = box(0, 0, 40, 30).difference(box(28, 10, 34, 20))
        tower = box(6, 6, 22, 24)
        podium = footprint.difference(tower)
        patches, _ = clean_partition([
            (tower, self.support(tower, 90)),
            (podium, self.support(podium, 20))], 1.5, .1/.07)
        self.check_partition(patches, footprint)
        self.assertLess(patches[0][0].symmetric_difference(tower).area, 1e-6)

    def test_interlocking_fingers_lower_without_eroding_supported_cores(self):
        footprint = box(0, 0, 40, 30)
        west = box(0, 0, 10, 30)
        for bottom in range(0, 30, 4):
            west = west.union(box(10, bottom, 30, min(30, bottom+2)))
        east = footprint.difference(west)
        # Both sides lose their narrow fingers, leaving a shared channel.
        # Assign the narrow disputed channel to the lower supported roof.
        # Neither its original fingers nor the high roof's fingers should
        # reappear as narrow raised walls, and both broad cores stay exact.
        patches, _ = clean_partition([(west, self.support(west, 45)),
                                      (east, self.support(east, 20))], 1.5, .1/.07)
        self.check_partition(patches, footprint)
        self.assertLess(patches[0][0].symmetric_difference(box(0, 0, 10, 30)).area, 1e-6)
        self.assertLess(patches[1][0].symmetric_difference(box(10, 0, 40, 30)).area, 1e-6)

    def test_printable_small_crown_is_not_removed_with_narrow_interface_noise(self):
        footprint = box(0, 0, 40, 30)
        crown = box(12, 12, 16.5, 16.5)
        podium = footprint.difference(crown)
        patches, _ = clean_partition([
            (crown, self.support(crown, 60)),
            (podium, self.support(podium, 20))], 1.5, .1/.07)
        self.check_partition(patches, footprint)
        self.assertLess(patches[0][0].symmetric_difference(crown).area, 1e-6)

    def test_a_low_roof_channel_is_not_reassigned_upward_as_a_raised_blade(self):
        footprint = box(0, 0, 40, 30)
        low = box(10, 10, 20, 20).union(box(19, 14, 35, 16))
        high = footprint.difference(low)
        patches, _ = clean_partition([(low, self.support(low, 20)),
                                      (high, self.support(high, 45))], 1.5, .1/.07)
        self.check_partition(patches, footprint)
        self.assertLess(patches[0][0].symmetric_difference(low).area, 1e-6)
        self.assertTrue(patches[0][0].covers(Point(30, 15)))
        self.assertTrue(np.all(patches[0][1][:, 2] == 20))

    def test_crossing_slopes_are_ordered_at_the_gap_not_by_remote_roof_heights(self):
        x, y = np.meshgrid(np.arange(.5, 40, 1.), np.arange(.5, 8, 1.))
        first = np.column_stack((x.ravel(), y.ravel(), 10+.6*x.ravel()))
        second = np.column_stack((x.ravel(), y.ravel()+12, 27-.2*x.ravel()))
        self.assertLess(np.median(first[:, 2]), np.median(second[:, 2]))
        # These independent sloping roofs reverse their height ordering along
        # their common interface. Whole-roof medians would get the east wrong.
        for center_x in (5., 35.):
            gap = box(center_x-1, 8, center_x+1, 12)
            a, b = _local_height(first, gap, 1.5), _local_height(second, gap, 1.5)
            self.assertAlmostEqual(a, 10+.6*center_x, places=6)
            self.assertAlmostEqual(b, 27-.2*center_x, places=6)
            self.assertEqual(a < b, center_x == 5.)

    def test_boolean_contact_lines_do_not_change_the_areal_partition(self):
        footprint = box(0, 0, 40, 30)
        upper = box(10, 10, 20, 20).union(box(19, 14, 35, 16))
        lower = footprint.difference(upper)
        inputs = [(upper, self.support(upper, 45)),
                  (lower, self.support(lower, 20))]
        expected, _ = clean_partition(inputs, 1.5, .1/.07)
        difference = BaseGeometry.difference

        def with_contact_line(geometry, other, *args, **kwargs):
            result = difference(geometry, other, *args, **kwargs)
            # GEOS clipping can return area plus zero-area contacts. Exercise
            # that representation at the Boolean-operation boundary, not just
            # at entry, where polygon extraction already handled collections.
            return GeometryCollection([result, LineString([(99, 99), (100, 100)])])

        with mock.patch.object(BaseGeometry, 'difference', with_contact_line):
            actual, _ = clean_partition(inputs, 1.5, .1/.07)
        self.check_partition(actual, footprint)
        for (region, support), (wanted, wanted_support) in zip(actual, expected):
            self.assertIn(region.geom_type, ('Polygon', 'MultiPolygon'))
            self.assertLess(region.symmetric_difference(wanted).area, 1e-6)
            np.testing.assert_array_equal(support, wanted_support)

    def test_continuous_roof_with_one_region_is_not_spatially_eroded(self):
        footprint = box(0, 0, 20, 20).union(box(20, 9, 30, 11))
        support = self.support(footprint, 30)
        patches, _ = clean_partition([(footprint, support)], 1.5, .1/.07)
        self.assertTrue(patches[0][0].equals(footprint))
        np.testing.assert_array_equal(patches[0][1], support)


if __name__ == '__main__':
    unittest.main()
