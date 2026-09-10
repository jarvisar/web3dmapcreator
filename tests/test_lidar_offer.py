"""Default preparation is EPT-only; finite gap offers require explicit consent."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

try:
    import numpy as np
    from shapely.geometry import box, mapping
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class OfferTests(unittest.TestCase):
    def setUp(self):
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bundle = CacheBundle(Path(self.temp.name), Bounds(-74, 40, -73.9, 40.1))
        self.bundle.ensure_directory()
        features = [{'id': name, 'properties': {}, 'geometry': mapping(box(x, 40.02, x+.001, 40.021))}
                    for name, x in [('west', -73.99), ('east', -73.92)]]
        self.bundle.data_path('building').write_text(json.dumps({'features': features}))
        self.bundle.data_path('building_part').write_text('{"features": []}')
        self.request = request_signature(self.bundle, .07, .077)
        external = str(Path(__file__).resolve().parents[1] / 'jarvizar_city_model/external')
        with patch.object(sys, 'path', [external] + sys.path):
            self.worker = importlib.import_module('download_lidar')
            acquisition = importlib.import_module('lidar_acquisition')
            measurements = importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        self.ept = {'url': 'https://example.com/ept/ept.json', 'name': 'EPT', 'format': 'EPT',
                    'coverage': box(-74, 40, -73.9, 40.1)}
        self.laz = acquisition.grouped_laz([
            {'url': f'https://example.com/laz/{name}.laz', 'bbox': bounds, 'size_bytes': 1024}
            for name, bounds in [('west', [-74, 40, -73.95, 40.1]), ('east', [-73.95, 40, -73.9, 40.1])]])[0]
        self.sources = [self.ept, self.laz]
        self.reads, self.downloads = [], []
        self.gap = 'insufficient_roof_points'
        def read(fetch, source, bbox):
            self.reads.append(source['format'])
            for tile in source.get('tiles', []):
                fetch.download(tile['url'])
            return np.empty((0, 7)), {'url': source['url'], 'points': 100}
        def measure(batch, *args, **kwargs):
            records, rejected = {}, {}
            for f in batch:
                if self.reads[-1] == 'EPT' and f['id'] == 'east' and self.gap:
                    rejected[f['id']] = self.gap
                else:
                    records[f['id']] = {'height_m': 30, 'tiers': []}
            return records, {}, rejected
        for target, name, options in (
            (acquisition, 'discover_sources', {'side_effect': lambda *a, **kw: ([dict(s) for s in self.sources], [])}),
            (acquisition, 'read_source', {'side_effect': read}),
            (measurements, 'measure_features', {'side_effect': measure}),
            (acquisition.lidar_ept.Fetcher, 'download', {'side_effect': lambda url, **kw: self.downloads.append(url) or Path('tile.laz')}),
        ):
            p = patch.object(target, name, **options)
            p.start()
            self.addCleanup(p.stop)

    def prepare(self, **kwargs):
        return self.worker.prepare(self.bundle.path, self.request, **kwargs)

    def test_default_replay_and_refresh_never_acquire_laz_then_consent_fills_only_gap(self):
        from jarvizar_city_model.external.lidar_offer import offer_details
        first = self.prepare()
        self.assertEqual(first['buildings'], 1)
        self.assertEqual(first['laz_offers'][0]['buildings'], ['east'])
        self.assertEqual(len(first['laz_offers'][0]['areas']), 1)
        self.assertIn('Area W/S/E/N', offer_details(first['laz_offers']))
        count = len(self.reads)
        self.prepare()
        self.assertEqual(len(self.reads), count)
        result = self.prepare(refresh=True)
        self.assertFalse(self.downloads)
        self.assertTrue(all(fmt == 'EPT' for fmt in self.reads))
        count = len(self.reads)
        accepted = self.prepare(laz_approval=result['laz_offer_token'])
        self.assertEqual(self.reads[count:], ['LAZ'])
        self.assertEqual(accepted['buildings'], 2)
        self.assertFalse(accepted['laz_offers'])
        self.assertEqual(self.downloads, ['https://example.com/laz/east.laz'])

    def test_forged_and_stale_consent_fail_before_any_acquisition(self):
        result = self.prepare()
        count = len(self.reads)
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.prepare(laz_approval='anything')
        self.request = {**self.request, 'xy_scale': .08}
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.prepare(laz_approval=result['laz_offer_token'])
        self.assertEqual(len(self.reads), count)
        self.assertFalse(self.downloads)

    def test_new_tiles_require_a_new_offer_even_with_old_consent(self):
        result = self.prepare()
        east = next(t for t in self.laz['tiles'] if t['url'].endswith('/east.laz'))
        self.laz['tiles'].append({**east, 'url': 'https://example.com/laz/extra.laz'})
        updated = self.prepare(laz_approval=result['laz_offer_token'])
        self.assertFalse(self.downloads)
        self.assertNotEqual(updated['laz_offer_token'], result['laz_offer_token'])
        self.assertEqual(len(updated['laz_offers'][0]['tiles']), 2)

    def test_better_metadata_does_not_make_a_reconstruction_rejection_a_gap(self):
        self.gap = 'unresolved_upper_roof'
        self.ept['survey_metadata'] = {'point_spacing_m': 2}
        self.laz['survey_metadata'] = {'point_spacing_m': .1}
        result = self.prepare()
        self.assertFalse(result['laz_offers'])
        self.assertFalse(self.downloads)

    def test_no_ept_still_requires_consent(self):
        self.sources = [self.laz]
        result = self.prepare()
        self.assertEqual(result['buildings'], 0)
        self.assertEqual(result['laz_offers'][0]['buildings'], ['east', 'west'])
        self.assertFalse(self.reads)
        self.assertFalse(self.downloads)

    def test_secondary_ept_reconstruction_rejection_does_not_offer_laz(self):
        self.sources.append({**self.ept, 'url': 'https://example.com/secondary/ept.json'})
        # First EPT rejects reconstruction, the second cannot turn it into a
        # LAZ gap even if that second survey is sparse.
        self.gap = 'footprint_roof_mismatch'
        result = self.prepare()
        self.assertFalse(result['laz_offers'])
        self.assertEqual(len(self.reads), 3)
        self.assertFalse(self.downloads)
