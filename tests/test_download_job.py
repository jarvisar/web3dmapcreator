"""Non-blocking downloads: progress, failure advice, cancellation and commits."""

import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jarvizar_city_model.data import download_job
from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.data.download_job import (
    OFFLINE_MESSAGE,
    DownloadJob,
    cached_message,
    cancelled_message,
    classify_failure,
    failure_text,
    parse_progress,
    rotate_logs,
    using_cache_message,
)
from jarvizar_city_model.data.dem import ElevationGrid
from jarvizar_city_model.data.overture import (
    OvertureDownloadError,
    download_dem_to_cache,
    download_to_cache,
)

FIXTURE = ROOT / "tests" / "download_helper_fixture.py"
BOUNDS = Bounds(-84.5337, 39.08554, -84.47422, 39.11094)


def alive(pid):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            kernel.GetExitCodeProcess(handle, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class ProgressTests(unittest.TestCase):
    def test_only_prefixed_lines_are_progress(self):
        self.assertIsNone(parse_progress("WARNING: pyarrow noise"))
        self.assertIsNone(parse_progress("progress:   "))
        self.assertEqual(parse_progress("progress: Finding the latest Overture release"),
                         ("Finding the latest Overture release", None))

    def test_counter_is_the_item_in_progress(self):
        text, fraction = parse_progress("progress: Downloading land_use (3/4): 1,200 features")
        self.assertEqual(text, "Downloading land_use (3/4): 1,200 features")
        self.assertAlmostEqual(fraction, 0.5)
        self.assertEqual(parse_progress("progress: Downloading elevation tiles (1/16)")[1], 0.0)
        self.assertIsNone(parse_progress("progress: odd (5/4)")[1])
        self.assertIsNone(parse_progress("progress: odd (0/4)")[1])


class ClassificationTests(unittest.TestCase):
    def kind(self, text, **options):
        return classify_failure(text, **options)[0]

    def test_offline_message_names_the_preference(self):
        self.assertIn("Allow Online Access", OFFLINE_MESSAGE)
        self.assertIn("Preferences > System > Network", OFFLINE_MESSAGE)

    def test_missing_packages_name_the_module_and_the_setup(self):
        kind, message = classify_failure(
            "Could not import the official overturemaps client\nNo module named 'overturemaps'")
        self.assertEqual(kind, "packages")
        self.assertEqual(message, "The downloader Python is missing overturemaps; "
                                  "run the downloader setup again")
        kind, message = classify_failure("ModuleNotFoundError: No module named 'pyarrow.dataset'")
        self.assertIn("missing pyarrow;", message)
        self.assertEqual(self.kind("ImportError: DLL load failed while importing lib"), "packages")

    def test_network_failures_name_the_server(self):
        for text in ("<urlopen error [Errno 11001] getaddrinfo failed>",
                     "AWS Error NETWORK_CONNECTION during HeadObject operation: curlCode: 6, "
                     "Couldn't resolve host name",
                     "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed",
                     "HTTP Error 407: Proxy Authentication Required",
                     "The read operation timed out",
                     "[WinError 10061] No connection could be made",
                     "Temporary failure in name resolution"):
            with self.subTest(text=text):
                self.assertEqual(self.kind(text), "network")
        self.assertIn("Overture servers", classify_failure("getaddrinfo failed")[1])
        message = classify_failure("Elevation tile 12/1/2 failed: <urlopen error timed out>",
                                   stage="dem")[1]
        self.assertIn("elevation tile server", message)
        self.assertIn("VPN, firewall or proxy", message)

    def test_disk_permission_memory_and_server(self):
        self.assertEqual(self.kind("[Errno 28] No space left on device"), "disk_full")
        self.assertEqual(self.kind("[WinError 112] There is not enough space on the disk"), "disk_full")
        self.assertEqual(self.kind("PermissionError: [WinError 5] Access is denied: 'C:\\x'"),
                         "permission")
        self.assertEqual(self.kind("MemoryError"), "memory")
        self.assertEqual(self.kind("Elevation tile 9/1/1 failed: HTTP 503", stage="dem"), "server")
        self.assertIn("Cache Directory", classify_failure("No space left on device")[1])

    def test_timeout_killed_python_and_unknown(self):
        kind, message = classify_failure("", timed_out=True, timeout_s=1800)
        self.assertEqual(kind, "timeout")
        self.assertIn("30 minutes", message)
        self.assertIn("1 minute;", classify_failure("", stage="dem", timed_out=True, timeout_s=5)[1])
        kind, message = classify_failure("", returncode=3, result=False)
        self.assertEqual(kind, "killed")
        self.assertIn("exit code 3", message)
        self.assertIn("0xC0000005", classify_failure("", returncode=0xC0000005, result=False)[1])
        self.assertIn("memory", classify_failure("", returncode=-9, result=False)[1])
        self.assertEqual(self.kind("SyntaxError: future feature annotations is not defined",
                                   returncode=1, result=False), "python")
        # A reported error the helper explained is not a crash.
        self.assertEqual(classify_failure("STAC index lists no building files", returncode=1),
                         ("unknown", ""))

    def test_failure_text_keeps_a_short_raw_detail(self):
        self.assertEqual(failure_text("unknown", "", "index missing", "overture"), "index missing")
        self.assertEqual(failure_text("unknown", "", "tile failed", "dem"),
                         "Elevation download failed: tile failed")
        text = failure_text("network", "Could not reach the Overture servers", "x" * 400, "overture")
        self.assertTrue(text.startswith("Could not reach the Overture servers (xxx"))
        self.assertLess(len(text), 220)
        self.assertEqual(failure_text("timeout", "Timed out", "", "overture"), "Timed out")


class HelperOutputTests(unittest.TestCase):
    """The real helpers keep one JSON line on stdout and report progress on stderr."""

    def run_main(self, main, argv):
        import contextlib
        import io
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(argv)
        lines = stdout.getvalue().splitlines()
        self.assertEqual(len(lines), 1, stdout.getvalue())
        progress = [parse_progress(line) for line in stderr.getvalue().splitlines()]
        return code, json.loads(lines[0]), [item for item in progress if item is not None]

    def test_elevation_helper_reports_tiles(self):
        from jarvizar_city_model.external import download_dem
        from test_dem import encode_png_rgb
        tile = encode_png_rgb(256, 256, bytes([128, 0, 0]) * (256 * 256))
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(download_dem, "_fetch_tile", return_value=tile):
            code, result, progress = self.run_main(download_dem.main, [
                "--bbox", "-84.52", "39.09", "-84.50", "39.10", "--output-dir", folder,
                "--columns", "8", "--zoom", "10"])
        self.assertEqual((code, result["ok"]), (0, True))
        texts = [text for text, _fraction in progress]
        total = result["tiles_used"]
        self.assertEqual(texts[:total], [f"Downloading elevation tiles ({index}/{total})"
                                         for index in range(1, total + 1)])
        self.assertEqual(texts[-2:], ["Resampling the elevation grid", "Writing the elevation grid"])

    def test_overture_helper_reports_types_and_counts(self):
        try:
            import overturemaps.core  # noqa: F401
        except ImportError:
            self.skipTest("overturemaps is not installed")
        from jarvizar_city_model.external import download_overture

        def fake_download(feature_type, bbox, release, output, report=None):
            output.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
            report(1500)
            return 1500, ["id"]

        with tempfile.TemporaryDirectory() as folder, \
                patch("overturemaps.core.get_latest_release", return_value="2026-01-01.0"), \
                patch.object(download_overture, "_download_one", fake_download), \
                patch.object(download_overture, "PROGRESS_INTERVAL_S", 0.0):
            code, result, progress = self.run_main(download_overture.main, [
                "--bbox", "-84.52", "39.09", "-84.50", "39.10", "--output-dir", folder,
                "--types", "building", "water"])
        self.assertEqual((code, result["ok"], result["counts"]), (0, True, {"building": 1500, "water": 1500}))
        self.assertEqual([text for text, _fraction in progress], [
            "Finding the latest Overture release", "Overture release 2026-01-01.0",
            "Downloading building (1/2)", "Downloading building (1/2): 1,500 features",
            "Downloading water (2/2)", "Downloading water (2/2): 1,500 features"])
        self.assertEqual([fraction for _text, fraction in progress][2:], [0.0, 0.0, 0.5, 0.5])


class MessageTests(unittest.TestCase):
    def test_status_formats_are_unchanged(self):
        manifest = {"release": "2026-09-23.0", "feature_counts": {"building": 12, "water": 3},
                    "dem": {"columns": 384, "rows": 200, "min_m": 140.2, "max_m": 260.7}}
        self.assertEqual(using_cache_message(manifest, ("building", "segment")),
                         "Using cache: 12 building, ? segment")
        self.assertEqual(cached_message(manifest, ("building", "water"), True),
                         "Cached release 2026-09-23.0: 12 building, 3 water, DEM 384x200 (140-261 m)")
        self.assertEqual(cached_message({}, ("building",), False),
                         "Cached release unknown: 0 building")
        self.assertEqual(cancelled_message([]), "Download cancelled; cache unchanged")
        self.assertEqual(cancelled_message(["Overture data"]),
                         "Download cancelled; Overture data cached")


class JobTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp(prefix="jcm_download_test_"))
        self.addCleanup(self._remove_work)
        self.control = self.work / "control"
        self.control.mkdir()
        self.bundle = CacheBundle(self.work / "cache", BOUNDS)
        helper = patch.object(download_job, "_external_script", lambda name: FIXTURE)
        helper.start()
        self.addCleanup(helper.stop)
        self.jobs = []
        self.addCleanup(self._stop_jobs)

    def _stop_jobs(self):
        for job in self.jobs:
            if not job.done:
                job.abort(10)

    def _remove_work(self):
        import shutil
        shutil.rmtree(self.work, ignore_errors=True)

    def scenario(self, **modes):
        path = self.work / "scenario.json"
        path.write_text(json.dumps({**modes, "control": str(self.control)}), encoding="utf-8")
        environment = patch.dict(os.environ, {"JCM_FAKE_DOWNLOAD": str(path)})
        environment.start()
        self.addCleanup(environment.stop)

    def job(self, types=("building", "building_part"), dem=None, **options):
        job = DownloadJob(sys.executable, self.bundle, types, dem_columns=dem, **options)
        self.jobs.append(job)
        return job

    def drive(self, job, limit=60.0):
        deadline = time.monotonic() + limit
        while job.poll():
            self.assertLess(time.monotonic(), deadline, job.status())
            time.sleep(0.02)

    def temporary_folders(self):
        return sorted(self.bundle.cache_root.glob("jarvizar_download_*"))

    def cached_state(self):
        if not self.bundle.path.exists():
            return {}
        return {path.name: path.read_bytes() for path in sorted(self.bundle.path.iterdir())}

    def log_text(self, job):
        self.assertIsNotNone(job.log_path)
        return job.log_path.read_text(encoding="utf-8")

    def wait_for(self, path, limit=30.0):
        deadline = time.monotonic() + limit
        while not path.exists():
            self.assertLess(time.monotonic(), deadline, f"{path} was never written")
            time.sleep(0.02)

    def test_success_commits_both_stages_and_logs_the_run(self):
        self.scenario(overture="success", dem="success")
        job = self.job(dem=32)
        self.drive(job)
        self.assertEqual(job.state, "succeeded", job.error)
        self.assertEqual(job.completed, ["Overture data", "Elevation"])
        for name in ("building", "building_part"):
            self.assertTrue(self.bundle.data_path(name).is_file())
        self.assertTrue(self.bundle.has_dem())
        self.assertEqual(ElevationGrid.load(self.bundle.path).columns, 4)
        manifest = self.bundle.read_manifest()
        self.assertEqual(job.manifest, manifest)
        self.assertEqual(manifest["release"], "2026-01-01.0")
        self.assertEqual(manifest["feature_counts"], {"building": 1, "building_part": 1})
        self.assertEqual(manifest["dem"]["columns"], 4)
        self.assertEqual(manifest["feature_types"], ["building", "building_part"])
        self.assertEqual(self.temporary_folders(), [])
        self.assertEqual(job.status()["fraction"], 1.0)
        log = self.log_text(job)
        self.assertEqual(job.log_path.parent, self.bundle.cache_root / "logs")
        self.assertRegex(job.log_path.name, r"^download-\d{8}T\d{6}Z(-\d+)?\.log$")
        for expected in ("== Overture data ==", "== Elevation ==", "download_helper_fixture.py",
                         "--types building building_part", "Exit code 0", "-- stderr --",
                         "progress: Downloading building (1/2)", "Result: succeeded"):
            self.assertIn(expected, log)

    def test_synchronous_wrappers_keep_their_results(self):
        self.scenario(overture="success", dem="success")
        manifest = download_to_cache(sys.executable, self.bundle, ("water",))
        self.assertEqual(manifest["feature_counts"], {"water": 1})
        self.assertEqual(manifest["source"], "Overture Maps")
        self.assertEqual(manifest["client_version"], "0.0-test")
        manifest = download_dem_to_cache(sys.executable, self.bundle, columns=64)
        self.assertEqual(manifest["dem"]["source"], "test tiles")
        self.assertIn("dem_downloaded_at_utc", manifest)
        self.assertEqual(manifest["feature_counts"], {"water": 1})
        self.assertEqual(self.temporary_folders(), [])

    def test_progress_is_parsed_while_the_helper_runs(self):
        self.scenario(overture="gate")
        job = self.job(dem=16)
        deadline = time.monotonic() + 30
        while True:
            self.assertTrue(job.poll())
            status = job.status()
            if status["message"].startswith("Downloading building_part"):
                break
            self.assertLess(time.monotonic(), deadline, status)
            time.sleep(0.02)
        self.assertEqual(status["message"], "Downloading building_part (2/2): 1,234 features")
        self.assertEqual((status["stage"], status["stage_index"], status["stage_count"]),
                         ("Overture data", 1, 2))
        self.assertAlmostEqual(status["fraction"], 0.25)
        self.assertGreater(status["elapsed"], 0.0)
        (self.control / "release").write_text("go", encoding="utf-8")
        self.drive(job)
        self.assertEqual(job.state, "succeeded", job.error)

    def test_a_failure_leaves_the_existing_cache_alone(self):
        self.bundle.ensure_directory()
        self.bundle.data_path("building").write_text("old buildings", encoding="utf-8")
        self.bundle.write_manifest({"release": "old", "feature_counts": {"building": 7}})
        before = self.cached_state()
        for mode, kind, words in (("network", "network", "Could not reach the Overture servers"),
                                  ("no_module", "packages", "missing overturemaps"),
                                  ("disk_full", "disk_full", "Not enough disk space"),
                                  ("crash", "killed", "injected helper crash"),
                                  ("missing_output", "unknown", "did not create building.geojson")):
            with self.subTest(mode=mode):
                self.scenario(overture=mode)
                job = self.job()
                self.drive(job)
                self.assertEqual(job.state, "failed")
                self.assertEqual(job.kind, kind)
                self.assertIn(words, job.error)
                self.assertEqual(self.cached_state(), before)
                self.assertEqual(self.temporary_folders(), [])
                self.assertIn(f"Result: failed ({kind})", self.log_text(job))
                with self.assertRaises(OvertureDownloadError) as caught:
                    download_to_cache(sys.executable, self.bundle, ("building",))
                self.assertIn(words, str(caught.exception))

    def test_a_later_failure_keeps_the_committed_stage(self):
        self.scenario(overture="success", dem="crash")
        job = self.job(("water",), dem=16)
        self.drive(job)
        self.assertEqual(job.state, "failed")
        self.assertEqual(job.completed, ["Overture data"])
        self.assertTrue(self.bundle.data_path("water").is_file())
        self.assertFalse(self.bundle.has_dem())
        self.assertIn("stopped unexpectedly (exit code 3)", job.error)

    def assert_helpers_stopped(self, job, stage):
        pids = json.loads((self.control / f"{stage}-pids.json").read_text(encoding="utf-8"))
        grandchild = int((self.control / f"{stage}-grandchild.pid").read_text(encoding="utf-8"))
        deadline = time.monotonic() + 10
        remaining = None
        while time.monotonic() < deadline:
            remaining = [pid for pid in (pids["helper"], pids["launcher"], grandchild) if alive(pid)]
            if not remaining:
                break
            time.sleep(0.05)
        self.assertEqual(remaining, [], "helper process tree is still running")
        self.assertIsNotNone(job._steps[job._index].process.poll())

    def test_cancel_stops_the_whole_process_tree(self):
        self.bundle.ensure_directory()
        self.bundle.data_path("building").write_text("old buildings", encoding="utf-8")
        before = self.cached_state()
        self.scenario(overture="hang")
        job = self.job(dem=16)
        job.start()
        self.wait_for(self.control / "overture-pids.json")
        self.assertTrue(job.poll())
        self.assertEqual(job.status()["message"], "Downloading building (1/2)")
        started = time.monotonic()
        job.cancel()
        self.assertLess(time.monotonic() - started, 5.0)
        self.assertEqual(job.status()["message"], "Stopping the downloader")
        self.drive(job, 20)
        self.assertEqual(job.state, "cancelled")
        self.assert_helpers_stopped(job, "overture")
        self.assertEqual(self.temporary_folders(), [])
        self.assertEqual(self.cached_state(), before)
        self.assertEqual(job.completed, [])
        self.assertIn("Result: cancelled", self.log_text(job))
        with self.assertRaises(OvertureDownloadError) as caught:
            job.run()
        self.assertIn("cache unchanged", str(caught.exception))

    def test_timeout_stops_the_helper_and_reports_it(self):
        self.scenario(overture="success", dem="hang")
        # Long enough for a loaded machine to start the helper tree first.
        job = self.job(("water",), dem=16, dem_timeout=6.0)
        job.start()
        self.drive(job, 40)
        self.assertEqual(job.state, "failed")
        self.assertEqual(job.kind, "timeout")
        self.assertIn("The elevation download timed out after 1 minute;", job.error)
        self.assert_helpers_stopped(job, "dem")
        self.assertEqual(self.temporary_folders(), [])
        self.assertEqual(job.completed, ["Overture data"])
        self.assertFalse(self.bundle.has_dem())

    def test_a_python_that_cannot_start_is_reported(self):
        not_python = self.work / "python.txt"
        not_python.write_text("not an interpreter", encoding="utf-8")
        job = DownloadJob(not_python, self.bundle, ("building",))
        self.jobs.append(job)
        self.drive(job)
        self.assertEqual(job.state, "failed")
        self.assertEqual(job.kind, "launch")
        self.assertIn("Cannot start the Overture Python", job.error)
        self.assertEqual(self.temporary_folders(), [])

    def test_cancel_before_start_runs_nothing(self):
        job = self.job()
        job.cancel()
        self.assertEqual(job.state, "cancelled")
        self.assertFalse(job.poll())
        self.assertEqual(self.temporary_folders(), [])

    def test_folders_left_by_a_killed_blender_are_removed(self):
        root = self.bundle.cache_root
        stale, recent = root / "jarvizar_download_stale", root / "jarvizar_download_recent"
        for folder in (stale / "overture", recent / "overture"):
            folder.mkdir(parents=True)
            (folder / "building.geojson").write_text("partial", encoding="utf-8")
        old = time.time() - 2 * 24 * 3600
        os.utime(stale, (old, old))
        self.bundle.ensure_directory()
        self.bundle.data_path("water").write_text("cached", encoding="utf-8")
        self.scenario(overture="success")
        job = self.job(("building",))
        self.drive(job)
        self.assertEqual(job.state, "succeeded", job.error)
        self.assertFalse(stale.exists())
        self.assertTrue((recent / "overture" / "building.geojson").is_file())
        self.assertEqual(self.bundle.data_path("water").read_text(encoding="utf-8"), "cached")
        self.assertEqual(self.temporary_folders(), [recent])

    def test_logs_keep_only_the_newest(self):
        logs = self.bundle.cache_root / "logs"
        logs.mkdir(parents=True)
        old = time.time() - 3600
        for index in range(25):
            path = logs / f"download-20200101T0000{index:02d}Z.log"
            path.write_text("old", encoding="utf-8")
            os.utime(path, (old + index, old + index))
        (logs / "support-notes.txt").write_text("keep", encoding="utf-8")
        self.scenario(overture="success")
        job = self.job(("water",))
        self.drive(job)
        remaining = sorted(path.name for path in logs.glob("download-*.log"))
        self.assertEqual(len(remaining), 20)
        self.assertIn(job.log_path.name, remaining)
        self.assertNotIn("download-20200101T000000Z.log", remaining)
        self.assertIn("download-20200101T000024Z.log", remaining)
        self.assertTrue((logs / "support-notes.txt").is_file())
        rotate_logs(logs, keep=2)
        self.assertEqual(len(list(logs.glob("download-*.log"))), 2)
        self.assertIn(job.log_path.name, [path.name for path in logs.glob("download-*.log")])


if __name__ == "__main__":
    unittest.main()
