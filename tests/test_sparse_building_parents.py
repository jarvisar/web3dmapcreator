import copy
import unittest
from jarvizar_city_model.geometry.buildings import select_building_geometry

def feature(identifier, bounds=(0,0,10,10), **props):
    x,y,X,Y=bounds
    return {'id':identifier,'properties':props,'geometry':{'type':'Polygon',
        'coordinates':[[[x,y],[X,y],[X,Y],[x,Y],[x,y]]]}}

class SparseParentsTests(unittest.TestCase):
    def test_floor_parent_and_lower_sparse_roof_retained_only_when_enabled(self):
        parent=feature('parent',has_parts=True,num_floors=18)
        part=feature('part',(0,0,2,2),building_id='parent',height=24)
        self.assertFalse(select_building_geometry([parent],[part]).buildings)
        result=select_building_geometry([parent],[part],retain_sparse_parents=True)
        self.assertEqual(result.buildings,(parent,))
        self.assertEqual(result.parts,(part,))

    def test_complete_or_heightless_coverage_stays_suppressed(self):
        parent=feature('parent',has_parts=True,num_floors=18)
        known=feature('known',(0,0,2,2),building_id='parent',height=24)
        for extra in (feature('extra',building_id='parent'),feature('extra',building_id='parent',height=54)):
            self.assertFalse(select_building_geometry([parent],[known,extra],True).buildings)

    def test_parent_holes_preserved_and_part_holes_opt_out(self):
        parent=feature('parent',has_parts=True,num_floors=18)
        parent['geometry']['coordinates'].append([[4,4],[4,6],[6,6],[6,4],[4,4]])
        part=feature('part',(0,0,2,2),building_id='parent',height=24)
        original=copy.deepcopy(parent)
        self.assertEqual(select_building_geometry([parent],[part],True).buildings,(original,))
        part['geometry']['coordinates'].append([[.5,.5],[.5,1],[1,1],[1,.5],[.5,.5]])
        self.assertFalse(select_building_geometry([parent],[part],True).buildings)

    def test_fallback_height_retained_but_invalid_or_elevated_parent_skipped(self):
        part=feature('part',(0,0,2,2),building_id='parent',height=24)
        parent=feature('parent',has_parts=True)
        self.assertEqual(select_building_geometry([parent],[part],True).buildings,(parent,))
        for props in ({'height':10,'min_height':20},{'height':30,'min_height':20}):
            parent=feature('parent',has_parts=True,**props)
            self.assertFalse(select_building_geometry([parent],[part],True).buildings)

    def test_majority_missing_threshold_keeps_all_parts(self):
        parent=feature('parent',has_parts=True,height=25)
        part=feature('part',(0,0,3,10),building_id='parent',height=15)
        original=copy.deepcopy([parent,part])
        result=select_building_geometry([parent],[part],True)
        self.assertEqual(result.buildings,(parent,))
        self.assertEqual(result.parts,(part,))
        self.assertEqual([parent,part],original)
        part['geometry']=feature('wide',(0,0,7,10))['geometry']
        self.assertFalse(select_building_geometry([parent],[part],True).buildings)

    def test_disconnected_footprint_uses_area_weighted_components(self):
        parent=feature('parent',has_parts=True,height=20)
        large=parent['geometry']['coordinates']
        small=feature('small',(20,0,21,1))['geometry']['coordinates']
        parent['geometry']={'type':'MultiPolygon','coordinates':[large,small]}
        part=feature('part',(0,0,3,10),building_id='parent',height=10)
        self.assertEqual(select_building_geometry([parent],[part],True).buildings,(parent,))
        # A fully covered large component cannot be outweighed by an empty tiny wing.
        part['geometry']=feature('covered')['geometry']
        self.assertFalse(select_building_geometry([parent],[part],True).buildings)
        # Nor can a covered tiny component suppress a mostly empty large body.
        part['geometry']={'type':'Polygon','coordinates':small}
        self.assertEqual(select_building_geometry([parent],[part],True).buildings,(parent,))
