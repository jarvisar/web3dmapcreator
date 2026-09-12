"""Area admission precedes acquisition while retaining neighboring roof masks."""
import copy
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.data.lidar import request_signature, load_measurements
from jarvizar_city_model.external.lidar_footprint import (
    DEFAULT_MINIMUM_FOOTPRINT_AREA_MM2, FOOTPRINT_SKIP_REASON,
    minimum_footprint_area_m2, select_footprints)

try:
    import numpy as np
    from shapely.affinity import rotate
    from shapely.geometry import box, mapping, MultiPolygon, Polygon
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class FootprintTests(unittest.TestCase):
    def test_area_respects_shape_holes_components_and_rotation(self):
        geometries = {
            'small': box(0, 0, 9, 9),
            'long': box(0, 0, 4, 40),
            'rotated': rotate(box(0, 0, 4, 40), 37),
            'courtyard': Polygon(box(0, 0, 20, 20).exterior.coords,
                                 [box(1, 1, 19, 19).exterior.coords]),
            'components': MultiPolygon([box(0, 0, 9, 9), box(20, 0, 29, 9)]),
            'concave': Polygon([(0, 0), (30, 0), (30, 1), (1, 1), (1, 30), (0, 30)]),
            'rock': box(0, 0, 1, 1),
        }
        features = [{'id': key, 'properties': {'lidar_surface_kind': 'rock'} if key == 'rock' else {}}
                    for key in geometries]
        threshold = minimum_footprint_area_m2(DEFAULT_MINIMUM_FOOTPRINT_AREA_MM2, .07**2)
        admitted, rejected = select_footprints(features, geometries, threshold)
        self.assertEqual({f['id'] for f in admitted}, {'long', 'rotated', 'components', 'rock'})
        self.assertEqual(set(rejected), {'small', 'courtyard', 'concave'})
        self.assertEqual(select_footprints(features, geometries, 0), (features, {}))
        self.assertEqual(select_footprints(features[:1], geometries, 81)[0], features[:1])
        self.assertEqual(len(select_footprints(features, geometries,
            minimum_footprint_area_m2(.5, .14**2))[0]), len(features))

    def test_conversion_uses_area_and_rejects_invalid_settings(self):
        self.assertAlmostEqual(minimum_footprint_area_m2(.5, .07 * .14), .5 / (.07 * .14), places=6)
        for area in (-1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                minimum_footprint_area_m2(area, .07**2)
        for scale in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                minimum_footprint_area_m2(.5, scale)

    def test_worker_skips_before_reads_retains_neighbors_and_reselects_on_change(self):
        external = str(Path(__file__).resolve().parents[1] / 'jarvizar_city_model/external')
        path_patch = patch.object(sys, 'path', [external] + sys.path)
        path_patch.start()
        self.addCleanup(path_patch.stop)
        worker = importlib.import_module('download_lidar')
        acquisition = importlib.import_module('lidar_acquisition')
        measurements = importlib.import_module('lidar_measurements')
        with tempfile.TemporaryDirectory() as directory:
            bundle = CacheBundle(Path(directory), Bounds(-.001, -.001, .001, .001))
            bundle.ensure_directory()
            features = [
                {'id': 'small', 'properties': {}, 'geometry': mapping(box(0, 0, .00008, .00008))},
                {'id': 'large', 'properties': {}, 'geometry': mapping(box(.0001, 0, .0003, .0002))},
            ]
            bundle.data_path('building').write_text(json.dumps({'features': features}))
            bundle.data_path('building_part').write_text(json.dumps({'features': [{
                'id': 'detail', 'properties': {'building_id': 'large'},
                'geometry': mapping(box(.0001, 0, .00011, .00001))}]}))
            source = {'url': 'https://example.org/ept.json', 'name': 'survey', 'format': 'EPT',
                      'coverage': box(-.001, -.001, .001, .001)}
            def measure(batch, *args, **kwargs):
                self.assertTrue(kwargs['neighbors_by_id']['large'], 'Skipped house must remain a ground exclusion')
                self.assertEqual(len(kwargs['source_parts_by_parent']['large']), 1)
                return {f['id']: {'height_m': 30., 'tiers': []} for f in batch}, {}, {}
            with patch.object(acquisition, 'discover_sources', side_effect=lambda *a, **k: ([copy.deepcopy(source)], [])) as discover, \
                 patch.object(acquisition, 'read_source', side_effect=lambda *a, **k: (np.empty((0, 7)), {'url': source['url']})) as read, \
                 patch.object(measurements, 'measure_features', side_effect=measure) as fit:
                request = request_signature(bundle, .07, .077)
                result = worker.prepare(bundle.path, request)
                self.assertEqual(result['candidate_buildings'], 2)
                self.assertEqual(result['rejection_counts'], {FOOTPRINT_SKIP_REASON: 1})
                self.assertEqual([f['id'] for f in fit.call_args.args[0]], ['large'])
                self.assertEqual(set(load_measurements(bundle, request)[0]), {'large'})
                self.assertTrue(worker.prepare(bundle.path, request)['reused_prepared'])
                self.assertEqual((discover.call_count, read.call_count, fit.call_count), (1, 1, 1))
                disabled = request_signature(bundle, .07, .077, min_footprint_area_mm2=0)
                self.assertIn('stale', load_measurements(bundle, disabled)[1])
                result = worker.prepare(bundle.path, disabled)
                self.assertEqual(result['buildings'], 2)
                self.assertFalse(result['rejection_counts'])
                self.assertEqual({f['id'] for f in fit.call_args.args[0]}, {'small', 'large'})
                # An entirely filtered selection is a valid offline result.
                discover.reset_mock(); read.reset_mock(); fit.reset_mock()
                empty = request_signature(bundle, .07, .077, min_footprint_area_mm2=10)
                result = worker.prepare(bundle.path, empty)
                self.assertEqual(result['rejection_counts'], {FOOTPRINT_SKIP_REASON: 2})
                self.assertEqual(result['buildings'], 0)
                discover.assert_not_called(); read.assert_not_called(); fit.assert_not_called()
                self.assertTrue(worker.prepare(bundle.path, empty)['reused_prepared'])
