"""Cross-format identity must suppress redundant clouds without losing gaps."""
import unittest
from unittest.mock import Mock

from jarvizar_city_model.external.lidar_identity import metadata_identity, same_survey, common_identity
from jarvizar_city_model.external.lidar_metadata import normalized_metadata, read_report
from jarvizar_city_model.external.lidar_ranking import AcquisitionPlan, rank_sources


class Coverage:
    def __init__(self, *identifiers):
        self.identifiers = identifiers
    def covers(self, identifier):
        return identifier in self.identifiers


def source(name, fmt, project='project_2020', **metadata):
    return {'url': name, 'format': fmt, 'survey_identity': metadata_identity({
        'provider': 'agency', 'project_id': project}), 'survey_metadata': normalized_metadata(metadata),
        'coverage': Coverage('west', 'east'), 'catalog_coverage': 1}


class IdentityTests(unittest.TestCase):
    def test_provider_projects_match_across_delivery_and_metadata_links(self):
        ept = {'url': 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/ST_Example_2020/ept.json'}
        laz = {'downloadURL': 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/Parent_2020/ST_EXAMPLE_2020/LAZ/unrelated-name.laz',
               'vendorMetaUrl': 'https://prd-tnm.s3.amazonaws.com/index.html?prefix=StagedProducts/Elevation/metadata/Parent_2020/ST_EXAMPLE_2020'}
        a, b = ({'survey_identity': metadata_identity(s)} for s in (ept, laz))
        self.assertEqual(same_survey(a, b), 'usgs:st_example_2020')
        self.assertEqual(len(b['survey_identity']['evidence']), 2)
        self.assertNotIn('unrelated-name.laz', repr(b))
        other = {'survey_identity': metadata_identity({'url': laz['downloadURL'].replace('ST_EXAMPLE_2020', 'ST_Other_2020')})}
        self.assertIsNone(same_survey(a, other))  # Same parent programme is insufficient.

    def test_filenames_titles_tile_ids_and_unscoped_ids_never_establish_identity(self):
        for data in ({'url': 'https://example.com/ST_Example_2020.laz'},
                     {'name': 'ST_Example_2020', 'title': 'ST_Example_2020', 'sourceId': 'tile-id'},
                     {'project_id': 'ST_Example_2020'},
                     {'url': 'https://rockyweb.usgs.gov.evil.test/Projects/ST_Example_2020/LAZ/a.laz'}):
            identity = metadata_identity(data)
            self.assertFalse(identity['projects'])
            self.assertFalse(identity['datasets'])

    def test_explicit_ids_survive_reports_and_mixed_members_remain_unknown(self):
        identities = {}
        fetch = Mock(get=Mock(return_value=b'{"provider":"agency","dataset_id":"uuid-123", "projectId":"project"}'))
        read_report(fetch, 'https://example.com/report.json', identities=identities)
        identity = identities['https://example.com/report.json']
        self.assertEqual(identity['datasets'], ['agency:uuid_123'])
        self.assertFalse(common_identity([identity, {}])['datasets'])
        fetch.download.assert_not_called()

    def test_date_and_edition_conflicts_prevent_false_equivalence(self):
        ept = source('ept', 'EPT', acquisition_year=2010)
        laz = source('laz', 'LAZ', acquisition_year=2024)
        self.assertIsNone(same_survey(ept, laz))
        self.assertIs(rank_sources([ept, laz])[0][0], laz)
        ept['survey_metadata'] = {}
        ept['survey_identity']['datasets'] = ['agency:v1']
        laz['survey_identity']['datasets'] = ['agency:v2']
        self.assertIsNone(same_survey(ept, laz))

    def plan(self, *sources):
        features = [{'id': k} for k in ('west', 'east')]
        return AcquisitionPlan(sources, features, {f['id']: f['id'] for f in features}), features

    def test_same_survey_cannot_outrank_ept_from_format_metadata_and_stays_redundant(self):
        ept = source('ept', 'EPT', point_spacing_m=2)
        laz = source('laz', 'LAZ', point_spacing_m=.5)
        for ordered in ([laz, ept], [ept, laz]):
            self.assertIs(rank_sources(ordered)[0][0], ept)
            plan, features = self.plan(*ordered)
            self.assertIs(plan.next(set())[0], ept)
            plan.observe(ept, features, {}, {'west': 'insufficient_ground', 'east': 'insufficient_roof_points'}, {'points': 100})
            self.assertIsNone(plan.next(set()))
            self.assertIn('redundant survey', plan.skipped['laz']['east'])

    def test_other_attempted_ept_also_suppresses_its_laz_mirror(self):
        preferred = source('a-ept', 'EPT', project='new')
        older = source('b-ept', 'EPT', project='old')
        laz = source('laz', 'LAZ', project='old')
        plan, features = self.plan(preferred, older, laz)
        self.assertIs(plan.next(set())[0], preferred)
        plan.observe(preferred, features, {}, {f['id']: 'insufficient_ground' for f in features})
        self.assertIs(plan.next(set())[0], older)
        plan.observe(older, features, {}, {f['id']: 'sparse_or_noisy_roof' for f in features})
        self.assertIsNone(plan.next(set()))

    def test_same_survey_remains_available_only_where_ept_is_missing(self):
        ept, laz = source('ept', 'EPT'), source('laz', 'LAZ')
        ept['coverage'] = Coverage('west')
        plan, features = self.plan(ept, laz)
        self.assertEqual(plan.next(set())[1], features[:1])
        plan.observe(ept, features[:1], {}, {'west': 'insufficient_roof_points'})
        selected, pending, reason = plan.next(set())
        self.assertIs(selected, laz)
        self.assertEqual(pending, features[1:])
        self.assertIn('no suitable EPT coverage', reason)

    def test_failed_and_empty_ept_delivery_allow_same_survey_fallback(self):
        for rejection, info in (('source_read_failed', None), ('insufficient_coverage', {'points': 100}),
                                ('insufficient_ground', {'points': 0})):
            ept, laz = source('ept', 'EPT'), source('laz', 'LAZ')
            plan, features = self.plan(ept, laz)
            plan.next(set())
            plan.observe(ept, features, {}, {f['id']: rejection for f in features}, info)
            selected, _, reason = plan.next(set())
            self.assertIs(selected, laz)
            self.assertIn('delivery gap', reason)

    def test_unknown_identity_preserves_deterministic_gap_and_upgrade_fallbacks(self):
        ept, laz = source('ept', 'EPT'), source('laz', 'LAZ')
        laz['survey_identity'] = {}
        plan, features = self.plan(laz, ept)
        self.assertIs(plan.next(set())[0], ept)
        plan.observe(ept, features, {}, {f['id']: 'insufficient_ground' for f in features})
        self.assertIs(plan.next(set())[0], laz)
        laz['survey_metadata'] = normalized_metadata({'point_density_m2': 10})
        ept['survey_metadata'] = normalized_metadata({'point_density_m2': 2})
        self.assertIs(rank_sources([ept, laz])[0][0], laz)


if __name__ == '__main__':
    unittest.main()
