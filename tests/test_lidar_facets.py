import unittest
from unittest.mock import patch

try:
    import numpy as np
    from shapely.geometry import box, shape, mapping, GeometryCollection, LineString, Point
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_facets import fit_faceted_roof, continuous_boundary
    from jarvizar_city_model.external.lidar_measurements import measure_building, PointIndex
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class FacetedRoofTests(unittest.TestCase):
    def test_clipped_mixed_geometry_preserves_step_and_continuity_decisions(self):
        footprint = unary_union([box(0, 0, 24, 24), box(26, 0, 30, 24)])
        upper = box(6, 6, 18, 18)
        # Clipping valid polygonal data can leave line contacts with another
        # footprint component. GEOS gives that collection a None boundary.
        raw = unary_union([upper, box(24, 0, 26, 24)])
        mixed = raw.intersection(footprint)
        self.assertEqual(mixed.geom_type, 'GeometryCollection')
        for roof, expected in ((lambda x, y: 50 if 6<x<18 and 6<y<18 else 10, False),
                               (lambda x, y: 10 + x*.2, True)):
            samples = self.cloud(roof)[:, :3]
            self.assertIs(continuous_boundary(upper, footprint, samples, 1.5, .35), expected)
            self.assertIs(continuous_boundary(mixed, footprint, samples, 1.5, .35), expected)

    def test_nonareal_boundary_has_no_continuity_evidence(self):
        for boundary in (GeometryCollection(), LineString([(5, 5), (10, 10)]),
                         GeometryCollection([LineString([(5, 5), (10, 10)]), Point(12, 12)])):
            self.assertIsNone(continuous_boundary(boundary, box(0, 0, 24, 24),
                                                 self.cloud()[:, :3], 1.5, .35))

    def test_mixed_sample_boundary_keeps_complete_detailed_roof(self):
        footprint, upper = box(0, 0, 24, 24), box(6, 6, 18, 18)
        raw = unary_union([upper, box(24, 0, 26, 24)])
        samples = self.cloud(lambda x, y: 50 if upper.contains(Point(x, y)) else 10)[:, :3]
        original = {'height_m': 10, 'tiers': [
            {'bottom_m': 10, 'top_m': 50, 'geometry': mapping(upper)}]}
        expected, reason = fit_faceted_roof(footprint, samples, 1.5, 1.43, .65,
                                           original, sample_boundaries=[upper])
        actual, actual_reason = fit_faceted_roof(footprint, samples, 1.5, 1.43, .65,
                                                original, sample_boundaries=[raw])
        self.assertIsNotNone(expected, reason)
        self.assertEqual(actual_reason, reason)
        self.assertEqual(actual, expected)
        self.covered(actual, footprint)

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
        result, reason = self.measure(points)
        self.assertEqual(reason, 'faceted_roof')
        self.assertGreaterEqual(result['roof_patch_count'], 2)
        self.covered(result, box(0,0,24,24))
        for surface in result['roof_surfaces']:
            heights = [v[2] for ring in surface['geometry']['coordinates'] for v in ring]
            self.assertLess(max(heights)-min(heights), 8, 'No ramp from tower to podium')
        upper = unary_union([shape(s['geometry']) for s in result['roof_surfaces']
                             if max(v[2] for v in s['geometry']['coordinates'][0]) > 30])
        # Surface ownership is reconstructed directly, so its boundary should
        # approach the actual tower, not reproduce the old raster contour.
        expected = box(6, 6, 18, 18)
        self.assertLess(upper.symmetric_difference(expected).area, expected.area*.1)
        self.assertLess(upper.boundary.hausdorff_distance(expected.boundary), 1.5)

    def test_supported_slope_crosses_artificial_major_terrace_bands(self):
        footprint = box(0, 0, 24, 24)
        samples = self.cloud(lambda x, y: 12 + .8*x)[:, :3]
        original = {'height_m': 16, 'tiers': [
            {'bottom_m': 16, 'top_m': 22, 'geometry': mapping(box(8, 0, 24, 24))},
            {'bottom_m': 22, 'top_m': 30, 'geometry': mapping(box(16, 0, 24, 24))}]}
        result, why = fit_faceted_roof(footprint, samples, 1.5, 1.43, .05/.077, original)
        self.assertIsNotNone(result, why)
        self.assertEqual(result['continuous_terrace_boundaries'], 2)
        self.assertEqual(result['roof_patch_count'], 1)
        self.covered(result, footprint)
        for surface in result['roof_surfaces']:
            for x, y, z in surface['geometry']['coordinates'][0]:
                self.assertAlmostEqual(z, 12 + .8*x, places=6)

    def test_shallow_real_setback_does_not_become_a_ramp(self):
        footprint, upper = box(0, 0, 24, 24), box(9, 0, 24, 24)
        samples = self.cloud(lambda x, y: 21.5 if x > 9 else 20)[:, :3]
        original = {'height_m': 20, 'tiers': [
            {'bottom_m': 20, 'top_m': 21.5, 'geometry': mapping(upper)}]}
        result, why = fit_faceted_roof(footprint, samples, 1.5, 1.43, .05/.077, original)
        self.assertIsNotNone(result, why)
        self.covered(result, footprint)
        self.assertEqual(result['roof_patch_count'], 2)
        for surface in result['roof_surfaces']:
            ring = surface['geometry']['coordinates'][0]
            expected = 21.5 if shape(surface['geometry']).centroid.x > 9 else 20
            self.assertTrue(all(abs(v[2] - expected) < 1e-6 for v in ring))

    def test_mostly_continuous_boundary_keeps_supported_raised_inset(self):
        from jarvizar_city_model.external.lidar_facets import continuous_boundary
        footprint, upper = box(0, 0, 24, 24), box(9, 0, 24, 24)
        samples = self.cloud(lambda x, y: 12 + .8*x + (6 if x > 9 and y > 19 else 0))[:, :3]
        # Most of x=9 crosses one plane, but its final few metres meet a real
        # raised inset. A majority/quantile continuity vote erases that wall.
        self.assertIs(continuous_boundary(upper, footprint, samples, 1.5, .35), False)

    def test_continuity_requires_support_along_the_whole_boundary(self):
        from jarvizar_city_model.external.lidar_facets import continuous_boundary
        footprint, upper = box(0, 0, 24, 24), box(9, 0, 24, 24)
        samples = self.cloud(lambda x, y: 12 + .8*x)[:, :3]
        self.assertIs(continuous_boundary(upper, footprint, samples, 1.5, .35), True)
        samples = samples[samples[:, 1] < 18]
        # Agreement over the observed lower section says nothing about the
        # missing upper section; it cannot authorize removing a major tier.
        self.assertIsNone(continuous_boundary(upper, footprint, samples, 1.5, .35))

    def test_planar_patch_filters_sub_tolerance_survey_noise(self):
        from jarvizar_city_model.external.lidar_facets import patch_facets
        samples = self.cloud(lambda x, y: 20 + .15*np.sin(x*4)*np.cos(y*3))[:, :3]
        surfaces, error = patch_facets(box(0, 0, 24, 24), samples, 1.5, .35, 1024)
        self.assertEqual(len(surfaces), 2)
        self.assertLess(error, .2)
        self.assertTrue(all(abs(v[2] - 20) < .01 for s in surfaces
                            for v in s['geometry']['coordinates'][0]))

    def test_adaptive_patch_does_not_bridge_abrupt_sample_heights_with_steep_facets(self):
        from jarvizar_city_model.external.lidar_facets import patch_facets, UnsupportedFit
        samples = self.cloud(lambda x, y: 50 if x > 12 else 20)[:, :3]
        # A missed partition or ambiguous edge may mix neighboring roof levels.
        # Refinement cannot turn the remaining sub-cell gap into a near-vertical
        # triangle; the owning envelope must retain its measured terrace.
        with self.assertRaisesRegex(UnsupportedFit, 'unsupported roof slope'):
            patch_facets(box(0, 0, 24, 24), samples, 1.5, .35, 1024)

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
        # Detailed reconstruction derives these controls from output scale;
        # its conservative fallback uses that same physical detail policy.
        old, old_reason = measure_building(box(0, 0, 24, 24), PointIndex(points),
                                          .1 / .07, .05 / .077, ground_m=0,
                                          roof_mode='TERRACES')
        with patch('jarvizar_city_model.external.lidar_facets.MAX_PATCH_VERTICES', 3):
            result, reason = self.measure(points)
            for width, step in ((.01/.07, .02/.077), (1/.07, 1/.077)):
                self.assertEqual(measure_building(box(0, 0, 24, 24), PointIndex(points),
                    width, step, ground_m=0, roof_mode='FACETED'), (result, reason))
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
