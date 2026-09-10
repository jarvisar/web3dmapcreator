"""Provider discovery, range-only COPC decoding, normalization and consent policy."""
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse

try:
    import laspy
    import numpy as np
    import shapefile
    from pyproj import CRS
    from shapely.geometry import box, mapping
    from jarvizar_city_model.external import lidar_acquisition as acquisition
    from jarvizar_city_model.external.lidar_candidates import candidate, asset_format, discovery_settings
    from jarvizar_city_model.external.lidar_copc import read_copc, BoundedCopcReader, RangeStream
    from jarvizar_city_model.external.lidar_ept import Fetcher, BudgetExceeded
    from jarvizar_city_model.external.lidar_flai import inventory, discover_flai, INVENTORY_URL, BUCKET_URL
    from jarvizar_city_model.external.lidar_stac import discover_stac, stac_metadata
    from jarvizar_city_model.external.lidar_ranking import rank_sources, AcquisitionPlan
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


def copc_fixture():
    """One valid compressed root node, generated locally without PDAL/network."""
    header = laspy.LasHeader(point_format=6, version='1.4')
    header.add_crs(CRS('EPSG:32631+5703'))
    header.scales = [.001] * 3
    header.offsets = [500000, 5500000, 0]
    header.vlrs.insert(0, laspy.VLR('copc', 1, record_data=b'\0' * 160))
    cloud = laspy.LasData(header)
    cloud.x = np.array([500001, 500002, 500003, 500100])
    cloud.y = np.array([5500001, 5500002, 5500003, 5500100])
    cloud.z = np.array([100, 120, 130, 140])
    cloud.classification = [2, 6, 7, 6]
    cloud.number_of_returns = [1] * 4
    cloud.return_number = [1] * 4
    stream = io.BytesIO()
    cloud.write(stream, do_compress=True)
    data = bytearray(stream.getvalue())
    offset = struct.unpack_from('<I', data, 96)[0]
    table = struct.unpack_from('<Q', data, offset)[0]
    evlr_offset = len(data)
    hierarchy_offset = evlr_offset + 60
    data += struct.pack('<H16sHQ32s', 0, b'copc', 1000, 32, b'hierarchy')
    data += struct.pack('<iiiiQii', 0, 0, 0, 0, offset + 8, table - offset - 8, 4)
    struct.pack_into('<QI', data, 235, evlr_offset, 1)
    vlr_offset = struct.unpack_from('<H', data, 94)[0] + 54
    struct.pack_into('<5dQQ2d', data, vlr_offset,
                     500050, 5500050, 120, 100, 1, hierarchy_offset, 32, 0, 0)
    return bytes(data)


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class InternationalTests(unittest.TestCase):
    bbox = [3, 49.65, 3.01, 49.66]

    def stac_item(self, name='one', format='COPC', bbox=None, **props):
        return {'type': 'Feature', 'stac_version': '1.0.0', 'id': name, 'collection': 'survey',
                'geometry': mapping(box(*(bbox or self.bbox))),
                'properties': {'datetime': '2022-06-01T00:00:00Z', 'proj:epsg': 32631,
                               'vertical_units': 'm', **props},
                'assets': {'cloud': {'href': name + ('.copc.laz' if format == 'COPC' else '.las' if format == 'LAS' else '/ept.json'),
                                     'file:size': 1000}}, 'links': []}

    def test_copc_real_decode_only_reads_ranges_crops_and_filters(self):
        from pyproj import Transformer
        data = copc_fixture()
        bbox = Transformer.from_crs(32631, 4326, always_xy=True).transform_bounds(500000, 5500000, 500010, 5500010)
        fetch = Mock(range=Mock(side_effect=lambda url, start, size: data[start:start+size]))
        points, info = read_copc(fetch, {'url': 'https://test/cloud.copc.laz', 'format': 'COPC'}, bbox)
        self.assertEqual(points.shape, (2, 7))
        np.testing.assert_allclose(points[:, 2], [100, 120])
        np.testing.assert_allclose(points[:, 3], [2, 6])
        self.assertEqual(info['nodes'], 1)
        self.assertEqual(info['tiles'][0]['horizontal_crs'], 'EPSG:32631')
        fetch.download.assert_not_called()
        fetch.get.assert_not_called()
        self.assertTrue(all(c.args[2] > 0 for c in fetch.range.call_args_list))

    def test_copc_guards_counts_before_point_transfer(self):
        from pyproj import Transformer
        data = copc_fixture()
        bbox = Transformer.from_crs(32631, 4326, always_xy=True).transform_bounds(500000, 5500000, 500010, 5500010)
        fetch = Mock(range=Mock(side_effect=lambda url, start, size: data[start:start+size]))
        with self.assertRaises(BudgetExceeded):
            read_copc(fetch, {'url': 'https://test/cloud.copc.laz', 'format': 'COPC'}, bbox, max_points=1)
        point_offset = struct.unpack_from('<I', data, 96)[0] + 8
        self.assertFalse(any(c.args[1] == point_offset for c in fetch.range.call_args_list))

    def test_unknown_classification_never_assumes_asprs(self):
        from jarvizar_city_model.external.lidar_normalize import classifications
        points = Mock(classification=np.array([2, 6, 42, 99]))
        custom = {'classification': {'convention': 'custom', 'mapping': {'42': 'ground', '99': 'building'}}}
        np.testing.assert_equal(classifications(points, metadata=custom), [0, 0, 2, 6])
        with self.assertRaisesRegex(ValueError, 'convention'):
            classifications(points, metadata={'classification': {'convention': 'custom'}})

    def test_fallback_units_never_override_header_units_and_unknowns_rejected(self):
        from jarvizar_city_model.external.lidar_laz import coordinate_system
        header = laspy.LasHeader(point_format=6, version='1.4')
        with self.assertRaisesRegex(ValueError, 'vertical units'):
            coordinate_system(header, {'horizontal_crs': 'EPSG:32631'})
        crs, factor = coordinate_system(header, {'horizontal_crs': 'EPSG:32631', 'vertical_units': 'us-ft'})
        self.assertAlmostEqual(factor, 1200/3937)
        header.add_crs(CRS('EPSG:32631+5703'))
        self.assertEqual(coordinate_system(header, {'vertical_units': 'ft'})[1], 1)

    def test_stac_api_search_relative_next_duplicate_and_outside_items(self):
        root = {'type': 'Catalog', 'links': [{'rel': 'search', 'href': './search'}]}
        pages = [root, {'type': 'FeatureCollection', 'features': [self.stac_item()],
                       'links': [{'rel': 'next', 'href': '?page=2'}]},
                 {'type': 'FeatureCollection', 'features': [self.stac_item(), self.stac_item('outside', bbox=[0, 0, 1, 1])], 'links': []}]
        fetch = Mock(json=Mock(side_effect=pages))
        failures = []
        sources = list(discover_stac(fetch, self.bbox, 'https://test/api/', failures, lambda _: None))
        self.assertFalse(failures)
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]['format'], 'COPC')
        self.assertEqual(len(sources[0]['tiles']), 1)
        self.assertIn('bbox', parse_qs(urlparse(fetch.json.call_args_list[1].args[0]).query))
        self.assertEqual(fetch.json.call_args_list[2].args[0], 'https://test/api/search?page=2')
        fetch.download.assert_not_called()
        fetch.range.assert_not_called()

    def test_stac_post_pagination_merges_query_and_preserves_las_consent(self):
        fetch = Mock()
        fetch.json.return_value = {'type': 'Catalog', 'links': [{'rel': 'search', 'href': 'search', 'method': 'POST'}]}
        fetch.json_request.side_effect = [
            {'type': 'FeatureCollection', 'features': [self.stac_item(format='LAS')],
             'links': [{'rel': 'next', 'href': 'search', 'method': 'POST', 'merge': True, 'body': {'token': 'next'}}]},
            {'type': 'FeatureCollection', 'features': [], 'links': []}]
        failures = []
        sources = list(discover_stac(fetch, self.bbox, 'https://test/api/', failures, lambda _: None))
        self.assertFalse(failures)
        self.assertEqual(sources[0]['format'], 'LAS')
        self.assertEqual(fetch.json_request.call_args_list[1].args[1]['bbox'], self.bbox)
        self.assertEqual(fetch.json_request.call_args_list[1].args[1]['token'], 'next')
        fetch.download.assert_not_called()
        fetch.range.assert_not_called()

    def test_static_stac_collection_license_and_epoch_isolation(self):
        collection = {'type': 'Collection', 'id': 'survey', 'license': 'CC-BY-4.0',
                      'links': [{'rel': 'item', 'href': 'old.json'}, {'rel': 'item', 'href': 'new.json'}]}
        fetch = Mock(json=Mock(side_effect=[collection, self.stac_item('old', datetime='2010-01-01T00:00:00Z'), self.stac_item('new')]))
        sources = list(discover_stac(fetch, self.bbox, 'https://test/catalog.json', [], lambda _: None))
        self.assertEqual(len(sources), 2)
        self.assertTrue(all(s['license'] == 'CC-BY-4.0' for s in sources))
        self.assertNotEqual(sources[0]['fingerprint'], sources[1]['fingerprint'])

    def test_publication_time_is_not_acquisition_density_uses_crs_units(self):
        meta = stac_metadata({'created': '2025-01-01T00:00:00Z', 'pc:density': 1, 'proj:epsg': 2263})
        self.assertNotIn('acquisition_start', meta['survey_metadata'])
        self.assertAlmostEqual(meta['survey_metadata']['point_density_m2'], 1/(1200/3937)**2)
        meta = stac_metadata({'pc:density': 100, 'proj:epsg': 4326})
        self.assertNotIn('point_density_m2', meta['survey_metadata'])

    def test_broken_provider_does_not_remove_other_candidates(self):
        src = candidate('test', 'id', 'scan', 'https://test/ept.json', 'EPT', box(*self.bbox))
        with patch.dict(acquisition.PROVIDERS, {'usgs': Mock(return_value=iter([src])),
                'flai': Mock(side_effect=OSError('unavailable'))}), \
                patch.object(acquisition, 'enrich_sources'), patch.object(acquisition, 'enrich_provenance'):
            sources, failures = acquisition.discover_sources(Mock(), self.bbox, discovery={'providers': ['usgs', 'flai']})
        self.assertEqual(len(sources), 1)
        self.assertEqual(failures[0]['source'], 'flai')

    def test_rank_copc_quality_then_ept_tie_and_no_marginal_las_upgrade(self):
        ept = candidate('one', 'a', 'a', 'https://test/ept.json', 'EPT', box(*self.bbox), survey_metadata={'point_spacing_m': 1})
        copc = candidate('two', 'b', 'b', 'https://test/b.copc.laz', 'COPC', box(*self.bbox), survey_metadata={'point_spacing_m': .5})
        las = candidate('three', 'c', 'c', 'https://test/c.las', 'LAS', box(*self.bbox), survey_metadata={'point_spacing_m': .45})
        self.assertIs(rank_sources([ept, copc, las])[0][0], copc)
        copc['survey_metadata'] = ept['survey_metadata']
        self.assertIs(rank_sources([copc, ept])[0][0], ept)

    def test_copc_duplicate_staged_delivery_only_admitted_for_actual_delivery_gap(self):
        identity = {'datasets': ['test:scan']}
        copc = candidate('test', 'scan', 'scan', 'https://test/a.copc.laz', 'COPC', box(*self.bbox), survey_identity=identity)
        las = candidate('test', 'scan', 'scan', 'https://test/a.las', 'LAS', box(*self.bbox), survey_identity=identity)
        features = [{'id': 'a'}]
        plan = AcquisitionPlan([copc, las], features, {'a': box(*self.bbox)})
        plan.observe(copc, features, {}, {'a': 'insufficient_ground'}, {'points': 100, 'nodes': 2})
        self.assertFalse(plan.admission('a', las)[0])
        plan.observe(copc, features, {}, {'a': 'insufficient_ground'}, {'points': 0, 'nodes': 0})
        self.assertTrue(plan.admission('a', las)[0])

    def test_candidate_revision_normalization_and_provider_settings_change_identity(self):
        a = candidate('test', 'scan', 'scan', 'https://test/a.copc.laz', 'COPC', box(*self.bbox), vertical_units='m')
        b = candidate('test', 'scan', 'scan', 'https://test/a.copc.laz', 'COPC', box(*self.bbox), vertical_units='ft')
        self.assertNotEqual(a['fingerprint'], b['fingerprint'])
        self.assertIn('flai', discovery_settings()['providers'])
        self.assertEqual(asset_format('https://test/data?token=123', 'application/vnd.laszip+copc'), 'COPC')
        with self.assertRaises(ValueError):
            discovery_settings(stac_urls=['http://test'])

    def index_fixture(self, fields):
        shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
        writer = shapefile.Writer(shp=shp, shx=shx, dbf=dbf)
        for key in fields:
            writer.field(key, 'C', size=200)
        # Clockwise exterior rings, matching ESRI's convention.
        for bounds, record in [(self.bbox, fields), ([10, 10, 11, 11], {k: 'outside.copc.laz' for k in fields})]:
            w, s, e, n = bounds
            writer.poly([[(w, s), (w, n), (e, n), (e, s), (w, s)]])
            writer.record(**record)
        writer.close()
        return shp.getvalue(), dbf.getvalue()

    def test_flai_published_inventory_and_sparse_index_rows_no_point_requests(self):
        text = '| Test survey | 4326 | data/XX/Agency/Scan_2022/copc | 2022-01-01 | 2022-12-31 | 10 | CC-BY-4.0 |'
        self.assertEqual(len(list(inventory(text))), 1)
        shp, dbf = self.index_fixture({'fname': 'inside.copc.laz'})
        key = 'data/XX/Agency/Scan_2022/shp/index.shp'
        listing = f'<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>{key}</Key><ETag>revision</ETag></Contents></ListBucketResult>'.encode()
        fetch = Mock()
        def get(url, **kwargs):
            if url == INVENTORY_URL:
                return text.encode()
            if url.endswith('.shp'):
                return shp
            if 'list-type' in url:
                return listing
            raise AssertionError('Unexpected discovery download: ' + url)
        fetch.get.side_effect = get
        fetch.range.side_effect = lambda url, start, size: (shp if url.endswith('.shp') else dbf)[start:start+size]
        failures = []
        sources = list(discover_flai(fetch, self.bbox, failures, lambda _: None))
        self.assertFalse(failures)
        self.assertEqual(len(sources), 1)
        self.assertEqual(len(sources[0]['tiles']), 1)
        self.assertTrue(sources[0]['tiles'][0]['url'].endswith('/copc/inside.copc.laz'))
        fetch.download.assert_not_called()
        self.assertTrue(all(not c.args[0].endswith('.laz') for c in fetch.range.call_args_list))

    def test_opentopography_catalog_to_projected_tile_index_never_reads_las(self):
        from jarvizar_city_model.external.lidar_opentopography import discover_opentopography
        shp, dbf = self.index_fixture({'URL': 'https://test/inside.las'})
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr('index.shp', shp)
            archive.writestr('index.dbf', dbf)
            archive.writestr('index.prj', CRS(4326).to_wkt())
        document = {'Datasets': [{'Dataset': {'name': 'Survey', 'alternateName': 'scan',
            'identifier': {'value': 'test.scan'}, 'url': 'https://test/source',
            'temporalCoverage': '2020-01-01 / 2020-12-31',
            'spatialCoverage': {'geo': {'geojson': {'features': [{'geometry': mapping(box(*self.bbox))}]}}}}}]}
        fetch = Mock(json=Mock(return_value=document), get=Mock(return_value=stream.getvalue()))
        failures = []
        sources = list(discover_opentopography(fetch, self.bbox, failures, lambda _: None))
        self.assertFalse(failures)
        self.assertEqual(sources[0]['format'], 'LAS')
        self.assertEqual(len(sources[0]['tiles']), 1)
        self.assertEqual(sources[0]['survey_metadata']['acquisition_start'], '2020-01-01')
        fetch.download.assert_not_called()
        fetch.range.assert_not_called()

    def test_stac_thumbnail_and_broken_pagination_are_not_point_clouds(self):
        item = self.stac_item(**{'pc:encoding': 'copc'})
        item['assets']['thumbnail'] = {'href': 'thumbnail.png', 'roles': ['thumbnail']}
        fetch = Mock(json=Mock(return_value={'type': 'FeatureCollection', 'features': [item],
                     'links': [{'rel': 'next', 'href': 'https://test/search'}]}))
        failures = []
        sources = list(discover_stac(fetch, self.bbox, 'https://test/search', failures, lambda _: None))
        self.assertEqual(len(sources), 1)
        self.assertEqual(len(sources[0]['tiles']), 1)
        self.assertIn('Repeated', failures[0]['reason'])

    def test_reported_single_year_dates_undated_points_without_overwriting_gps(self):
        source = {'url': 'https://test/scan.copc.laz', 'format': 'COPC',
                  'survey_metadata': {'acquisition_start': '2020-01-01', 'acquisition_end': '2020-12-31'}}
        raw = np.array([[3, 49.65, 100, 2, 1, 0, 0]], dtype=float)
        with patch.object(acquisition, 'read_copc', side_effect=lambda *a: (raw.copy(), {})):
            points, _ = acquisition.read_source(Mock(), source, self.bbox)
            self.assertEqual(list(points[0, 5:]), [2020, .75])
            source['survey_metadata']['acquisition_end'] = '2021-12-31'
            points, _ = acquisition.read_source(Mock(), source, self.bbox)
            self.assertEqual(points[0, 5], 0)
            raw[0, 5:] = [2019, 1]
            source['survey_metadata']['acquisition_end'] = '2020-12-31'
            points, _ = acquisition.read_source(Mock(), source, self.bbox)
            self.assertEqual(list(points[0, 5:]), [2019, 1])


if __name__ == '__main__':
    unittest.main()
