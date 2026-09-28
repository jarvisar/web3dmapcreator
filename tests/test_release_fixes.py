"""Pure regression tests for the release-audit fixes (no Blender, no network)."""

from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jarvizar_city_model.data.cache import Bounds
from jarvizar_city_model.data.download_job import classify_failure
from jarvizar_city_model.data.environment import interpreter_path
from jarvizar_city_model.data.folders import ensure_writable
from jarvizar_city_model.data.generation_job import GenerationJob
from jarvizar_city_model.data.overture import resolve_python
from jarvizar_city_model.data.projection import normalize_minus, parse_bounds_text


class FolderTests(unittest.TestCase):
    def test_creates_a_missing_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "a" / "b"
            self.assertEqual(ensure_writable(target), target)
            self.assertTrue(target.is_dir())
            self.assertEqual(list(target.iterdir()), [])

    def test_export_folders_are_never_created(self):
        with tempfile.TemporaryDirectory() as folder:
            missing = Path(folder) / "missing"
            with self.assertRaisesRegex(FileNotFoundError, "Folder not found"):
                ensure_writable(missing, create=False)
            self.assertFalse(missing.exists())
            self.assertEqual(ensure_writable(folder, create=False), Path(folder))

    def test_refuses_at_once_with_a_plain_message(self):
        with tempfile.TemporaryDirectory() as folder:
            blocker = Path(folder) / "file.txt"
            blocker.write_text("x", encoding="utf-8")
            with self.assertRaisesRegex(OSError, "Cannot write to .*Choose another folder"):
                ensure_writable(blocker / "sub")


class BoundsTextTests(unittest.TestCase):
    def test_typographic_minus_signs(self):
        for sign in ("−", "–", "﹣", "－"):
            bounds = parse_bounds_text(f"{sign}84.5337,39.08554,{sign}84.47422,39.11094")
            self.assertAlmostEqual(bounds.west, -84.5337)
            self.assertAlmostEqual(bounds.east, -84.47422)
        self.assertEqual(normalize_minus("−1"), "-1")

    def test_decimal_commas_get_a_hint(self):
        with self.assertRaisesRegex(ValueError, "found 8; use a point for decimals"):
            parse_bounds_text("-84,5337;39,08554;-84,47422;39,11094")

    def test_range_messages_name_the_fields(self):
        with self.assertRaisesRegex(ValueError, "West must be less than East"):
            Bounds(-84.4, 39.0, -84.5, 39.1).validate()
        with self.assertRaisesRegex(ValueError, "South must be less than North"):
            Bounds(-84.5, 39.1, -84.4, 39.0).validate()
        with self.assertRaisesRegex(ValueError, "South and North must be between -90 and 90"):
            Bounds(-84.5, 39.0, -84.4, 95.0).validate()
        with self.assertRaisesRegex(ValueError, "West and East must be between -180 and 180"):
            Bounds(-190.0, 39.0, -84.4, 39.1).validate()


class InterpreterPathTests(unittest.TestCase):
    def test_quotes_and_spaces_are_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            python = Path(folder) / "python.exe"
            python.write_bytes(b"")
            quoted = f'  "{python}"  '
            self.assertEqual(interpreter_path(quoted), str(python))
            self.assertEqual(resolve_python(quoted), python)

    def test_an_environment_folder_resolves_to_its_python(self):
        with tempfile.TemporaryDirectory() as folder:
            for index, parts in enumerate((("Scripts", "python.exe"), ("bin", "python3"))):
                venv = Path(folder) / f"venv{index}"
                inner = venv.joinpath(*parts)
                inner.parent.mkdir(parents=True)
                inner.write_bytes(b"")
                self.assertEqual(interpreter_path(str(venv)), str(inner))

    def test_blank_stays_blank(self):
        self.assertEqual(interpreter_path(' "" '), "")
        self.assertEqual(interpreter_path(None), "")


class FailureTests(unittest.TestCase):
    def test_missing_package_metadata_is_a_setup_problem(self):
        kind, message = classify_failure(
            "importlib.metadata.PackageNotFoundError: No package metadata was found for overturemaps")
        self.assertEqual(kind, "packages")
        self.assertIn("missing overturemaps", message)


class WorkerLogTests(unittest.TestCase):
    def test_failed_worker_log_is_kept_and_rotated(self):
        with tempfile.TemporaryDirectory() as folder:
            job = object.__new__(GenerationJob)
            job.directory = Path(folder) / "worker"
            job.directory.mkdir()
            job.cleaned = False
            (job.directory / "worker.log").write_text("Traceback: boom\n", encoding="utf-8")
            logs = Path(folder) / "logs"
            logs.mkdir()
            for index in range(25):
                (logs / f"generation-20000101T0000{index:02d}Z.log").write_text("old", encoding="utf-8")
            kept = job.keep_log(logs, keep=20)
            self.assertEqual(kept.read_text(encoding="utf-8"), "Traceback: boom\n")
            remaining = sorted(logs.glob("generation-*.log"))
            self.assertEqual(len(remaining), 20)
            self.assertIn(kept, remaining)
            job.cleaned = True
            self.assertIsNone(job.keep_log(logs))


if __name__ == "__main__":
    unittest.main()
