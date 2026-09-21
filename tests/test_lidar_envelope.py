"""The upper sheet bridges facade recesses without erasing whole roof masses."""
import unittest
from unittest.mock import patch

try:
    import numpy as np
    from shapely import contains_xy
    from shapely.affinity import rotate
    from shapely.geometry import box, Point, Polygon, MultiPolygon, shape
    from shapely.ops import unary_union
    from jarvizar_city_model.external.lidar_envelope import fit_roof_envelope
    from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building
    from jarvizar_city_model.external.lidar_simplify import MIN_GAP
    from jarvizar_city_model.geometry.lidar_envelope import envelope_solid
    from lidar_envelope_test_utils import cap_area, height_at, height_contour
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class UpperEnvelopeTests(unittest.TestCase):
    def cloud(self, footprint, roof):
        x0, y0, x1, y1 = footprint.bounds
        xx, yy = np.meshgrid(np.arange(x0+.2, x1, .4), np.arange(y0+.2, y1, .4))
        xy = np.column_stack((xx.ravel(), yy.ravel()))
        xy = xy[contains_xy(footprint, xy[:, 0], xy[:, 1])]
        return np.column_stack((xy, roof(xy[:, 0], xy[:, 1])))

    def fit(self, footprint, cloud, scale=(.07, .077)):
        record, reason = fit_roof_envelope(footprint, cloud, 1.5, scale, cloud)
        self.assertIsNotNone(record, reason)
        self.assertEqual(record['surface_reconstruction'], 'roof_envelope')
        polygons = [shape(s['geometry']) for s in record['roof_surfaces']]
        self.assertLess(unary_union(polygons).symmetric_difference(footprint).area, 1e-6)
        self.assertAlmostEqual(cap_area(record), footprint.area, places=5)
        self.assertFalse(record['tiers'])
        return record

    def test_blanket_spans_deep_narrow_recess_and_preserves_broad_lower_roof(self):
        footprint = box(0, 0, 40, 30)
        # A recess narrower than the rank window (two cells) is bridged; a
        # wider one is real geometry and stays.
        roof = lambda x, y: np.where(x > 28, 20., np.where((x > 12)&(x < 12.5), 8., 60.))
        record = self.fit(footprint, self.cloud(footprint, roof))
        self.assertGreater(height_at(record, 12.25, 15), 57)
        self.assertAlmostEqual(height_at(record, 36, 15), 20, delta=.6)
        self.assertAlmostEqual(height_at(record, 6, 15), 60, delta=.6)

    def test_dense_lower_facade_returns_do_not_carve_roof(self):
        footprint = box(0, 0, 24, 24)
        roof = self.cloud(footprint, lambda x, y: np.full_like(x, 80.))
        facade = np.array([(12., y, z) for y in np.arange(.2, 24, .15) for z in np.arange(3, 80, .2)])
        xyz = np.concatenate((roof, facade))
        points = np.column_stack((xyz, np.full(len(xyz), 6), np.ones(len(xyz))))
        record, why = measure_building(footprint, PointIndex(points), 1.43, .65,
                                      ground_m=0, roof_mode='FACETED')
        self.assertIsNotNone(record, why)
        self.assertEqual(record['surface_reconstruction'], 'roof_envelope')
        self.assertGreater(height_at(record, 12, 12), 79)

    def test_isolated_high_return_is_removed_but_supported_cap_survives(self):
        footprint = box(0, 0, 30, 30)
        cap = box(12, 12, 18, 18)
        cloud = self.cloud(footprint, lambda x, y: np.where(contains_xy(cap, x, y), 35., 20.))
        cloud = np.concatenate((cloud, [[4.13, 4.17, 100.]]))
        record = self.fit(footprint, cloud)
        self.assertLess(height_at(record, 4.13, 4.17), 21)
        self.assertAlmostEqual(height_at(record, 15, 15), 35, delta=.6)
        self.assertLess(max(v[2] for s in record['roof_surfaces'] for v in s['geometry']['coordinates'][0]), 36)

    def test_courtyard_and_disconnected_component_do_not_share_sheet(self):
        first = box(0, 0, 24, 24).difference(box(8, 8, 16, 16))
        second = box(25, 0, 35, 24)
        footprint = MultiPolygon([first, second])
        roof = lambda x, y: np.where(x < 24, 30.+.1*x, 8.)
        record = self.fit(footprint, self.cloud(footprint, roof))
        self.assertAlmostEqual(height_at(record, 30, 12), 8., delta=.3)
        self.assertAlmostEqual(height_at(record, 22, 12), 32.2, delta=.3)
        self.assertLess(height_contour(record, 1).intersection(box(8, 8, 16, 16)).area, 1e-8)

    def test_slender_towers_keep_their_heights(self):
        footprint = box(0, 0, 30, 24)
        towers = [(box(8, 10, 11, 13), 30.), (box(13, 10, 16, 13), 38.), (box(18, 10, 21, 13), 26.)]

        def roof(x, y):
            z = np.full(len(x), 10.)
            for tower, top in towers:
                z[contains_xy(tower, x, y)] = top
            return z
        record = self.fit(footprint, self.cloud(footprint, roof))
        for tower, top in towers:
            self.assertAlmostEqual(height_at(record, tower.centroid.x, tower.centroid.y), top, delta=.3)
        self.assertLess(max(height_at(record, x, 11.5) for x in (12, 17)), 11)
        # Unmarked, their walls wander two cells at every merge and each
        # tower is cut down by metres.
        with patch('jarvizar_city_model.external.lidar_envelope._spires',
                   lambda heights, rise: np.zeros(heights.shape, dtype=bool)):
            plain = self.fit(footprint, self.cloud(footprint, roof))
        self.assertLess(height_at(plain, 14.5, 11.5), 36)

    def test_steep_spire_is_gridded_as_finely_as_it_was_scanned(self):
        footprint = Point(0, 0).buffer(8)
        record = self.fit(footprint, self.cloud(footprint, lambda x, y: 40-3*np.hypot(x, y)))
        # Half a metre under a cell's top holds a sixth of a steep cell's
        # returns, which reads as a sparse survey; the noisy slope below
        # reads the same way and must stay on its coarser grid.
        self.assertEqual(record['surface_diagnostics']['envelope_pitch_m'], .5)
        self.assertGreater(height_at(record, 0, 0), 38)

    def test_noisy_slope_is_not_terraced(self):
        footprint = box(0, 0, 40, 30)
        noise = np.random.default_rng(3)
        record = self.fit(footprint, self.cloud(
            footprint, lambda x, y: 20+.4*x+noise.uniform(-2, 2, len(x))))
        self.assertGreater(record['surface_diagnostics']['envelope_pitch_m'], .5)
        xs = np.arange(4, 36, .25)
        profiles = np.array([[height_at(record, x, y) for x in xs] for y in (7.3, 15.1, 22.7)])
        # A median alone settles into small plateaus here, which the cap
        # shows as terraces across the slope.
        self.assertLess(np.mean(np.diff(profiles, axis=1)/.25 < .1), .05)
        trend = np.polyval(np.polyfit(np.tile(xs, 3), profiles.ravel(), 1), np.tile(xs, 3))
        self.assertLess(np.std(profiles.ravel()-trend), .16)

    def test_roof_wall_on_rotated_building_is_not_ribbed(self):
        angle = np.radians(30)
        footprint = rotate(box(0, 0, 60, 24), 30, origin=(0, 0))
        across = lambda x, y: -x*np.sin(angle)+y*np.cos(angle)
        record = self.fit(footprint, self.cloud(footprint, lambda x, y: np.where(across(x, y) < 12, 40., 25.)))
        # On a grid laid across the building the wall is a staircase of cells,
        # which the cap shows as a row of vertical ribs. On the grid laid along
        # it the wall is one straight step; the collapse may still move a
        # corner by a fraction of a cell where the wall meets the outline.
        riser = height_contour(record, 32.5).boundary.difference(footprint.exterior.buffer(1.5))
        offsets = [across(x, y) for line in getattr(riser, 'geoms', [riser]) for x, y in line.coords]
        self.assertTrue(offsets)
        self.assertLess(max(offsets)-min(offsets), .5)
        self.assertAlmostEqual(float(np.mean(offsets)), 12, delta=1)

    def test_diagonal_tower_wall_is_not_ribbed(self):
        footprint = box(0, 0, 40, 40)
        record = self.fit(footprint, self.cloud(footprint, lambda x, y: np.where(x+y < 40.5, 60., 20.)))
        # A fixed cell diagonal folds each cell the wall cuts into a notch, and
        # smoothing across the wall smears it into a ramp of uneven heights.
        # The wall is placed from a raster smoothed over three cells, so only
        # its last few metres at the outline may lean a few centimetres.
        riser = height_contour(record, 40).boundary.difference(footprint.exterior.buffer(3))
        offsets = [(x+y)/np.sqrt(2) for line in getattr(riser, 'geoms', [riser]) for x, y in line.coords]
        self.assertTrue(offsets)
        # A stair would be half a cell (0.35 m); the collapse's least-squares
        # placement leaves a few centimetres.
        self.assertLess(max(offsets)-min(offsets), .2)

    def test_curved_tower_face_inside_footprint_is_not_ribbed(self):
        # Shaped like 71 South Wacker, Chicago: the outline also covers a low
        # plaza, so the tower's curved face is a wall inside the cap. Drawn
        # through raster nodes it is a staircase of cells, each stair a rib
        # down the facade standing up to 0.4 m off its neighbours.
        footprint = box(0, 0, 90, 70)
        face = lambda x: 40+12*(1-((x-45)/45)**2)
        record = self.fit(footprint, self.cloud(footprint, lambda x, y: np.where(y < face(x), 200., 10.)))
        riser = height_contour(record, 105).boundary.difference(footprint.exterior.buffer(3))
        x, y = np.array([c for line in getattr(riser, 'geoms', [riser]) for c in line.coords]).T
        order = np.argsort(x)
        x, offset = x[order], ((y-face(x))/np.hypot(1, 24*(x-45)/45**2))[order]
        trend = np.array([offset[abs(x-at) < 2].mean() for at in x])
        self.assertLess(np.abs(offset-trend).max(), .2)
        self.assertLess(abs(offset.mean()), .5)
        # The wall is a run of steep faces inside one cap, which joins into a
        # single solid walled along the footprint; the collapse leaves a few
        # hundred faces of a raster that had thousands.
        self.assertLess(len(record['roof_surfaces']), 1500)
        rings = [[(x*.07, y*.07, z*.077) for x, y, z in s['geometry']['coordinates'][0][:-1]]
                 for s in record['roof_surfaces']]
        outline = [[[(x*.07, y*.07) for x, y in footprint.exterior.coords[:-1]]]]
        self.assertIsNotNone(envelope_solid(rings, (record['height_m']-1)*.077, outline))

    def test_stepped_tower_corners_inside_footprint_keep_their_steps(self):
        # Shaped like the Chicago Mercantile Exchange Center: 3 m notches step
        # a tower's corners down to the lower wing in the same outline. Placing
        # walls inside their cells must not round real steps away.
        footprint = box(0, 0, 60, 80)
        tower = unary_union([box(0, 39.5, 60, 80), box(3.5, 36.5, 56.5, 80),
                             box(6.5, 33.5, 53.5, 80), box(9.5, 30.5, 50.5, 80)])
        record = self.fit(footprint, self.cloud(
            footprint, lambda x, y: np.where(contains_xy(tower, x, y), 160., 20.)))
        for x, y in ((1.75, 38), (5, 35), (8, 32), (58.25, 38), (55, 35), (52, 32)):
            self.assertAlmostEqual(height_at(record, x, y), 20, delta=.6)
        for x, y in ((1.75, 41), (5, 38), (8, 35), (11, 32), (58.25, 41), (55, 38), (52, 35), (49, 32)):
            self.assertAlmostEqual(height_at(record, x, y), 160, delta=.6)
        wall = height_contour(record, 90)
        self.assertLess(wall.symmetric_difference(tower).area, 20)
        notches = [Point(c) for c in tower.exterior.coords[:-1] if 0 < c[0] < 60 and c[1] < 40]
        self.assertEqual(len(notches), 12)
        self.assertLess(max(wall.boundary.distance(p) for p in notches), 1.5)

    def test_grid_follows_print_scale_and_survey_density(self):
        from jarvizar_city_model.external.lidar_envelope import envelope_parameters, facet_budget
        # Half a printed layer per cell, 0.5 m at the default scale...
        self.assertAlmostEqual(envelope_parameters((.035, .0385))[0], 1.)
        self.assertAlmostEqual(envelope_parameters((.07, .077))[0], .8)
        # ...while a cell still averages about one return, down to 0.5 m...
        self.assertAlmostEqual(envelope_parameters((.07, .077), 20.)[0], .5)
        self.assertAlmostEqual(envelope_parameters((.07, .077), 2.25)[0], 2/3)
        # ...but a sparse survey is never gridded finer than it can support.
        self.assertAlmostEqual(envelope_parameters((.28, .308), 1.)[0], .8)
        self.assertAlmostEqual(envelope_parameters((.0175, .0193), 50.)[0], 2.)
        self.assertEqual(facet_budget(1.), 16384)
        self.assertEqual(facet_budget(2.), 16384)
        self.assertEqual(facet_budget(.5), 65536)

    def test_reconstruction_never_calls_legacy_architectural_region_fitting(self):
        footprint = box(0, 0, 30, 24)
        xyz = self.cloud(footprint, lambda x, y: 30+5*np.sin(x/10))
        cloud = np.column_stack((xyz, np.full(len(xyz), 6), np.ones(len(xyz))))
        with patch('jarvizar_city_model.external.lidar_surfaces.fit_surface_roof', side_effect=AssertionError), \
             patch('jarvizar_city_model.external.lidar_facets.fit_faceted_roof', side_effect=AssertionError):
            record, why = measure_building(footprint, PointIndex(cloud), 1.43, .65,
                                          ground_m=0, roof_mode='FACETED')
        self.assertIsNotNone(record, why)
        self.assertEqual(record['surface_reconstruction'], 'roof_envelope')

    def test_outline_a_hair_off_a_grid_line_leaves_no_sliver_corners(self):
        # The east wall sits a millimetre past the 0.5 m grid line at 24 m,
        # so every face along it would clip into a millimetre-wide sliver,
        # thinner than float32 holds at print scale. Corners that close to
        # the outline are snapped onto it; every other corner stays at
        # least a quarter of the vertex gap away.
        footprint = box(0, 0, 24.001, 20)
        record = self.fit(footprint, self.cloud(footprint, lambda x, y: np.full_like(x, 30.)))
        boundary = footprint.boundary
        for surface in record['roof_surfaces']:
            for x, y, _z in surface['geometry']['coordinates'][0]:
                distance = boundary.distance(Point(x, y))
                self.assertTrue(distance < 1e-9 or distance >= MIN_GAP/4-1e-9, distance)

    def test_invalid_input_and_budget_failure_are_explicit(self):
        footprint = box(0, 0, 24, 24)
        samples = self.cloud(footprint, lambda x, y: 20+x*.1)
        with self.assertRaises(ValueError):
            fit_roof_envelope(footprint, samples, 0)
        with self.assertRaises(ValueError):
            fit_roof_envelope(footprint, [[0, 0, float('nan')]], 1.5)
        with patch('jarvizar_city_model.external.lidar_envelope.MAX_ENVELOPE_FACETS', 2):
            result, reason = fit_roof_envelope(footprint, samples, 1.5)
        self.assertIsNone(result)
        self.assertIn('budget', reason)


if __name__ == '__main__':
    unittest.main()
