"""Coverage robustness without relaxing evidence or inventing roof geometry."""
import unittest

try:
    import numpy as np
    from shapely.affinity import rotate, translate
    from shapely.geometry import box, MultiPolygon
    from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class GridCoverageTests(unittest.TestCase):
    def points(self):
        # A well sampled roof: edge returns split across the original 1.5 m
        # cells, leaving several short of three samples despite a coherent roof.
        return np.array([(x,y,30,6,1) for x in np.arange(.75,8.75,.5)
                         for y in np.arange(.75,8.75,.5)])

    def measure(self, points, footprint=None):
        return measure_building(box(0,0,9.5,9.5) if footprint is None else footprint,
                                PointIndex(points), 1.5, .65, ground_m=0)

    def test_grid_boundary_near_miss_recovers_a_measured_flat_height(self):
        for angle in (0, .37):
            with self.subTest(angle=angle):
                points = self.points()
                rotation = np.array([[np.cos(angle),-np.sin(angle)], [np.sin(angle),np.cos(angle)]])
                points[:,:2] = points[:,:2] @ rotation.T + [103.2,-27.4]
                footprint = translate(rotate(box(0,0,9.5,9.5), angle, origin=(0,0), use_radians=True), 103.2,-27.4)
                result, reason = self.measure(points, footprint)
                self.assertIsNotNone(result, reason)
                self.assertAlmostEqual(result['height_m'], 30)
                self.assertGreaterEqual(result['coverage'], .85)
                self.assertFalse(result['tiers'])
                self.assertIn('coverage_grid_offset', result)

    def test_deterministic_selection_with_shuffled_point_order(self):
        points = self.points()
        first, _ = self.measure(points)
        self.assertIsNotNone(first)
        np.random.default_rng(31).shuffle(points)
        self.assertEqual(self.measure(points)[0], first)

    def test_missing_roof_strip_is_not_completed_by_grid_retries(self):
        points = self.points()
        result, _ = self.measure(points[points[:,0] < 6.5])
        self.assertIsNone(result)

    def test_unobserved_disconnected_component_still_rejects_whole_building(self):
        footprint = MultiPolygon([box(0,0,9.5,9.5), box(12,0,15,3)])
        result, reason = self.measure(self.points(), footprint)
        self.assertIsNone(result)
        self.assertEqual(reason, 'footprint_roof_mismatch')

    def test_positive_ground_contradiction_cannot_be_retried_away(self):
        points = self.points()
        points[:, 2:4] = [0,2]
        result, reason = self.measure(points)
        self.assertIsNone(result)
        self.assertEqual(reason, 'observed_ground_in_footprint')

    def test_already_supported_roof_keeps_its_original_measurement(self):
        points = np.array([(x,y,30,6,1) for x in np.arange(.15,9.4,.3)
                           for y in np.arange(.15,9.4,.3)])
        result, reason = self.measure(points)
        self.assertEqual(reason, 'height_only')
        self.assertAlmostEqual(result['height_m'], 30)
        self.assertFalse(result['tiers'])
        self.assertNotIn('coverage_grid_offset', result)
