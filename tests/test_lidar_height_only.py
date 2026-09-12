"""Height-only measurements retain evidence checks without reconstructing roofs."""
import unittest
from unittest.mock import patch
import numpy as np
from shapely.geometry import box, mapping
from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building, measure_features
from jarvizar_city_model.external.lidar_records import validate_records
import test_lidar_measurements as fixtures


class HeightOnlyTests(unittest.TestCase):
    cloud = fixtures.MeasurementsTests.cloud

    def measure(self, points):
        return measure_building(box(0, 0, 60, 60), PointIndex(points), 6, 3,
                                roof_mode='HEIGHT_ONLY')

    def test_small_tower_over_podium_and_noise_without_reconstruction(self):
        with patch('jarvizar_city_model.external.lidar_envelope.fit_roof_envelope', side_effect=AssertionError('envelope called')), \
             patch('jarvizar_city_model.external.lidar_planes.fit_roof_planes', side_effect=AssertionError('planes called')):
            for roof, expected in ((lambda x,y: 90 if 20<x<30 and 20<y<30 else 20, 90),
                                   (lambda x,y: 100 if 28<x<31 and 28<y<31 else 30, 30),
                                   (lambda x,y: 45-abs(x-30)*.5, 45)):
                record, reason = self.measure(self.cloud(roof))
                self.assertEqual(reason, 'height_only')
                self.assertAlmostEqual(record['height_m'], expected, delta=1.5)
                self.assertEqual(record['method'], 'height_only')
                self.assertEqual(record['tiers'], [])
                self.assertNotIn('roof_surfaces', record)
                validate_records({'building':record})

    def test_ground_coverage_vegetation_and_epoch_checks_still_apply(self):
        cloud = self.cloud(lambda x,y:30)
        self.assertEqual(self.measure(cloud[cloud[:,3] != 2])[1], 'insufficient_ground')
        self.assertIsNone(self.measure(cloud[~((cloud[:,0]>20)&(cloud[:,0]<60)&(cloud[:,3]==6))])[0])
        self.assertIsNone(self.measure(self.cloud(lambda x,y:30, class_id=5))[0])
        feature = {'id':'one', 'properties':{}, 'geometry':mapping(box(0,0,60,60))}
        cloud = np.column_stack((cloud, np.full(len(cloud), 2020), np.ones(len(cloud))))
        cloud[::2,5] = 2022
        records, _, rejected = measure_features([feature], cloud, lambda x,y:(x,y), lambda x,y:(x,y),
            6,3,box(-100,-100,100,100), roof_mode='HEIGHT_ONLY', prefer_lidar=True)
        self.assertFalse(records)
        self.assertEqual(rejected['one'], 'mixed_capture_epochs')

    def test_unclassified_slopes_need_coherence_and_small_high_patch_is_ignored(self):
        record, _ = self.measure(self.cloud(lambda x,y: 30+x*.3,class_id=1))
        self.assertIsNotNone(record)
        self.assertIsNone(self.measure(self.cloud(lambda x,y:30+8*np.sin(x*.3)+8*np.cos(y*.3),class_id=1))[0])
        from jarvizar_city_model.external.lidar_height import supported_height
        cells={(x,y):18. for x in range(100) for y in range(100)}
        for x in range(40,45):
            for y in range(40,45): cells[(x,y)]=60.
        top, _ = supported_height(cells,3,0.)
        self.assertEqual(top,18.)

    def test_assembly_top_uses_tower_not_podium_and_no_part_infill(self):
        geometry = box(0,0,60,60)
        feature = {'id':'one', 'properties':{'height':10,'has_parts':True}, 'geometry':mapping(geometry)}
        part = {'id':'tower', 'properties':{'height':90,'roof_shape':'flat'}}
        with patch('jarvizar_city_model.external.lidar_measurements.measure_source_parts', side_effect=AssertionError('infill called')):
            records, _, rejected = measure_features([feature], self.cloud(lambda x,y:90 if 18<x<42 and 18<y<42 else 10),
                lambda x,y:(x,y), lambda x,y:(x,y), 6,3,box(-100,-100,100,100),
                source_parts_by_parent={'one':[(part,box(18,18,42,42))]}, roof_mode='HEIGHT_ONLY')
        self.assertFalse(rejected)
        self.assertEqual(records['one']['height_m'], 90)
        self.assertNotIn('infill_geometry', records['one'])
        self.assertNotIn('part_heights', records['one'])

    def test_conflict_preference_and_ground_datum(self):
        feature = {'id':'one', 'properties':{'height':150}, 'geometry':mapping(box(0,0,60,60))}
        for prefer in (False, True):
            records, _, rejected = measure_features([feature], self.cloud(lambda x,y:30,ground=1700),
                lambda x,y:(x,y), lambda x,y:(x,y), 6,3,box(-100,-100,100,100),
                roof_mode='HEIGHT_ONLY', prefer_lidar=prefer)
            if prefer:
                self.assertAlmostEqual(records['one']['height_m'],30)
            else:
                self.assertEqual(rejected['one'],'no_supported_main_mass')

    def test_heightless_tower_not_taller_tagged_podium_gets_tall_height(self):
        feature={'id':'one','properties':{'has_parts':True},'geometry':mapping(box(0,0,60,60))}
        podium={'id':'podium','properties':{'height':30}}
        tower={'id':'tower','properties':{}}
        records,_,rejected=measure_features([feature],self.cloud(lambda x,y:33 if x<20 else 208),
            lambda x,y:(x,y),lambda x,y:(x,y),6,3,box(-100,-100,100,100),roof_mode='HEIGHT_ONLY',
            source_parts_by_parent={'one':[(podium,box(0,0,20,60)),(tower,box(20,0,60,60))]})
        self.assertFalse(rejected)
        self.assertEqual(records['one']['source_heights'],{'podium':33.,'tower':208.})

    def test_scalar_record_cannot_smuggle_geometry(self):
        for key, value in (('roof_mesh',{'vertices':[]}),('part_heights',{'one':30}),
                           ('infill_geometry',mapping(box(0,0,1,1)))):
            with self.assertRaises(ValueError):
                validate_records({'one':{'height_m':30,'tiers':[],'method':'height_only',key:value}})
