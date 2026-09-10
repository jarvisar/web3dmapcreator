"""Actual worker acquisition must evaluate a trial before admitting later tiles."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from lidar_consent_fixture import prepare_reviewed_laz
from unittest.mock import patch

try:
    import numpy as np
    from shapely.geometry import box, mapping
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class IncrementalTests(unittest.TestCase):
    def run_worker(self, mode):
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature
        external = str(Path(__file__).resolve().parents[1] / 'jarvizar_city_model/external')
        with patch.object(sys, 'path', [external] + sys.path):
            worker = importlib.import_module('download_lidar')
            acquisition = importlib.import_module('lidar_acquisition')
            measurements = importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        features = [{'id': str(i), 'properties': {},
                     'geometry': mapping(box(-73.995+i*.025, 40.02, -73.994+i*.025, 40.021))} for i in range(3)]
        laz = acquisition.grouped_laz([{'url': f'https://example.com/laz/{i}.laz',
                                      'bbox': [-74+i*.025, 40, -73.975+i*.025, 40.1]} for i in range(3)])[0]
        ept = {'url': 'https://example.com/ept/ept.json', 'name': 'EPT', 'format': 'EPT',
               'coverage': box(-74, 40, -73.9 if mode != 'hard_gap' else -73.95, 40.1)}
        if mode == 'superior':
            ept['survey_metadata'] = {'point_spacing_m': 2}
            laz['survey_metadata'] = {'point_spacing_m': .5}
        active = []
        events = []
        def transfer(url, **kwargs):
            events.append(('download', url.rsplit('/', 1)[-1]))
            return Path('tile.laz')
        def read(fetch, selected, bbox):
            active[:] = [selected['format']]
            if selected['format'] == 'LAZ':
                for tile in selected['tiles']:
                    fetch.download(tile['url'])
                if mode == 'read_failure':
                    raise OSError('Trial delivery failed')
            return np.empty((0, 7)), {'url': selected['url'], 'points': 100}
        def measure(batch, *args, **kwargs):
            identifier = batch[0]['id']
            if active[0] == 'EPT':
                return {}, {}, {identifier: 'insufficient_ground'}
            events.append(('evaluated', identifier))
            if mode == 'benefit' or (mode == 'later_failure' and identifier == '0'):
                return {identifier: {'height_m': 30, 'tiers': []}}, {}, {}
            return {}, {}, {identifier: 'insufficient_ground'}
        with tempfile.TemporaryDirectory() as temporary:
            bundle = CacheBundle(Path(temporary), Bounds(-74, 40, -73.9, 40.1))
            bundle.ensure_directory()
            bundle.data_path('building').write_text(json.dumps({'features': features}))
            bundle.data_path('building_part').write_text('{"features": []}')
            request = request_signature(bundle, .07, .077)
            with patch.object(acquisition, 'discover_sources', side_effect=lambda *a, **kw: ([dict(ept), dict(laz)], [])), \
                 patch.object(acquisition, 'read_source', side_effect=read), \
                 patch.object(measurements, 'measure_features', side_effect=measure), \
                 patch.object(acquisition.lidar_ept.Fetcher, 'download', side_effect=transfer):
                prepare_reviewed_laz(worker, bundle.path, request)
                result = json.loads((bundle.path / 'lidar_buildings.json').read_text())
                first = list(events)
                if mode != 'read_failure':
                    events.clear()
                    prepare_reviewed_laz(worker, bundle.path, request)
                    self.assertFalse(events, 'Checkpoint replay must preserve the stop decision without point reads')
                return first, next(s for s in result['discovered_sources'] if s['format'] == 'LAZ')

    def test_unproductive_trial_defers_remaining_tiles_even_on_replay(self):
        events, source = self.run_worker('no_benefit')
        self.assertEqual(events, [('download', '0.laz'), ('evaluated', '0')])
        self.assertEqual(source['incremental_acquisition']['deferred_buildings'], 2)
        self.assertEqual(len(source['selected_tiles']), 1)

    def test_successful_trials_continue_one_batch_at_a_time(self):
        events, source = self.run_worker('benefit')
        self.assertEqual(events, [(action, str(i) + ('.laz' if action == 'download' else ''))
                                  for i in range(3) for action in ('download', 'evaluated')])
        self.assertEqual(source['incremental_acquisition']['recovered_buildings'], 3)

    def test_later_unproductive_batch_stops_further_speculation(self):
        events, source = self.run_worker('later_failure')
        self.assertEqual([v for action, v in events if action == 'download'], ['0.laz', '1.laz'])
        self.assertEqual(source['incremental_acquisition']['deferred_buildings'], 1)

    def test_independent_coverage_gaps_survive_an_unproductive_trial_elsewhere(self):
        events, source = self.run_worker('hard_gap')
        self.assertEqual([v for action, v in events if action == 'download'], ['0.laz', '2.laz'])
        self.assertEqual(source['incremental_acquisition']['deferred_buildings'], 1)

    def test_material_upgrade_is_independently_justified(self):
        events, source = self.run_worker('superior')
        self.assertEqual([v for action, v in events if action == 'download'], ['0.laz', '1.laz', '2.laz'])
        self.assertEqual(source['incremental_acquisition']['deferred_buildings'], 0)

    def test_failed_trial_does_not_queue_remaining_speculative_transfers(self):
        events, source = self.run_worker('read_failure')
        self.assertEqual(events, [('download', '0.laz')])
        self.assertEqual(source['incremental_acquisition']['deferred_buildings'], 2)


if __name__ == '__main__':
    unittest.main()
