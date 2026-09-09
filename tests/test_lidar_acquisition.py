"""Real LAZ decoding plus isolated catalogs, transport and source selection."""
import importlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse
from urllib.error import HTTPError

try:
    import laspy
    import numpy as np
    from pyproj import CRS, Transformer
    from shapely.geometry import box, mapping
    from jarvizar_city_model.external import lidar_acquisition as acquisition, lidar_laz
    from jarvizar_city_model.external.lidar_ept import Fetcher, BudgetExceeded
    from jarvizar_city_model.external.lidar_selection import choose_measurement
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class AcquisitionTests(unittest.TestCase):
    bbox = [-87.64, 41.88, -87.63, 41.89]

    def item(self, name='tile', bounds=None, project='survey'):
        west, south, east, north = bounds or self.bbox
        return {'sourceId': name, 'downloadURL': f'https://example.com/{project}/{name}.laz',
                'boundingBox': dict(minX=west, minY=south, maxX=east, maxY=north),
                'publicationDate': '2026-01-01', 'lastUpdated': '2026-09-01'}

    def cloud(self, crs='EPSG:26916+6360'):
        header = laspy.LasHeader(point_format=6, version='1.4')
        header.add_crs(CRS(crs))
        header.scales = [.001]*3
        header.offsets = [400000, 4600000, 0]
        header.global_encoding.gps_time_type = 1
        cloud = laspy.LasData(header)
        lon = np.array([-87.635]*8 + [-87.62])
        lat = np.array([41.885, 41.88501, 41.88502, 41.88503, 41.88504,
                        41.88505, 41.88506, 41.88507, 41.885])
        cloud.x, cloud.y = Transformer.from_crs(4326, CRS(crs).to_2d(), always_xy=True).transform(lon, lat)
        cloud.z = np.array([100, 200, 200, 200, 200, 200, 200, 200, 200])
        cloud.classification = [2, 6, 1, 7, 6, 6, 12, 18, 6]
        cloud.withheld = [0, 0, 0, 0, 1, 0, 0, 0, 0]
        cloud.overlap = [0, 0, 0, 0, 0, 1, 0, 0, 0]
        cloud.number_of_returns = [1, 1, 2, 1, 1, 1, 1, 1, 1]
        cloud.return_number = [1]*9
        cloud.gps_time = np.full(9, (np.datetime64('2022-06-01')-np.datetime64('1980-01-06'))/np.timedelta64(1,'s')-1e9)
        return cloud

    def test_tnm_pagination_dedup_spatial_filter_and_product_errors(self):
        fetch = Mock()
        pages = [dict(total=5, items=[self.item('a'), self.item('a')]),
                 dict(total=5, items=[self.item('b'), self.item('outside', [0, 0, 1, 1])]),
                 dict(total=5, items=[{'sourceId': 'broken'}])]
        fetch.json.side_effect = pages
        failures = []
        tiles = list(acquisition.tnm_tiles(fetch, self.bbox, failures, page_size=2))
        self.assertEqual([t['id'] for t in tiles], ['a', 'b'])
        self.assertEqual(len(failures), 1)
        for offset, call in zip((0, 2, 4), fetch.json.call_args_list):
            query = parse_qs(urlparse(call.args[0]).query)
            self.assertEqual(query['offset'], [str(offset)])
            self.assertEqual(query['datasets'], ['Lidar Point Cloud (LPC)'])
            self.assertEqual(query['prodFormats'], ['LAZ'])
        self.assertNotIn('capture_year', tiles[0])
        self.assertEqual(len(acquisition.grouped_laz(tiles)), 1)

    def test_api_errors_and_nonadvancing_pages_are_reported(self):
        for pages in ([{'errorMessage': 'offline'}], [{'items': [], 'total': 4}],
                      [{'items': [self.item()], 'total': 4}]*2):
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                list(acquisition.tnm_tiles(Mock(json=Mock(side_effect=pages)), self.bbox, []))

    def test_failed_tnm_page_shrinks_without_skipping_products(self):
        fetch = Mock()
        fetch.json.side_effect = [
            {'items': [self.item('a'), self.item('b')], 'total': 3},
            HTTPError(acquisition.TNM_URL, 500, 'Internal Server Error', {}, None),
            {'items': [self.item('c')], 'total': 3}]
        failures = []
        tiles = list(acquisition.tnm_tiles(fetch, self.bbox, failures))
        self.assertEqual([t['id'] for t in tiles], ['a', 'b', 'c'])
        queries = [parse_qs(urlparse(c.args[0]).query) for c in fetch.json.call_args_list]
        self.assertEqual([q['offset'] for q in queries], [['0'], ['2'], ['2']])
        self.assertEqual([q['max'] for q in queries], [['100'], ['100'], ['50']])
        self.assertFalse(failures)

    def test_persistent_page_errors_keep_partial_results_and_report_failure(self):
        fetch = Mock()
        page = {'items': [self.item('a')], 'total': 3}
        error = HTTPError(acquisition.TNM_URL, 503, 'Unavailable', {}, None)
        def read(url, **kwargs):
            if url == acquisition.lidar_ept.CATALOG_URL:
                return {'features': []}
            if parse_qs(urlparse(url).query)['offset'] == ['0']:
                return page
            raise error
        fetch.json.side_effect = read
        sources, failures = acquisition.discover_sources(fetch, self.bbox)
        self.assertEqual(len(sources), 1)
        self.assertEqual(len(sources[0]['tiles']), 1)
        self.assertEqual(failures[0]['source'], 'TNMAccess')
        self.assertEqual(fetch.json.call_count, 7)  # catalog + first + failed 100/50/25/12/10

    def test_ept_outage_still_discovers_laz_and_laz_outage_keeps_ept(self):
        catalog = {'features': [{'properties': {'url': 'https://example.com/ept.json', 'name': 'survey'},
                                 'geometry': mapping(box(*self.bbox))}]}
        for broken in ('EPT', 'LAZ'):
            def read(url, **kwargs):
                is_ept = url == acquisition.lidar_ept.CATALOG_URL
                if is_ept == (broken == 'EPT'):
                    raise OSError('offline')
                return catalog if is_ept else {'items': [self.item()], 'total': 1}
            sources, failures = acquisition.discover_sources(Mock(json=Mock(side_effect=read)), self.bbox)
            self.assertEqual(len(sources), 1)
            self.assertNotEqual(sources[0]['format'], broken)
            self.assertEqual(len(failures), 1)

    def test_laz_chunking_crop_flags_dates_and_independent_vertical_units(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'unrelated-name.laz'
            self.cloud().write(path)
            fetch = Mock(download=Mock(return_value=path))
            tiles = [{'url': 'https://example.com/survey/tile.laz', 'bbox': self.bbox},
                     {'url': 'https://example.com/survey/outside.laz', 'bbox': [0, 0, 1, 1]}]
            source = acquisition.grouped_laz(tiles)[0]
            points, info = lidar_laz.read_laz(fetch, source, self.bbox, chunk_size=2)
            self.assertEqual(points.shape, (3, 7))
            np.testing.assert_allclose(points[:, 2], np.array([100, 200, 200])*1200/3937)
            self.assertEqual(points[:, 3].tolist(), [2, 6, 1])
            self.assertEqual(points[:, 4].tolist(), [1, 1, 0])
            self.assertEqual(points[:, 5].tolist(), [2022]*3)
            self.assertEqual(points[:, 6].tolist(), [1]*3)
            self.assertEqual(fetch.download.call_count, 1)
            self.assertEqual(info['format'], 'LAZ')
            with self.assertRaises(BudgetExceeded):
                lidar_laz.read_laz(fetch, source, self.bbox, max_points=2, chunk_size=2)

    def test_unknown_units_rejected_and_legacy_geotiff_units_respected(self):
        from laspy.vlrs.known import GeoKeyEntryStruct
        header = laspy.LasHeader(point_format=3, version='1.2')
        header.add_crs(CRS(26916))
        with self.assertRaisesRegex(ValueError, 'vertical units'):
            lidar_laz.coordinate_system(header)
        directory = next(v for v in header.vlrs if hasattr(v, 'geo_keys'))
        key = GeoKeyEntryStruct()
        key.id, key.tiff_tag_location, key.count, key.value_offset = 4099, 0, 1, 9003
        directory.geo_keys.append(key)
        self.assertAlmostEqual(lidar_laz.coordinate_system(header)[1], 1200/3937)
        with self.assertRaisesRegex(ValueError, 'horizontal CRS'):
            lidar_laz.coordinate_system(laspy.LasHeader())

    def test_staged_laz_preserves_existing_tier_measurement_pipeline(self):
        from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building
        from test_lidar_measurements import MeasurementsTests
        raw = MeasurementsTests().cloud(lambda x, y: 60 if 10 < x < 50 and 10 < y < 50 else 30)
        raw = np.concatenate([raw+np.array([dx, dy, 0, 0, 0])
                              for dx in (-.25, .25) for dy in (-.25, .25)])
        crs = CRS('EPSG:26916+5703')
        to_lonlat = Transformer.from_crs(crs.to_2d(), 4326, always_xy=True)
        to_metric = Transformer.from_crs(4326, crs.to_2d(), always_xy=True)
        header = laspy.LasHeader(point_format=6, version='1.4')
        header.add_crs(crs)
        header.scales, header.offsets = [.001]*3, [400000, 4600000, 0]
        cloud = laspy.LasData(header)
        cloud.x, cloud.y, cloud.z = raw[:,0]+447000, raw[:,1]+4637000, raw[:,2]
        cloud.classification = raw[:,3].astype(int)
        cloud.number_of_returns = np.ones(len(raw), dtype=int)
        cloud.return_number = np.ones(len(raw), dtype=int)
        bbox = to_lonlat.transform_bounds(446970, 4636970, 447090, 4637090, densify_pts=21)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'mass.laz'
            cloud.write(path)
            source = acquisition.grouped_laz([{'url':'https://example.com/mass.laz', 'bbox':bbox}])[0]
            points, _ = lidar_laz.read_laz(Mock(download=Mock(return_value=path)), source, bbox)
        x, y = to_metric.transform(points[:,0], points[:,1])
        points[:,0], points[:,1] = x-447000, y-4637000
        result, reason = measure_building(box(0,0,60,60), PointIndex(points), .1/.07, .05/.077)
        self.assertEqual(reason, 'tiers')
        self.assertAlmostEqual(result['height_m'], 30)
        self.assertEqual([round(t['top_m']) for t in result['tiers']], [60])

    def test_manifest_locates_arbitrary_names_by_headers_only(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'cloud.laz'
            self.cloud().write(path)
            data = path.read_bytes()
        ranges = []
        def read(url, start, size):
            ranges.append((start, size))
            return data[start:start+size]
        fetch = Mock(range=Mock(side_effect=read))
        header = lidar_laz.header_bounds(fetch, 'https://example.com/arbitrary.laz')
        self.assertTrue(box(*header['bbox']).intersects(box(*self.bbox)))
        self.assertLess(sum(size for _, size in ranges), len(data))
        fetch.get.return_value = b'\xef\xbb\xbf# downloads\nhttps://example.com/a.laz\nhttps://example.com/z.laz\nhttps://example.com/a.laz\n'
        with patch.object(lidar_laz, 'header_bounds', side_effect=[header, {'bbox': [0, 0, 1, 1]}]):
            tiles = list(acquisition.manifest_tiles(fetch, 'https://example.com/0_file_download_links.txt', self.bbox, [], lambda _: None))
        self.assertEqual([t['url'] for t in tiles], ['https://example.com/a.laz'])
        fetch.download.assert_not_called()

    def test_http_range_refusal_never_reads_point_body(self):
        response = Mock(status=200, headers={})
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with tempfile.TemporaryDirectory() as temp, patch('urllib.request.urlopen', return_value=response):
            with self.assertRaisesRegex(ValueError, 'bounded LAS header'):
                Fetcher(Path(temp)).range('https://example.com/tile.laz', 0, 227)
        response.read.assert_not_called()

    def test_failed_download_is_atomic_and_revision_refreshes_once(self):
        class Response(io.BytesIO):
            headers = {'Content-Length': '4'}
        with tempfile.TemporaryDirectory() as temp:
            fetch = Fetcher(Path(temp), refresh=True)
            url = 'https://example.com/a.laz'
            with patch('urllib.request.urlopen', side_effect=lambda *a, **kw: Response(b'roof')) as request:
                first = fetch.download(url, revision='old')
                self.assertEqual(fetch.download(url, revision='old'), first)
                self.assertNotEqual(fetch.download(url, revision='new'), first)
                self.assertEqual(request.call_count, 2)
            with patch('urllib.request.urlopen', side_effect=lambda *a, **kw: Response(b'bad')), patch('time.sleep'):
                with self.assertRaises(OSError):
                    Fetcher(Path(temp), refresh=True).download(url, revision='old')
            self.assertEqual(first.read_bytes(), b'roof')
            self.assertFalse(list(Path(temp).glob('*.partial')))

    def test_both_formats_can_win_quality_age_coverage_and_classification(self):
        baseline = {'height_m': 30, 'tiers': [], 'capture_year': 2018, 'coverage': .9,
                    'explained_fraction': .9, 'roof_support_density_m2': 1}
        for format in ('LAZ', 'EPT'):
            other = {**baseline, 'source_format': 'EPT' if format == 'LAZ' else 'LAZ', 'source': 'a'}
            for improvements in ({'capture_year': 2022}, {'coverage': 1},
                                 {'roof_support_density_m2': 4}, {'classified_roof_fraction': 1}):
                better = {**baseline, **improvements, 'source_format': format, 'source': 'z'}
                for records in ([other, better], [better, other]):
                    selected, audit = choose_measurement(records, prefer_lidar=True)
                    self.assertIs(selected, better)
                    self.assertEqual(audit['source_format'], format)

    def test_worker_laz_only_decodes_into_existing_measurements_and_resumes(self):
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature
        external = str(Path(__file__).resolve().parents[1]/'jarvizar_city_model/external')
        with patch.object(sys, 'path', [external]+sys.path):
            worker = importlib.import_module('download_lidar')
            adapter = importlib.import_module('lidar_acquisition')
            measurements = importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        with tempfile.TemporaryDirectory() as temp:
            bundle = CacheBundle(Path(temp), Bounds(*self.bbox))
            bundle.ensure_directory()
            feature = {'id': 'one', 'properties': {}, 'geometry': mapping(box(-87.636,41.884,-87.634,41.886))}
            bundle.data_path('building').write_text(json.dumps({'features': [feature]}))
            bundle.data_path('building_part').write_text('{"features": []}')
            cloud = Path(temp)/'test.laz'
            self.cloud().write(cloud)
            request = request_signature(bundle, .07, .077)
            def catalog(url, **kwargs):
                if url == adapter.lidar_ept.CATALOG_URL:
                    return {'features': []}
                return {'items': [self.item()], 'total': 1}
            def measure(features, points, *args, **kwargs):
                self.assertEqual(points.shape, (3, 7))
                self.assertTrue(np.all(np.abs(points[:, 0]) < 100))  # local metric XY
                self.assertAlmostEqual(points[0, 2], 100*1200/3937)
                return {'one': {'height_m': 30, 'tiers': []}}, {'height_only': 1}, {}
            with patch.object(adapter.lidar_ept.Fetcher, 'json', side_effect=catalog), \
                 patch.object(adapter.lidar_ept.Fetcher, 'download', return_value=cloud) as download, \
                 patch.object(measurements, 'measure_features', side_effect=measure) as processor:
                self.assertEqual(worker.prepare(bundle.path, request)['buildings'], 1)
                self.assertEqual(worker.prepare(bundle.path, request)['buildings'], 1)
                self.assertEqual(processor.call_count, 1)
                self.assertEqual(download.call_count, 1)
            payload = json.loads((bundle.path/'lidar_buildings.json').read_text())
            self.assertEqual(payload['buildings']['one']['source_format'], 'LAZ')
            self.assertEqual(payload['selection']['one']['source_format'], 'LAZ')
            self.assertFalse(payload['failures'])

    def test_tile_seams_deduplicate_returns_without_combining_surveys(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'seam.laz'
            self.cloud().write(path)
            tiles = [{'url': f'https://example.com/one/{name}.laz', 'bbox': self.bbox}
                     for name in ('left', 'right')]
            tiles.append({'url': 'https://example.com/two/left.laz', 'bbox': self.bbox})
            sources = acquisition.grouped_laz(tiles)
            self.assertEqual(len(sources), 2)
            fetch = Mock(download=Mock(return_value=path))
            points, _ = lidar_laz.read_laz(fetch, sources[0], self.bbox)
            self.assertEqual(len(points), 3)
            self.assertEqual(fetch.download.call_count, 2)
            self.assertNotIn('two', ' '.join(call.args[0] for call in fetch.download.call_args_list))

    def test_updated_inventory_changes_checkpoint_identity(self):
        tiles = [{'url': 'https://example.com/tile.laz', 'bbox': self.bbox, 'updated': '2024'}]
        first = acquisition.grouped_laz(tiles)[0]['fingerprint']
        tiles[0]['updated'] = '2026'
        self.assertNotEqual(first, acquisition.grouped_laz(tiles)[0]['fingerprint'])

    def test_evlr_crs_can_be_located_with_only_header_ranges(self):
        from laspy.vlrs.vlrlist import VLRList
        cloud = self.cloud()
        crs_vlr = cloud.header.vlrs.pop(0)
        cloud.header.evlrs = VLRList([crs_vlr])
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'evlr.laz'
            cloud.write(path)
            data = path.read_bytes()
        fetch = Mock(range=Mock(side_effect=lambda url, start, size: data[start:start+size]))
        header = lidar_laz.header_bounds(fetch, 'https://example.com/evlr.laz')
        self.assertAlmostEqual(header['z_to_metres'], 1200/3937)
        self.assertGreater(fetch.range.call_count, 2)
        # The early transfer check must defer EVLR-only CRS to the full reader.
        prefix = lidar_laz.validate_download_prefix(io.BytesIO(data), len(data))
        self.assertEqual(prefix, data[:len(prefix)])
        self.assertLess(len(prefix), len(data))


if __name__ == '__main__':
    unittest.main()
