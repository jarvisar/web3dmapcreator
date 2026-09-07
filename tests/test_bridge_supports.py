"""Support placement follows the gap to ground, not the source-way length."""

import unittest

from jarvizar_city_model.geometry.deck_profile import additional_support_stations, support_stations


class UnsupportedSpanTests(unittest.TestCase):
    def stations(self, length=8.0, ground=lambda x, y: 0.0, **kwargs):
        return additional_support_stations(
            [(0.0, 0.0), (length, 0.0)], [0.8, 0.8], ground,
            thickness=0.6, maximum_span=2.1, half_length=0.3, **kwargs,
        )

    def test_shallow_gap_gets_enough_support_without_filling_the_span(self):
        stations = self.stations()
        intervals = [(0.0, 0.0)] + [(8*t-0.3, 8*t+0.3) for t in stations] + [(8.0, 8.0)]
        self.assertTrue(stations)
        self.assertLessEqual(len(stations), 3)
        self.assertTrue(all(b[0]-a[1] <= 2.1 for a, b in zip(intervals, intervals[1:])))

    def test_short_bridge_omitted_by_end_exclusions_gets_one_support(self):
        self.assertEqual(support_stations([(0, 0), (2.6, 0)], 2.1, 0.84), [])
        self.assertEqual(len(self.stations(length=2.6)), 1)

    def test_grounded_bridge_needs_no_support(self):
        self.assertEqual(self.stations(ground=lambda x, y: 0.2), [])

    def test_long_bridge_with_only_a_short_air_gap_needs_no_support(self):
        self.assertEqual(self.stations(length=20, ground=lambda x, y: 0.0 if 9.1<x<10.9 else 0.2), [])

    def test_existing_piers_already_break_up_the_gap(self):
        self.assertEqual(self.stations(existing=[0.125, 0.375, 0.625, 0.875]), [])

    def test_a_missing_foundation_never_gets_a_floating_pier(self):
        self.assertEqual(self.stations(is_void=lambda x, y: True), [])

    def test_crossing_road_is_kept_clear(self):
        stations = self.stations(is_obstructed=lambda t: abs(t*8-4) < 1.0)
        self.assertTrue(stations)
        self.assertTrue(all(abs(t*8-4) >= 1.0 for t in stations))


if __name__ == '__main__':
    unittest.main()
