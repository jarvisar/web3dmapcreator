"""Tests for local cache identity and completeness checks."""

import json
from pathlib import Path
import tempfile
import unittest

from jarvizar_city_model.data.cache import Bounds, CacheBundle, cache_key


class CacheTests(unittest.TestCase):
    def test_cache_key_is_stable_and_bbox_specific(self):
        first = Bounds(-84.53370, 39.08554, -84.47422, 39.11094)
        same = Bounds(-84.5337, 39.08554, -84.47422, 39.11094)
        other = Bounds(-84.5336, 39.08554, -84.47422, 39.11094)
        self.assertEqual(cache_key(first), cache_key(same))
        self.assertNotEqual(cache_key(first), cache_key(other))

    def test_complete_bundle_requires_manifest_and_both_files(self):
        bounds = Bounds(-1, -1, 1, 1)
        with tempfile.TemporaryDirectory() as directory:
            bundle = CacheBundle(Path(directory), bounds)
            bundle.ensure_directory()
            bundle.data_path("building").write_text(
                '{"type":"FeatureCollection","features":[]}', encoding="utf-8"
            )
            bundle.data_path("building_part").write_text(
                '{"type":"FeatureCollection","features":[]}', encoding="utf-8"
            )
            self.assertFalse(bundle.is_complete())
            bundle.write_manifest({"release": "test"})
            self.assertTrue(bundle.is_complete())

            manifest = json.loads(bundle.manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["bbox"], [-1, -1, 1, 1])
            self.assertEqual(manifest["cache_format"], 1)

    def test_rejects_invalid_bounds(self):
        for bounds in (Bounds(1, 0, -1, 1), Bounds(-1, 2, 1, -2)):
            with self.assertRaises(ValueError):
                bounds.validate()


if __name__ == "__main__":
    unittest.main()

