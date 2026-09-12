"""Authoritative collection dates reach ranking without guessing from names."""
import copy
from datetime import datetime, timezone
import json
import unittest
from unittest.mock import Mock, patch

from shapely.geometry import box, mapping

from jarvizar_city_model.external import lidar_acquisition as acquisition
from jarvizar_city_model.external import lidar_usgs_projects as projects
from jarvizar_city_model.external.lidar_ranking import rank_sources


def epoch(day):
    return datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp()*1000


def source(name, staged=False):
    url = (f'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/group/{name}/LAZ/'
           if staged else f'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{name}/ept.json')
    return dict(provider='USGS', name=name, url=url, format='LAZ' if staged else 'EPT',
                coverage=box(0, 0, 2, 2), catalog_coverage=1, survey_metadata={})


def row(name='CA_Example_1_B23', start='2023-04-20', end='2023-04-20', **extra):
    return dict(workunit=name, workunit_id=100,
                collect_start=epoch(start) if start else None,
                collect_end=epoch(end) if end else None, ql='QL 0', **extra)


class USGSProjectTests(unittest.TestCase):
    def enrich(self, sources, rows):
        fetch = Mock()
        fetch.get.return_value = json.dumps(dict(type='FeatureCollection', features=[
            dict(type='Feature', id=i, properties=r, geometry=mapping(box(0, 0, 2, 2)))
            for i, r in enumerate(rows)])).encode()
        failures = []
        projects.enrich_usgs_projects(fetch, sources, (0, 0, 2, 2), failures, lambda _: None)
        self.assertFalse(failures)
        self.assertEqual(fetch.get.call_count, 1)
        self.assertEqual(fetch.get.call_args.kwargs['ttl'], 24*3600)
        return fetch

    def test_recent_collection_beats_four_digit_name_and_new_publication(self):
        old, new, laz = source('USGS_LPC_CA_Example_2018'), source('CA_Example_1_B23'), source('CA_Example_1_B23', True)
        old['project_year_hint'] = 2018
        old['survey_metadata']['publication_date'] = '2026-09-01'
        self.enrich([old, new, laz], [row(), row('CA_Example_2018', '2017-12-01', '2018-04-24')])
        self.assertIs(rank_sources([old, laz, new])[0][0], new)
        for s in (new, laz):
            self.assertEqual(s['survey_metadata']['acquisition_start'], '2023-04-20')
            self.assertEqual(s['survey_metadata']['acquisition_end'], '2023-04-20')
            self.assertEqual(s['survey_metadata']['usgs_quality_level'], 'QL 0')
            self.assertNotIn('point_spacing_m', s['survey_metadata'])
            self.assertNotIn('classification_quality', s['survey_metadata'])

    def test_full_workunit_identity_required_and_unknown_metadata_preserved(self):
        names = ['CA_Example_2_B23', 'CA_Example_1_B24', 'CA_Example_B23']
        sources = [source(n) for n in names]
        external = source('CA_Example_1_B23')
        external.update(provider='Other', name='CA_Example_1_B23')
        self.enrich(sources+[external], [row()])
        self.assertTrue(all(not s['survey_metadata'] for s in sources+[external]))

    def test_url_identity_wins_over_similar_display_name(self):
        s = source('CA_Example_2_B23')
        s['name'] = 'CA_Example_1_B23'
        self.enrich([s], [row()])
        self.assertNotIn('acquisition_start', s['survey_metadata'])

    def test_ambiguous_workunit_is_not_assigned_dates(self):
        s = source('CA_Example_1_B23')
        self.enrich([s], [row(), {**row(), 'workunit_id': 200}])
        self.assertFalse(s['survey_metadata'])

    def test_no_matching_geometry_does_not_supply_metadata(self):
        s = source('CA_Example_1_B23')
        s['coverage'] = box(3, 3, 4, 4)
        self.enrich([s], [row()])
        self.assertFalse(s['survey_metadata'])

    def test_publication_and_dem_resolution_are_not_acquisition_or_point_spacing(self):
        s = source('CA_Example_1_B23')
        self.enrich([s], [row(start=None, end=None, lpc_pub_date=epoch('2024-08-22'), dem_gsd_meters=.25)])
        self.assertNotIn('acquisition_start', s['survey_metadata'])
        self.assertNotIn('acquisition_end', s['survey_metadata'])
        self.assertNotIn('point_spacing_m', s['survey_metadata'])

    def test_invalid_timestamps_and_reversed_ranges_remain_unknown(self):
        for value in (True, None, '2023', -1, float('nan'), 10**30):
            self.assertIsNone(projects._collection_date(value))
        s = source('CA_Example_1_B23')
        self.enrich([s], [row(start='2023-05-01', end='2023-04-20')])
        self.assertNotIn('acquisition_start', s['survey_metadata'])
        self.assertNotIn('acquisition_end', s['survey_metadata'])

    def test_end_only_and_existing_multiyear_interval_are_retained(self):
        s = source('CA_Example_1_B23')
        self.enrich([s], [row(start=None)])
        self.assertNotIn('acquisition_start', s['survey_metadata'])
        self.assertEqual(s['survey_metadata']['acquisition_end'], '2023-04-20')
        s['survey_metadata'].update(acquisition_start='2022-01-01', acquisition_end='2024-01-01')
        self.enrich([s], [row()])
        self.assertEqual(s['survey_metadata']['acquisition_start'], '2022-01-01')
        self.assertEqual(s['survey_metadata']['acquisition_end'], '2024-01-01')

    def test_service_failure_is_reported_without_losing_sources_or_old_dates(self):
        s = source('CA_Example_1_B23')
        s['survey_metadata'] = {'acquisition_end': '2022-12-31'}
        baseline = copy.deepcopy(s)
        failures = []
        projects.enrich_usgs_projects(Mock(get=Mock(side_effect=OSError('offline'))), [s],
                                     (0, 0, 2, 2), failures, lambda _: None)
        self.assertEqual(s, baseline)
        self.assertEqual(len(failures), 1)

    def test_discovery_applies_project_metadata_before_ranking(self):
        old, new = source('USGS_LPC_CA_Example_2018'), source('CA_Example_1_B23')
        with patch.dict(acquisition.PROVIDERS, usgs=lambda *args: [old, new]), \
             patch.object(acquisition, 'enrich_sources'), \
             patch.object(acquisition, 'enrich_provenance'), \
             patch.object(acquisition, 'enrich_asset_provenance'), \
             patch.object(projects, 'features', return_value=[(row(), box(0, 0, 2, 2))]):
            ranked, failures = acquisition.discover_sources(Mock(), (0, 0, 2, 2), discovery={'providers': ['usgs']})
        self.assertFalse(failures)
        self.assertIs(ranked[0], new)
        self.assertEqual(new['rank'], 1)
        self.assertEqual(acquisition.source_audit(ranked)[0]['survey_metadata']['usgs_workunit_id'], 100)


if __name__ == '__main__':
    unittest.main()
