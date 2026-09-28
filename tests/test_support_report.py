"""Plain-text support report built by Copy Support Info, without Blender."""

import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data import support
from jarvizar_city_model.data.environment import ModuleStatus, ValidationResult


class ValueTests(unittest.TestCase):
    def test_changed_settings_ignore_float_storage_noise(self):
        rows = [("mm_per_metre", 0.07000000029802322, 0.07), ("road_gap_mm", 0.5, 0.4),
                ("generate_trees", True, False), ("scale_mode", "FIXED", "FIXED"),
                ("lidar_stac_urls", "", ""), ("flags", {"B", "A"}, set())]
        self.assertEqual(support.setting_changes(rows), [
            "road_gap_mm: 0.5 (default 0.4)",
            "generate_trees: on (default off)",
            "flags: A, B (default (none))",
        ])
        self.assertEqual(support.format_value(""), "(blank)")
        self.assertEqual(support.format_value((1.0, 2.5)), "1, 2.5")

    def test_long_text_is_truncated_with_a_count(self):
        self.assertEqual(support.truncate("abcdef", 10), "abcdef")
        self.assertEqual(support.truncate("abcdef", 4), "abcd ... (2 more characters)")

    def test_sizes(self):
        self.assertEqual(support.size_text(512), "512 bytes")
        self.assertEqual(support.size_text(1536), "1.5 KB")
        self.assertEqual(support.size_text(3 * 1024 ** 3), "3.0 GB")


class FolderTests(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)

    def tearDown(self):
        self._directory.cleanup()

    def test_cache_folder_state(self):
        lines = support.cache_lines(self.root)
        self.assertEqual(lines[1], "Exists: yes; writable: yes")
        self.assertTrue(lines[2].startswith("Free space: "))
        self.assertEqual(list(self.root.iterdir()), [], "the write test leaves nothing behind")
        self.assertIn("Exists: no", support.cache_lines(self.root / "missing" / "cache")[1])
        self.assertEqual(support.cache_lines(""), ["Folder: (blank)"])

    def test_newest_logs_first(self):
        logs = self.root / "logs"
        logs.mkdir()
        now = time.time()
        for index in range(7):
            path = logs / f"download-{index}.log"
            path.write_text("x" * index, encoding="utf-8")
            os.utime(path, (now - 100 + index, now - 100 + index))
        (logs / "notes.txt").write_text("not a log", encoding="utf-8")
        lines = support.recent_logs(self.root)
        self.assertEqual([line.split(" ")[0] for line in lines[:5]],
                         [f"download-{index}.log" for index in (6, 5, 4, 3, 2)])
        self.assertEqual(lines[5], "2 older logs not listed")
        self.assertEqual(support.recent_logs(self.root / "none"), ["No logs folder"])
        self.assertEqual(support.recent_logs(""), ["No logs folder"])

    def test_bundle_files(self):
        self.assertEqual(support.bundle_file_lines(self.root / "bbox_missing"), ["Not downloaded yet"])
        (self.root / "building.geojson").write_bytes(b"x" * 2048)
        (self.root / "terrain.f32").write_bytes(b"x" * 10)
        (self.root / "ignored.tmp").write_bytes(b"x")
        self.assertEqual(support.bundle_file_lines(self.root),
                         ["building.geojson (2.0 KB)", "terrain.f32 (10 bytes)"])

    def test_report_is_saved_under_the_cache(self):
        created = datetime(2026, 9, 27, 12, 30, 5, tzinfo=timezone.utc)
        path = support.save_report(self.root, "text\n", created)
        self.assertEqual(path, self.root / "support" / "support-20260927-123005.txt")
        self.assertEqual(path.read_text(encoding="utf-8"), "text\n")


class ManifestTests(unittest.TestCase):
    def test_manifest_summary(self):
        manifest = {
            "release": "2026-09-17.0", "client_version": "1.0.2",
            "downloaded_at_utc": "2026-09-20T10:00:00+00:00",
            "feature_counts": {"segment": 20, "building": 10},
            "dem": {"columns": 384, "rows": 210, "min_m": 120.4, "max_m": 250.6, "zoom": 13,
                    "tiles_missing": 0, "source": "AWS Terrain Tiles"},
            "dem_downloaded_at_utc": "2026-09-20T10:01:00+00:00",
            "lidar": {"buildings": 42, "sources": ["x"] * 100},
        }
        self.assertEqual(support.manifest_lines(manifest), [
            "Overture release: 2026-09-17.0",
            "Client: 1.0.2",
            "Downloaded: 2026-09-20T10:00:00+00:00",
            "Features: building 10, segment 20",
            "Elevation: 384x210, 120 to 251 m, zoom 13, AWS Terrain Tiles",
            "Elevation downloaded: 2026-09-20T10:01:00+00:00",
            "LiDAR prepared: 42 buildings",
        ])

    def test_missing_or_odd_manifests(self):
        self.assertEqual(support.manifest_lines({}), ["No manifest"])
        self.assertEqual(support.manifest_lines(None), ["No manifest"])
        self.assertEqual(support.manifest_lines({"dem": {"min_m": "?"}}), ["Elevation: present"])
        self.assertEqual(support.manifest_lines({"bbox": [1, 2, 3, 4]}),
                         ["Manifest has no download details"])


class ReportTests(unittest.TestCase):
    def test_home_folder_is_hidden_and_described(self):
        text = r"C:\Users\Ann Lee\cache and c:\users\ann lee\x, C:/Users/Ann Lee/y C:\Users\Ann Leet"
        self.assertEqual(support.redact_home(text, r"C:\Users\Ann Lee", ignore_case=True),
                         r"~\cache and ~\x, ~/y C:\Users\Ann Leet")
        self.assertEqual(support.redact_home("/home/adam/x /home/adamant", "/home/adam", False),
                         "~/x /home/adamant")
        self.assertEqual(support.redact_home("/x", "/", False), "/x")
        self.assertEqual(support.home_notes("/home/adam"), "Home folder: ASCII, no spaces")
        self.assertEqual(support.home_notes(r"C:\Users\Zoë Ann"),
                         "Home folder: contains spaces; contains non-ASCII characters")

    def test_validation_lines(self):
        result = ValidationResult(
            path="/env/bin/python", exists=True, ran=True, python_version=(3, 11, 5),
            executable="/env/bin/python", expected_version="1.0.2",
            downloader=ModuleStatus("overturemaps", True, "1.0.2"),
            lidar=[ModuleStatus("laspy", False, "", "ModuleNotFoundError: laspy")])
        lines = support.validation_lines(result)
        self.assertEqual(lines[:4], ["[ok] Interpreter found", "[ok] Not Blender's own Python",
                                     "[ok] Python 3.11.5", "[ok] overturemaps 1.0.2"])
        self.assertTrue(lines[4].startswith("[note] Optional LiDAR packages missing: laspy"))
        self.assertIn("laspy: no version; ModuleNotFoundError: laspy", lines)
        self.assertEqual(support.validation_lines(None), ["Not checked"])

    def test_report_layout(self):
        created = datetime(2026, 9, 27, 12, 0, 0, tzinfo=timezone.utc)
        text = support.build_report([("Add-on", ["Version: 1.2.3", "Folder: /home/adam/addon"]),
                                     ("Recent logs", [])], created, "/home/adam", False)
        self.assertEqual(text, "\n".join([
            support.TITLE, "Created: 2026-09-27 12:00:00 UTC", "",
            "[Add-on]", "Version: 1.2.3", "Folder: ~/addon", "",
            "[Recent logs]", "(none)", ""]))


if __name__ == "__main__":
    unittest.main()
