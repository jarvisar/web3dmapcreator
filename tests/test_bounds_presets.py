import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.bounds_presets import load_presets, parse_presets
from jarvizar_city_model.data.projection import parse_bounds_text


class BoundsPresetTests(unittest.TestCase):
    def test_reads_names_and_pasteable_bounds_sorted_without_case(self):
        presets = parse_presets(
            "vegas: -115.20238,36.07963,-115.14393,36.13378\n"
            "Big frisco:-122.44417,37.76678,-122.37834,37.81745\n"
            "Rome: 12.45845,41.88803,12.49510,41.90649\n"
        )
        self.assertEqual([name for name, _ in presets], ["Big frisco", "Rome", "vegas"])
        self.assertEqual(presets[1][1], "12.45845,41.88803,12.4951,41.90649")
        bounds = parse_bounds_text(presets[0][1])
        self.assertEqual((bounds.west, bounds.north), (-122.44417, 37.81745))

    def test_skips_comments_blanks_bad_boxes_and_repeated_names(self):
        presets = parse_presets(
            "# Name: west,south,east,north\n"
            "\n"
            "Disney world: -81.60576,28.39744,-81.55542,28.42994\n"
            "Disney World: -81.6,28.3,-81.5,28.4\n"
            "no separator here\n"
            ": -81.6,28.3,-81.5,28.4\n"
            "Off the globe: -81.6,128.3,-81.5,128.4\n"
            "Short: 1,2,3\n"
        )
        self.assertEqual(presets, [("Disney world", "-81.60576,28.39744,-81.55542,28.42994")])

    def test_packaged_presets_are_all_usable(self):
        presets = load_presets()
        self.assertGreaterEqual(len(presets), 15)
        self.assertIn("Chicago", [name for name, _ in presets])
        for _, bounds in presets:
            parse_bounds_text(bounds)

    def test_missing_file_gives_an_empty_menu(self):
        self.assertEqual(load_presets(Path(__file__).with_name("no_such_presets.txt")), [])


if __name__ == "__main__":
    unittest.main()
