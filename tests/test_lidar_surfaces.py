"""Geometry regressions for surface reconstruction at the default print scale."""
import unittest

try:
    import numpy as np
    from shapely import contains_xy
    from shapely.geometry import GeometryCollection, LineString, Point, Polygon, box, shape
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building
    from jarvizar_city_model.external.lidar_surfaces import (
        _plane, _planar_surfaces, _regularize_regions, surface_parameters)
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class CoherentSurfaceTests(unittest.TestCase):
    scale = (.07, .077)

    def cloud(self, footprint, roof, noise=0):
        left, bottom, right, top = footprint.bounds
        xx, yy = np.meshgrid(np.arange(left + .2, right, .4),
                             np.arange(bottom + .2, top, .4), indexing='ij')
        x, y = xx.ravel(), yy.ravel()
        inside = contains_xy(footprint, x, y)
        x, y = x[inside], y[inside]
        z = np.broadcast_to(roof(x, y), x.shape).astype(float, copy=True)
        if noise:
            z += noise * np.sin(x * 7.3) * np.cos(y * 5.9)
        return np.column_stack((x, y, z, np.full(len(x), 6), np.ones(len(x))))

    def measure(self, footprint, roof=None, noise=0, points=None,
                scale=None, width=.1/.07, step=.05/.077, mode='FACETED'):
        if points is None:
            points = self.cloud(footprint, roof, noise)
        return measure_building(footprint, PointIndex(points), width, step,
                                ground_m=0, roof_mode=mode,
                                surface_scale=scale or self.scale)

    def reconstructed(self, footprint, **kwargs):
        record, reason = self.measure(footprint, **kwargs)
        self.assertIsNotNone(record, reason)
        self.assertEqual(reason, 'faceted_roof', record.get('surface_fallback'))
        self.assertEqual(record.get('surface_reconstruction'), 'coherent_regions')
        self.assertFalse(record['tiers'], 'Continuous surfaces must not become terraces')
        self.assertEqual(record['cell_m'], 1.5)
        self.assert_partition(record, footprint)
        return record

    def assert_partition(self, record, footprint):
        surfaces = record['roof_surfaces']
        self.assertTrue(surfaces)
        self.assertLessEqual(len(surfaces), 1024)
        polygons = [shape(surface['geometry']) for surface in surfaces]
        self.assertTrue(all(p.is_valid and p.area > 0 for p in polygons))
        union = unary_union(polygons)
        self.assertLess(union.symmetric_difference(footprint).area, 1e-5)
        self.assertLess(abs(sum(p.area for p in polygons) - footprint.area), 1e-5,
                        'Roof patches may not overlap or leave gaps')
        for surface in surfaces:
            self.assertEqual(surface['bottom_m'], record['height_m'])
            for ring in surface['geometry']['coordinates']:
                self.assertTrue(np.isfinite(ring).all())
                self.assertTrue(all(v[2] >= record['height_m'] - 1e-6 for v in ring))

    def height_at(self, record, x, y):
        heights = []
        for surface in record['roof_surfaces']:
            if not shape(surface['geometry']).covers(Point(x, y)):
                continue
            points = np.asarray(surface['geometry']['coordinates'][0][:-1])
            center = np.mean(points[:, :2], axis=0)
            design = np.column_stack((points[:, :2] - center, np.ones(len(points))))
            coef, _, rank, _ = np.linalg.lstsq(design, points[:, 2], rcond=None)
            self.assertEqual(rank, 3)
            heights.append(float(np.dot(np.array([x, y]) - center, coef[:2]) + coef[2]))
        self.assertTrue(heights, f'No generated roof above {(x, y)}')
        return max(heights)

    def assert_heights(self, record, roof, probes, tolerance):
        for x, y in probes:
            self.assertAlmostEqual(self.height_at(record, x, y), float(roof(x, y)),
                                   delta=tolerance, msg=f'Roof height at {(x, y)}')

    def test_noisy_flat_roof_is_one_horizontal_surface(self):
        footprint = box(0, 0, 30, 24)
        record = self.reconstructed(footprint, roof=lambda x, y: 25, noise=.2)
        self.assertEqual(len(record['roof_surfaces']), 1)
        heights = [p[2] for p in record['roof_surfaces'][0]['geometry']['coordinates'][0]]
        self.assertLess(max(heights) - min(heights), 1e-6)
        # The unchanged upper-band sampler has a slight positive height bias;
        # reconstruction must remove its spatial noise, not invent accuracy.
        self.assertAlmostEqual(heights[0], 25, delta=.15)

    def test_mixed_footprint_contacts_preserve_the_areal_roof_envelope(self):
        footprint = box(0, 0, 24, 24)
        mixed = GeometryCollection([footprint, LineString([(24, 12), (25, 12)])])
        self.assertTrue(mixed.is_valid)
        points = self.cloud(footprint, lambda x, y: np.where(x < 12, 20., 30.))
        expected = self.reconstructed(footprint, points=points)
        actual = self.reconstructed(mixed, points=points)
        self.assertEqual(actual['roof_surfaces'], expected['roof_surfaces'])
        self.assertEqual(actual['height_m'], expected['height_m'])

    def test_broad_subprint_roof_ripple_does_not_become_an_adaptive_mesh(self):
        footprint=box(0,0,48,36)
        roof=lambda x,y:20+.4*np.sin(x/3)*np.cos(y/4)
        record=self.reconstructed(footprint,roof=roof,noise=.05)
        self.assertEqual(len(record['roof_surfaces']),1)
        self.assert_heights(record,lambda x,y:20,[(3,3),(15,15),(30,25),(44,32)],.3)

    def test_slopes_are_planes_including_steep_roofs(self):
        footprint = box(0, 0, 24, 24)
        for gradient in (.35, 2.3):
            with self.subTest(gradient=gradient):
                roof = lambda x, y: 20 + gradient*x + .12*y
                record = self.reconstructed(footprint, roof=roof, noise=.12)
                self.assertEqual(len(record['roof_surfaces']), 1)
                self.assert_heights(record, roof,
                    [(x, y) for x in (1, 6, 12, 18, 23) for y in (1, 12, 23)], .2)

    def test_noisy_gable_keeps_ridge_and_two_continuous_slopes(self):
        footprint = box(0, 0, 30, 24)
        roof = lambda x, y: 35 - .55*np.abs(x - 15)
        record = self.reconstructed(footprint, roof=roof, noise=.15)
        self.assertLess(len(record['roof_surfaces']), 80)
        self.assert_heights(record, roof,
            [(x, y) for x in (1, 5, 10, 15, 20, 25, 29) for y in (2, 12, 22)], .7)
        height_ranges = [np.ptp([v[2] for v in surface['geometry']['coordinates'][0]])
                         for surface in record['roof_surfaces']]
        self.assertGreater(sum(r > .1 for r in height_ranges), len(height_ranges)*.75)

    def test_barrel_roof_is_a_continuous_curve(self):
        footprint = box(0, 0, 30, 24)
        roof = lambda x, y: 20 + 8*(1 - ((x - 15)/15)**2)
        record = self.reconstructed(footprint, roof=roof, noise=.1)
        self.assertEqual(record['roof_patch_count'], 1)
        self.assertLess(len(record['roof_surfaces']), 128)
        self.assert_heights(record, roof,
            [(x, y) for x in (1, 5, 10, 15, 20, 25, 29) for y in (2, 12, 22)], .85)
        self.assertGreater(self.height_at(record, 15, 12) - self.height_at(record, 1, 12), 6)
        sloped_area = sum(shape(s['geometry']).area for s in record['roof_surfaces']
                          if np.ptp([v[2] for v in s['geometry']['coordinates'][0]]) > .1)
        self.assertGreater(sloped_area, footprint.area*.8)

    def test_shallow_architectural_step_stays_vertical(self):
        footprint = box(0, 0, 30, 24)
        roof = lambda x, y: np.where(x > 15, 21.5, 20.)
        record = self.reconstructed(footprint, roof=roof, noise=.1)
        self.assertEqual(record['roof_patch_count'], 2)
        self.assertLessEqual(len(record['roof_surfaces']), 4)
        self.assert_heights(record, roof,
            [(x, y) for x in (3, 12, 18, 27) for y in (3, 12, 21)], .15)
        for surface in record['roof_surfaces']:
            heights = [v[2] for v in surface['geometry']['coordinates'][0]]
            self.assertLess(max(heights) - min(heights), .1, 'A real wall became a ramp')

    def test_significant_rooftop_plant_survives_roof_noise(self):
        footprint, plant = box(0, 0, 30, 24), box(12, 8, 21, 17)
        roof = lambda x, y: np.where(contains_xy(plant, x, y), 29., 25.)
        record = self.reconstructed(footprint, roof=roof, noise=.2)
        self.assert_heights(record, roof, [(3, 3), (27, 20), (15, 12), (18, 14)], .2)
        upper = unary_union([shape(s['geometry']) for s in record['roof_surfaces']
                             if max(v[2] for v in s['geometry']['coordinates'][0]) > 27])
        self.assertLess(upper.symmetric_difference(plant).area, plant.area*.15)
        self.assertEqual(record['roof_patch_count'], 2)
        # The base cap is triangulated around the plant's hole, while it still
        # represents one coherent horizontal roof region.
        self.assertLess(len(record['roof_surfaces']), 40)

    def test_podium_multiple_towers_and_small_crown_keep_their_massing(self):
        footprint = box(0, 0, 48, 48)
        west, east = box(6, 9, 21, 39), box(30, 12, 42, 36)
        crown = box(12, 21, 16.5, 25.5)
        roof = lambda x, y: np.where(contains_xy(crown, x, y), 95.,
            np.where(contains_xy(west, x, y), 70.,
                     np.where(contains_xy(east, x, y), 50., 20.)))
        record = self.reconstructed(footprint, roof=roof, noise=.1)
        self.assert_heights(record, roof,
            [(3, 3), (24, 24), (9, 15), (18, 33), (35, 18), (35, 30), (14, 23)], .2)
        self.assertEqual(record['roof_patch_count'], 4)
        self.assertEqual(record['planar_patch_count'], 4)
        self.assertLess(len(record['roof_surfaces']), 128)
        for surface in record['roof_surfaces']:
            heights = [v[2] for v in surface['geometry']['coordinates'][0]]
            self.assertLess(max(heights) - min(heights), .2, 'Tower and podium were joined by a ramp')

    def test_curved_roof_preserves_courtyard(self):
        hole = box(10, 8, 20, 16)
        footprint = box(0, 0, 30, 24).difference(hole)
        roof = lambda x, y: 20 + 8*(1 - ((x - 15)/15)**2)
        record = self.reconstructed(footprint, roof=roof, noise=.1)
        self.assert_heights(record, roof,
            [(3, 3), (15, 3), (27, 3), (3, 12), (27, 12), (15, 21)], .85)
        for surface in record['roof_surfaces']:
            self.assertLess(shape(surface['geometry']).intersection(hole).area, 1e-7)

    def test_detailed_mode_is_independent_of_legacy_width_and_step(self):
        footprint = box(0, 0, 30, 24)
        roof = lambda x, y: np.where(x > 15, 21.5, 20.)
        points = self.cloud(footprint, roof, noise=.1)
        expected = self.measure(footprint, points=points)
        for width, step in ((.01/.07, .02/.077), (1/.07, 1/.077)):
            with self.subTest(width=width, step=step):
                self.assertEqual(self.measure(footprint, points=points, width=width, step=step), expected)
        fine, _ = self.measure(footprint, points=points, mode='TERRACES')
        coarse, _ = self.measure(footprint, points=points, mode='TERRACES', step=3)
        self.assertTrue(fine['tiers'])
        self.assertFalse(coarse['tiers'])

    def test_larger_print_preserves_more_of_a_curved_surface(self):
        footprint = box(0, 0, 30, 24)
        roof = lambda x, y: 20 + 8*(1 - ((x - 15)/15)**2)
        points = self.cloud(footprint, roof)
        small = self.reconstructed(footprint, points=points, scale=(.035, .0385))
        large = self.reconstructed(footprint, points=points, scale=(.14, .154))
        self.assertGreater(surface_parameters((.035, .0385))[2], surface_parameters((.14, .154))[2])
        self.assertGreaterEqual(len(large['roof_surfaces']), len(small['roof_surfaces']))
        probes = [(x, y) for x in np.arange(1, 30, 2) for y in (3, 12, 21)]
        error = lambda r: max(abs(self.height_at(r, x, y) - roof(x, y)) for x, y in probes)
        self.assertLessEqual(error(large), error(small) + .1)
        self.assertLess(error(large), .7)

    def test_subprint_parallel_roofs_join_without_an_artificial_ramp(self):
        footprint = box(0, 0, 30, 24)
        record = self.reconstructed(footprint, roof=lambda x, y: np.where(x > 15, 20.55, 20.))
        self.assertEqual(len(record['roof_surfaces']), 1)
        heights = [v[2] for v in record['roof_surfaces'][0]['geometry']['coordinates'][0]]
        self.assertLess(max(heights)-min(heights), .01)
        # Region growing may already identify one roof; the geometry and its
        # error matter, not which later stage would otherwise merge labels.
        self.assertGreaterEqual(min(heights), 20.)
        self.assertLessEqual(max(heights), 20.55)

    def test_shallow_continuous_slope_is_not_flattened_like_a_small_step(self):
        footprint = box(0, 0, 30, 24)
        roof = lambda x, y: 20 + .0274*x
        record = self.reconstructed(footprint, roof=roof, noise=.01)
        self.assertEqual(len(record['roof_surfaces']), 1)
        self.assert_heights(record, roof,
                            [(x, y) for x in (1, 15, 29) for y in (3, 12, 21)], .03)
        self.assertGreater(self.height_at(record, 29, 12) - self.height_at(record, 1, 12), .7)

    def test_parallel_region_merge_preserves_independently_measured_gradient(self):
        for gradient in ((0., 0.), (.35, .12)):
            with self.subTest(gradient=gradient):
                xx, yy = np.meshgrid(np.arange(.75, 30, 1.5),
                                     np.arange(.75, 24, 1.5), indexing='ij')
                x, y = xx.ravel(), yy.ravel()
                labels = (x > 15).astype(int)
                measured = 20 + gradient[0]*x + gradient[1]*y + labels*.55
                samples = np.column_stack((x, y, measured))
                regions = {0: box(0, 0, 15, 24), 1: box(15, 0, 30, 24)}
                merged, ownership, _, diagnostics = _regularize_regions(
                    regions, samples, labels, 1.5, 3., .65, .325)
                self.assertEqual(len(merged), 1)
                self.assertEqual(len(np.unique(ownership)), 1)
                self.assertEqual(diagnostics['surface_merged_subprint_regions'], 1)
                center, coef, _ = _plane(samples, .325, .65)
                np.testing.assert_allclose(coef[:2], gradient, atol=1e-9)
                self.assertLess(np.max(np.abs(samples[:, 2] - measured)), .56)
                self.assertAlmostEqual(sum(g.area for g in merged.values()), 30*24)

    def test_parallel_region_merge_keeps_printable_steps_and_limits_accumulation(self):
        for levels in ((20., 21.5), (20., 20.5, 21.)):
            with self.subTest(levels=levels):
                xx, yy = np.meshgrid(np.arange(.75, 15*len(levels), 1.5),
                                     np.arange(.75, 24, 1.5), indexing='ij')
                x, y = xx.ravel(), yy.ravel()
                labels = (x//15).astype(int)
                measured = np.asarray(levels)[labels]
                samples = np.column_stack((x, y, measured))
                regions = {i: box(15*i, 0, 15*(i+1), 24) for i in range(len(levels))}
                merged, ownership, _, _ = _regularize_regions(
                    regions, samples, labels, 1.5, 3., .65, .325)
                self.assertGreaterEqual(len(merged), 2)
                for label in np.unique(ownership):
                    selected = ownership == label
                    self.assertLessEqual(np.ptp(measured[selected]), .65)
                    self.assertLess(np.ptp(samples[selected, 2]), 1e-8)
                if len(levels) == 2:
                    np.testing.assert_array_equal(samples[:, 2], measured)

    def test_long_thin_roof_noise_does_not_make_facade_ribs(self):
        footprint = box(0, 0, 48, 36)
        # These strips contain many returns, but only one transverse survey
        # cell. The broad 9x9 m plant remains an independent supported roof.
        roof = lambda x, y: 20 + np.where((x > 18) & (x < 27) & (y > 12) & (y < 21), 5,
                                         np.where(x < 1, 3, 0))
        record = self.reconstructed(footprint, roof=roof)
        self.assertGreater(record['surface_diagnostics']['surface_filtered_strips'], 0)
        self.assert_heights(record, lambda x, y: 25 if 18 < x < 27 and 12 < y < 21 else 20,
                            [(.5, 6), (.5, 24), (12, 6), (22, 16), (40, 24)], .15)

    def test_point_order_does_not_change_reconstruction(self):
        footprint = box(0, 0, 30, 24)
        roof = lambda x, y: np.where(x > 15, 35., 20.)
        points = self.cloud(footprint, roof, noise=.15)
        expected = self.measure(footprint, points=points)
        np.random.default_rng(412).shuffle(points)
        self.assertEqual(self.measure(footprint, points=points), expected)

    def test_valid_but_nearly_coincident_cap_edges_use_robust_triangles(self):
        # A clipping seam can fold out and back a long distance while having
        # negligible width. GEOS accepts the ring, but Blender's float32 cap
        # tessellator can collapse it and reject the entire measured building.
        outline = Polygon([(0, 0), (20, 0), (20, 10), (10+1e-8, 10),
                           (10, 15), (10, 10), (0, 10)])
        self.assertTrue(outline.is_valid)
        self.assertLess(outline.minimum_clearance, .005)
        center, coef = np.array([10., 5.]), np.array([.4, .1, 30.])
        surfaces = _planar_surfaces(outline, center, coef)
        self.assertGreater(len(surfaces), 1)
        self.assertTrue(all(len(s['geometry']['coordinates'][0]) == 4 for s in surfaces))
        polygons = [shape(s['geometry']) for s in surfaces]
        self.assertLess(unary_union(polygons).symmetric_difference(outline).area, 1e-6)
        self.assertAlmostEqual(sum(p.area for p in polygons), outline.area, places=6)
        for surface in surfaces:
            for x, y, z in surface['geometry']['coordinates'][0]:
                self.assertAlmostEqual(z, np.dot(np.array([x, y])-center, coef[:2])+coef[2])


if __name__ == '__main__':
    unittest.main()
