"""Footprint-based LAZ admission reaches both prefetch and the actual reader."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from lidar_consent_fixture import prepare_reviewed_laz
from unittest.mock import patch

try:
    import numpy as np
    from pyproj import CRS, Transformer
    from shapely.geometry import box, mapping
    from shapely.ops import transform
    from jarvizar_city_model.external.lidar_tiles import building_tile_plan, batch_source
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class FootprintTileTests(unittest.TestCase):
    def run_worker(self, *, split=False, same=False):
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature
        external = str(Path(__file__).resolve().parents[1] / 'jarvizar_city_model/external')
        with patch.object(sys, 'path', [external] + sys.path):
            worker = importlib.import_module('download_lidar')
            acquisition = importlib.import_module('lidar_acquisition')
            measurement = importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        metric = CRS.from_proj4('+proj=aeqd +lat_0=0 +lon_0=0 +datum=WGS84 +units=m')
        to_geo = Transformer.from_crs(metric, 4326, always_xy=True).transform
        features = [{'id': name, 'properties': {}, 'geometry': mapping(transform(to_geo, geometry))}
                    for name, geometry in [('west', box(40, 40, 60, 60)), ('east', box(240, 240, 260, 260))]]
        tiles = [{'url': f'https://example.com/project/{name}.laz',
                  'bbox': list(transform(to_geo, geometry).bounds)} for name, geometry in (
                      ('west', box(0, 0, 74, 120)), ('ground', box(74, 0, 120, 120)),
                      ('empty-middle', box(130, 130, 170, 170)), ('east', box(180, 180, 310, 310)))]
        laz = acquisition.grouped_laz(tiles)[0]
        identity = {'projects': ['agency:survey'], 'datasets': [], 'evidence': ['provider project_id=survey']}
        laz.update(survey_identity=identity)
        sources = [laz]
        if same:
            sources.append({'url': 'https://example.com/ept/ept.json', 'name': 'EPT delivery', 'format': 'EPT',
                            'coverage': box(-.01, -.01, .01, .01), 'survey_identity': identity})
        reads = []
        def read(fetch, source, bbox):
            admitted = [t['url'].rsplit('/', 1)[-1] for t in source.get('tiles', [])]
            reads.append(admitted)
            if split and len(reads) == 1:
                raise acquisition.lidar_ept.BudgetExceeded('Cropped point budget; subdivide group')
            for tile in source.get('tiles', []):
                fetch.download(tile['url'])
            return np.empty((0, 7)), {'url': source['url'], 'points': 100}
        def measure(batch, *a, **kw):
            if same:
                return {}, {}, {f['id']: 'insufficient_ground' for f in batch}
            return {f['id']: {'height_m': 30, 'tiers': []} for f in batch}, {}, {}
        with tempfile.TemporaryDirectory() as temp:
            bundle = CacheBundle(Path(temp), Bounds(-.01, -.01, .01, .01))
            bundle.ensure_directory()
            bundle.data_path('building').write_text(json.dumps({'features': features}))
            bundle.data_path('building_part').write_text('{"features": []}')
            request = request_signature(bundle, .07, .077)
            with patch.object(acquisition, 'discover_sources', side_effect=lambda *a, **kw: ([dict(s) for s in sources], [])), \
                 patch.object(acquisition, 'read_source', side_effect=read), \
                 patch.object(measurement, 'measure_features', side_effect=measure), \
                 patch.object(acquisition.lidar_ept.Fetcher, 'download', side_effect=lambda url, **kw: Path(url.rsplit('/', 1)[-1])) as download:
                result = prepare_reviewed_laz(worker, bundle.path, request)
                self.assertEqual(result['buildings'], 0 if same else 2)
                payload = json.loads((bundle.path / 'lidar_buildings.json').read_text())
                downloads = [c.args[0].rsplit('/', 1)[-1] for c in download.call_args_list]
                if not split:
                    download.reset_mock()
                    count = len(reads)
                    prepare_reviewed_laz(worker, bundle.path, request)
                    self.assertEqual(len(reads), count)
                    download.assert_not_called()
            return downloads, reads, payload

    def test_empty_space_between_candidates_is_excluded_from_prefetch_and_read(self):
        downloads, reads, payload = self.run_worker()
        self.assertCountEqual(downloads, ['west.laz', 'ground.laz', 'east.laz'])
        self.assertEqual(len(reads), 1)  # Both footprints share one batch rectangle.
        self.assertCountEqual(reads[0], downloads)
        audit = payload['discovered_sources'][0]['selected_tiles']
        ground = next(a for a in audit if a['url'].endswith('/ground.laz'))
        self.assertEqual(ground['ground_halos'], ['west'])
        self.assertFalse(ground['footprints'])
        self.assertIn('no suitable EPT coverage (or COPC)', ground['reasons'])

    def test_split_batches_keep_the_same_precise_tile_allowlist(self):
        downloads, reads, _ = self.run_worker(split=True)
        # Each child has its own prefetch scope; Fetcher reuses completed files.
        self.assertEqual(set(downloads), {'west.laz', 'ground.laz', 'east.laz'})
        self.assertCountEqual(reads[1], ['west.laz', 'ground.laz'])
        self.assertEqual(reads[2], ['east.laz'])

    def test_same_survey_is_not_downloaded_on_live_or_checkpoint_replay(self):
        downloads, reads, payload = self.run_worker(same=True)
        self.assertFalse(downloads)
        self.assertEqual(reads, [[]])
        laz = next(s for s in payload['discovered_sources'] if s['format'] == 'LAZ')
        self.assertFalse(laz.get('selected_tiles'))
        self.assertTrue(any('redundant survey' in reason for reason in laz['skipped_fallback_reasons']))


if __name__ == '__main__':
    unittest.main()
