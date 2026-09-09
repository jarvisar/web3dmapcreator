"""Prefer usable measurements without bypassing roof/mesh evidence checks."""
import unittest

from jarvizar_city_model.external.lidar_selection import choose_measurement
from test_lidar_selection import record
import test_lidar_measurements as measurements

if measurements.AVAILABLE:
    import numpy as np
    from shapely.geometry import box, mapping
    from jarvizar_city_model.external.lidar_measurements import (
        measure_features, measure_source_parts, PointIndex)


class SurveyPreferenceTests(unittest.TestCase):
    def test_preference_selects_one_complete_survey_despite_conflicts(self):
        older = record('dense', 2014, height=190, coverage=1, density=5, explained=1)
        newer = record('sparse', 2022, height=30, coverage=.85, density=.3, explained=.6)
        observations = [{'source':'new', 'reason':'observed_ground_in_footprint', 'capture_year':2022}]
        self.assertIsNone(choose_measurement([older, newer], observations)[0])
        selected, audit = choose_measurement([older, newer], observations, prefer_lidar=True)
        self.assertIs(selected, older)
        self.assertEqual(audit['reason'], 'best_usable_survey')
        self.assertEqual(len(audit['ignored_conflicts']), 2)
        self.assertIsNone(choose_measurement([], prefer_lidar=True)[0])


@unittest.skipUnless(measurements.AVAILABLE, 'optional LiDAR dependencies not installed')
class HeightPreferenceTests(unittest.TestCase):
    def features(self, source_height, measured_height, prefer, built=None):
        props = {'height':source_height, 'num_floors':round(source_height/3)}
        if built:
            props['start_date'] = str(built)
        feature = {'id':'tower', 'properties':props, 'geometry':mapping(box(0,0,60,60))}
        cloud = measurements.MeasurementsTests().cloud(lambda x,y:measured_height)
        cloud = np.column_stack((cloud, np.full(len(cloud), 2017), np.ones(len(cloud))))
        return measure_features([feature], cloud, lambda x,y:(x,y), lambda x,y:(x,y),
                                6, 2, box(-100,-100,100,100), prefer_lidar=prefer)

    def test_preference_uses_measured_height_in_both_conflict_directions(self):
        for source, measured in ((19,190),(190,19)):
            self.assertFalse(self.features(source, measured, False)[0])
            result, _, rejected = self.features(source, measured, True)
            self.assertFalse(rejected)
            self.assertAlmostEqual(result['tower']['height_m'], measured)
            self.assertEqual(result['tower']['height_decision'], 'lidar_preferred')
            self.assertEqual(result['tower']['source_height_decision'], 'source_height_conflict')

    def test_source_construction_date_can_be_overridden_but_empty_roof_cannot(self):
        self.assertEqual(self.features(19,190,False,built=2022)[2]['tower'], 'predates_building')
        result = self.features(19,190,True,built=2022)[0]['tower']
        self.assertTrue(result['source_date_conflict'])
        self.assertFalse(self.features(19,0,True)[0])

    def test_neighboring_upper_edge_does_not_reject_the_main_infill(self):
        footprint, part_shape = box(0,0,60,60), box(20,20,40,40)
        feature = {'id':'parent', 'properties':{'height':76,'has_parts':True}, 'geometry':mapping(footprint)}
        part = {'id':'roof', 'properties':{'num_floors':8}, 'geometry':mapping(part_shape)}
        def roof(x,y):
            if 22<x<40 and 20<y<40:
                return 30
            return 76
        cloud = measurements.MeasurementsTests().cloud(roof)
        cloud = np.concatenate([cloud + np.array([dx,dy,0,0,0])
            for dx,dy in ((0,0),(.15,0),(0,.15),(.15,.15))])
        for prefer in (False, True):
            result, reason = measure_source_parts(feature, [(part,part_shape)], footprint,
                PointIndex(cloud), .1/.07, .05/.077, prefer_lidar=prefer)
            self.assertIsNotNone(result, reason)
            self.assertAlmostEqual(result['height_m'], 76, delta=.2)
            self.assertLessEqual(result['part_heights'].get('roof', 24), 30.2)
