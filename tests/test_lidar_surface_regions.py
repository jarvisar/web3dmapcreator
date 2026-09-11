"""Surface inference regressions with equal-weight supported cell samples."""
import unittest

try:
    import numpy as np
    from shapely.geometry import Point
    from jarvizar_city_model.external.lidar_surfaces import fit_surface_roof
    from jarvizar_city_model.external.lidar_surface_regions import (
        segment_surfaces, _neighbors, _denoise_plane_outliers)
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class SurfaceRegionTests(unittest.TestCase):
    def samples(self, roof, size=24, noise=0):
        xy = np.array([(x, y) for x in np.arange(.75, size, 1.5)
                       for y in np.arange(.75, size, 1.5)])
        z = np.array([roof(x, y) for x, y in xy])
        z += np.random.default_rng(4).normal(0, noise, len(z))
        return np.column_stack((xy, z))

    def run_fit(self, roof, size=24, noise=0, **kwargs):
        samples = self.samples(roof, size, noise)
        labels, fitted, diagnostics = segment_surfaces(samples, 1.5, 1.43, **kwargs)
        return samples, labels, fitted, diagnostics

    def test_noisy_flat_roof_is_one_coherent_plane(self):
        _, labels, fitted, diagnostics = self.run_fit(lambda x, y: 20., noise=.15)
        self.assertEqual(len(set(labels)), 1, diagnostics)
        self.assertLess(np.ptp(fitted[:, 2]), .10)
        self.assertGreater(diagnostics['surface_noise_m'], 0)

    def test_shallow_step_is_two_planes_without_a_ramp(self):
        samples, labels, fitted, diagnostics = self.run_fit(lambda x, y: 20. if x < 9 else 21.5)
        self.assertEqual(len(set(labels)), 2, diagnostics)
        np.testing.assert_allclose(samples, fitted, atol=1e-6)
        self.assertNotEqual(labels[0], labels[-1])

    def test_subnoise_parallel_levels_do_not_invent_a_global_slope(self):
        _, labels, fitted, diagnostics = self.run_fit(lambda x, y: 20. if x < 12 else 20.55)
        self.assertEqual(len(set(labels)), 1, diagnostics)
        self.assertLess(np.ptp(fitted[:, 2]), 1e-6)
        self.assertGreater(fitted[0, 2], 20.)
        self.assertLess(fitted[0, 2], 20.55)

    def test_genuine_shallow_gradient_survives_the_same_noise_tolerance(self):
        samples, labels, fitted, diagnostics = self.run_fit(lambda x, y: 20. + .0274 * x)
        self.assertEqual(len(set(labels)), 1, diagnostics)
        np.testing.assert_allclose(fitted, samples, atol=1e-6)

    def test_slope_is_continuous_without_height_quantization(self):
        samples = self.samples(lambda x, y: 12. + .8 * x + .2 * y)
        labels, fitted, diagnostics = segment_surfaces(samples, 1.5, 1.43)
        self.assertEqual(len(set(labels)), 1, diagnostics)
        np.testing.assert_allclose(fitted, samples, atol=1e-6)

    def test_barrel_keeps_curvature_without_height_bands(self):
        samples, labels, fitted, diagnostics = self.run_fit(lambda x, y: 15. + 7 * (1 - ((x - 12) / 12) ** 2))
        self.assertEqual(len(set(labels)), 1, diagnostics)
        self.assertLess(np.max(np.abs(samples[:, 2] - fitted[:, 2])), .35)
        self.assertGreater(np.ptp(fitted[:, 2]), 5.)

    def test_gable_retains_ridge_and_slopes(self):
        samples, labels, fitted, diagnostics = self.run_fit(lambda x, y: 25. - .8 * abs(x - 12))
        self.assertLessEqual(len(set(labels)), 2, diagnostics)
        self.assertLess(np.max(np.abs(samples[:, 2] - fitted[:, 2])), .35)

    def test_six_metre_rooftop_structure_survives(self):
        samples, labels, fitted, diagnostics = self.run_fit(
            lambda x, y: 23. if 9 < x < 15 and 9 < y < 15 else 20., noise=.08)
        self.assertEqual(len(set(labels)), 2, diagnostics)
        top = (samples[:, 0] > 9) & (samples[:, 0] < 15) & (samples[:, 1] > 9) & (samples[:, 1] < 15)
        self.assertEqual(len(set(labels[top])), 1)
        self.assertEqual(len(set(labels[~top])), 1)
        self.assertNotEqual(labels[top][0], labels[~top][0])
        self.assertGreater(fitted[top, 2].min(), 22.7)
        self.assertLess(fitted[~top, 2].max(), 20.3)

    def test_multiple_tower_setbacks_stay_separate(self):
        def roof(x, y):
            return 80. if 12 < x < 24 and 12 < y < 24 else (
                40. if 6 < x < 30 and 6 < y < 30 else 12.)
        samples, labels, fitted, diagnostics = self.run_fit(roof, size=36)
        self.assertEqual(len(set(labels)), 3, diagnostics)
        np.testing.assert_allclose(samples, fitted, atol=1e-6)

    def test_supported_boundary_strip_is_not_orphaned_by_centroid_spacing(self):
        samples = self.samples(lambda x, y: 20.)
        last = samples[:, 0] == samples[:, 0].max()
        samples[last, 0] += 1.2
        labels, fitted, diagnostics = segment_surfaces(samples, 1.5, 1.43)
        self.assertEqual(len(set(labels)), 1, diagnostics)
        np.testing.assert_allclose(samples, fitted, atol=1e-6)

    def test_one_ambiguous_connection_cannot_erase_a_measured_wall(self):
        samples = self.samples(lambda x, y: 20. if x < 12 else 21.5)
        bridge = (samples[:, 0] > 10) & (samples[:, 0] < 14) & (samples[:, 1] < 1)
        samples[bridge, 2] = 20.75
        labels, _, diagnostics = segment_surfaces(samples, 1.5, 1.43)
        self.assertEqual(len(set(labels)), 2, diagnostics)
        self.assertNotEqual(labels[samples[:, 0] < 10][0], labels[samples[:, 0] > 14][0])

    def test_noisy_rooftop_boundaries_do_not_extrapolate_spikes(self):
        samples, labels, fitted, diagnostics = self.run_fit(
            lambda x, y: 23. if 12 < x < 24 and 12 < y < 24 else 20., size=36, noise=.2)
        top = (samples[:, 0] > 12) & (samples[:, 0] < 24) & (samples[:, 1] > 12) & (samples[:, 1] < 24)
        self.assertEqual(len(set(labels)), 2, diagnostics)
        self.assertEqual(diagnostics['surface_planar_regions'], 2)
        self.assertLess(np.max(np.abs(fitted[top, 2] - 23.)), .2)
        self.assertLess(np.max(np.abs(fitted[~top, 2] - 20.)), .2)

    def test_four_supported_cells_preserve_a_small_coherent_crown(self):
        samples, labels, fitted, diagnostics = self.run_fit(
            lambda x, y: 24. if 10.5 < x < 13.5 and 10.5 < y < 13.5 else 20.)
        top = samples[:, 2] > 22
        self.assertEqual(int(top.sum()), 4)
        self.assertEqual(len(set(labels)), 2, diagnostics)
        np.testing.assert_allclose(fitted[top, 2], 24., atol=1e-6)

    def test_isolated_spike_is_removed(self):
        samples = self.samples(lambda x, y: 20.)
        samples[100, 2] = 27.
        labels, fitted, diagnostics = segment_surfaces(samples, 1.5, 1.43)
        self.assertEqual(len(set(labels)), 1, diagnostics)
        np.testing.assert_allclose(fitted[:, 2], 20., atol=1e-6)
        self.assertEqual(diagnostics['surface_removed_islands'], 1)

    def test_disconnected_single_return_uses_nearby_supported_roof(self):
        samples = self.samples(lambda x, y: 20.)
        samples = np.vstack((samples, [27.75, 12., 2.]))
        labels, fitted, diagnostics = segment_surfaces(samples, 1.5, 1.43)
        self.assertEqual(len(set(labels)), 1, diagnostics)
        self.assertEqual(diagnostics['surface_gap_islands'], 1)
        np.testing.assert_allclose(fitted[:, 2], 20., atol=1e-6)

    def test_disconnected_supported_roof_is_not_an_outlier(self):
        samples = self.samples(lambda x, y: 20.)
        crown = np.array([(x, y, 35.) for x in (27.75, 29.25) for y in (10.5, 12.)])
        samples = np.vstack((samples, crown))
        labels, fitted, diagnostics = segment_surfaces(samples, 1.5, 1.43)
        self.assertEqual(len(set(labels)), 2, diagnostics)
        np.testing.assert_allclose(fitted[-4:, 2], 35., atol=1e-6)

    def test_plane_consensus_filters_only_spatially_unsupported_outliers(self):
        # A region can contain a low facade return linked through an ambiguous
        # local slope. Four adjacent crown samples still represent architecture
        # even though they are less than two percent of this broad roof.
        samples = self.samples(lambda x, y: 72.)
        crown = (samples[:, 0] > 9) & (samples[:, 0] < 12) & (samples[:, 1] > 9) & (samples[:, 1] < 12)
        samples[crown, 2] = 77.
        samples[0, 2] = 67.
        _, edges, _ = _neighbors(samples, 1.5)
        corrected = _denoise_plane_outliers(np.zeros(len(samples), dtype=int), samples, edges, .3,
                                            np.zeros(len(samples), dtype=bool))
        self.assertEqual(corrected, 1)
        self.assertAlmostEqual(samples[0, 2], 72.)
        np.testing.assert_allclose(samples[crown, 2], 77.)

    def test_labels_and_geometry_ignore_input_order(self):
        samples = self.samples(lambda x, y: 30. if 9 < x < 18 else 12. + .3 * y, noise=.1)
        labels, fitted, diagnostics = segment_surfaces(samples, 1.5, 1.43)
        shuffle = np.random.default_rng(5).permutation(len(samples))
        shuffled_labels, shuffled, shuffled_diagnostics = segment_surfaces(samples[shuffle], 1.5, 1.43)
        np.testing.assert_array_equal(labels[shuffle], shuffled_labels)
        np.testing.assert_array_equal(fitted[shuffle], shuffled)
        self.assertEqual(diagnostics, shuffled_diagnostics)

    def test_over_budget_planar_outline_returns_explicit_fallback(self):
        footprint = Point(12, 12).buffer(12, quad_segs=1025)
        self.assertGreater(len(footprint.exterior.coords), 4096)
        samples = self.samples(lambda x, y: 20.)
        samples = samples[np.linalg.norm(samples[:, :2] - [12, 12], axis=1) < 12]
        record, reason = fit_surface_roof(footprint, samples, 1.5)
        self.assertIsNone(record)
        self.assertEqual(reason, 'roof polygon vertex budget')


if __name__ == '__main__':
    unittest.main()
