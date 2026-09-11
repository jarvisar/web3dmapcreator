"""Localized compatibility roofs must retain a complete architectural envelope."""
import unittest

try:
    import numpy as np
    from shapely.geometry import Point, box, mapping, shape
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_surfaces import _planar_surfaces
    from jarvizar_city_model.external.lidar_surface_completion import complete_from_retained
    AVAILABLE=True
except ImportError:
    AVAILABLE=False


@unittest.skipUnless(AVAILABLE,'optional LiDAR dependencies not installed')
class SurfaceCompletionTests(unittest.TestCase):
    def test_failed_crown_keeps_its_full_old_height_above_supported_slope(self):
        footprint=box(0,0,30,24)
        tower=box(12,8,21,17)
        legacy={'height_m':20.,'cell_m':1.5,'method':'flat_regions',
                'tiers':[{'geometry':mapping(tower),'bottom_m':20.,'top_m':80.}],
                'faceted_fallback':'unsupported roof slope'}
        candidate={'surfaces':_planar_surfaces(footprint.difference(tower),np.zeros(2),np.array([.3,0.,20.])),
                   'unresolved':[(tower,'unsupported roof slope')],
                   'metadata':{'roof_patch_count':2,'roof_fit_p95_m':.2}}
        result=complete_from_retained(legacy,footprint,candidate)
        self.assertEqual(result['surface_reconstruction'],'coherent_regions_with_retained_patches')
        self.assertAlmostEqual(result['retained_surface_area_fraction'],tower.area/footprint.area)
        roofs=[shape(s['geometry']) for s in result['roof_surfaces']]
        self.assertLess(unary_union(roofs).symmetric_difference(footprint).area,1e-6)
        self.assertAlmostEqual(sum(g.area for g in roofs),footprint.area)
        crown=[s for s in result['roof_surfaces'] if shape(s['geometry']).covers(Point(15,12))]
        self.assertTrue(crown)
        self.assertEqual({round(v[2],6) for s in crown for ring in s['geometry']['coordinates'] for v in ring},{80.})
        self.assertTrue(any(max(v[2] for v in s['geometry']['coordinates'][0])-
                            min(v[2] for v in s['geometry']['coordinates'][0])>1 for s in result['roof_surfaces']))

    def test_incomplete_or_overlapping_candidates_keep_original_complete_roof(self):
        footprint=box(0,0,30,24)
        legacy={'height_m':30.,'cell_m':1.5,'tiers':[]}
        for supported,missing in ((box(0,0,10,24),box(20,0,30,24)),
                                  (box(0,0,20,24),box(10,0,30,24))):
            candidate={'surfaces':_planar_surfaces(supported,np.zeros(2),np.array([0.,0.,30.])),
                       'unresolved':[(missing,'test')],'metadata':{}}
            self.assertIs(complete_from_retained(legacy,footprint,candidate),legacy)

    def test_retained_surfaces_preserve_a_courtyard(self):
        footprint=box(0,0,30,24).difference(box(12,8,18,16))
        west=footprint.intersection(box(0,0,15,24))
        legacy={'height_m':25.,'cell_m':1.5,'tiers':[
            {'geometry':mapping(footprint.difference(west)),'bottom_m':25.,'top_m':45.}]}
        candidate={'surfaces':_planar_surfaces(west,np.zeros(2),np.array([.3,0.,25.])),
                   'unresolved':[(footprint.difference(west),'unobserved roof boundary')],'metadata':{}}
        result=complete_from_retained(legacy,footprint,candidate)
        self.assertTrue(result.get('retained_surface_patches'))
        roofs=[shape(s['geometry']) for s in result['roof_surfaces']]
        self.assertFalse(unary_union(roofs).covers(Point(15,12)))
        self.assertLess(unary_union(roofs).symmetric_difference(footprint).area,1e-6)

    def test_fallback_does_not_cut_new_plateaus_into_a_continuous_old_roof(self):
        footprint=box(0,0,30,24)
        legacy={'height_m':20.,'cell_m':1.5,'tiers':[],
                'roof_surfaces':_planar_surfaces(footprint,np.zeros(2),np.array([.3,0.,20.]))}
        candidate={'surfaces':_planar_surfaces(box(0,0,15,24),np.zeros(2),np.array([0.,0.,25.])),
                   'unresolved':[(box(15,0,30,24),'insufficient support')],'metadata':{}}
        self.assertIs(complete_from_retained(legacy,footprint,candidate),legacy)

    def test_continuous_retention_can_expand_without_losing_an_independent_roof(self):
        footprint=box(0,0,30,24)
        tower=box(20,0,30,24)
        legacy={'height_m':20.,'cell_m':1.5,'tiers':[
            {'geometry':mapping(tower),'bottom_m':20.,'top_m':50.}]}
        proposed=_planar_surfaces(box(0,0,30,12),np.zeros(2),np.array([0.,0.,30.]))
        proposed+=_planar_surfaces(box(20,12,30,24),np.zeros(2),np.array([0.,0.,50.]))
        candidate={'surfaces':proposed,'unresolved':[(box(0,12,20,24),'insufficient support')],'metadata':{}}
        result=complete_from_retained(legacy,footprint,candidate)
        self.assertTrue(result.get('retained_surface_patches'))
        roofs=[shape(s['geometry']) for s in result['roof_surfaces']]
        self.assertLess(unary_union(roofs).symmetric_difference(footprint).area,1e-6)
        for surface in result['roof_surfaces']:
            if shape(surface['geometry']).covers(Point(5,5)):
                self.assertTrue(all(abs(v[2]-20)<1e-6 for v in surface['geometry']['coordinates'][0]))
