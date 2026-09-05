"""The downloader interpreter is resolved from scene, preference, then env."""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.overture import OvertureDownloadError, resolve_python


class ResolvePythonTests(unittest.TestCase):
    def setUp(self):
        self.existing = sys.executable
        self.previous = os.environ.pop("JARVIZAR_OVERTURE_PYTHON", None)

    def tearDown(self):
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

    def test_a_configured_path_that_does_not_exist_is_reported(self):
        with self.assertRaises(OvertureDownloadError) as caught:
            resolve_python("", "C:/nowhere/python.exe")
        self.assertIn("does not exist", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
