"""The upper sheet bridges facade recesses without erasing whole roof masses."""
import unittest
from unittest.mock import patch

try:
    import numpy as np
    from shapely import contains_xy
    from shapely.geometry import box, Polygon, MultiPolygon, shape
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_envelope import fit_roof_envelope
    from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building
    from lidar_envelope_test_utils import height_at, height_contour
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class UpperEnvelopeTests(unittest.TestCase):
    def cloud(self, footprint, roof):
        x0, y0, x1, y1 = footprint.bounds
        xx, yy = np.meshgrid(np.arange(x0+.2, x1, .4), np.arange(y0+.2, y1, .4))
        xy = np.column_stack((xx.ravel(), yy.ravel()))
        xy = xy[contains_xy(footprint, xy[:, 0], xy[:, 1])]
        return np.column_stack((xy, roof(xy[:, 0], xy[:, 1])))

    def fit(self, footprint, cloud, scale=(.07, .077)):
        record, reason = fit_roof_envelope(footprint, cloud, 1.5, scale, cloud)
        self.assertIsNotNone(record, reason)
        self.assertEqual(record['surface_reconstruction'], 'roof_envelope')
        polygons = [shape(s['geometry']) for s in record['roof_surfaces']]
        self.assertLess(unary_union(polygons).symmetric_difference(footprint).area, 1e-6)
        self.assertAlmostEqual(sum(p.area for p in polygons), footprint.area, places=5)
        self.assertFalse(record['tiers'])
        self.assertLess(record['surface_diagnostics']['envelope_fit_max_m'], .61)
        return record

    def test_blanket_spans_deep_narrow_recess_and_preserves_broad_lower_roof(self):
        footprint = box(0, 0, 40, 30)
        roof = lambda x, y: np.where(x > 28, 20., np.where((x > 12)&(x < 13), 8., 60.))
        record = self.fit(footprint, self.cloud(footprint, roof))
        self.assertGreater(height_at(record, 12.5, 15), 57)
        self.assertAlmostEqual(height_at(record, 36, 15), 20, delta=.6)
        self.assertAlmostEqual(height_at(record, 6, 15), 60, delta=.6)

    def test_dense_lower_facade_returns_do_not_carve_roof(self):
        footprint = box(0, 0, 24, 24)
        roof = self.cloud(footprint, lambda x, y: np.full_like(x, 80.))
        facade = np.array([(12., y, z) for y in np.arange(.2, 24, .15) for z in np.arange(3, 80, .2)])
        xyz = np.concatenate((roof, facade))
        points = np.column_stack((xyz, np.full(len(xyz), 6), np.ones(len(xyz))))
        record, why = measure_building(footprint, PointIndex(points), 1.43, .65,
                                      ground_m=0, roof_mode='FACETED')
        self.assertIsNotNone(record, why)
        self.assertEqual(record['surface_reconstruction'], 'roof_envelope')
        self.assertGreater(height_at(record, 12, 12), 79)

    def test_isolated_high_return_is_removed_but_supported_cap_survives(self):
        footprint = box(0, 0, 30, 30)
        cap = box(12, 12, 18, 18)
        cloud = self.cloud(footprint, lambda x, y: np.where(contains_xy(cap, x, y), 35., 20.))
        cloud = np.concatenate((cloud, [[4.13, 4.17, 100.]]))
        record = self.fit(footprint, cloud)
        self.assertLess(height_at(record, 4.13, 4.17), 21)
        self.assertAlmostEqual(height_at(record, 15, 15), 35, delta=.6)
        self.assertLess(max(v[2] for s in record['roof_surfaces'] for v in s['geometry']['coordinates'][0]), 36)

    def test_courtyard_and_disconnected_component_do_not_share_sheet(self):
        first = box(0, 0, 24, 24).difference(box(8, 8, 16, 16))
        second = box(25, 0, 35, 24)
        footprint = MultiPolygon([first, second])
        roof = lambda x, y: np.where(x < 24, 30.+.1*x, 8.)
        record = self.fit(footprint, self.cloud(footprint, roof))
        self.assertAlmostEqual(height_at(record, 30, 12), 8., delta=.3)
        self.assertAlmostEqual(height_at(record, 22, 12), 32.2, delta=.3)
        self.assertLess(height_contour(record, 1).intersection(box(8, 8, 16, 16)).area, 1e-8)

    def test_noisy_slope_is_not_terraced(self):
        footprint = box(0, 0, 40, 30)
        noise = np.random.default_rng(3)
        record = self.fit(footprint, self.cloud(
            footprint, lambda x, y: 20+.4*x+noise.uniform(-2, 2, len(x))))
        xs = np.arange(4, 36, .25)
        profiles = np.array([[height_at(record, x, y) for x in xs] for y in (7.3, 15.1, 22.7)])
        # A median alone settles into small plateaus here, which the cap
        # shows as terraces across the slope.
        self.assertLess(np.mean(np.diff(profiles, axis=1)/.25 < .1), .05)
        trend = np.polyval(np.polyfit(np.tile(xs, 3), profiles.ravel(), 1), np.tile(xs, 3))
        self.assertLess(np.std(profiles.ravel()-trend), .16)

    def test_reconstruction_never_calls_legacy_architectural_region_fitting(self):
        footprint = box(0, 0, 30, 24)
        xyz = self.cloud(footprint, lambda x, y: 30+5*np.sin(x/10))
        cloud = np.column_stack((xyz, np.full(len(xyz), 6), np.ones(len(xyz))))
        with patch('jarvizar_city_model.external.lidar_surfaces.fit_surface_roof', side_effect=AssertionError), \
             patch('jarvizar_city_model.external.lidar_facets.fit_faceted_roof', side_effect=AssertionError):
            record, why = measure_building(footprint, PointIndex(cloud), 1.43, .65,
                                          ground_m=0, roof_mode='FACETED')
        self.assertIsNotNone(record, why)
        self.assertEqual(record['surface_reconstruction'], 'roof_envelope')

    def test_invalid_input_and_budget_failure_are_explicit(self):
        footprint = box(0, 0, 24, 24)
        samples = self.cloud(footprint, lambda x, y: 20+x*.1)
        with self.assertRaises(ValueError):
            fit_roof_envelope(footprint, samples, 0)
        with self.assertRaises(ValueError):
            fit_roof_envelope(footprint, [[0, 0, float('nan')]], 1.5)
        with patch('jarvizar_city_model.external.lidar_envelope.MAX_ENVELOPE_FACETS', 2):
            result, reason = fit_roof_envelope(footprint, samples, 1.5)
        self.assertIsNone(result)
        self.assertIn('budget', reason)


if __name__ == '__main__':
    unittest.main()
