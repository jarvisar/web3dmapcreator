"""Decode reuse and bounded EPT concurrency must preserve actual point arrays."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

try:
    import laspy
    import numpy as np
    import test_lidar_acquisition as acquisition_fixture
    from jarvizar_city_model.external import lidar_ept as ept, lidar_laz as laz
    from jarvizar_city_model.external.lidar_decode_cache import DecodedPointCache
    from jarvizar_city_model.external.lidar_downloads import ept_node_data, prefetch_source
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class DecodeReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = DecodedPointCache()
        self.addCleanup(self.cache.close)
        self.fixture = acquisition_fixture.AcquisitionTests()
        self.path = self.root/'tile.laz'
        self.fixture.cloud().write(self.path)
        self.source = {'url': 'https://example.com/survey/', 'format': 'LAZ', 'tiles': [
            {'url': 'https://example.com/tile.laz', 'bbox': self.fixture.bbox}]}
        outer = self
        class Fetch:
            decoded_cache = outer.cache
            def download(self, *args, **kwargs):
                return outer.path
            def progress(self, message):
                pass
        self.fetch = Fetch()

    def read(self, bbox=None, **kwargs):
        return laz.read_laz(self.fetch, self.source, bbox or self.fixture.bbox, chunk_size=2, **kwargs)

    def test_laz_second_crop_reuses_raw_records_and_preserves_order_flags_and_dates(self):
        first, info = self.read()
        first[:] = -123  # Returned batches never alias the reusable raw records.
        bbox = [-87.64, 41.885005, -87.63, 41.89]
        with patch.object(laspy.LasReader, 'chunk_iterator', side_effect=AssertionError('decoded twice')):
            second, second_info = self.read(bbox)
        self.fetch.decoded_cache = None
        expected, expected_info = self.read(bbox)
        np.testing.assert_array_equal(second, expected)
        self.assertEqual(second_info, expected_info)
        self.assertEqual(len(self.cache.tiles), 1)
        self.assertGreater(self.cache.disk_bytes, 0)
        array, handle = next(iter(self.cache.tiles.values()))
        self.assertFalse(array.flags.writeable)
        self.cache.close()
        self.assertTrue(handle.closed)
        self.assertEqual(self.cache.disk_bytes, 0)

    def test_laz_budget_abort_does_not_cache_partial_tile(self):
        with self.assertRaises(ept.BudgetExceeded):
            self.read(max_points=1)
        self.assertEqual(self.cache.disk_bytes, 0)
        self.assertFalse(self.cache.tiles)
        self.assertEqual(len(self.read()[0]), 3)
        with self.assertRaises(ept.BudgetExceeded):
            self.read(max_points=1)  # The limit also applies to cache hits.

    def test_laz_changed_file_and_normalization_are_not_reused_as_old_points(self):
        initial, _ = self.read()
        cloud = self.fixture.cloud()
        cloud.z = np.asarray(cloud.z) + 10
        cloud.write(self.path)
        changed, _ = self.read()
        self.assertFalse(np.array_equal(changed[:, 2], initial[:, 2]))
        # Normalization is reapplied to raw reuse, including changed class maps.
        self.source['vertical_units'] = 'ft'
        self.source['classification'] = {'mapping': {'2': 'ground', '6': 'noise', '1': 'unclassified'}}
        cached, _ = self.read()
        self.fetch.decoded_cache = None
        fresh, _ = self.read()
        np.testing.assert_array_equal(cached, fresh)
        self.assertLess(len(cached), len(changed))

    def test_laz_storage_failure_and_oversized_tiles_keep_streaming(self):
        self.fetch.decoded_cache = None
        expected, _ = self.read()
        self.fetch.decoded_cache = self.cache
        with patch('jarvizar_city_model.external.lidar_decode_cache.tempfile.TemporaryFile', side_effect=OSError('disk full')):
            actual, _ = self.read()
        np.testing.assert_array_equal(actual, expected)
        self.cache.tile_limit = 1
        with patch('jarvizar_city_model.external.lidar_decode_cache.tempfile.TemporaryFile', side_effect=AssertionError('oversize allocation')):
            actual, _ = self.read()
        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(self.cache.disk_bytes, 0)

    def test_laz_eviction_closes_old_mapping_and_respects_total_budget(self):
        size = self.fixture.cloud().points.array.nbytes
        self.cache.disk_limit = size
        self.read()
        _, previous = next(iter(self.cache.tiles.values()))
        new_path = self.root/'other.laz'
        self.fixture.cloud().write(new_path)
        self.path = new_path
        self.read()
        self.assertTrue(previous.closed)
        self.assertEqual(self.cache.disk_bytes, size)
        self.assertEqual(len(self.cache.tiles), 1)

    def test_laz_write_failure_discards_cache_but_keeps_all_points(self):
        self.fetch.decoded_cache = None
        expected, _ = self.read()
        self.fetch.decoded_cache = self.cache
        temporary = tempfile.TemporaryFile()
        with patch('jarvizar_city_model.external.lidar_decode_cache.tempfile.TemporaryFile', return_value=temporary), \
             patch.object(temporary, 'write', side_effect=OSError('disk full')):
            actual, _ = self.read()
        np.testing.assert_array_equal(actual, expected)
        self.assertTrue(temporary.closed)
        self.assertFalse(self.cache.tiles)

    def test_laz_prefetch_wrapper_shares_cache_across_batches(self):
        with prefetch_source(self.fetch, self.source, [self.fixture.bbox], workers=1) as downloads:
            expected, _ = laz.read_laz(downloads, self.source, self.fixture.bbox)
        with prefetch_source(self.fetch, self.source, [self.fixture.bbox], workers=1) as downloads:
            with patch.object(laspy.LasReader, 'chunk_iterator', side_effect=AssertionError('decoded twice')):
                actual, _ = laz.read_laz(downloads, self.source, self.fixture.bbox)
        np.testing.assert_array_equal(actual, expected)

    def test_ept_memory_lru_and_oversized_node(self):
        cloud = self.fixture.cloud()
        size = cloud.points.array.nbytes
        self.cache.memory_limit = 2 * size
        for key in ('a', 'b'):
            self.cache.store_node(key, self.fixture.cloud())
        self.cache.node('a')
        self.cache.store_node('c', self.fixture.cloud())
        self.assertIsNone(self.cache.node('b'))
        self.assertEqual(self.cache.memory_bytes, 2 * size)
        self.assertFalse(self.cache.node('a').points.array.flags.writeable)
        self.cache.memory_limit = 1
        self.cache.store_node('oversized', cloud)
        self.assertIsNone(self.cache.node('oversized'))

    def test_ept_actual_decode_reuse_crop_and_content_revision(self):
        fetch = ept.Fetcher(self.root/'ept')
        self.addCleanup(fetch.decoded_cache.close)
        fetch.download_workers = 1
        url = 'https://example.com/survey/ept.json'
        cloud = self.fixture.cloud()
        meta = {'dataType': 'laszip', 'hierarchyType': 'json', 'srs': {'wkt': cloud.header.parse_crs().to_wkt()},
                'bounds': list(cloud.header.mins) + list(cloud.header.maxs), 'span': 128}
        def node_bytes(value):
            stream = io.BytesIO()
            value.write(stream, do_compress=True)
            return stream.getvalue()
        data = node_bytes(cloud)
        with patch.object(fetch, 'json', return_value=meta), patch.object(ept, 'collect_nodes', return_value=['0-0-0-0']), \
             patch.object(fetch, 'get', side_effect=lambda *a, **k: data):
            first, _ = ept.read_ept(fetch, url, self.fixture.bbox)
            with patch.object(laspy.LasReader, 'read', side_effect=AssertionError('decoded twice')):
                second, _ = ept.read_ept(fetch, url, self.fixture.bbox)
            np.testing.assert_array_equal(first, second)
            with self.assertRaises(ept.BudgetExceeded):
                ept.read_ept(fetch, url, self.fixture.bbox, max_points=1)
            cloud.z = np.asarray(cloud.z) + 5
            data = node_bytes(cloud)
            changed, _ = ept.read_ept(fetch, url, self.fixture.bbox)
            self.assertFalse(np.array_equal(first[:, 2], changed[:, 2]))


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class EptPrefetchTests(unittest.TestCase):
    def test_concurrent_get_coalesces_refresh_and_counts_each_response_once(self):
        with tempfile.TemporaryDirectory() as temp:
            fetch = ept.Fetcher(Path(temp), refresh=True)
            self.addCleanup(fetch.decoded_cache.close)
            with patch('urllib.request.urlopen', side_effect=lambda *a, **k: io.BytesIO(b'node')) as opened:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(lambda _: fetch.get('https://example.com/a'), range(8)))
            self.assertEqual(results, [b'node'] * 8)
            self.assertEqual(opened.call_count, 1)
            self.assertEqual((fetch.requests, fetch.bytes), (1, 4))

    def test_overlap_order_window_limit_and_no_repeat_network(self):
        started, gate = threading.Event(), threading.Event()
        lock = threading.Lock()
        active = peak = 0
        urls = [f'https://example.com/{i}' for i in range(9)]
        class Response(io.BytesIO):
            def __enter__(self):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                    if active == 3:
                        started.set()
                if not gate.wait(5):
                    raise AssertionError('EPT downloads did not overlap')
                return self
            def __exit__(self, *args):
                nonlocal active
                with lock:
                    active -= 1
                return super().__exit__(*args)
        with tempfile.TemporaryDirectory() as temp:
            fetch = ept.Fetcher(Path(temp), refresh=True)
            fetch.download_workers = 3
            self.addCleanup(fetch.decoded_cache.close)
            with patch('urllib.request.urlopen', side_effect=lambda url, **k: Response(url.encode())) as opened:
                with ept_node_data(fetch, urls) as values:
                    try:
                        self.assertTrue(started.wait(5))
                        self.assertEqual(opened.call_count, 3)
                    finally:
                        gate.set()
                    actual = list(values)
                self.assertEqual(actual, [(url, url.encode()) for url in urls])
                self.assertEqual(peak, 3)
                self.assertEqual(opened.call_count, len(urls))
                with ept_node_data(fetch, urls) as values:
                    self.assertEqual(list(values), actual)
                self.assertEqual(opened.call_count, len(urls))
            self.assertEqual(fetch.requests, len(urls))
            self.assertEqual(fetch.bytes, sum(len(url) for url in urls))

    def test_early_exit_stays_in_window_and_explicit_budget_keeps_serial_admission(self):
        urls = [f'https://example.com/{i}' for i in range(12)]
        for budget in (None, 5):
            with self.subTest(budget=budget), tempfile.TemporaryDirectory() as temp:
                fetch = ept.Fetcher(Path(temp), max_bytes=budget)
                fetch.download_workers = 2
                self.addCleanup(fetch.decoded_cache.close)
                with patch('urllib.request.urlopen', side_effect=lambda *a, **k: io.BytesIO(b'node')) as opened:
                    with ept_node_data(fetch, urls) as values:
                        self.assertEqual(next(values), (urls[0], b'node'))
                    self.assertLessEqual(opened.call_count, 2 if budget is None else 1)
                    self.assertLessEqual(fetch.bytes, 8 if budget is None else 5)
                self.assertFalse(list(Path(temp).glob('*.partial')))

    def test_failed_prefetch_is_reported_at_original_position(self):
        with tempfile.TemporaryDirectory() as temp:
            fetch = ept.Fetcher(Path(temp))
            fetch.download_workers = 2
            self.addCleanup(fetch.decoded_cache.close)
            def get(url):
                if url.endswith('/bad'):
                    raise ValueError('oversized node response')
                return b'node'
            with patch.object(fetch, 'get', side_effect=get):
                with ept_node_data(fetch, ['https://example.com/good', 'https://example.com/bad']) as values:
                    self.assertEqual(next(values)[1], b'node')
                    with self.assertRaisesRegex(ValueError, 'oversized'):
                        next(values)


if __name__ == '__main__':
    unittest.main()
