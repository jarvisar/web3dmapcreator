"""Source confidence and spatial height checks, including stale tall LiDAR."""
import unittest

from jarvizar_city_model.external.lidar_source import height_decision, estimated_height


def estimated(height, **properties):
    return dict(height=height, sources=[{'property':'/properties/height',
                'dataset':'Microsoft ML Buildings'}], **properties)


class SourceConfidenceTests(unittest.TestCase):
    def test_regional_top_preserves_overlap_precedence_and_ignores_distant_faces(self):
        try:
            from shapely.geometry import box, mapping
        except ImportError:
            self.skipTest('optional LiDAR dependencies not installed')
        from jarvizar_city_model.external.lidar_source import regional_top
        footprint = box(0, 0, 10, 10)
        def surface(bounds, height):
            ring = [[x, y, height] for x, y in box(*bounds).exterior.coords]
            return {'geometry': {'type': 'Polygon', 'coordinates': [ring]}, 'bottom_m': 2}
        record = {'height_m': 2, 'tiers': [], 'roof_surfaces': [
            surface((20, 20, 30, 30), 100),
            surface((0, 0, 9, 10), 8),
            surface((0, 0, 10, 10), 20)]}
        self.assertEqual(regional_top(record, footprint, footprint), 8)
        # Tiers retain priority over overlapping surfaces, including a hole.
        tier = footprint.difference(box(4, 4, 6, 6))
        record['tiers'] = [{'top_m': 12, 'geometry': mapping(tier)},
                           {'top_m': 200, 'geometry': mapping(box(30, 30, 40, 40))}]
        self.assertEqual(regional_top(record, footprint, footprint), 12)
        self.assertIsNone(regional_top(record, box(20, 20, 21, 21), footprint))

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
