import io
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import CancelledError
from unittest.mock import patch

from jarvizar_city_model.external.lidar_transfer import stream_tile


class Response(io.BytesIO):
    def __init__(self, body, status=200, **headers):
        super().__init__(body)
        self.status = status
        self.headers = {'Content-Length': str(len(body)), **headers}


class TransferTests(unittest.TestCase):
    def seed_partial(self, path):
        class Interrupted(Response):
            def read(self, size):
                if self.tell():
                    raise OSError('connection lost')
                return super().read(4)
        with patch('urllib.request.urlopen', side_effect=[Interrupted(b'roofdata', ETag='"v1"'),
                   OSError('offline'), OSError('offline')]), patch('time.sleep'):
            with self.assertRaises(OSError):
                stream_tile('https://example.com/a', path, 100, lambda _: None)

    def test_resume_after_interrupted_job_uses_validated_range(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'tile.partial'
            self.seed_partial(path)
            self.assertEqual(path.read_bytes(), b'roof')
            response = Response(b'data', 206, ETag='"v1"', **{'Content-Range': 'bytes 4-7/8'})
            with patch('urllib.request.urlopen', return_value=response) as opened:
                self.assertEqual(stream_tile('https://example.com/a', path, 100, lambda _: None), 8)
                self.assertEqual(opened.call_args.args[0].get_header('Range'), 'bytes=4-')
                self.assertEqual(opened.call_args.args[0].get_header('If-range'), '"v1"')
            self.assertEqual(path.read_bytes(), b'roofdata')

    def test_changed_resource_or_ignored_range_restarts_without_mixing_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'tile.partial'
            self.seed_partial(path)
            with patch('urllib.request.urlopen', return_value=Response(b'NEW!', ETag='"v2"')):
                self.assertEqual(stream_tile('https://example.com/a', path, 100, lambda _: None), 4)
            self.assertEqual(path.read_bytes(), b'NEW!')

    def test_mismatched_range_or_etag_cannot_be_appended(self):
        for headers in ({'Content-Range': 'bytes 0-3/8', 'ETag': '"v1"'},
                        {'Content-Range': 'bytes 4-7/8', 'ETag': '"v2"'}):
            with self.subTest(headers=headers), tempfile.TemporaryDirectory() as temp:
                path = Path(temp)/'tile.partial'
                self.seed_partial(path)
                responses = [Response(b'data', 206, **headers), Response(b'NEW!', ETag='"v2"')]
                with patch('urllib.request.urlopen', side_effect=responses) as opened, patch('time.sleep'):
                    stream_tile('https://example.com/a', path, 100, lambda _: None)
                    self.assertIsInstance(opened.call_args.args[0], str)  # retry is a full GET
                self.assertEqual(path.read_bytes(), b'NEW!')

    def test_cancel_retains_strongly_validated_partial_for_next_job(self):
        cancel = threading.Event()
        class Interrupted(Response):
            def read(self, size):
                cancel.set()
                return super().read(4)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'tile.partial'
            with patch('urllib.request.urlopen', return_value=Interrupted(b'roofdata', ETag='"v1"')):
                with self.assertRaises(CancelledError):
                    stream_tile('https://example.com/a', path, 100, lambda _: None, cancel)
            self.assertEqual(path.read_bytes(), b'roof')
            self.assertTrue(path.with_suffix('.partial.json').is_file())

    def test_header_rejection_stops_before_reading_point_body(self):
        try:
            import laspy
            from jarvizar_city_model.external.lidar_laz import validate_download_prefix
        except ImportError:
            self.skipTest('optional LiDAR dependencies not installed')
        output = io.BytesIO()
        laspy.LasData(laspy.LasHeader()).write(output)
        data = output.getvalue()+b'point body'*10000
        class CountedResponse(Response):
            count = 0
            def read(self, size):
                result = super().read(size)
                self.count += len(result)
                return result
        response = CountedResponse(data, ETag='"v1"')
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'tile.partial'
            with patch('urllib.request.urlopen', return_value=response):
                with self.assertRaisesRegex(ValueError, 'horizontal CRS'):
                    stream_tile('https://example.com/a', path, len(data), lambda _: None,
                                validate_prefix=validate_download_prefix)
            self.assertLess(response.count, 1000)
            self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
