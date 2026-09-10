"""Official index contracts, normalization, duplicate scope and staged ZIP delivery."""
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse
import zipfile

try:
    import numpy as np
    from shapely.geometry import box, mapping
    from jarvizar_city_model.external import lidar_services as services
    from jarvizar_city_model.external import lidar_france as france, lidar_canada as canada
    from jarvizar_city_model.external import lidar_england as england, lidar_germany as germany
    from jarvizar_city_model.external import lidar_spain as spain, lidar_scotland as scotland
    from jarvizar_city_model.external import lidar_acquisition as acquisition
    from jarvizar_city_model.external.lidar_ept import Fetcher
    from jarvizar_city_model.external.lidar_identity import same_survey, original_asset_id
    from jarvizar_city_model.external.lidar_provenance import enrich_asset_provenance
    from jarvizar_city_model.external.lidar_ranking import rank_sources, AcquisitionPlan, material_advantages, selection_thresholds
    from jarvizar_city_model.external.lidar_metadata import normalized_metadata
    from jarvizar_city_model.external.lidar_normalize import classifications
    from jarvizar_city_model.external.lidar_archives import fetch_tile
    from test_lidar_international import copc_fixture
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class OfficialTests(unittest.TestCase):
    bbox = [2, 48, 2.01, 48.01]

    def feature(self, i, bounds=None, **props):
        return dict(type='Feature', id=i, geometry=mapping(box(*(bounds or self.bbox))), properties=props)

    def fetch(self, *rows):
        return Mock(get=Mock(return_value=json.dumps(dict(type='FeatureCollection', features=list(rows))).encode()))

    def test_wfs_pages_server_capped_results_and_explicit_axis_order(self):
        pages = [dict(type='FeatureCollection', features=[self.feature(i)], numberMatched='2') for i in (1, 2)]
        fetch = Mock(get=Mock(side_effect=[json.dumps(p).encode() for p in pages]))
        self.assertEqual(len(list(services.features(fetch, 'https://test/wfs', self.bbox, layer='tiles'))), 2)
        queries = [parse_qs(urlparse(c.args[0]).query) for c in fetch.get.call_args_list]
        self.assertEqual([q['startIndex'] for q in queries], [['0'], ['1']])
        self.assertEqual(queries[0]['srsName'], ['CRS:84'])
        self.assertTrue(queries[0]['bbox'][0].endswith(',CRS:84'))
        self.assertEqual(fetch.get.call_args.kwargs['attempts'], 1)

    def test_catalog_errors_repeated_pages_and_wrong_crs_fail_closed(self):
        bad = dict(type='FeatureCollection', features=[self.feature(1)], numberMatched=2)
        fetch = Mock(get=Mock(return_value=json.dumps(bad).encode()))
        with self.assertRaisesRegex(ValueError, 'repeated'):
            list(services.features(fetch, 'https://test/wfs', self.bbox))
        for document in ({'error': {'code': 500}}, {**bad, 'crs': {'properties': {'name': 'EPSG:2154'}}}):
            with self.subTest(document=document), self.assertRaises(ValueError):
                list(services.features(Mock(get=Mock(return_value=json.dumps(document).encode())), 'https://test', self.bbox))
        with self.assertRaisesRegex(ValueError, 'reported feature count'):
            list(services.features(Mock(get=Mock(return_value=json.dumps({**bad, 'features': []}).encode())), 'https://test', self.bbox))

    def test_arcgis_filters_exact_footprints_without_point_requests(self):
        fetch = self.fetch(self.feature(1, value='in'), self.feature(2, bounds=[0, 0, 1, 1]))
        rows = list(services.features(fetch, 'https://test/query', self.bbox, arcgis=True))
        self.assertEqual([r[0]['value'] for r in rows], ['in'])
        self.assertEqual(parse_qs(urlparse(fetch.get.call_args.args[0]).query)['outSR'], ['4326'])
        fetch.range.assert_not_called()
        fetch.download.assert_not_called()

    def test_france_range_endpoint_dates_processing_and_custom_classes(self):
        base = dict(code_mission='survey', date_debut_acquisition='2023-03-03', date_fin_acquisition='2023-03-03',
                    date_edition='2026-01-01', systeme_planimetrique='LAMB93', systeme_altimetrique='IGN69', nombre_points=100000)
        fetch = self.fetch(*[self.feature(i, **base, procede_classement=level,
            url_npl=f'https://data.geopf.fr/telechargement/download/dataset/{i}.copc.laz')
            for i, level in enumerate(('AUTOMATIQUE', 'MANUEL'))])
        sources = list(france.discover_france(fetch, self.bbox, [], lambda _: None))
        selected = rank_sources(sources)[0][0]
        self.assertEqual(selected['survey_metadata']['classification_quality'], 1)
        self.assertEqual(selected['survey_metadata']['acquisition_start'], '2023-03-03')
        self.assertIn('/chunk/telechargement/', selected['tiles'][0]['url'])
        self.assertEqual(selected['horizontal_crs'], 'EPSG:2154')
        np.testing.assert_equal(classifications(Mock(classification=np.array([1, 2, 6, 64, 66, 67])), metadata=selected), [1, 2, 6, 0, 0, 1])
        fetch.download.assert_not_called()

    def test_canada_documented_collection_end_not_project_year(self):
        name = 'ON_TRCA2023_20230511_NAD83CSRS_UTMZ17_1km_E6290_N48340_CLASS.copc.laz'
        fetch = self.fetch(self.feature(1, provider='publisher', project='old-name-2001', url='https://test/' + name))
        source = list(canada.discover_canada(fetch, self.bbox, [], lambda _: None))[0]
        self.assertEqual(source['survey_metadata']['acquisition_end'], '2023-05-11')
        self.assertNotIn('acquisition_start', source['survey_metadata'])
        self.assertIsNone(canada.collection_end('https://test/20230511.copc.laz'))
        self.assertIsNone(canada.collection_end('https://test/ON_20239999_NAD83CSRS_UTM17_1km_E0_N0_CLASS.copc.laz'))
        self.assertEqual(source['vertical_datum'], 'CGVD2013')
        newer = {**source, 'survey_metadata': normalized_metadata({'acquisition_end': '2025-01-01'})}
        self.assertIs(rank_sources([source, newer])[0][0], newer)
        self.assertFalse(material_advantages(newer, source, selection_thresholds()))

    def test_english_join_requires_point_product_year_grid_and_index(self):
        uri = 'https://test/delivery'
        delivery = dict(product={'id': 'national_lidar_programme_point_cloud'}, year={'id': '2020'}, tile={'id': 'TQ3080'}, uri=uri)
        fetch = Mock(get=Mock(return_value=json.dumps(dict(count=2, results=[delivery,
            {**delivery, 'product': {'id': 'lidar_composite_dtm'}}])).encode()))
        row = dict(pnt_fn='TQ3080_P_1234_20200101_20200102.laz', tilename='TQ3080', year=2020,
                   polygon_id='P_1234', sd_flown='2020-01-01', ed_flown='2020-01-02')
        with patch.object(england, 'features', return_value=[(row, box(*self.bbox)), ({**row, 'tilename': 'TQ4080'}, box(*self.bbox))]):
            sources = list(england.discover_england(fetch, self.bbox, [], lambda _: None))
        self.assertEqual(len(sources), 1)
        self.assertEqual(len(sources[0]['tiles']), 1)
        tile = sources[0]['tiles'][0]
        self.assertEqual(tile['archive_url'], uri)
        self.assertEqual(tile['archive_member'], row['pnt_fn'])
        self.assertIn('5 km', sources[0]['delivery_note'])
        fetch.download.assert_not_called()

    def test_nrw_spatial_listing_and_class20_is_unclassified(self):
        name = '3dm_32_350_5650_1_nw'
        geometry = germany.grid_polygon(name + '.laz', r'3dm_32_(?P<x>\d{3})_(?P<y>\d{4})_1_nw\.laz')
        listing = f'<list><file name="{name}.laz" size="1234" timestamp="2025-01-01"/><file name="3dm_32_500_5900_1_nw.laz" size="456"/></list>'.encode()
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as z:
            z.writestr('3dm_nw.csv', f'Preface\nKachelname;Aktualitaet;Aufloesung;Koordinatenreferenzsystem_Hoehe\n{name};2022-01-01;4;DE_DHHN2016_NH\n')
        fetch = Mock(get=Mock(side_effect=[listing, stream.getvalue()]))
        source = list(germany.discover_nrw(fetch, geometry.buffer(-.001).bounds, [], lambda _: None))[0]
        self.assertEqual(len(source['tiles']), 1)
        self.assertEqual(source['survey_metadata']['acquisition_start'], '2022-01-01')
        np.testing.assert_equal(classifications(Mock(classification=np.array([1, 2, 6, 20, 21, 24, 26])), metadata=source), [1, 2, 0, 1, 0, 0, 0])

    def test_bavaria_uses_actual_metalink_urls_and_keeps_unknown_epochs_apart(self):
        fetch = Mock(get=Mock(return_value=b'<metalink><file name="691_5334.laz"><url>https://test/a.laz</url></file><file name="692_5334.laz"><url>https://test/b.laz</url></file></metalink>'))
        from shapely.ops import unary_union
        region = unary_union([germany.grid_polygon(n, r'(?P<x>\d{3})_(?P<y>\d{4})\.laz') for n in ('691_5334.laz', '692_5334.laz')])
        sources = list(germany.discover_bavaria(fetch, region.bounds, [], lambda _: None))
        self.assertEqual(len(sources), 2)
        self.assertTrue(fetch.get.call_args.kwargs['body'].startswith('SRID=4326;POLYGON'))
        self.assertEqual(fetch.get.call_args.kwargs['content_type'], 'text/plain')
        self.assertEqual({s['tiles'][0]['url'] for s in sources}, {'https://test/a.laz', 'https://test/b.laz'})

    def test_spain_uses_supplied_index_urls_and_documented_capture_schema(self):
        row = dict(FICHERO='PNOA_2019_CLM_NW_412-4414_ORT-CLA-RGB.laz', URL='https://test/download.laz')
        with patch.object(spain, 'features', return_value=[(row, box(*self.bbox))]):
            source = list(spain.discover_spain_clm(Mock(), self.bbox, [], lambda _: None))[0]
        self.assertEqual(source['tiles'][0]['url'], row['URL'])
        self.assertEqual(source['survey_metadata']['acquisition_end'], '2019-12-31')
        self.assertEqual(source['format'], 'LAZ')

    def test_scotland_uses_spatial_s3_prefix_not_guessed_downloads(self):
        self.assertEqual(scotland.grid_ref(530000, 180000), 'TQ3080')
        self.assertEqual(scotland.grid_ref(171000, 620000), 'NR7120')
        from pyproj import Transformer
        bbox = Transformer.from_crs(27700, 4326, always_xy=True).transform_bounds(171100, 620100, 171200, 620200)
        key = scotland.PREFIX + 'NR7120_10PPM_LAZ_ScotlandNationalLiDAR.laz'
        fetch = Mock(get=Mock(return_value=f'<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>{key}</Key><Size>1234</Size><ETag>abc</ETag></Contents></ListBucketResult>'.encode()))
        source = list(scotland.discover_scotland(fetch, bbox, [], lambda _: None))[0]
        self.assertEqual(source['tiles'][0]['url'], scotland.BUCKET + key)
        self.assertEqual(source['survey_metadata']['point_density_m2'], 10)
        self.assertNotIn('acquisition_start', source['survey_metadata'])
        fetch.download.assert_not_called()

    def test_metadata_ttl_refreshes_between_jobs_but_coalesces_within_job(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            url = 'https://test/index'
            path = cache / hashlib.sha256(url.encode()).hexdigest()
            path.write_bytes(b'old')
            os.utime(path, (1, 1))
            response = Mock()
            response.__enter__ = Mock(return_value=io.BytesIO(b'new'))
            response.__exit__ = Mock(return_value=False)
            with patch('urllib.request.urlopen', return_value=response) as opened:
                fetch = Fetcher(cache)
                self.assertEqual(fetch.get(url, ttl=86400), b'new')
                self.assertEqual(fetch.get(url, ttl=0), b'new')
                opened.assert_called_once()

    def test_zip_extracts_only_named_member_and_reuses_shared_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'delivery.zip'
            cloud = copc_fixture()
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('nested/wanted.laz', cloud)
                z.writestr('../unselected.laz', b'not a cloud')
            fetch = Fetcher(root)
            fetch.download = Mock(return_value=archive)
            member = dict(url='https://test/archive#member=wanted.laz', archive_url='https://test/archive', archive_member='wanted.laz')
            path = fetch_tile(fetch, member)
            self.assertEqual(path.read_bytes(), cloud)
            self.assertEqual(path.parent, root)
            self.assertEqual(fetch_tile(fetch, member), path)
            fetch.download.assert_called_once()
            self.assertFalse((root.parent / 'unselected.laz').exists())
            with self.assertRaisesRegex(ValueError, 'unambiguous'):
                fetch_tile(fetch, {**member, 'url': 'https://test/archive#missing', 'archive_member': 'missing.laz'})

    def test_failed_shared_delivery_is_not_retried_for_every_building_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            fetch = Fetcher(Path(directory))
            with patch.object(fetch, '_download', side_effect=TimeoutError('offline')) as transfer:
                for _ in range(3):
                    with self.assertRaises(OSError):
                        fetch.download('https://test/tile.zip')
                transfer.assert_called_once()
            # Failures are job-local; a new preparation is a deliberate retry.
            with patch.object(Fetcher, '_download', return_value=Path(directory) / 'good') as transfer:
                Fetcher(Path(directory)).download('https://test/tile.zip')
                transfer.assert_called_once()

    def test_corrupt_zip_is_a_recoverable_source_error_and_publishes_no_tile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'bad.zip'
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as z:
                z.writestr('wanted.laz', copc_fixture())
            valid = stream.getvalue()
            with zipfile.ZipFile(io.BytesIO(valid)) as z:
                info = z.getinfo('wanted.laz')
            damaged = bytearray(valid)
            damaged[info.header_offset + 30 + len(info.filename) + len(info.extra) + info.file_size - 1] ^= 1
            for data in (b'PK\x03\x04truncated', damaged):
                path.write_bytes(data)
                fetch = Fetcher(root)
                fetch.download = Mock(return_value=path)
                with self.assertRaisesRegex(ValueError, 'Invalid point-cloud ZIP'):
                    fetch_tile(fetch, dict(url='https://test/zip#member=wanted.laz', archive_url='https://test/zip', archive_member='wanted.laz'))
                self.assertEqual([p.name for p in root.iterdir()], ['bad.zip'])

    def test_duplicate_scope_and_stream_failure_fallback(self):
        def source(name, fmt, bounds, asset):
            s = services.candidate(name, name, name, f'https://test/{name}', fmt, box(*bounds),
                tiles=[dict(url=f'https://test/{name}.laz', bbox=bounds, original_asset_id=asset)], catalog_coverage=1)
            s['survey_identity'] = {'datasets': [name + ':id']}
            return s
        left = source('original', 'COPC', [0, 0, 2, 2], 'ea:unique-survey-tile')
        right = source('mirror', 'COPC', [0, 0, 1, 1], 'ea:unique-survey-tile')
        enrich_asset_provenance([left, right], lambda _: None)
        self.assertTrue(same_survey(left, right, box(.1, .1, .2, .2)))
        self.assertFalse(same_survey(left, right, box(.5, .5, 1.5, 1.5)))
        features = [{'id': 'one'}]
        plan = AcquisitionPlan([left, right], features, {'one': box(.1, .1, .2, .2)})
        selected, batch, _ = plan.next(set())
        plan.observe(selected, batch, {}, {'one': 'insufficient_roof_points'}, {'points': 100})
        self.assertIsNone(plan.next(set()))
        plan = AcquisitionPlan([left, right], features, {'one': box(.1, .1, .2, .2)})
        plan.next(set())  # Default outcome is a failed transfer, not sparse data.
        self.assertIsNotNone(plan.next(set()))

    def test_original_asset_identifiers_require_acquisition_specific_schema(self):
        name = 'TQ3080_P_1234_20200101_20200102'
        self.assertEqual(original_asset_id('ea', name + '.laz'), original_asset_id('ea', name + '.copc.laz'))
        self.assertIsNone(original_asset_id('ea', 'TQ3080.laz'))
        self.assertIsNone(original_asset_id('unknown', name + '.laz'))

    def test_official_authority_only_breaks_quality_ties(self):
        def s(name, **meta):
            return dict(url='https://test/' + name, name=name, format='COPC', catalog_coverage=1, survey_metadata=normalized_metadata(meta))
        official, mirror = s('official', acquisition_year=2020), s('mirror', acquisition_year=2020)
        official['authoritative'] = True
        self.assertIs(rank_sources([mirror, official])[0][0], official)
        mirror['survey_metadata'] = normalized_metadata({'acquisition_year': 2023})
        self.assertIs(rank_sources([mirror, official])[0][0], mirror)

    def test_failed_official_provider_does_not_disable_other_discovery(self):
        good = services.candidate('Good', 'survey', 'survey', 'https://test/good.copc.laz', 'COPC', box(*self.bbox))
        with patch.dict(acquisition.PROVIDERS, {'ign_france': Mock(side_effect=OSError('offline')), 'nrcan': Mock(return_value=[good])}), patch.object(acquisition, 'enrich_provenance'):
            sources, failures = acquisition.discover_sources(Mock(), self.bbox, discovery={'providers': ['ign_france', 'nrcan']})
        self.assertEqual(sources[0]['name'], 'survey')
        self.assertEqual(failures[0]['source'], 'ign_france')


if __name__ == '__main__':
    unittest.main()
