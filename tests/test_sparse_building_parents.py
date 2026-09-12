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

    def test_no_guessed_height_or_elevated_parent(self):
        part=feature('part',(0,0,2,2),building_id='parent',height=24)
        for props in ({},{'height':10,'min_height':20},{'height':30,'min_height':20}):
            parent=feature('parent',has_parts=True,**props)
            self.assertFalse(select_building_geometry([parent],[part],True).buildings)
