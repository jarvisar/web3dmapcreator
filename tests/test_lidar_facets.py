import unittest
from unittest.mock import patch

try:
    import numpy as np
    from shapely.geometry import box, shape, mapping
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_facets import fit_faceted_roof
    from jarvizar_city_model.external.lidar_measurements import measure_building, PointIndex
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class FacetedRoofTests(unittest.TestCase):
    def curve(self, x, y):
        return 15+7*(1-((x-12)/12)**2)

    def cloud(self, roof=None):
        roof = roof or self.curve
        return np.array([(x,y,roof(x,y),6,1) for x in np.arange(.25,24,.45)
                         for y in np.arange(.25,24,.45)])

    def measure(self, points, mode='FACETED', planes=True):
        return measure_building(box(0,0,24,24), PointIndex(points), 1.43, .25,
                                ground_m=0, roof_mode=mode, roof_planes=planes)

    def covered(self, record, footprint):
        roofs = [shape(s['geometry']) for s in record['roof_surfaces']]
        self.assertLess(unary_union(roofs).symmetric_difference(footprint).area, 1e-6)
        self.assertAlmostEqual(sum(p.area for p in roofs), footprint.area, places=6)
        self.assertTrue(all(s['bottom_m'] == record['height_m'] for s in record['roof_surfaces']))

    def test_curved_roof_has_sloping_facets_instead_of_height_bands(self):
        points = self.cloud()
        old, _ = self.measure(points, 'TERRACES')
        result, reason = self.measure(points)
        self.assertTrue(old['tiers'])
        self.assertEqual(reason, 'faceted_roof')
        self.assertFalse(result['tiers'])
        self.assertGreater(len(result['roof_surfaces']), 8)
        self.assertLessEqual(len(result['roof_surfaces']), 1024)
        self.assertLessEqual(result['roof_fit_p95_m'], .35)
        self.covered(result, box(0,0,24,24))
        slopes = 0
        for surface in result['roof_surfaces']:
            ring = surface['geometry']['coordinates'][0]
            slopes += max(v[2] for v in ring)-min(v[2] for v in ring) > .3
            for x,y,z in ring:
                self.assertLess(abs(z-self.curve(x,y)), 1.3)  # 1.5 m supported cell footprint.
        self.assertGreater(slopes, len(result['roof_surfaces'])/2)

    def test_major_podium_step_stays_vertical(self):
        points = self.cloud(lambda x,y:45+3*np.sin(x/5) if 6<x<18 and 6<y<18 else 10)
        original, _ = self.measure(points, 'TERRACES')
        result, reason = self.measure(points)
        self.assertEqual(reason, 'faceted_roof')
        self.assertGreaterEqual(result['roof_patch_count'], 2)
        self.covered(result, box(0,0,24,24))
        for surface in result['roof_surfaces']:
            heights = [v[2] for ring in surface['geometry']['coordinates'] for v in ring]
            self.assertLess(max(heights)-min(heights), 8, 'No ramp from tower to podium')
        upper = unary_union([shape(s['geometry']) for s in result['roof_surfaces']
                             if max(v[2] for v in s['geometry']['coordinates'][0]) > 30])
        expected = shape(next(t for t in original['tiers'] if t['top_m'] > 30)['geometry'])
        self.assertLess(upper.symmetric_difference(expected).area, 1e-6)

    def test_courtyard_is_not_bridged_by_convex_triangulation(self):
        from shapely import contains_xy
        footprint = box(0,0,24,24).difference(box(8,8,16,16))
        samples = self.cloud()[:, :3]
        samples = samples[contains_xy(footprint, samples[:,0], samples[:,1])]
        result, why = fit_faceted_roof(footprint, samples, 1.5, 1.43, .25, {'height_m':22, 'tiers':[]})
        self.assertIsNotNone(result, why)
        self.covered(result, footprint)

    def test_unknown_boundary_and_extreme_spike_retain_original_envelope(self):
        samples = self.cloud()[:, :3]
        inner = samples[(samples[:,0]>5)&(samples[:,0]<19)&(samples[:,1]>5)&(samples[:,1]<19)]
        result, why = fit_faceted_roof(box(0,0,24,24), inner, 1.5, 1.43, .25, {'height_m':22, 'tiers':[]})
        self.assertIsNone(result)
        self.assertEqual(why, 'unobserved roof boundary')
        samples[len(samples)//2, 2] = 300
        result, _ = fit_faceted_roof(box(0,0,24,24), samples, 1.5, 1.43, .25, {'height_m':22, 'tiers':[]})
        self.assertIsNone(result)

    def test_uncertain_patch_keeps_its_existing_height(self):
        from shapely import contains_xy
        footprint, upper = box(0,0,24,24), box(9,9,15,15)
        samples = self.cloud()[:, :3]
        samples = samples[~contains_xy(upper, samples[:,0], samples[:,1])]
        original = {'height_m':16, 'tiers':[{'bottom_m':16, 'top_m':45, 'geometry':mapping(upper)}]}
        result, why = fit_faceted_roof(footprint, samples, 1.5, 1.43, .25, original)
        self.assertIsNotNone(result, why)
        self.assertTrue(result['retained_roof_patches'])
        self.covered(result, footprint)
        high = [s for s in result['roof_surfaces'] if shape(s['geometry']).intersection(upper).area > 1e-7]
        self.assertTrue(high)
        self.assertTrue(all(v[2] == 45 for s in high for ring in s['geometry']['coordinates'] for v in ring))

    def test_detail_budget_falls_back_and_modes_preserve_classic_results(self):
        points = self.cloud()
        old, old_reason = self.measure(points, 'TERRACES')
        with patch('jarvizar_city_model.external.lidar_facets.MAX_PATCH_VERTICES', 3):
            result, reason = self.measure(points)
        note = result.pop('faceted_fallback')
        self.assertIn('budget', note)
        self.assertEqual((result, reason), (old, old_reason))
        self.assertEqual(self.measure(points, planes=False), self.measure(points, 'TERRACES', planes=False))

    def test_repeated_runs_and_point_order_are_deterministic(self):
        points = self.cloud()
        first = self.measure(points)
        np.random.default_rng(41).shuffle(points)
        self.assertEqual(self.measure(points), first)

    def test_touching_roof_boundaries_keep_holes_when_direct_triangulation_fails(self):
        from shapely.geometry import Polygon
        from shapely.errors import GEOSException
        from shapely import constrained_delaunay_triangles
        from jarvizar_city_model.external.lidar_facets import roof_triangles
        roof = Polygon([(0,0),(10,0),(10,10),(0,10)],
                       holes=[[(0,5),(3,3),(3,7)]])
        self.assertTrue(roof.is_valid)
        def constrained(piece):
            if piece.equals(roof):
                raise GEOSException('Unable to find a convex corner')
            return constrained_delaunay_triangles(piece)
        with patch('jarvizar_city_model.external.lidar_facets.constrained_delaunay_triangles',
                   side_effect=constrained):
            triangles = roof_triangles(roof)
        self.assertTrue(triangles)
        self.assertLess(unary_union(triangles).symmetric_difference(roof).area, 1e-8)
        self.assertAlmostEqual(sum(t.area for t in triangles), roof.area)
        self.assertTrue(all(len(t.exterior.coords) == 4 and not t.interiors for t in triangles))

    def test_microscopic_clipping_slivers_do_not_become_roof_solids(self):
        from shapely.geometry import Polygon
        from jarvizar_city_model.external.lidar_facets import printable_facet
        self.assertFalse(printable_facet(Polygon([(0,0),(10,0),(5,.001)])))
        self.assertTrue(printable_facet(Polygon([(0,0),(10,0),(5,1)])))
