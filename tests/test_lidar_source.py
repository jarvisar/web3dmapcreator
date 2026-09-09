"""Source confidence and spatial height checks, including stale tall LiDAR."""
import unittest

from jarvizar_city_model.external.lidar_source import height_decision, estimated_height


def estimated(height, **properties):
    return dict(height=height, sources=[{'property':'/properties/height',
                'dataset':'Microsoft ML Buildings'}], **properties)


class SourceConfidenceTests(unittest.TestCase):
    def test_old_tall_scan_does_not_override_credible_new_short_building(self):
        for properties in ({'height':19}, {'height':19, 'start_date':'2024'},
                           {'height':19, 'sources':[{'dataset':'USGS Lidar', 'property':''}]},
                           estimated(19, num_floors=4)):
            self.assertEqual(height_decision(properties,190,True), 'source_height_conflict')

    def test_credible_tower_not_lowered_to_old_podium(self):
        self.assertEqual(height_decision({'height':190},19,True), 'source_height_conflict')

    def test_derived_height_needs_strong_evidence_in_either_direction(self):
        for old,observed in ((22.5,207),(207,22.5)):
            self.assertEqual(height_decision(estimated(old),observed,True), 'corrected_estimated_height')
            self.assertEqual(height_decision(estimated(old),observed,False), 'weak_height_correction')

    def test_obviously_wrong_height_can_be_corroborated_by_floor_count(self):
        self.assertEqual(height_decision({'height':3,'num_floors':60},207,True), 'corrected_estimated_height')
        self.assertEqual(height_decision({'height':3,'num_floors':60},207,False), 'weak_height_correction')
        self.assertEqual(height_decision({'num_floors':60},20,True), 'source_height_conflict')

    def test_units_unknown_provenance_and_good_values_are_respected(self):
        self.assertEqual(height_decision({'height':'60 ft'},190,True), 'source_height_conflict')
        self.assertEqual(height_decision({'height':'''60' 6"'''},190,True), 'source_height_conflict')
        self.assertEqual(height_decision({'height':200},207,False), 'measured_height')
        self.assertEqual(height_decision({'height':197.5,'num_floors':32},197.7,True), 'measured_height')
        self.assertEqual(height_decision({},207,True), 'measured_height')
        self.assertFalse(estimated_height({'height':20,'sources':[{'property':'/properties/height','dataset':'Other'}]}))
        self.assertFalse(estimated_height({'height':20,'sources':[{'property':'/properties/height','dataset':'OpenStreetMap'},
                          {'property':'/properties/height','dataset':'USGS Lidar'}]}))

    def test_bad_derived_height_can_use_independent_source_corroboration(self):
        self.assertEqual(height_decision(estimated(21,num_floors=49),140,False), 'corrected_estimated_height')
        self.assertEqual(height_decision(estimated(21),140,False,corroborated=True), 'corrected_estimated_height')
        self.assertEqual(height_decision({'height':21},140,False,corroborated=True), 'source_height_conflict')
