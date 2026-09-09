"""Worker protocol failures, cancellation ownership, and atomic progress files."""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvizar_city_model.data import generation_job as module


class GenerationJobTests(unittest.TestCase):
    def job(self):
        process = Mock()
        process.poll.return_value = None
        with patch.object(module.subprocess, "Popen", return_value=process):
            job = module.GenerationJob("blender", {"cache_directory": "cache"})
        def cleanup():
            process.poll.return_value = 0
            job.cleanup()
        self.addCleanup(cleanup)
        return job, process

    def test_cancel_is_nonblocking_and_retains_temporary_until_exit(self):
        job, process = self.job()
        job.cancel()
        process.terminate.assert_called_once()
        process.wait.assert_not_called()
        with self.assertRaises(RuntimeError):
            job.cleanup()
        self.assertTrue(job.directory.exists())
        process.poll.return_value = -1
        with self.assertRaises(ValueError):
            job.result()
        job.cleanup()
        job.cleanup()
        self.assertFalse(job.directory.exists())

    def test_failed_stop_can_retry_without_releasing_ownership(self):
        job, process = self.job()
        process.terminate.side_effect = [OSError("busy"), None]
        with self.assertRaises(OSError):
            job.cancel()
        self.assertTrue(job.directory.exists())
        job.cancel()
        self.assertEqual(process.terminate.call_count, 2)

    def test_application_exit_stops_and_reaps_its_worker(self):
        job, process = self.job()
        process.wait.side_effect = lambda **kwargs: setattr(process.poll, "return_value", 0)
        job._shutdown()
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=2)
        self.assertFalse(job.directory.exists())

    def test_unresponsive_worker_is_killed_on_a_later_tick_without_waiting(self):
        job, process = self.job()
        with patch.object(module.time, "monotonic", side_effect=[10.0, 11.0]):
            job.cancel()
            job.cancel()
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        process.wait.assert_not_called()
        with self.assertRaises(RuntimeError):
            job.cleanup()

    def test_missing_corrupt_failed_and_cancelled_results_never_publish(self):
        job, process = self.job()
        with self.assertRaises(RuntimeError):
            job.result()
        process.poll.return_value = 1
        with self.assertRaises(ValueError):
            job.result()
        for payload in ([], {"protocol": 999}, {"protocol": 1, "ok": False, "error": "failed"},
                        {"protocol": 1, "ok": True}):
            job.result_path.write_text(json.dumps(payload))
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                job.result()
        process.poll.return_value = 0
        job.model_path.touch()
        payload = {"protocol": 1, "ok": True, "root": "CITY_MODEL", "message": "done", "lidar_status": "disabled"}
        job.result_path.write_text(json.dumps(payload))
        self.assertEqual(job.result(), payload)
        job.cancel()
        with self.assertRaises(ValueError):
            job.result()

    def test_progress_ignores_partial_or_invalid_observations(self):
        job, process = self.job()
        for content in ("{", "null", '{"phase": "terrain", "fraction": "nan"}',
                        '{"phase": {}, "fraction": 0.5}'):
            job.progress_path.write_text(content)
            self.assertIsNone(job.progress())
        module.write_json(job.progress_path, {"phase": "terrain", "fraction": .5})
        self.assertEqual(job.progress(), ("terrain", .5))

    @unittest.skipUnless(os.name == "nt", "Windows file sharing contract")
    def test_atomic_publication_retries_windows_reader_conflict(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "progress.json"
            module.write_json(path, {"old": True})
            original = Path.replace
            attempts = 0
            def busy_once(source, target):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    self.assertEqual(json.loads(path.read_text()), {"old": True})
                    raise PermissionError("reader holds destination")
                return original(source, target)
            with patch.object(Path, "replace", busy_once):
                module.write_json(path, {"new": True})
            self.assertEqual(attempts, 2)
            self.assertEqual(json.loads(path.read_text()), {"new": True})
            self.assertFalse(path.with_suffix(".tmp").exists())
