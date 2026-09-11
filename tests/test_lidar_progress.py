"""Progress is advisory even when Windows refuses an atomic file replacement."""
from concurrent.futures import ThreadPoolExecutor
import importlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from jarvizar_city_model.external.lidar_progress import ProgressReporter


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'progress.json'
        self.path.write_text('{"message":"previous"}')
        self.log = io.StringIO()
        self.stderr = patch('sys.stderr', self.log)
        self.stderr.start()
        self.addCleanup(self.stderr.stop)
        self.reporter = ProgressReporter(self.path)
        self.reporter.MIN_INTERVAL_SECONDS = 0

    def test_transient_reader_conflict_retries_and_preserves_complete_json(self):
        replace = Path.replace
        calls = []
        def conflict(temporary, destination):
            calls.append(destination)
            if len(calls) == 1:
                self.assertEqual(json.loads(self.path.read_text())['message'], 'previous')
                raise PermissionError('reader holds destination')
            return replace(temporary, destination)
        with patch.object(Path, 'replace', conflict), patch('time.sleep') as sleep:
            self.assertTrue(self.reporter('Measuring roofs', accepted=5, candidates=10))
        self.assertEqual(json.loads(self.path.read_text()),
                         {'message': 'Measuring roofs', 'accepted': 5, 'candidates': 10})
        sleep.assert_called_once_with(.005)
        self.assertNotIn('unavailable', self.log.getvalue())

    def test_persistent_replace_denial_is_nonfatal_and_later_updates_recover(self):
        with patch.object(Path, 'replace', side_effect=PermissionError('Access is denied')) as replace, patch('time.sleep'):
            self.assertFalse(self.reporter('first'))
            self.assertFalse(self.reporter('second'))
            self.assertEqual(replace.call_count, 6)
        self.assertEqual(json.loads(self.path.read_text())['message'], 'previous')
        self.assertEqual(self.log.getvalue().count('preparation continues'), 1)
        self.assertTrue(self.reporter('recovered'))
        self.assertEqual(json.loads(self.path.read_text())['message'], 'recovered')

    def test_temporary_write_errors_are_also_advisory(self):
        for error in (PermissionError('temporary locked'), OSError('disk unavailable')):
            with self.subTest(error=error), patch.object(Path, 'write_text', side_effect=error), patch('time.sleep'):
                self.assertFalse(self.reporter('Downloading'))
                self.assertEqual(json.loads(self.path.read_text())['message'], 'previous')

    def test_file_writes_are_throttled_including_failures_but_all_messages_are_logged(self):
        self.reporter.MIN_INTERVAL_SECONDS = .2
        with patch('time.monotonic', return_value=100) as clock:
            self.assertTrue(self.reporter('first'))
            self.assertFalse(self.reporter('second'))
            self.assertEqual(json.loads(self.path.read_text())['message'], 'first')
            clock.return_value = 101
            with patch.object(Path, 'replace', side_effect=PermissionError('locked')) as replace, patch('time.sleep'):
                self.assertFalse(self.reporter('failed update'))
                self.assertFalse(self.reporter('still throttled'))
                self.assertEqual(replace.call_count, 3)
            clock.return_value = 102
            self.assertTrue(self.reporter('last'))
        for text in ('first', 'second', 'failed update', 'still throttled', 'last'):
            self.assertIn(text, self.log.getvalue())

    def test_parallel_download_statuses_cannot_overwrite_each_others_temporary_file(self):
        replace = Path.replace
        def delayed_replace(temporary, destination):
            before = temporary.read_bytes()
            time.sleep(.001)
            self.assertEqual(temporary.read_bytes(), before)
            return replace(temporary, destination)
        with patch.object(Path, 'replace', delayed_replace), ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(self.reporter, str(i), i, 20) for i in range(20)]
            self.assertTrue(all(f.result() for f in futures))
        payload = json.loads(self.path.read_text())
        self.assertEqual(payload['accepted'], int(payload['message']))

    def test_stage_context_survives_transfer_messages_and_completion_is_not_throttled(self):
        self.reporter.MIN_INTERVAL_SECONDS = .2
        with patch('time.monotonic', return_value=100):
            self.assertTrue(self.reporter('First roof',stage='Reconstructing roofs',completed=0,total=4))
            self.assertFalse(self.reporter('Download details'))
            self.assertTrue(self.reporter('Complete',completed=4,force=True))
        payload=json.loads(self.path.read_text())
        self.assertEqual((payload['stage'],payload['completed'],payload['total']),('Reconstructing roofs',4,4))
        self.assertIn('updated_at',payload)

    def test_blender_retains_last_valid_status_during_partial_reads(self):
        from jarvizar_city_model.data.lidar import LidarPreparation
        job=object.__new__(LidarPreparation)
        job.progress_path=self.path
        job.started=time.monotonic()-12
        job.last_progress={'message':'Starting'}
        self.path.write_text(json.dumps({'message':'Fitting roof','completed':2,'total':7}))
        self.assertEqual(job.status()['completed'],2)
        self.path.write_text('{broken')
        self.assertEqual(job.progress(),'Fitting roof')
        self.path.write_text('{"message":"invalid counters","total":"bad"}')
        self.assertEqual(job.status()['completed'],2)
        self.assertGreaterEqual(job.status()['elapsed'],12)

    @unittest.skipUnless(os.name == 'nt', 'Windows reader-lock regression')
    def test_real_windows_reader_reproduces_access_denied_and_worker_status_recovers(self):
        temporary = self.path.with_suffix('.partial')
        temporary.write_text('{"message":"replacement"}')
        with self.path.open('rb') as reader:
            with self.assertRaises(PermissionError) as caught:
                temporary.replace(self.path)
            self.assertIn(caught.exception.winerror, (5, 32))
            self.assertFalse(self.reporter('locked'))
            self.assertEqual(json.load(reader)['message'], 'previous')
        self.assertTrue(self.reporter('unlocked'))
        self.assertEqual(json.loads(self.path.read_text())['message'], 'unlocked')


class PreparationProgressTests(unittest.TestCase):
    def test_status_write_failure_cannot_abort_preparation_or_mask_required_write_failure(self):
        try:
            import numpy as np
            from shapely.geometry import box, mapping
        except ImportError:
            self.skipTest('optional LiDAR dependencies not installed')
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature
        external = str(Path(__file__).resolve().parents[1] / 'jarvizar_city_model/external')
        with patch.object(sys, 'path', [external] + sys.path):
            worker = importlib.import_module('download_lidar')
            acquisition = importlib.import_module('lidar_acquisition')
            measurements = importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        for denied in ('progress', 'checkpoint', 'result'):
            with self.subTest(denied=denied), tempfile.TemporaryDirectory() as temp:
                bundle = CacheBundle(Path(temp), Bounds(-74, 40, -73.9, 40.1))
                bundle.ensure_directory()
                feature = {'id': 'one', 'properties': {}, 'geometry': mapping(box(-73.99, 40.02, -73.989, 40.021))}
                bundle.data_path('building').write_text(json.dumps({'features': [feature]}))
                bundle.data_path('building_part').write_text('{"features": []}')
                result_path = bundle.path / 'lidar_buildings.json'
                result_path.write_text('previous published result')
                progress_path = bundle.path / 'progress.json'
                source = {'name': 'survey', 'url': 'https://example.com/ept.json',
                          'format': 'EPT', 'coverage': box(-74, 40, -73.9, 40.1)}
                request = request_signature(bundle, .07, .077)
                replace = Path.replace
                def deny(temporary, destination):
                    destination = Path(destination)
                    if (destination == progress_path or (denied == 'checkpoint' and destination.parent.name == 'lidar_jobs')
                            or (denied == 'result' and destination == result_path)):
                        raise PermissionError('Access is denied')
                    return replace(temporary, destination)
                with patch.object(acquisition, 'discover_sources', return_value=([source], [])), \
                     patch.object(acquisition, 'read_source', return_value=(np.empty((0, 7)), {'url': source['url']})) as read, \
                     patch.object(measurements, 'measure_features', return_value=({'one': {'height_m': 30, 'tiers': []}}, {}, {})), \
                     patch.object(worker.ProgressReporter, 'MIN_INTERVAL_SECONDS', 0), \
                     patch.object(Path, 'replace', deny), patch('time.sleep'), patch('sys.stderr', io.StringIO()):
                    if denied == 'progress':
                        self.assertEqual(worker.prepare(bundle.path, request, progress_path=progress_path)['buildings'], 1)
                        payload = json.loads(result_path.read_text())
                        self.assertEqual(set(payload['buildings']), {'one'})
                        self.assertFalse(payload['failures'])
                        # Persistent advisory failures must not spoil checkpoint replay.
                        self.assertEqual(worker.prepare(bundle.path, request, progress_path=progress_path)['buildings'], 1)
                        self.assertEqual(read.call_count, 1)
                    else:
                        with self.assertRaises(PermissionError):
                            worker.prepare(bundle.path, request, progress_path=progress_path)
                        self.assertEqual(result_path.read_text(), 'previous published result')
