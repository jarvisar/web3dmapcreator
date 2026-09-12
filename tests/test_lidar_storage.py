"""Storage limits must never evict prepared work or active download inputs."""
from pathlib import Path
from types import SimpleNamespace
import hashlib
import io
import os
import tempfile
import time
import unittest
from unittest.mock import patch

from jarvizar_city_model.external.lidar_storage import CacheStorage, StorageFull, inventory, GIB
from jarvizar_city_model.external.lidar_worker import cache_owner


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def file(self, name, size=100, age=0):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'x' * size)
        os.utime(path, (time.time()-age, time.time()-age))
        return path

    def point(self, key, **kwargs):
        return self.file('lidar_derived/' + 'a'*64 + '/points/' + key*64 + '.npy', **kwargs)

    def storage(self, size=100, reserve=0):
        return CacheStorage(self.root, size/GIB, reserve/GIB)

    def test_trim_preserves_bundles_generations_unknown_files_and_prefers_points(self):
        point = self.point('b')
        sidecar = self.file(str(point.relative_to(self.root).with_suffix('.json')), size=2)
        tile = self.file('lidar_tiles/' + 'c'*64, age=100)
        protected = [self.file('bbox_example/lidar_buildings.json'),
                     self.file('bbox_example/lidar_jobs/baseline.json'),
                     self.file('bbox_example/building.geojson'),
                     self.file('lidar_derived/' + 'a'*64 + '/generation.json'),
                     self.file('lidar_tiles/my-own-data.laz')]
        storage = self.storage()
        self.assertEqual(storage.plan()['reclaim'], 102)
        self.assertTrue(point.exists())  # preview is read-only
        storage.trim()
        self.assertFalse(point.exists())
        self.assertFalse(sidecar.exists())
        self.assertTrue(tile.exists())
        self.assertTrue(all(p.exists() for p in protected))

    def test_oldest_points_first_and_explicit_touch_preserves_ttl(self):
        old = self.point('b', age=100)
        recent = self.point('c', age=50)
        before = old.stat().st_mtime
        storage = self.storage()
        storage.touch(old)
        storage.trim()
        self.assertTrue(old.exists())
        self.assertEqual(old.stat().st_mtime, before)
        self.assertFalse(recent.exists())

    def test_keep_marker_and_active_data_fail_without_deleting_other_data(self):
        point = self.point('b')
        self.file(str(point.parent.relative_to(self.root) / '.keep'), size=0)
        other = self.file('lidar_tiles/' + 'c'*64)
        storage = self.storage(size=50)
        with self.assertRaises(StorageFull):
            storage.trim()
        self.assertTrue(point.exists())
        self.assertTrue(other.exists())

    def test_partial_cleanup_requires_age_and_does_not_remove_resumable_recent_data(self):
        old = self.file('lidar_tiles/'+'a'*64+'.partial', age=8*86400)
        meta = self.file('lidar_tiles/'+'a'*64+'.partial.json', age=8*86400)
        recent = self.file('lidar_tiles/'+'b'*64+'.partial')
        storage = self.storage(size=1000)
        storage.trim()
        self.assertFalse(old.exists())
        self.assertFalse(meta.exists())
        self.assertTrue(recent.exists())

    def test_active_old_partial_is_pinned(self):
        partial = self.file('lidar_tiles/'+'a'*64+'.partial', age=8*86400)
        storage = self.storage(size=1000)
        storage.touch(partial.with_suffix(''))
        storage.trim()
        self.assertTrue(partial.exists())

    def test_concurrent_reservations_prevent_overcommit(self):
        storage = self.storage(size=12*1024**2)
        a = self.root/'lidar_tiles'/('a'*64)
        b = a.with_name('b'*64)
        with storage.writing(a) as first, storage.writing(b) as second:
            first(1)
            with self.assertRaises(StorageFull):
                second(1)
        self.assertFalse(storage.reservations)

    def test_free_space_reserve_stops_before_replacing_published_data(self):
        result = self.file('bbox_example/lidar_buildings.json')
        storage = self.storage(size=GIB, reserve=10)
        with patch('jarvizar_city_model.external.lidar_storage.shutil.disk_usage', return_value=SimpleNamespace(free=5)):
            with self.assertRaises(StorageFull):
                storage.write_bytes(result, b'new', managed=False)
        self.assertEqual(result.read_bytes(), b'x'*100)
        self.assertFalse(result.with_suffix('.partial').exists())

    def test_completed_batch_can_make_room_for_next_batch(self):
        old = self.point('b')
        storage = self.storage(size=100)
        storage.touch(old)
        with self.assertRaises(StorageFull):
            storage.trim(extra=50)
        storage.release_inputs()
        storage.trim(extra=50)
        self.assertFalse(old.exists())

    def test_optional_points_skip_cache_when_space_is_unavailable(self):
        import numpy as np
        from jarvizar_city_model.external.lidar_point_cache import PointBatchCache
        storage = self.storage(size=1)
        points = np.ones((3, 7))
        cache = PointBatchCache(self.root, {'url':'https://example.com/a'},
                               {'source':'a'*64, 'generation':'initial'}, [0,0,1,1], 1, storage=storage)
        self.assertFalse(cache.save(points, {'url':'https://example.com/a'}))
        self.assertFalse(cache.path.exists())
        self.assertFalse(cache.path.with_suffix('.partial').exists())
        np.testing.assert_array_equal(points, np.ones((3, 7)))

    def test_provider_cannot_swallow_storage_failure_as_missing_survey(self):
        from jarvizar_city_model.external import lidar_acquisition as acquisition
        with patch.dict(acquisition.PROVIDERS, {'usgs': lambda *args: (_ for _ in ()).throw(StorageFull('full'))}):
            with self.assertRaises(StorageFull):
                acquisition.discover_sources(None, [0,0,1,1], discovery={'providers':['usgs']})

    def test_failed_unlink_still_counts_storage(self):
        self.point('b')
        storage = self.storage(size=50)
        with patch.object(Path, 'unlink', side_effect=PermissionError('busy')):
            with self.assertRaises(StorageFull):
                storage.trim()
        self.assertEqual(storage.plan()['used'], 100)

    def test_cleanup_shares_worker_exclusion(self):
        with cache_owner(self.root):
            with self.assertRaises(ValueError):
                with cache_owner(self.root):
                    self.fail('overlapping owner')

    def test_directory_links_are_never_followed(self):
        outside = self.root/'outside'
        outside.mkdir()
        target = outside/('a'*64)
        target.write_bytes(b'keep')
        try:
            (self.root/'lidar_tiles').symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('directory symlink permission unavailable')
        self.storage(size=1).trim()
        self.assertTrue(target.exists())

    def test_source_download_is_accounted_and_cached_reads_pin_it(self):
        from jarvizar_city_model.external.lidar_ept import Fetcher
        fetch = Fetcher(self.root/'lidar_tiles')
        self.addCleanup(fetch.decoded_cache.close)
        fetch.storage = self.storage(size=32*1024**2)
        with patch('urllib.request.urlopen', return_value=io.BytesIO(b'data')):
            self.assertEqual(fetch.get('https://example.com/a'), b'data')
        self.assertEqual(sum(e['bytes'] for e in inventory(self.root)), 4)
        path = fetch.cache/hashlib.sha256(b'https://example.com/a').hexdigest()
        self.assertIn(path, fetch.storage.pins)
        with patch('urllib.request.urlopen', side_effect=AssertionError('redownloaded')):
            self.assertEqual(fetch.get('https://example.com/a'), b'data')

    def test_streaming_space_failure_preserves_valid_resume(self):
        from jarvizar_city_model.external.lidar_transfer import stream_tile
        class Response(io.BytesIO):
            headers = {'Content-Length': '100000', 'ETag': '"stable"'}
            status = 200
        partial = self.root/'tile.partial'
        def ensure(size):
            if size > 65536:
                raise StorageFull('full')
        with patch('urllib.request.urlopen', return_value=Response(b'x'*100000)):
            with self.assertRaises(StorageFull):
                stream_tile('https://example.com/tile', partial, 200000, lambda _: None, ensure_space=ensure)
        self.assertEqual(partial.stat().st_size, 65536)
        self.assertTrue(partial.with_suffix('.partial.json').exists())


if __name__ == '__main__':
    unittest.main()
