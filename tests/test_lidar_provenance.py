"""Verify original EPT inputs using metadata, without point-cloud acquisition."""
import io
import json
import unittest
from unittest.mock import patch
from uuid import UUID

try:
    import laspy
    import numpy as np
    from shapely.geometry import box
    from jarvizar_city_model.external import lidar_provenance as provenance
    from jarvizar_city_model.external.lidar_identity import same_survey, possible_duplicate, metadata_identity
    from jarvizar_city_model.external.lidar_ranking import AcquisitionPlan
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class ProvenanceTests(unittest.TestCase):
    def fixture(self, *, legacy=False):
        header = laspy.LasHeader(point_format=6, version='1.4')
        header.uuid = UUID('b9488211-7425-4341-a337-4144e9b39724')
        header.point_count = 100
        header.mins, header.maxs = np.array([1., 1., 10.]), np.array([4., 4., 50.])
        header.scales = np.array([.01, .01, .01])
        stream = io.BytesIO()
        header.write_to(stream)
        binary = stream.getvalue()
        original = {'project_id': str(UUID(bytes=header.uuid.bytes_le)), 'count': 100,
                    'dataformat_id': 6, 'global_encoding': 0, 'scale_x': .01, 'scale_y': .01, 'scale_z': .01,
                    'minx': 1, 'miny': 1, 'minz': 10, 'maxx': 4, 'maxy': 4, 'maxz': 50,
                    'creation_year': 2019}  # Serialization year is not acquisition.
        ept_url = 'https://example.com/packaged-survey/ept.json'
        base = ept_url.rsplit('/', 1)[0] + '/ept-sources/'
        tile = {'url': 'https://example.com/staged/differently-named.laz', 'bbox': [0, 0, 10, 10]}
        ept = {'url': ept_url, 'name': 'EPT', 'format': 'EPT', 'coverage': box(0, 0, 10, 10)}
        laz = {'url': 'https://example.com/staged/', 'name': 'LAZ', 'format': 'LAZ', 'tiles': [tile], 'coverage': box(0, 0, 10, 10)}
        entries = [{'path': 'original.laz', 'bounds': [1, 1, 10, 4, 4, 50], 'points': 100,
                    **({'status': 'inserted'} if legacy else {'inserted': True, 'metadataPath': 'input.json'})}]
        documents = {base + ('list.json' if legacy else 'manifest.json'): entries,
                     base + ('0.json' if legacy else 'input.json'): {'metadata': original, 'path': 'original.laz'},
                     ept_url: {'dataType': 'laszip', 'hierarchyType': 'json', 'bounds': [0, 0, 0, 10, 10, 100],
                               'srs': {'authority': 'EPSG', 'horizontal': '4326', 'vertical': '5703'}}}
        class Fetch:
            def __init__(self):
                self.reads, self.ranges = [], []
            def get(self, url, **kwargs):
                self.reads.append((url, kwargs))
                if url not in documents:
                    raise FileNotFoundError(url)
                return json.dumps(documents[url]).encode()
            def json(self, url, **kwargs):
                return json.loads(self.get(url, **kwargs))
            def range(self, url, start, size):
                self.ranges.append((url, start, size))
                return binary[start:start+size]
            def download(self, *args, **kwargs):
                raise AssertionError('Provenance must not acquire a point cloud')
        return Fetch(), ept, laz, documents, base

    def test_original_project_guid_and_header_facts_verify_renamed_delivery_locally(self):
        fetch, ept, laz, _, _ = self.fixture()
        provenance.enrich_provenance(fetch, [ept, laz], [0, 0, 10, 10], lambda _: None)
        inside, outside = box(2, 2, 3, 3), box(7, 7, 8, 8)
        self.assertTrue(same_survey(ept, laz, inside))
        self.assertIsNone(same_survey(ept, laz, outside))
        self.assertIsNone(same_survey(ept, laz))  # Never promote a sampled tile to the whole survey.
        self.assertEqual(sum(size for _, _, size in fetch.ranges), 375)
        self.assertTrue(all(start + size <= 375 for _, start, size in fetch.ranges))
        features = [{'id': 'inside'}, {'id': 'outside'}]
        plan = AcquisitionPlan([ept, laz], features, {'inside': inside, 'outside': outside})
        self.assertEqual(plan.next(set())[0]['format'], 'EPT')
        plan.observe(ept, features, {}, {f['id']: 'insufficient_ground' for f in features}, {'points': 100})
        self.assertEqual(plan.next(set())[1], features[1:])

    def test_legacy_list_and_numbered_metadata_are_supported(self):
        fetch, ept, laz, _, _ = self.fixture(legacy=True)
        provenance.enrich_provenance(fetch, [ept, laz], [0, 0, 10, 10], lambda _: None)
        self.assertTrue(same_survey(ept, laz, box(2, 2, 3, 3)))

    def test_changed_or_unknown_original_header_is_not_equivalent(self):
        for field, value in (('project_id', str(UUID(int=0))), ('project_id', str(UUID(int=1))),
                             ('count', 101), ('maxz', 60), ('scale_x', .1), ('dataformat_id', 3)):
            with self.subTest(field=field, value=value):
                fetch, ept, laz, documents, base = self.fixture()
                documents[base + 'input.json']['metadata'][field] = value
                provenance.enrich_provenance(fetch, [ept, laz], [0, 0, 10, 10], lambda _: None)
                self.assertIsNone(same_survey(ept, laz, box(2, 2, 3, 3)))

    def test_failed_entries_missing_metadata_and_bounds_do_not_confirm_identity(self):
        for mode in ('failed', 'missing', 'bounds', 'wrong_input'):
            fetch, ept, laz, documents, base = self.fixture()
            if mode == 'failed':
                documents[base + 'manifest.json'][0]['inserted'] = False
            elif mode == 'missing':
                del documents[base + 'input.json']
            elif mode == 'bounds':
                documents[base + 'manifest.json'][0]['bounds'] = []
            else:
                documents[base + 'input.json']['path'] = 'another.laz'
            provenance.enrich_provenance(fetch, [ept, laz], [0, 0, 10, 10], lambda _: None)
            self.assertFalse(laz.get('provenance_matches'))

    def test_limits_and_untrusted_links_fail_conservatively(self):
        fetch, ept, laz, _, base = self.fixture()
        with patch.object(provenance, 'MAX_INPUTS', 0):
            provenance.enrich_provenance(fetch, [ept, laz], [0, 0, 10, 10], lambda _: None)
        self.assertFalse(fetch.ranges)
        with patch.object(provenance, 'PROVENANCE_BUDGET', 1):
            provenance.enrich_provenance(fetch, [ept, laz], [0, 0, 10, 10], lambda _: None)
        self.assertFalse(laz.get('provenance_matches'))
        for path in ('../ept-data/file.json', '%2e%2e/ept-data/file.json', 'https://elsewhere.test/file.json', 'file.laz'):
            with self.assertRaises(ValueError):
                provenance.input_metadata_url(base, path)

    def test_name_similarity_is_only_a_hint(self):
        a = {'survey_identity': metadata_identity({'provider': 'usgs', 'project_id': 'USGS_LPC_ST_Example_2017_LAS_2019'})}
        b = {'survey_identity': metadata_identity({'provider': 'usgs', 'project_id': 'ST_Example_2017'})}
        self.assertTrue(possible_duplicate(a, b))
        self.assertIsNone(same_survey(a, b))

    def test_original_project_path_can_establish_identity_without_headers(self):
        fetch, ept, laz, documents, base = self.fixture()
        documents[base + 'manifest.json'][0]['path'] = 's3://usgs-lidar/Projects/ST_Project_2020/laz/input.laz'
        laz['survey_identity'] = metadata_identity({'provider': 'usgs', 'project_id': 'ST_Project_2020'})
        provenance.enrich_provenance(fetch, [ept, laz], [0, 0, 10, 10], lambda _: None)
        self.assertTrue(same_survey(ept, laz))
        self.assertFalse(fetch.ranges)


if __name__ == '__main__':
    unittest.main()
