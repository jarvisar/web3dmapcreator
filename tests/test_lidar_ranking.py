"""Metadata evidence, deterministic preference and actual acquisition admission."""
import importlib
import itertools
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from jarvizar_city_model.external.lidar_metadata import (
    normalized_metadata, aggregate_metadata, fgdc_metadata, read_report,
)
from jarvizar_city_model.external.lidar_ranking import rank_sources, selection_thresholds

try:
    import numpy as np
    from shapely.geometry import box, mapping
    from jarvizar_city_model.external import lidar_acquisition as acquisition
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


def source(name, format='EPT', **metadata):
    return {'url': f'https://example.com/{name}/' + ('ept.json' if format == 'EPT' else ''),
            'name': name, 'format': format, 'catalog_coverage': 1,
            'survey_metadata': normalized_metadata(metadata)}


class RankingTests(unittest.TestCase):
    def first(self, *sources, thresholds=None):
        return rank_sources(sources, thresholds)[0][0]['name']

    def test_ept_preferred_for_equal_and_marginal_improvements(self):
        ept = source('ept', acquisition_year=2021, point_spacing_m=.7, point_density_m2=4,
                     vertical_rmse_m=.15, horizontal_rmse_m=.3)
        laz = source('laz', 'LAZ', acquisition_year=2023, point_spacing_m=.6, point_density_m2=5,
                     vertical_rmse_m=.12, horizontal_rmse_m=.25)
        self.assertEqual(self.first(ept, laz), 'ept')

    def test_clearly_superior_laz_by_each_independent_quality_metric(self):
        for key, poor, better in [('point_spacing_m', 1.5, .5), ('point_density_m2', 2, 8),
                                 ('horizontal_rmse_m', .6, .15), ('vertical_rmse_m', .3, .1),
                                 ('vertical_accuracy_m', .4, .1), ('horizontal_accuracy_m', 1, .25)]:
            with self.subTest(key=key):
                basis = {key.replace('_m', '_basis'): '95% confidence'} if 'accuracy' in key else {}
                self.assertEqual(self.first(source('ept', **{key: poor}, **basis),
                    source('laz', 'LAZ', **{key: better}, **basis)), 'laz')

    def test_accuracy_requires_same_axis_and_statistic_and_confidence(self):
        ept = source('ept', point_spacing_m=2, vertical_rmse_m=.4, horizontal_accuracy_m=1,
                     horizontal_accuracy_basis='90% confidence')
        laz = source('laz', 'LAZ', horizontal_rmse_m=.01, vertical_accuracy_m=.01,
                     horizontal_accuracy_m=.1, horizontal_accuracy_basis='95% confidence')
        self.assertEqual(self.first(laz, ept), 'ept')
        self.assertEqual(self.first(
            source('a', vertical_accuracy_m=.4, vertical_accuracy_basis='95% confidence'),
            source('z', vertical_accuracy_m=.1, vertical_accuracy_basis='95% confidence')), 'z')

    def test_substantially_older_ept_and_uncertain_acquisition_intervals(self):
        laz = source('laz', 'LAZ', acquisition_year=2024)
        self.assertEqual(self.first(source('ept', acquisition_year=2016), laz), 'laz')
        # Five calendar labels apart can mean only four years; retain EPT.
        self.assertEqual(self.first(source('ept', acquisition_year=2019), laz), 'ept')
        broad = source('ept', acquisition_start='2014-01-01', acquisition_end='2022-12-31')
        self.assertEqual(self.first(broad, laz), 'ept')

    def test_missing_metadata_does_not_purchase_laz_or_use_publication_dates(self):
        ept = source('ept', publicationDate='2000-01-01', title='Project_1999')
        laz = source('laz', 'LAZ', publicationDate='2026-01-01', acquisition_year=2024,
                     point_spacing_m=.1, point_density_m2=100)
        self.assertEqual(self.first(ept, laz), 'ept')
        self.assertFalse(ept['survey_metadata'])

    def test_ties_are_independent_of_catalog_order(self):
        sources = [source('z'), source('a'), source('new', 'LAZ')]
        for permutation in itertools.permutations(sources):
            self.assertEqual(self.first(*permutation), 'a')

    def test_spacing_and_density_use_a_consistent_resolution_scale(self):
        self.assertEqual(self.first(source('a', point_spacing_m=.5),
                                   source('z', point_density_m2=8)), 'z')
        # Equivalent resolution returns to the stable URL tie-break.
        self.assertEqual(self.first(source('z', point_spacing_m=.5),
                                   source('a', point_density_m2=4)), 'a')

    def test_classification_availability_and_reported_quality(self):
        laz = source('laz', 'LAZ', ground_class=True, building_class=True)
        self.assertEqual(self.first(source('ept', ground_class=True, building_class=False), laz), 'laz')
        self.assertEqual(self.first(source('ept'), laz), 'ept')  # unknown != absent
        self.assertEqual(self.first(source('ept', classification_quality=.6, classification_basis='validated fraction'),
            source('laz', 'LAZ', classification_quality=.95, classification_basis='validated fraction')), 'laz')
        self.assertEqual(self.first(source('ept', ground_class=False), laz), 'laz')
        self.assertEqual(self.first(source('ept', classification_quality=0, classification_basis='validated fraction'),
            source('laz', 'LAZ', classification_quality=.9, classification_basis='validated fraction')), 'laz')

    def test_thresholds_require_relative_and_absolute_improvement_and_are_configurable(self):
        self.assertEqual(self.first(source('ept', vertical_rmse_m=.02),
                                   source('laz', 'LAZ', vertical_rmse_m=.001)), 'ept')
        ept, laz = source('ept', acquisition_year=2020), source('laz', 'LAZ', acquisition_year=2024)
        self.assertEqual(self.first(ept, laz, thresholds={'age_difference_years': 2}), 'laz')
        for overrides in ({'bad': 1}, {'spacing_ratio': 1}, {'adequate_coverage': 2},
                          {'age_difference_years': float('nan')}, {'density_ratio': True}):
            with self.assertRaises(ValueError):
                selection_thresholds(overrides)


class MetadataTests(unittest.TestCase):
    def test_explicit_units_dates_and_no_invented_accuracy(self):
        metadata = normalized_metadata({'pointSpacing': {'value': 2, 'unit': 'ft'},
            'pointDensity': {'value': 8, 'unit': 'points/m2'}, 'vertical_rmse_m': .1,
            'acquisitionDate': '2020-02', 'publicationDate': '2026', 'classifications': [1, 2, 6]})
        self.assertAlmostEqual(metadata['point_spacing_m'], .6096)
        self.assertEqual(metadata['point_density_m2'], 8)
        self.assertEqual(metadata['acquisition_end'], '2020-02-29')
        self.assertTrue(metadata['ground_class'])
        self.assertNotIn('horizontal_accuracy_m', metadata)
        self.assertFalse(normalized_metadata({'pointSpacing': .5, 'span': 256, 'scale': .01,
            'points': 100000, 'creation_year': 2024, 'acquisition_date': '2022-02-30'}))

    def test_incomplete_or_mixed_tile_metadata_is_conservative(self):
        a = normalized_metadata({'acquisition_year': 2018, 'point_spacing_m': .5, 'vertical_rmse_m': .1})
        b = normalized_metadata({'acquisition_year': 2020, 'point_spacing_m': 1})
        meta = aggregate_metadata([a, b])
        self.assertEqual(meta['acquisition_start'], '2018-01-01')
        self.assertEqual(meta['acquisition_end'], '2020-12-31')
        self.assertEqual(meta['point_spacing_m'], 1)
        self.assertNotIn('vertical_rmse_m', meta)
        self.assertFalse(aggregate_metadata([a, {}]))

    def test_fgdc_uses_ground_time_and_tested_accuracy_not_specification(self):
        xml = b'''<metadata><idinfo><citation><citeinfo><pubdate>2026</pubdate></citeinfo></citation>
          <timeperd><timeinfo><rngdates><begdate>20170416</begdate><enddate>20170507</enddate></rngdates></timeinfo>
          <current>ground condition</current></timeperd>
          <descript><abstract>Nominal pulse spacing (NPS) of 1 point every 0.35 meters.</abstract></descript></idinfo>
          <dataqual><posacc><vertacc><vertaccr>Required RMSE is 10 cm.</vertaccr><qvertpa>
          <vertaccv>0.101</vertaccv><vertacce>Tested 0.101 meters NVA at a 95% confidence level using RMSE(z) x 1.96.</vertacce>
          </qvertpa></vertacc></posacc></dataqual></metadata>'''
        meta = fgdc_metadata(xml)
        self.assertEqual(meta['acquisition_start'], '2017-04-16')
        self.assertEqual(meta['point_spacing_m'], .35)
        self.assertEqual(meta['vertical_accuracy_m'], .101)
        self.assertEqual(meta['vertical_accuracy_basis'], '95% confidence')
        self.assertNotIn('vertical_rmse_m', meta)
        self.assertNotIn('acquisition_start', fgdc_metadata(xml.replace(b'ground condition', b'publication date')))

    def test_metadata_landing_pages_and_ambiguous_units_stay_unknown(self):
        fetch = Mock()
        self.assertEqual(read_report(fetch, 'https://example.com/catalog/item'), {})
        fetch.get.assert_not_called()
        self.assertEqual(normalized_metadata({'pointSpacing': {'value': .5, 'unit': 'unknown'},
                                              'vertical_accuracy_m': float('inf')}), {})
        with self.assertRaises(ValueError):
            fgdc_metadata(b'<!DOCTYPE metadata [<!ENTITY a "x">]><metadata/>')

    def test_s3_metadata_links_are_listed_and_reports_deduplicated(self):
        listing = b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Contents><Key>survey/best_use_xml/report.xml</Key></Contents></ListBucketResult>'
        fetch = Mock(get=Mock(side_effect=[listing, b'<metadata/>']))
        read_report(fetch, 'https://prd-tnm.s3.amazonaws.com/index.html?prefix=survey')
        self.assertIn('prefix=survey%2Fbest_use_xml%2F', fetch.get.call_args_list[0].args[0])
        self.assertTrue(fetch.get.call_args_list[1].args[0].endswith('/survey/best_use_xml/report.xml'))
        fetch.download.assert_not_called()


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class AcquisitionAdmissionTests(unittest.TestCase):
    def run_worker(self, mode):
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature
        external = str(Path(__file__).resolve().parents[1] / 'jarvizar_city_model/external')
        with patch.object(sys, 'path', [external] + sys.path):
            worker = importlib.import_module('download_lidar')
            adapter = importlib.import_module('lidar_acquisition')
            measurements = importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        with tempfile.TemporaryDirectory() as temp:
            bundle = CacheBundle(Path(temp), Bounds(-74, 40, -73.9, 40.1))
            bundle.ensure_directory()
            features = [{'id': name, 'properties': {}, 'geometry': mapping(box(x, 40.02, x+.001, 40.021))}
                        for name, x in [('west', -73.99), ('east', -73.92)]]
            bundle.data_path('building').write_text(json.dumps({'features': features}))
            bundle.data_path('building_part').write_text('{"features": []}')
            ept = source('ept', acquisition_year=2016 if mode == 'outdated' else 2022,
                         point_spacing_m=2 if mode == 'quality' else .7)
            ept['coverage'] = box(-74, 40, -73.95 if mode == 'incomplete' else -73.9, 40.1)
            laz = adapter.grouped_laz([
                {'url': f'https://example.com/laz/{name}.laz', 'bbox': bounds}
                for name, bounds in [('west', [-74, 40, -73.95, 40.1]), ('east', [-73.95, 40, -73.9, 40.1])]])[0]
            laz.update(survey_metadata=normalized_metadata({'acquisition_year': 2024, 'point_spacing_m': .5}), catalog_coverage=1)
            spare = {**source('spare', 'LAZ'), 'coverage': box(-74, 40, -73.9, 40.1), 'tiles': [
                {'url': 'https://example.com/spare/all.laz', 'bbox': [-74, 40, -73.9, 40.1]}]}
            if mode == 'missing':
                ept['survey_metadata'] = {}
            if mode == 'partial_superior':
                laz['survey_metadata'] = normalized_metadata({'acquisition_year': 2024, 'point_spacing_m': .1})
                laz['coverage'] = box(-73.95, 40, -73.9, 40.1)
            current, reads, processed = [], [], []
            def read(fetch, selected, bbox):
                current[:] = [selected['format'], selected['name']]
                reads.append((selected['name'], bbox))
                if selected['format'] == 'EPT' and mode == 'failure':
                    raise OSError('EPT unavailable')
                if selected['format'] == 'LAZ':
                    for tile in selected['tiles']:
                        if box(*tile['bbox']).intersects(box(*bbox)):
                            fetch.download(tile['url'])
                return np.empty((0, 7)), {'url': selected['url'], 'classified_roof_fraction': 0}
            def measure(batch, *args, **kwargs):
                processed.extend((current[0], f['id']) for f in batch)
                records, rejected = {}, {}
                for f in batch:
                    if mode == 'gaps' and current[0] == 'EPT' and f['id'] == 'east':
                        rejected[f['id']] = 'insufficient_coverage'
                    elif mode.startswith('rejected:') and current[0] == 'EPT' and f['id'] == 'east':
                        rejected[f['id']] = mode.split(':', 1)[1]
                    elif mode == 'downgrade' and current[0] == 'EPT' and f['id'] == 'east':
                        rejected[f['id']] = 'unresolved_upper_roof' if current[1] == 'ept' else 'insufficient_roof_points'
                    else:
                        records[f['id']] = {'height_m': 30, 'tiers': []}
                return records, {}, rejected
            request = request_signature(bundle, .07, .077)
            sources = [spare, laz, ept]
            if mode == 'downgrade':
                sources.append({**source('older', acquisition_year=2000), 'coverage': ept['coverage']})
            with patch.object(adapter, 'discover_sources', side_effect=lambda *a, **kw: ([dict(s) for s in sources], [])), \
                 patch.object(adapter, 'read_source', side_effect=read), \
                 patch.object(measurements, 'measure_features', side_effect=measure), \
                 patch.object(adapter.lidar_ept.Fetcher, 'download', side_effect=lambda url, **kw: Path(url.rsplit('/', 1)[-1])) as transfer:
                first = worker.prepare(bundle.path, request)
                downloads = [c.args[0] for c in transfer.call_args_list]
                transfer.reset_mock()
                count = len(reads)
                second = worker.prepare(bundle.path, request)
                if mode != 'failure':
                    self.assertEqual(len(reads), count)
                transfer.assert_not_called()
                expected = 1 if mode.startswith('rejected:') or mode == 'downgrade' else 2
                self.assertEqual(first['buildings'], expected)
                self.assertEqual(second['buildings'], expected)
                if mode == 'marginal':
                    import hashlib
                    legacy_request = {k: v for k, v in request.items() if k != 'fallback_policy'}
                    for identifier in ('west', 'east'):
                        key = hashlib.sha256(json.dumps([legacy_request, ept['url'], '', '',
                            ept['survey_metadata'], [identifier]], sort_keys=True).encode()).hexdigest()
                        self.assertTrue((bundle.path / 'lidar_jobs' / (key + '.json')).is_file())
            return processed, downloads, json.loads((bundle.path / 'lidar_buildings.json').read_text())

    def test_ept_success_and_missing_metadata_never_download_overlapping_laz(self):
        for mode in ('marginal', 'missing'):
            with self.subTest(mode=mode):
                processed, downloads, _ = self.run_worker(mode)
                self.assertEqual(set(processed), {('EPT', 'west'), ('EPT', 'east')})
                self.assertFalse(downloads)

    def test_old_or_clearly_poor_ept_is_not_read_before_laz(self):
        for mode in ('outdated', 'quality'):
            with self.subTest(mode=mode):
                processed, downloads, _ = self.run_worker(mode)
                self.assertEqual(set(processed), {('LAZ', 'west'), ('LAZ', 'east')})
                self.assertEqual(len(downloads), 2)

    def test_incomplete_coverage_and_observed_gaps_only_fetch_gap_tiles(self):
        for mode in ('incomplete', 'gaps', 'partial_superior'):
            with self.subTest(mode=mode):
                processed, downloads, payload = self.run_worker(mode)
                self.assertIn(('EPT', 'west'), processed)
                self.assertIn(('LAZ', 'east'), processed)
                self.assertNotIn(('LAZ', 'west'), processed)
                self.assertEqual(downloads, ['https://example.com/laz/east.laz'])
                self.assertEqual(payload['buildings']['west']['source_format'], 'EPT')
                self.assertEqual(payload['buildings']['east']['source_format'], 'LAZ')
                self.assertFalse(payload['rejected'])

    def test_ept_read_failure_falls_back_without_trying_every_laz_survey(self):
        processed, downloads, payload = self.run_worker('failure')
        self.assertEqual(set(processed), {('LAZ', 'west'), ('LAZ', 'east')})
        self.assertEqual(len(downloads), 2)
        self.assertTrue(payload['failures'])

    def test_reconstruction_rejections_never_trigger_speculative_laz_even_on_resume(self):
        for reason in ('unresolved_upper_roof', 'footprint_roof_mismatch', 'roof_extends_outside_footprint',
                       'observed_ground_in_footprint', 'sparse_or_noisy_roof', 'complex_unclassified_roof',
                       'unprintable_major_tier', 'elevated_or_underground', 'incomplete_footprint_or_ground_halo',
                       'unknown_future_rejection'):
            with self.subTest(reason=reason):
                processed, downloads, payload = self.run_worker('rejected:' + reason)
                self.assertFalse(downloads)
                self.assertTrue(all(fmt == 'EPT' for fmt, _ in processed))
                self.assertEqual(payload['rejected']['east'], reason)
                self.assertTrue(any(s.get('skipped_fallback_reasons') for s in payload['discovered_sources']))

    def test_poorer_ept_cannot_turn_a_roof_fit_rejection_into_a_laz_gap(self):
        processed, downloads, payload = self.run_worker('downgrade')
        self.assertFalse(downloads)
        self.assertEqual(set(payload['buildings']), {'west'})

    def test_real_support_gaps_and_material_advantages_remain_eligible(self):
        from jarvizar_city_model.external.lidar_ranking import AcquisitionPlan
        for reason in ('insufficient_ground', 'insufficient_roof_points', 'source_read_failed'):
            ept = {**source('ept'), 'coverage': box(0, 0, 1, 1)}
            laz = {**source('laz', 'LAZ'), 'coverage': box(0, 0, 1, 1)}
            features = [{'id': 'one'}]
            plan = AcquisitionPlan([ept, laz], features, {'one': box(.1, .1, .2, .2)})
            self.assertEqual(plan.next(set())[0]['format'], 'EPT')
            plan.observe(ept, features, {}, {'one': reason})
            self.assertEqual(plan.next(set())[0]['format'], 'LAZ')
        ept['survey_metadata'] = normalized_metadata({'point_spacing_m': 2})
        laz['survey_metadata'] = normalized_metadata({'point_spacing_m': .5})
        plan.observe(ept, features, {}, {'one': 'unresolved_upper_roof'})
        self.assertTrue(plan.admission('one', laz)[0])
        plan.observe(ept, features, {}, {'one': 'elevated_or_underground'})
        self.assertFalse(plan.admission('one', laz)[0])

    def test_discovery_reads_metadata_once_before_any_laz_and_bounds_explicit_ept(self):
        bbox = [-74, 40, -73.9, 40.1]
        ept_url = 'https://example.com/ept/ept.json'
        report = 'https://example.com/survey.json'
        meta = {'dataType': 'laszip', 'hierarchyType': 'json', 'span': 256,
                'bounds': [-74, 40, 0, -73.95, 40.1, 100],
                'srs': {'authority': 'EPSG', 'horizontal': '4326', 'vertical': '5703'},
                'acquisition_year': 2016, 'point_spacing_m': 1.5}
        items = [{'sourceId': name, 'downloadURL': f'https://example.com/laz/{name}.laz',
                  'boundingBox': dict(zip(('minX', 'minY', 'maxX', 'maxY'), bbox)),
                  'vendorMetaUrl': report, 'publicationDate': '2026-01-01'} for name in ('a', 'b')]
        fetch = Mock(json=Mock(side_effect=lambda url, **kw: meta if url == ept_url else
            {'features': [{'geometry': mapping(box(*bbox)), 'properties': {'name': 'ept', 'url': ept_url}}]}
            if url == acquisition.lidar_ept.CATALOG_URL else {'items': items, 'total': 2}),
            get=Mock(return_value=b'{"acquisition_year": 2024, "point_spacing_m": 0.5}'))
        messages = []
        sources, failures = acquisition.discover_sources(fetch, bbox, progress=messages.append)
        self.assertFalse(failures)
        self.assertEqual(sources[0]['format'], 'LAZ')
        self.assertAlmostEqual(sources[1]['catalog_coverage'], .5)
        self.assertEqual(sum(call.args[0] == report for call in fetch.get.call_args_list), 1)
        fetch.download.assert_not_called()
        self.assertTrue(any('acquisition=2016' in m and 'spacing=1.5' in m and 'coverage=50.0%' in m for m in messages))
        sources, _ = acquisition.discover_sources(fetch, bbox, source_url=ept_url)
        self.assertAlmostEqual(sources[0]['catalog_coverage'], .5)

    def test_threshold_changes_invalidate_cache_and_worker_rejects_old_acquisition(self):
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature
        with tempfile.TemporaryDirectory() as temp:
            bundle = CacheBundle(Path(temp), Bounds(-74, 40, -73.9, 40.1))
            bundle.ensure_directory()
            for name in ('building', 'building_part'):
                bundle.data_path(name).write_text('{"features": []}')
            first = request_signature(bundle, .07, .077)
            second = request_signature(bundle, .07, .077, acquisition_thresholds={'age_difference_years': 10})
            self.assertNotEqual(first, second)
            external = str(Path(__file__).resolve().parents[1] / 'jarvizar_city_model/external')
            with patch.object(sys, 'path', [external] + sys.path):
                worker = importlib.import_module('download_lidar')
                with self.assertRaisesRegex(ValueError, 'acquisition version'):
                    worker.prepare(bundle.path, {**first, 'acquisition': 1})

    def test_holes_are_not_covered_by_an_adequate_map_fraction(self):
        from jarvizar_city_model.external.lidar_ranking import AcquisitionPlan
        geometry = box(.495, .495, .505, .505)
        ept = {**source('ept'), 'coverage': box(0, 0, 1, 1).difference(geometry)}
        laz = {**source('laz', 'LAZ'), 'coverage': box(0, 0, 1, 1)}
        plan = AcquisitionPlan([ept, laz], [{'id': 'hole'}], {'hole': geometry})
        selected, features, reason = plan.next(set())
        self.assertEqual(selected['format'], 'LAZ')
        self.assertIn('no suitable EPT coverage', reason)
        self.assertIsNone(plan.next({'hole'}))

    def test_known_unsupported_ept_is_skipped_from_metadata(self):
        fetch = Mock(json=Mock(return_value={'dataType': 'binary', 'hierarchyType': 'json'}))
        sources, _ = acquisition.discover_sources(fetch, [-74, 40, -73.9, 40.1],
            source_url='https://example.com/ept/ept.json')
        self.assertIn('laszip', sources[0]['unusable_reason'])
        fetch.download.assert_not_called()


if __name__ == '__main__':
    unittest.main()
