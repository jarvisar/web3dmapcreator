"""The downloader interpreter is resolved from scene, preference, env, then
the default setup location."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data import environment
from jarvizar_city_model.data.overture import OvertureDownloadError, resolve_python


class ResolvePythonTests(unittest.TestCase):
    def setUp(self):
        self.existing = sys.executable
        self.previous = os.environ.pop("JARVIZAR_OVERTURE_PYTHON", None)
        # This machine's own setup must not decide the result.
        self.default = mock.patch.object(environment, "default_venv_python",
                                         return_value=Path("C:/nowhere/default/python.exe"))
        self.default.start()

    def tearDown(self):
        self.default.stop()
        if self.previous is None:
            os.environ.pop("JARVIZAR_OVERTURE_PYTHON", None)
        else:
            os.environ["JARVIZAR_OVERTURE_PYTHON"] = self.previous

    def test_a_scene_path_overrides_the_preference(self):
        self.assertEqual(
            resolve_python(self.existing, "C:/nowhere/python.exe"), Path(self.existing)
        )

    def test_the_preference_is_used_when_the_scene_is_blank(self):
        self.assertEqual(resolve_python("   ", self.existing), Path(self.existing))

    def test_the_environment_is_the_last_resort(self):
        os.environ["JARVIZAR_OVERTURE_PYTHON"] = self.existing
        self.assertEqual(resolve_python("", ""), Path(self.existing))

    def test_nothing_configured_anywhere_names_the_preferences(self):
        with self.assertRaises(OvertureDownloadError) as caught:
            resolve_python("", "")
        self.assertIn("Add-ons", str(caught.exception))
        self.assertIn("Set Up Downloader", str(caught.exception))

    def test_the_default_setup_location_comes_after_the_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            default = Path(folder) / "python.exe"
            default.write_bytes(b"")
            with mock.patch.object(environment, "default_venv_python", return_value=default):
                self.assertEqual(resolve_python("", ""), default)
                # A configured path that is missing is reported, not replaced.
                with self.assertRaises(OvertureDownloadError):
                    resolve_python("", "C:/nowhere/python.exe")
                os.environ["JARVIZAR_OVERTURE_PYTHON"] = self.existing
                self.assertEqual(resolve_python("", ""), Path(self.existing))

    def test_a_configured_path_that_does_not_exist_is_reported(self):
        with self.assertRaises(OvertureDownloadError) as caught:
            resolve_python("", "C:/nowhere/python.exe")
        self.assertIn("does not exist", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
