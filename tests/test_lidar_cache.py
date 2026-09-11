"""Blender-side cache contract, independent of optional LiDAR dependencies."""
import json
from pathlib import Path
import tempfile
import unittest

from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.data.lidar import load_measurements, request_signature, measurement_summary


class LidarCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bundle = CacheBundle(Path(self.temp.name), Bounds(-88, 41, -87, 42))
        self.bundle.ensure_directory()
        for name in ("building", "building_part"):
            self.bundle.data_path(name).write_text('{"features": []}')
        self.signature = request_signature(self.bundle, .07, .077)

    def write(self, buildings):
        (self.bundle.path / "lidar_buildings.json").write_text(json.dumps({
            "format": 1, "request": self.signature, "buildings": buildings}))

    def test_missing_stale_and_corrupt_fall_back(self):
        self.assertFalse(load_measurements(self.bundle, self.signature)[0])
        self.write({"one": {"height_m": 30, "tiers": []}})
        self.assertEqual(len(load_measurements(self.bundle, self.signature)[0]), 1)
        altered = request_signature(self.bundle, .1, .11)
        self.assertIn("stale", load_measurements(self.bundle, altered)[1])
        self.bundle.data_path("building_part").write_text('{"features":[{}]}')
        altered = request_signature(self.bundle, .07, .077)
        self.assertIn("stale", load_measurements(self.bundle, altered)[1])
        self.write({"one": {"height_m": float("inf"), "tiers": []}})
        self.assertFalse(load_measurements(self.bundle, self.signature)[0])

    def test_disconnected_tiers_are_rejected(self):
        self.write({"one": {"height_m": 30, "tiers": [{"bottom_m": 35, "top_m": 60, "geometry": {}}]}})
        self.assertIn("Disconnected", load_measurements(self.bundle, self.signature)[1])

    def test_empty_coverage_is_valid_cached_result(self):
        self.write({})
        self.assertEqual(load_measurements(self.bundle, self.signature), ({}, "LiDAR measurements: 0 buildings"))

    def test_default_preference_and_policy_change_invalidate_preparation(self):
        self.assertTrue(self.signature['prefer_lidar'])
        self.write({'one':{'height_m':30, 'tiers':[]}})
        strict = request_signature(self.bundle, .07, .077, prefer_lidar=False)
        self.assertIn('stale', load_measurements(self.bundle, strict)[1])

    def test_detailed_surface_cache_ignores_legacy_terrace_controls(self):
        self.write({'one': {'height_m': 30, 'tiers': []}})
        for width, step in ((.01, .02), (.5, .2), (2, 1)):
            altered = request_signature(self.bundle, .07, .077,
                                        min_width_mm=width, min_step_mm=step)
            self.assertEqual(altered, self.signature)
            self.assertTrue(load_measurements(self.bundle, altered)[0])
        self.assertEqual(self.signature['min_width_mm'], .1)
        self.assertEqual(self.signature['min_step_mm'], .05)

    def test_detailed_surface_cache_tracks_actual_print_scales(self):
        self.write({'one': {'height_m': 30, 'tiers': []}})
        for xy_scale, z_scale in ((.14, .077), (.07, .154)):
            altered = request_signature(self.bundle, xy_scale, z_scale)
            self.assertIn('stale', load_measurements(self.bundle, altered)[1])

    def test_terrace_cache_still_tracks_width_and_step(self):
        classic = request_signature(self.bundle, .07, .077, roof_mode='TERRACES')
        for detail in ({'min_width_mm': .01}, {'min_step_mm': .02}):
            altered = request_signature(self.bundle, .07, .077,
                                        roof_mode='TERRACES', **detail)
            self.assertNotEqual(altered, classic)
            for key, value in detail.items():
                self.assertEqual(altered[key], value)

    def test_blender_float_detail_values_have_a_stable_signature(self):
        blender_floats = request_signature(self.bundle, .07, .077,
            min_width_mm=.10000000149011612, min_step_mm=.05000000074505806)
        self.assertEqual(blender_floats, self.signature)
        classic = request_signature(self.bundle, .07, .077, roof_mode='TERRACES')
        blender_floats = request_signature(self.bundle, .07, .077, roof_mode='TERRACES',
            min_width_mm=.10000000149011612, min_step_mm=.05000000074505806)
        self.assertEqual(blender_floats, classic)

    def test_acquisition_and_manifest_change_invalidate_preparation(self):
        self.write({'one': {'height_m': 30, 'tiers': []}})
        custom = request_signature(self.bundle, .07, .077, manifest_url=' https://example.com/links.txt ')
        self.assertEqual(custom['manifest_url'], 'https://example.com/links.txt')
        self.assertIn('stale', load_measurements(self.bundle, custom)[1])
        path = self.bundle.path/'lidar_buildings.json'
        payload = json.loads(path.read_text())
        del payload['request']['acquisition']
        path.write_text(json.dumps(payload))
        self.assertIn('stale', load_measurements(self.bundle, self.signature)[1])

    def test_source_assembly_rejects_corrupt_part_heights_and_infill(self):
        for changes in ({'part_heights':{'part':float('nan')}}, {'part_heights':[]},
                        {'infill_geometry':{'type':'Polygon','coordinates':[]}}, {}):
            self.write({'one':{'height_m':30,'tiers':[],'method':'source_parts',**changes}})
            self.assertFalse(load_measurements(self.bundle,self.signature)[0])
        self.write({'one':{'height_m':30,'tiers':[],'method':'source_parts','part_heights':{'part':90}}})
        self.assertTrue(load_measurements(self.bundle,self.signature)[0])

    def test_algorithm_three_cache_requires_new_preparation(self):
        self.write({'one':{'height_m':30,'tiers':[]}})
        path=self.bundle.path/'lidar_buildings.json'
        payload=json.loads(path.read_text());payload['request']['algorithm']=3
        path.write_text(json.dumps(payload))
        self.assertIn('stale',load_measurements(self.bundle,self.signature)[1])

    def test_previous_area_accounting_cache_requires_new_preparation(self):
        self.write({'one':{'height_m':30, 'tiers':[]}})
        path = self.bundle.path/'lidar_buildings.json'
        payload = json.loads(path.read_text())
        payload['request']['algorithm'] = 6
        path.write_text(json.dumps(payload))
        self.assertIn('stale', load_measurements(self.bundle,self.signature)[1])

    def test_previous_grid_measurements_require_new_preparation(self):
        self.write({'one':{'height_m':30, 'tiers':[]}})
        path = self.bundle.path/'lidar_buildings.json'
        payload = json.loads(path.read_text())
        payload['request']['algorithm'] = 7
        path.write_text(json.dumps(payload))
        self.assertIn('stale', load_measurements(self.bundle,self.signature)[1])

    def test_previous_surface_reconstruction_requires_new_preparation(self):
        self.assertEqual(self.signature['algorithm'], 15)
        self.write({'one': {'height_m': 30, 'tiers': []}})
        path = self.bundle.path/'lidar_buildings.json'
        payload = json.loads(path.read_text())
        payload['request']['algorithm'] = 14
        path.write_text(json.dumps(payload))
        self.assertIn('stale', load_measurements(self.bundle, self.signature)[1])

    def test_summary_counts_final_rejections_not_observations(self):
        self.write({'accepted':{'height_m':30, 'tiers':[]}})
        path = self.bundle.path/'lidar_buildings.json'
        payload = json.loads(path.read_text())
        payload.update(counts={'footprint_roof_mismatch':7, 'height_only':1},
                       rejected={'accepted':'footprint_roof_mismatch',
                                 'rejected':'footprint_roof_mismatch',
                                 'ground':'observed_ground_in_footprint'})
        path.write_text(json.dumps(payload))
        self.assertEqual(measurement_summary(self.bundle)['rejection_counts'],
                         {'footprint_roof_mismatch':1, 'observed_ground_in_footprint':1})

    def test_empty_tier_polygon_is_not_silently_dropped_to_podium(self):
        self.write({'one':{'height_m':20,'tiers':[{'bottom_m':20,'top_m':90,
                    'geometry':{'type':'Polygon','coordinates':[]}}]}})
        self.assertFalse(load_measurements(self.bundle,self.signature)[0])

    def test_nonfinite_roof_bottom_is_rejected(self):
        self.write({'one':{'height_m':20,'tiers':[],'roof_surfaces':[{'bottom_m':float('nan'),
                    'geometry':{'type':'Polygon','coordinates':[[[-87.8,41.2,20],[-87.7,41.2,30],[-87.7,41.3,30],[-87.8,41.2,20]]]}}]}})
        self.assertFalse(load_measurements(self.bundle,self.signature)[0])

    def test_roof_planes_are_validated_and_roof_setting_invalidates(self):
        record={'height_m':20,'tiers':[], 'roof_surfaces':[{'bottom_m':20,'geometry':{
            'type':'Polygon','coordinates':[[[-87.8,41.2,20],[-87.7,41.2,30],[-87.7,41.3,30],[-87.8,41.2,20]]]}}]}
        self.write({'one':record})
        self.assertTrue(load_measurements(self.bundle,self.signature)[0])
        altered=request_signature(self.bundle,.07,.077,roof_planes=False)
        self.assertIn('stale',load_measurements(self.bundle,altered)[1])
        record['roof_surfaces'][0]['geometry']['coordinates'][0][1][2]=float('nan')
        self.write({'one':record})
        self.assertFalse(load_measurements(self.bundle,self.signature)[0])

    def test_surface_mode_changes_signature_and_keeps_classic_fallback_available(self):
        self.assertEqual(self.signature['roof_mode'], 'FACETED')
        self.write({'one':{'height_m':30, 'tiers':[]}})
        classic = request_signature(self.bundle, .07, .077, roof_mode='TERRACES')
        self.assertIn('stale', load_measurements(self.bundle, classic)[1])
        with self.assertRaises(ValueError):
            request_signature(self.bundle, .07, .077, roof_mode='unknown')
        payload = json.loads((self.bundle.path/'lidar_buildings.json').read_text())
        payload['request']['algorithm'] = 10
        (self.bundle.path/'lidar_buildings.json').write_text(json.dumps(payload))
        self.assertIn('stale', load_measurements(self.bundle, self.signature)[1])

    def test_facets_have_a_bounded_surface_contract(self):
        surface = {'bottom_m':20, 'geometry':{'type':'Polygon', 'coordinates':[
            [[-87.8,41.2,20],[-87.7,41.2,30],[-87.7,41.3,30],[-87.8,41.2,20]]]}}
        record = {'height_m':20, 'tiers':[], 'method':'faceted_roof', 'roof_surfaces':[surface]*9}
        self.write({'one':record})
        self.assertTrue(load_measurements(self.bundle,self.signature)[0])
        record['method'] = 'roof_planes'
        self.write({'one':record})
        self.assertFalse(load_measurements(self.bundle,self.signature)[0])
        record.update(method='faceted_roof', roof_surfaces=[surface]*1025)
        self.write({'one':record})
        self.assertFalse(load_measurements(self.bundle,self.signature)[0])
