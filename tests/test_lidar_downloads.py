"""Concurrency contracts: real streaming transport with controlled responses."""
import io
import importlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from concurrent.futures import CancelledError, ThreadPoolExecutor
from unittest.mock import Mock, patch

try:
    from jarvizar_city_model.external.lidar_ept import Fetcher, BudgetExceeded
    from jarvizar_city_model.external.lidar_downloads import TileDownloads, prefetch_source
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


class Response(io.BytesIO):
    headers = {'Content-Length': '4'}


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class DownloadTests(unittest.TestCase):
    def tiles(self, count):
        return [{'url': f'https://example.com/{i}.laz', 'updated': 'v1',
                 'bbox': [i, 0, i+1, 1]} for i in range(count)]

    def test_configured_simultaneous_transfers_and_exact_accounting(self):
        for workers in (1, 4, 8, 16):
            with self.subTest(workers=workers):
                self.check_concurrent_transfers(workers)

    def check_concurrent_transfers(self, workers):
        gate, started = threading.Event(), threading.Event()
        lock = threading.Lock()
        active, peak = 0, 0

        class SlowResponse(Response):
            def __enter__(self):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(active, peak)
                    if active == workers:
                        started.set()
                if not gate.wait(5):
                    raise AssertionError('Downloads did not overlap')
                return self

            def __exit__(self, *args):
                nonlocal active
                with lock:
                    active -= 1
                return super().__exit__(*args)

        with tempfile.TemporaryDirectory() as temp:
            fetch = Fetcher(Path(temp), refresh=True)
            count = workers*2+1
            tiles = self.tiles(count)
            with patch('urllib.request.urlopen', side_effect=lambda *a, **k: SlowResponse(b'roof')) as opened:
                with TileDownloads(fetch, tiles + tiles, workers=workers) as downloads:
                    try:
                        self.assertTrue(started.wait(5), 'Configured transfers must start before any finishes')
                        self.assertEqual(peak, workers)
                    finally:
                        gate.set()
                    for tile in tiles:
                        self.assertEqual(downloads.download(tile['url'], revision='v1').read_bytes(), b'roof')
                self.assertEqual(opened.call_count, count)
            self.assertEqual((fetch.bytes, fetch.requests), (4*count, count))
            self.assertEqual(len(fetch.seen), count)
            self.assertFalse(list(Path(temp).glob('*.partial')))

    def test_invalid_limits_fail_before_starting_transfers(self):
        for value in (0, -1, 17, 1000, True, 4.0, '8', None):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'integer from 1 to 16'):
                TileDownloads(Mock(), self.tiles(1), workers=value)

    def test_shared_revision_refreshes_once_even_with_concurrent_callers(self):
        with tempfile.TemporaryDirectory() as temp:
            fetch = Fetcher(Path(temp), refresh=True)
            with patch('urllib.request.urlopen', side_effect=lambda *a, **k: Response(b'roof')) as opened:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    paths = list(pool.map(lambda _: fetch.download('https://example.com/a', revision='v1'), range(12)))
                self.assertEqual(opened.call_count, 1)
                self.assertEqual(len(set(paths)), 1)
                changed = fetch.download('https://example.com/a', revision='v2')
                self.assertNotEqual(changed, paths[0])
            self.assertEqual((fetch.bytes, fetch.requests), (8, 2))

    def test_explicit_total_budget_cannot_be_overspent_by_workers(self):
        with tempfile.TemporaryDirectory() as temp:
            fetch = Fetcher(Path(temp), max_bytes=6)
            with patch('urllib.request.urlopen', side_effect=lambda *a, **k: Response(b'roof')):
                with TileDownloads(fetch, self.tiles(2)) as downloads:
                    success, errors = [], []
                    for tile in self.tiles(2):
                        try:
                            success.append(downloads.download(tile['url'], revision='v1'))
                        except BudgetExceeded as exc:
                            errors.append(exc)
            self.assertEqual((len(success), len(errors), fetch.bytes), (1, 1, 4))
            self.assertFalse(list(Path(temp).glob('*.partial')))

    def test_cancelled_stream_preserves_complete_cache_and_removes_partial(self):
        cancel = threading.Event()

        class CancelResponse(Response):
            def read(self, size):
                result = super().read(size)
                cancel.set()
                return result

        with tempfile.TemporaryDirectory() as temp:
            with patch('urllib.request.urlopen', return_value=Response(b'roof')):
                path = Fetcher(Path(temp)).download('https://example.com/a')
            fetch = Fetcher(Path(temp), refresh=True)
            with patch('urllib.request.urlopen', return_value=CancelResponse(b'new!')):
                with self.assertRaises(CancelledError):
                    fetch.download('https://example.com/a', cancel=cancel)
            self.assertEqual(path.read_bytes(), b'roof')
            self.assertEqual((fetch.bytes, fetch.requests), (0, 0))
            self.assertFalse(list(Path(temp).glob('*.partial')))

    def test_failed_tile_does_not_discard_other_downloads(self):
        def download(url, **kwargs):
            if url.endswith('/0.laz'):
                raise OSError('unavailable')
            return Path('good.laz')
        with TileDownloads(Mock(download=Mock(side_effect=download)), self.tiles(2)) as downloads:
            with self.assertRaisesRegex(OSError, 'unavailable'):
                downloads.download(self.tiles(2)[0]['url'], revision='v1')
            self.assertEqual(downloads.download(self.tiles(2)[1]['url'], revision='v1'), Path('good.laz'))

    def test_lookahead_filters_tiles_and_leaves_ept_alone(self):
        fetch = Mock(download=Mock(return_value=Path('tile')))
        source = {'format': 'LAZ', 'tiles': self.tiles(5)}
        with prefetch_source(fetch, source, [[.1, .1, .9, .9], [3.1, .1, 3.9, .9]]) as downloads:
            for i in (0, 3):
                downloads.download(source['tiles'][i]['url'], revision='v1')
        self.assertEqual({call.args[0] for call in fetch.download.call_args_list},
                         {source['tiles'][i]['url'] for i in (0, 3)})
        fetch.reset_mock()
        with prefetch_source(fetch, source, []):
            pass
        with prefetch_source(fetch, {'format': 'EPT'}, [[0, 0, 1, 1]]) as ept:
            self.assertIs(ept, fetch)
        fetch.download.assert_not_called()

    def test_reader_cannot_download_an_unplanned_tile_or_revision(self):
        fetch = Mock(download=Mock(return_value=Path('tile')))
        with TileDownloads(fetch, self.tiles(1)) as downloads:
            for url, revision in ((self.tiles(2)[1]['url'], 'v1'), (self.tiles(1)[0]['url'], 'v2')):
                with self.assertRaisesRegex(ValueError, 'outside the acquisition plan'):
                    downloads.download(url, revision=revision)
        self.assertEqual(fetch.download.call_count, 1)

    def test_worker_prefetches_across_groups_and_skips_healthy_checkpoints(self):
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature
        from shapely.geometry import box, mapping
        import numpy as np
        external = str(Path(__file__).resolve().parents[1]/'jarvizar_city_model/external')
        with patch.object(sys, 'path', [external]+sys.path):
            worker = importlib.import_module('download_lidar')
            acquisition = importlib.import_module('lidar_acquisition')
            measurements = importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        all_started = threading.Barrier(4, timeout=5)
        main_thread = threading.get_ident()

        def download(url, **kwargs):
            all_started.wait()  # Deadlocks/fails if acquisition is per-group serial.
            return Path(url.rsplit('/', 1)[-1])

        def read(fetch, source, bbox):
            self.assertEqual(threading.get_ident(), main_thread)
            for tile in source['tiles']:
                if box(*tile['bbox']).intersects(box(*bbox)):
                    self.assertEqual(fetch.download(tile['url']), Path(tile['url'].rsplit('/', 1)[-1]))
            return np.empty((0, 7)), {'url': source['url'], 'points': 0}

        with tempfile.TemporaryDirectory() as temp:
            bundle = CacheBundle(Path(temp), Bounds(-74, 40, -73.9, 40.1))
            bundle.ensure_directory()
            features = [{'id': str(i), 'properties': {},
                         'geometry': mapping(box(-73.995+i*.025, 40.02, -73.994+i*.025, 40.021))}
                        for i in range(4)]
            tiles = [{'url': f'https://example.com/{i}.laz',
                      'bbox': [-74+i*.025, 40, -73.975+i*.025, 40.1]} for i in range(4)]
            source = acquisition.grouped_laz(tiles)[0]
            source.update(catalog_coverage=1, project_year_hint=None)
            bundle.data_path('building').write_text(json.dumps({'features': features}))
            bundle.data_path('building_part').write_text('{"features": []}')
            request = request_signature(bundle, .07, .077)
            def measure(features, *args, **kwargs):
                return {f['id']: {'height_m': 30, 'tiers': []} for f in features}, {}, {}
            with patch.object(acquisition, 'discover_sources', return_value=([source], [])), \
                 patch.object(acquisition, 'read_source', side_effect=read), \
                 patch.object(measurements, 'measure_features', side_effect=measure), \
                 patch.object(acquisition.lidar_ept.Fetcher, 'download', side_effect=download) as transfer:
                self.assertEqual(worker.prepare(bundle.path, request, progress_path=Path(temp)/'progress.json')['buildings'], 4)
                self.assertEqual(transfer.call_count, 4)
                transfer.reset_mock()
                self.assertEqual(worker.prepare(bundle.path, request, download_workers=8)['buildings'], 4)
                transfer.assert_not_called()
                checkpoint = next((bundle.path/'lidar_jobs').glob('*.json'))
                checkpoint.write_text('{}')
                transfer.side_effect = lambda url, **kw: Path(url.rsplit('/', 1)[-1])
                self.assertEqual(worker.prepare(bundle.path, request, download_workers=16)['buildings'], 4)
                self.assertEqual(transfer.call_count, 1)


if __name__ == '__main__':
    unittest.main()
