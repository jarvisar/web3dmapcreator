"""Sampling-boundary regressions; no Blender, network, or cached city inputs."""
import math
import unittest

try:
    import numpy as np
    from shapely import contains_xy
    from shapely.affinity import rotate, scale
    from shapely.geometry import Point, Polygon, MultiPolygon, box, shape
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_contours import regularize_grid_contours
    from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class GridContourTests(unittest.TestCase):
    cell = 1.5

    def raster(self, outline):
        cell = self.cell
        left, bottom, right, top = outline.bounds
        return unary_union([
            box(x*cell, y*cell, (x+1)*cell, (y+1)*cell)
            for x in range(math.floor(left/cell), math.ceil(right/cell))
            for y in range(math.floor(bottom/cell), math.ceil(top/cell))
            if outline.covers(Point((x+.5)*cell, (y+.5)*cell))])

    def assert_smoother(self, actual):
        raster = self.raster(actual)
        result = regularize_grid_contours(raster, self.cell)
        self.assertTrue(result.is_valid)
        self.assertLess(abs(result.length-actual.length), abs(raster.length-actual.length)*.25)
        self.assertLess(result.symmetric_difference(actual).area,
                        raster.symmetric_difference(actual).area*.7)
        self.assertLess(len(result.exterior.coords), len(raster.exterior.coords)*.3)
        self.assertLess(raster.boundary.hausdorff_distance(result.boundary), self.cell*.8)
        self.assertAlmostEqual(result.area, raster.area, delta=raster.area*.05)
        return raster, result

    def test_diagonal_setback_reduces_stairs_and_shape_error(self):
        self.assert_smoother(rotate(box(10, 10, 50, 40), 29))

    def test_curved_tower_reduces_stairs_without_dense_mesh(self):
        self.assert_smoother(Point(30, 30).buffer(23, quad_segs=64))

    def test_diagonal_grid_phase_does_not_inflate_tier_area(self):
        # Both endpoints can lie on the outward stair phase. Fitting those
        # corners directly biases an entire long wall by half a cell.
        raster = self.raster(Polygon([(30, 6), (54, 30), (30, 54), (6, 30)]))
        result = regularize_grid_contours(raster, self.cell)
        self.assertLess(result.length, raster.length*.8)
        self.assertAlmostEqual(result.area, raster.area, delta=raster.area*.01)

    def test_aligned_rectangle_remains_exact(self):
        outline = self.raster(box(6, 9, 51, 45))
        self.assertTrue(regularize_grid_contours(outline, self.cell).equals(outline))

    def test_concave_terraces_and_rectangular_courtyard_remain_exact(self):
        # The deep recess, courtyard corners, and thin connecting corridor
        # describe architecture; none is an alternating staircase run.
        courtyard = box(6, 6, 66, 66).difference(box(18, 18, 54, 54))
        recess = box(6, 6, 60, 60).difference(box(30, 30, 70, 70))
        narrow_corridor = unary_union([box(0, 0, 15, 15), box(30, 0, 45, 15),
                                      box(15, 6, 30, 9)])
        for outline in (courtyard, recess, narrow_corridor):
            with self.subTest(outline=outline.wkt):
                raster = self.raster(outline)
                result = regularize_grid_contours(raster, self.cell)
                self.assertTrue(result.equals(raster))
                self.assertEqual(len(result.interiors), len(raster.interiors))

    def test_curved_courtyard_retains_hole_and_bounded_area(self):
        courtyard = box(0, 0, 60, 60).difference(Point(30, 30).buffer(17, quad_segs=64))
        raster = self.raster(courtyard)
        result = regularize_grid_contours(raster, self.cell)
        self.assertTrue(result.is_valid)
        self.assertEqual(len(result.interiors), 1)
        self.assertTrue(Polygon(result.exterior).equals(box(0, 0, 60, 60)))
        self.assertLess(len(result.interiors[0].coords), len(raster.interiors[0].coords)*.5)
        self.assertAlmostEqual(Polygon(result.interiors[0]).area,
                               Polygon(raster.interiors[0]).area,
                               delta=Polygon(raster.interiors[0]).area*.05)

    def test_distinct_towers_remain_distinct(self):
        first = self.raster(Point(15, 15).buffer(10, quad_segs=32))
        second = self.raster(Point(42, 15).buffer(10, quad_segs=32))
        result = regularize_grid_contours(MultiPolygon([first, second]), self.cell)
        self.assertTrue(result.is_valid)
        self.assertEqual(result.geom_type, 'MultiPolygon')
        self.assertEqual(len(result.geoms), 2)

    def test_exact_source_diagonals_are_not_reinterpreted(self):
        outline = rotate(box(10, 10, 50, 40), 29)
        self.assertTrue(regularize_grid_contours(outline, self.cell).equals(outline))

    def test_tolerance_tracks_sampling_scale(self):
        raster = self.raster(Point(30, 30).buffer(23, quad_segs=64))
        expected = regularize_grid_contours(raster, self.cell)
        for factor in (.1, 10):
            scaled = scale(raster, xfact=factor, yfact=factor, origin=(0, 0))
            result = regularize_grid_contours(scaled, self.cell*factor)
            restored = scale(result, xfact=1/factor, yfact=1/factor, origin=(0, 0))
            self.assertLess(restored.symmetric_difference(expected).area, 1e-8)

    def test_raw_points_keep_nested_flat_towers_with_smoother_printable_outlines(self):
        footprint = box(0, 0, 60, 60)
        tower = rotate(box(15, 18, 45, 42), 29)
        crown = rotate(box(24, 24, 36, 36), 29)
        xy = np.array([(x, y) for x in np.arange(.25, 60, .45)
                       for y in np.arange(.25, 60, .45)])
        heights = np.where(contains_xy(crown, xy[:, 0], xy[:, 1]), 80,
                           np.where(contains_xy(tower, xy[:, 0], xy[:, 1]), 50, 20))
        points = np.column_stack((xy, heights, np.full(len(xy), 6), np.ones(len(xy))))
        index = PointIndex(points)
        # Add-on default XY scale, height multiplier, and printed detail limits.
        settings = dict(min_width_m=.1/.07, min_step_m=.05/(.07*1.1), ground_m=0)
        classic, why = measure_building(footprint, index, roof_mode='TERRACES', **settings)
        self.assertIsNotNone(classic, why)
        detailed, why = measure_building(footprint, index, roof_mode='FACETED', **settings)
        self.assertIsNotNone(detailed, why)
        self.assertEqual(why, 'faceted_roof')
        self.assertAlmostEqual(detailed['height_m'], 20)
        self.assertEqual([tier['top_m'] for tier in classic['tiers']], [50, 80])

        surfaces = detailed['roof_surfaces']
        roofs = [shape(surface['geometry']) for surface in surfaces]
        # Facet filtering permits only microscopic clipping slivers; preserve
        # the whole mapped outline and keep every roof inside its support.
        self.assertLess(unary_union(roofs).symmetric_difference(footprint).area, .05)
        self.assertTrue(all(footprint.covers(roof) for roof in roofs))
        for surface in surfaces:
            z = [v[2] for v in surface['geometry']['coordinates'][0]]
            self.assertLess(max(z)-min(z), .01, 'Flat tiers must not ramp across a real wall')
            self.assertLess(min(abs(z[0]-height) for height in (20, 50, 80)), .01)

        support = footprint
        for top, actual in ((50, tower), (80, crown)):
            old_outline = shape(next(t for t in classic['tiers'] if t['top_m'] == top)['geometry'])
            outline = unary_union([shape(s['geometry']) for s in surfaces
                                   if max(v[2] for v in s['geometry']['coordinates'][0]) >= top-.01])
            self.assertEqual(outline.geom_type, 'Polygon')
            self.assertTrue(support.buffer(1e-7).covers(outline))
            # Measure the external silhouette: tiny filtered triangulation
            # slivers are independently bounded by the roof-coverage assertion.
            self.assertLess(outline.exterior.length, old_outline.exterior.length*.9)
            self.assertLess(outline.symmetric_difference(actual).area,
                            old_outline.symmetric_difference(actual).area*.8)
            self.assertAlmostEqual(outline.area, old_outline.area, delta=old_outline.area*.05)
            self.assertFalse(outline.buffer(-settings['min_width_m']*.45).is_empty)
            support = outline


if __name__ == '__main__':
    unittest.main()
