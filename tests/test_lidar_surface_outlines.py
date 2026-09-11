"""Actual vector contour and partition regressions, independent of city data."""
import unittest

try:
    import numpy as np
    from shapely.affinity import rotate, translate
    from shapely.geometry import LineString, Point, Polygon, box, shape
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_surface_outlines import fit_chain, regularize_outlines
    from jarvizar_city_model.external.lidar_surfaces import _consolidate_patches, regularize_compatible_roof
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class SurfaceOutlineTests(unittest.TestCase):
    def raster(self, polygon, cell=1.5):
        x0,y0,x1,y1=polygon.bounds
        return unary_union([box(x,y,x+cell,y+cell)
            for x in np.arange(x0-cell,x1,cell) for y in np.arange(y0-cell,y1,cell)
            if polygon.covers(Point(x+cell/2,y+cell/2))])

    def test_circular_tier_becomes_a_fitted_closed_curve(self):
        actual=Point(30,30).buffer(20,quad_segs=128)
        measured=self.raster(actual)
        fitted=fit_chain(LineString(measured.exterior.coords),1.2)
        self.assertTrue(fitted.is_ring, 'Circle must close exactly for polygonization')
        self.assertLess(fitted.hausdorff_distance(actual.boundary),.4)
        self.assertLess(fitted.length, measured.length*.85)
        self.assertLess(len(fitted.coords),60)

    def test_diagonal_rectangular_plant_has_four_intentional_corners(self):
        actual=rotate(box(10,10,40,28),29)
        measured=self.raster(actual)
        fitted=fit_chain(LineString(measured.exterior.coords),1.2)
        self.assertEqual(len(fitted.coords),5)
        self.assertLess(fitted.hausdorff_distance(actual.boundary),.8)
        self.assertLess(abs(Polygon(fitted).area-actual.area)/actual.area,.08)

    def test_resolved_recess_is_not_replaced_by_a_rectangle(self):
        actual=rotate(box(0,0,30,24).difference(box(10,12,30,24)),19)
        measured=self.raster(actual)
        fitted=fit_chain(LineString(measured.exterior.coords),1.2)
        self.assertGreater(len(fitted.coords),5)
        self.assertLess(fitted.hausdorff_distance(measured.boundary),1.21)
        self.assertLess(Polygon(fitted).intersection(rotate(box(14,16,26,21),19,origin=(15,12))).area,10)

    def test_shared_three_way_interfaces_keep_exact_coverage_and_courtyard(self):
        footprint=box(0,0,50,40).difference(box(36,28,44,35))
        upper=self.raster(rotate(box(10,8,34,29),23)).intersection(footprint)
        west=footprint.intersection(box(0,0,22,40)).difference(upper)
        east=footprint.difference(upper.union(west))
        patches=[(g,np.empty((0,3))) for g in (upper,west,east)]
        result,diagnostics=regularize_outlines(patches,footprint,1.5,(.07,.077))
        self.assertGreater(diagnostics.get('surface_outline_fitted',0),0)
        shapes=[g for g,_ in result]
        self.assertLess(unary_union(shapes).symmetric_difference(footprint).area,1e-6)
        self.assertAlmostEqual(sum(g.area for g in shapes),footprint.area,places=6)
        self.assertTrue(all(g.is_valid for g in shapes))
        self.assertTrue(shapes[0].covers(Point(22,18)))
        self.assertFalse(unary_union(shapes).covers(Point(40,31)))

    def test_existing_continuous_roof_join_is_not_displaced(self):
        footprint=box(0,0,30,24)
        west=Polygon([(0,0),(15,0),(15,8),(15.1,12),(15,16),(15,24),(0,24)])
        patches=[(west,np.empty((0,3))),(footprint.difference(west),np.empty((0,3)))]
        fits=[(np.zeros(2),np.array([.5,0,20]),0),
              (np.zeros(2),np.array([-.5,0,35]),0)]
        result,_=regularize_outlines(patches,footprint,1.5,(.07,.077),fits=fits)
        self.assertTrue(result[0][0].equals(west))

    def test_legacy_levels_get_vector_boundaries_without_new_height_bands(self):
        footprint=box(0,0,60,60)
        tier=self.raster(Point(30,30).buffer(20,quad_segs=96))
        from shapely.geometry import mapping
        original={'height_m':20.,'cell_m':1.5,'method':'flat_regions',
                  'faceted_fallback':'unobserved roof boundary',
                  'tiers':[{'geometry':mapping(tier),'bottom_m':20.,'top_m':50.}]}
        refined=regularize_compatible_roof(original,footprint,(.07,.077))
        self.assertTrue(refined.get('compatibility_outline_refinement'))
        self.assertNotIn('surface_reconstruction',refined)
        self.assertEqual(refined['faceted_fallback'],original['faceted_fallback'])
        z={round(v[2],6) for s in refined['roof_surfaces'] for ring in s['geometry']['coordinates'] for v in ring}
        self.assertEqual(z,{20.,50.})
        shapes=[shape(s['geometry']) for s in refined['roof_surfaces']]
        self.assertLess(unary_union(shapes).symmetric_difference(footprint).area,1e-6)


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class FinalPlaneConsolidationTests(unittest.TestCase):
    def patches(self,levels,gradient=(0.,0.)):
        patches=[]
        for i,height in enumerate(levels):
            x,y=np.meshgrid(np.arange(i*15+.75,(i+1)*15,1.5),np.arange(.75,24,1.5))
            x,y=x.ravel(),y.ravel()
            samples=np.column_stack((x,y,height+gradient[0]*x+gradient[1]*y))
            patches.append((box(i*15,0,(i+1)*15,24),samples))
        return patches

    def fit(self,patches,scale=(.07,.077)):
        return _consolidate_patches(patches,1.5,.025/scale[1],.05/scale[1],scale)

    def test_subprint_offsets_merge_without_creating_a_ramp(self):
        for gradient in ((0.,0.),(.4,.12)):
            patches,fits,diagnostics=self.fit(self.patches((20.,20.9),gradient))
            self.assertEqual(len(patches),1)
            np.testing.assert_allclose(fits[0][1][:2],gradient,atol=1e-9)
            self.assertEqual(diagnostics['surface_final_plane_merges'],1)

    def test_nearby_corner_without_reverse_buffer_contact_stays_separate(self):
        # Rounded buffers are polygonal approximations: buffering A can touch B
        # while A misses buffered B. Such a neighbor has no shared roof edge.
        a = box(-10, -10, 0, 10)
        b = rotate(box(0, 0, 10, 10), 30, origin=(0, 0))
        b = translate(b, xoff=-b.bounds[0] + 9.995e-7)
        self.assertTrue(a.buffer(1e-6).intersects(b))
        self.assertTrue(a.intersection(b.buffer(1e-6)).is_empty)
        samples = np.array([[-5,-5,20],[-5,0,20],[-5,5,20],[-2,0,20]], float)
        # Put the second roof's observations inside its own supported interior.
        center = np.asarray(b.representative_point().coords[0])
        other = np.column_stack((center + np.array([[-1,0],[1,0],[0,-1],[0,1]]), np.full(4,20.)))
        patches = [(a, samples), (b, other)]
        for ordered in (patches, list(reversed(patches))):
            result, fits, diagnostics = self.fit(ordered)
            self.assertEqual(diagnostics['surface_final_plane_merges'], 0)
            self.assertEqual(len(result), 2)
            for (expected, support), (actual, retained), fit in zip(ordered, result, fits):
                self.assertTrue(actual.equals_exact(expected, 0))
                np.testing.assert_array_equal(retained, support)
                np.testing.assert_allclose(fit[1], [0., 0., 20.])

    def test_large_print_retains_the_same_resolved_step(self):
        patches=self.patches((20.,20.9))
        self.assertEqual(len(self.fit(patches)[0]),1)
        self.assertEqual(len(self.fit(patches,scale=(.14,.154))[0]),2)

    def test_real_tier_is_preserved_and_merges_cannot_drift(self):
        for levels in ((20.,21.5),(20.,20.8,21.6,22.4)):
            patches,fits,_=self.fit(self.patches(levels))
            self.assertGreaterEqual(len(patches),2)
            for (_g,s),fit in zip(patches,fits):
                self.assertLessEqual(np.ptp(s[:,2]),.1/.077)
                self.assertLess(np.linalg.norm(fit[1][:2]),1e-8)

    def test_printable_small_crown_is_not_hidden_by_large_neighbor(self):
        large,small=self.patches((20.,25.))
        small=(box(15,0,19.5,4.5),small[1][:6])
        result,_,_=self.fit([large,small])
        self.assertEqual(len(result),2)
