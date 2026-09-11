"""Planar folds have shared geometric ridges without erasing real walls."""
import unittest

try:
    import numpy as np
    from shapely import contains_xy
    from shapely.geometry import GeometryCollection, LineString, Point, Polygon, box
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_surface_junctions import reconcile_planar_junctions
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class SurfaceJunctionTests(unittest.TestCase):
    def fixture(self, planes, jitter=.35, offset=0., hole=False):
        footprint = box(0, 0, 30, 24)
        if hole:
            footprint = footprint.difference(box(5, 8, 10, 16))
        boundary = [(15 + offset + jitter*(-1)**i, y) for i, y in enumerate(np.arange(0, 25, 3))]
        left = Polygon([(0, 0), *boundary, (0, 24)]).intersection(footprint)
        right = footprint.difference(left)
        patches, observations = [], []
        for side, region in enumerate((left, right)):
            x, y = np.meshgrid(np.arange(.75, 30, 1.5), np.arange(.75, 24, 1.5), indexing='ij')
            x, y = x.ravel(), y.ravel()
            mask = (x < 15 if side == 0 else x > 15) & contains_xy(footprint, x, y)
            x, y = x[mask], y[mask]
            a, b, c = planes[side]
            patches.append((region, np.column_stack((x, y, a*x+b*y+c))))
            xx, yy = np.meshgrid(np.arange(.125, 30, .25), np.arange(.125, 24, .25), indexing='ij')
            xx, yy = xx.ravel(), yy.ravel()
            inside = (xx < 15 if side == 0 else xx > 15) & contains_xy(footprint, xx, yy)
            xx, yy = xx[inside], yy[inside]
            observations.append(np.column_stack((xx, yy, a*xx+b*yy+c)))
        return footprint, patches, np.concatenate(observations)

    def assert_fold(self, planes, hole=False, offset=0., observations=True):
        footprint, patches, points = self.fixture(planes, hole=hole, offset=offset)
        result = reconcile_planar_junctions(patches, 1.5, .325,
                                           observations=points if observations else None)
        regions = [region for region, _samples in result]
        self.assertLess(unary_union(regions).symmetric_difference(footprint).area, 1e-7)
        self.assertLess(regions[0].intersection(regions[1]).area, 1e-7)
        shared = regions[0].boundary.intersection(regions[1].boundary)
        for fraction in np.linspace(0, 1, 25):
            x, y = shared.interpolate(fraction, normalized=True).coords[0]
            self.assertAlmostEqual(x, 15., places=7)
            self.assertAlmostEqual(np.dot(planes[0][:2], (x, y)) + planes[0][2],
                                   np.dot(planes[1][:2], (x, y)) + planes[1][2], places=7)
        for before, after in zip(patches, result):
            self.assertIs(before[1], after[1], 'Measured surface ownership must not move')
        return result

    def test_gable_ridge_is_the_plane_intersection(self):
        self.assert_fold(((.5, 0, 20), (-.5, 0, 35)), observations=False)

    def test_valley_supports_the_opposite_plane_ownership(self):
        self.assert_fold(((-.5, 0, 35), (.5, 0, 20)))

    def test_flat_to_sloped_kink_is_continuous(self):
        self.assert_fold(((0, 0, 20), (1, 0, 5)))

    def test_steep_fold_uses_local_observations_not_height_bands(self):
        self.assert_fold(((2.5, 0, 20), (-2.5, 0, 95)), offset=.35)

    def test_courtyard_and_source_exterior_are_preserved(self):
        self.assert_fold(((.5, 0, 20), (-.5, 0, 35)), hole=True)

    def test_parallel_roof_levels_remain_vertical_steps(self):
        _footprint, patches, points = self.fixture(((0, 0, 20), (0, 0, 21.5)))
        result = reconcile_planar_junctions(patches, 1.5, .325, observations=points)
        self.assertEqual([p[0].wkb for p in result], [p[0].wkb for p in patches])

    def test_offset_sloping_roofs_keep_their_real_wall(self):
        # The extrapolated planes cross only .8 m from the true .8 m wall.
        # Distance to their intersection alone must not invent a ridge.
        _footprint, patches, points = self.fixture(((.5, 0, 20), (-.5, 0, 35.8)), jitter=0)
        for observations in (None, points):
            with self.subTest(raw_observations=observations is not None):
                result = reconcile_planar_junctions(patches, 1.5, .325, observations=observations)
                self.assertEqual([p[0].wkb for p in result], [p[0].wkb for p in patches])

    def test_distant_intersection_cannot_move_architectural_boundaries(self):
        _footprint, patches, points = self.fixture(((.5, 0, 20), (-.5, 0, 45)))
        result = reconcile_planar_junctions(patches, 1.5, .325, observations=points)
        self.assertEqual([p[0].wkb for p in result], [p[0].wkb for p in patches])

    def test_caller_planes_control_the_exact_junction(self):
        planes = ((.5, 0, 20), (-.5, 0, 35))
        _footprint, patches, points = self.fixture(planes)
        fits = [(np.array([0., 0.]), np.array(plane), 0.) for plane in planes]
        result = reconcile_planar_junctions(patches, 1.5, .325, observations=points, fits=fits)
        shared = result[0][0].boundary.intersection(result[1][0].boundary)
        self.assertAlmostEqual(shared.bounds[0], 15)
        self.assertAlmostEqual(shared.bounds[2], 15)

    def test_three_planes_reconcile_only_their_shared_interfaces(self):
        footprint = box(0, 0, 30, 24)
        left_line = [(10 + .3*(-1)**i, y) for i, y in enumerate(range(0, 25, 3))]
        right_line = [(20 + .3*(-1)**i, y) for i, y in enumerate(range(0, 25, 3))]
        left = Polygon([(0, 0), *left_line, (0, 24)])
        right = Polygon([*right_line, (30, 24), (30, 0)])
        regions = [left, footprint.difference(left.union(right)), right]
        planes = ((.5, 0, 20), (0, 0, 25), (-.5, 0, 35))
        patches, observations = [], []
        for i, region in enumerate(regions):
            xx, yy = np.meshgrid(np.arange(.125, 30, .25), np.arange(.125, 24, .25), indexing='ij')
            x, y = xx.ravel(), yy.ravel()
            mask = (x < 10) if i == 0 else (x > 20) if i == 2 else ((x > 10) & (x < 20))
            x, y = x[mask], y[mask]
            a, b, c = planes[i]
            points = np.column_stack((x, y, a*x+b*y+c))
            patches.append((region, points[::7]))
            observations.append(points)
        result = reconcile_planar_junctions(patches, 1.5, .325,
                                           observations=np.concatenate(observations))
        self.assertLess(unary_union([r for r, _ in result]).symmetric_difference(footprint).area, 1e-7)
        for i, expected_x in ((0, 10), (1, 20)):
            shared = result[i][0].boundary.intersection(result[i+1][0].boundary)
            self.assertAlmostEqual(shared.bounds[0], expected_x, places=7)
            self.assertAlmostEqual(shared.bounds[2], expected_x, places=7)

    def test_point_contacts_do_not_count_as_fold_evidence(self):
        planes = ((.5, 0, 20), (-.5, 0, 35))
        _footprint, patches, points = self.fixture(planes)
        for i, extra in enumerate((box(40, 40, 44, 44), box(44, 44, 48, 48))):
            xy = np.array(list(extra.exterior.coords)[:-1]) + .05
            a, b, c = planes[i]
            samples = np.column_stack((xy, a*xy[:, 0]+b*xy[:, 1]+c))
            patches[i] = (patches[i][0].union(extra), np.vstack((patches[i][1], samples)))
        result = reconcile_planar_junctions(patches, 1.5, .325, observations=points)
        # One analytic half-plane cannot describe the disconnected ownership;
        # retain this ambiguous pair instead of moving the distant component.
        self.assertEqual([p[0].wkb for p in result], [p[0].wkb for p in patches])

    def test_clipped_geometry_collection_keeps_only_areal_roof_components(self):
        planes = ((.5, 0, 20), (-.5, 0, 35))
        footprint, patches, points = self.fixture(planes)
        mixed = [(GeometryCollection([region, LineString([(40+i, 0), (40+i, 2)]),
                                      Point(50+i, 0)]), samples)
                 for i, (region, samples) in enumerate(patches)]
        self.assertTrue(all(region.boundary is None for region, _samples in mixed))
        expected = reconcile_planar_junctions(patches, 1.5, .325, observations=points)
        actual = reconcile_planar_junctions(mixed, 1.5, .325, observations=points)
        for (region, samples), (reference, original_samples) in zip(actual, expected):
            self.assertEqual(region.wkb, reference.wkb)
            self.assertIs(samples, original_samples)
        self.assertLess(unary_union([r for r, _ in actual]).symmetric_difference(footprint).area, 1e-7)

    def test_line_only_contact_does_not_become_a_roof(self):
        samples = np.array([(0., 0., 20.), (1., 0., 20.), (0., 1., 20.)])
        result = reconcile_planar_junctions([
            (GeometryCollection([LineString([(0, 0), (1, 0)]), Point(0, 1)]), samples)], 1.5, .325)
        self.assertTrue(result[0][0].is_empty)
        self.assertEqual(result[0][0].geom_type, 'Polygon')
        self.assertIs(result[0][1], samples)


if __name__ == '__main__':
    unittest.main()
