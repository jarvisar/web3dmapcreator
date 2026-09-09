"""Physical massing regressions at the add-on's default print scale."""
import json
from pathlib import Path
import tempfile
import unittest

from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.data.lidar import load_measurements, request_signature
import test_lidar_measurements as measurements

AVAILABLE = measurements.AVAILABLE

if AVAILABLE:
    import numpy as np
    from shapely.geometry import box, shape
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class MassingTests(unittest.TestCase):
    def measure(self, roof, width=.1/.07, step=.05/.077, extra_points=()):
        # Four nearby returns per one-metre sample provide dense roof evidence
        # even in the smallest 1.5 m measurement cells, with ground all around.
        points = measurements.MeasurementsTests().cloud(roof)
        points = np.concatenate([points + np.array([dx, dy, 0, 0, 0])
                                 for dx, dy in ((0, 0), (.15, 0), (0, .15), (.15, .15))])
        if len(extra_points):
            points = np.concatenate((points, np.asarray(extra_points)))
        return measure_building(box(0, 0, 60, 60), PointIndex(points), width, step)

    def assert_supported(self, result):
        self.assertIsNotNone(result)
        support = box(0, 0, 60, 60)
        for tier in result['tiers']:
            geometry = shape(tier['geometry'])
            self.assertTrue(geometry.is_valid and not geometry.is_empty)
            self.assertTrue(support.buffer(1e-7).covers(geometry))
            support = geometry

    def test_separate_small_crowns_survive_on_a_large_building(self):
        crowns = [box(x, x, x+4, x+4) for x in (9, 27, 45)]
        def roof(x, y):
            return 90 if any(a < x < c and b < y < d
                             for a, b, c, d in (p.bounds for p in crowns)) else 30
        result, reason = self.measure(roof)
        self.assert_supported(result)
        self.assertTrue(result['tiers'], reason)
        crown = shape(result['tiers'][-1]['geometry'])
        self.assertAlmostEqual(result['tiers'][-1]['top_m'], 90, delta=.2)
        self.assertEqual(len(getattr(crown, 'geoms', (crown,))), 3)
        for expected in crowns:
            self.assertLess(expected.area, 60*60*.015)
            self.assertTrue(crown.covers(expected.centroid))
            self.assertGreater(crown.intersection(expected).area, expected.area*.6)
        self.assertLess(crown.area, unary_union(crowns).area*2)

    def test_one_metre_step_survives_at_default_vertical_scale(self):
        result, reason = self.measure(lambda x, y: 31 if 15 < x < 45 and 15 < y < 45 else 30)
        self.assert_supported(result)
        self.assertTrue(result['tiers'], reason)
        self.assertAlmostEqual(result['height_m'], 30, delta=.1)
        self.assertAlmostEqual(result['tiers'][-1]['top_m'], 31, delta=.1)
        upper = shape(result['tiers'][-1]['geometry'])
        self.assertTrue(upper.covers(box(18, 18, 42, 42)))
        self.assertFalse(upper.intersects(box(1, 1, 5, 5)))

    def test_many_meaningful_setbacks_do_not_collapse_to_one_height(self):
        def roof(x, y):
            return 10 + 5*min(8, int(min(x, y, 60-x, 60-y)//3))
        result, reason = self.measure(roof)
        self.assert_supported(result)
        self.assertGreater(len(result['tiers']), 6, reason)
        self.assertAlmostEqual(result['height_m'], 10, delta=.2)
        self.assertEqual([round(t['top_m']) for t in result['tiers']], list(range(15, 51, 5)))
        self.assertTrue(shape(result['tiers'][-1]['geometry']).covers(box(27, 27, 33, 33)))

    def test_higher_nonflat_roof_keeps_the_supporting_shaft_whole(self):
        def roof(x, y):
            if not (10 < x < 50 and 10 < y < 50):
                return 10
            if 20 < x < 30 and 20 < y < 30:
                return 90
            if x > 32 and y > 20:
                return 60 + .2*(x-32) + .15*(y-20)
            return 50
        result, reason = self.measure(roof)
        self.assert_supported(result)
        shaft = next((shape(t['geometry']) for t in result['tiers'] if t['top_m'] >= 49), None)
        self.assertIsNotNone(shaft, reason)
        # This broad high roof reaches the shaft's outer edge. Ignoring its
        # returns cuts a large notch into the tower underneath it.
        high_roof_interior = box(36, 30, 46, 46)
        self.assertGreater(shaft.intersection(high_roof_interior).area, high_roof_interior.area*.95)
        self.assertGreater(shaft.intersection(box(10, 10, 50, 50)).area, 1600*.9)

    def test_losing_one_major_component_rejects_the_whole_envelope(self):
        def roof(x, y):
            broad = 6 < x < 26 and 15 < y < 45
            narrow = 42 < x < 46 and 6 < y < 54
            return 90 if broad or narrow else 20
        result, reason = self.measure(roof, width=8.6, step=3)
        self.assertIsNone(result)
        self.assertEqual(reason, 'unprintable_major_tier')

    def test_tiny_spike_and_isolated_high_returns_are_removed(self):
        result, _ = self.measure(
            lambda x, y: 100 if 29 < x < 29.8 and 29 < y < 29.8 else 30,
            extra_points=[(x, y, 600, 6, 1) for x, y in ((5.3, 5.3), (17.3, 33.3), (47.3, 19.3))])
        self.assert_supported(result)
        self.assertAlmostEqual(result['height_m'], 30, delta=.1)
        self.assertFalse(result['tiers'])


class MassingCacheTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.bundle = CacheBundle(Path(temp.name), Bounds(-88, 41, -87, 42))
        self.bundle.ensure_directory()
        for name in ('building', 'building_part'):
            self.bundle.data_path(name).write_text('{"features": []}')
        self.signature = request_signature(self.bundle, .07, .077)

    def write(self, record, signature=None):
        (self.bundle.path/'lidar_buildings.json').write_text(json.dumps({
            'format': 1, 'request': signature or self.signature, 'buildings': {'tower': record}}))

    def test_larger_tier_cache_roundtrips_without_silent_truncation(self):
        geometry = {'type': 'Polygon', 'coordinates': [
            [[-87.8, 41.2], [-87.7, 41.2], [-87.7, 41.3], [-87.8, 41.2]]]}
        record = {'height_m': 10, 'tiers': [
            {'bottom_m': 10+i, 'top_m': 11+i, 'geometry': geometry} for i in range(23)]}
        self.write(record)
        loaded, message = load_measurements(self.bundle, self.signature)
        self.assertIn('tower', loaded, message)
        self.assertEqual(loaded['tower']['tiers'], record['tiers'])
        record['tiers'].append({'bottom_m': 33, 'top_m': 34, 'geometry': geometry})
        self.write(record)
        self.assertFalse(load_measurements(self.bundle, self.signature)[0])

    def test_previous_algorithm_cache_requires_preparation(self):
        self.write({'height_m': 30, 'tiers': []}, {**self.signature, 'algorithm': 4})
        records, message = load_measurements(self.bundle, self.signature)
        self.assertFalse(records)
        self.assertIn('stale', message)
