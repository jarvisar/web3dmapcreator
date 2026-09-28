import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.area import fits_bed, real_size_m
from jarvizar_city_model.data.bounds_presets import (
    USER_PRESETS_HEADER,
    clean_name,
    load_presets,
    parse_presets,
    remove_preset,
    save_preset,
    unique_name,
)
from jarvizar_city_model.data.projection import parse_bounds_text

# Every box the presets file has offered; renaming must never lose one.
ORIGINAL_BOXES = (
    "-87.64575,41.87052,-87.60627,41.89397", "-111.90957,40.75561,-111.87889,40.78022",
    "-82.83485,27.96044,-82.79572,27.98152", "12.45845,41.88803,12.4951,41.90649",
    "-122.44417,37.76678,-122.37834,37.81745", "-87.9265,43.02416,-87.88925,43.04706",
    "-81.60576,28.39744,-81.55542,28.42994", "-74.07978,40.66423,-73.90366,40.82212",
    "-117.93851,33.79914,-117.90109,33.82053", "-115.20238,36.07963,-115.14393,36.13378",
    "-87.64124,41.87626,-87.61552,41.89041", "-71.08785,42.34434,-71.03974,42.37512",
    "-80.21513,25.74555,-80.16191,25.79804", "-106.68068,35.05846,-106.61716,35.10966",
    "2.26078,48.83275,2.37013,48.88741",
)


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
        self.assertGreaterEqual(len(presets), 25)
        self.assertIn("Chicago - The Loop", [name for name, _ in presets])
        for _, bounds in presets:
            parse_bounds_text(bounds)

    def test_packaged_presets_keep_every_original_box_under_one_unique_name(self):
        presets = load_presets()
        names = [name.casefold() for name, _ in presets]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(names, sorted(names))
        boxes = [bounds for _, bounds in presets]
        for box in ORIGINAL_BOXES:
            self.assertEqual(boxes.count(box), 1, box)

    def test_new_landmark_presets_fit_a_256_mm_bed_at_the_default_scale(self):
        new = [(name, bounds) for name, bounds in load_presets() if bounds not in ORIGINAL_BOXES]
        self.assertGreaterEqual(len(new), 8)
        for name, bounds in new:
            with self.subTest(name=name):
                width, height = real_size_m(parse_bounds_text(bounds))
                self.assertTrue(fits_bed(width * 0.07, height * 0.07, 256, 256))
                self.assertGreater(min(width, height) * 0.07, 150.0)

    def test_missing_file_gives_an_empty_menu(self):
        self.assertEqual(load_presets(Path(__file__).with_name("no_such_presets.txt")), [])


class UserPresetTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "config" / "bounds_presets.txt"

    def test_saving_creates_the_file_with_a_header(self):
        self.assertFalse(save_preset(self.path, "Home", " -84.5, 39.08 ,-84.47,39.11 "))
        self.assertEqual(self.path.read_text(encoding="utf-8"),
                         USER_PRESETS_HEADER + "Home: -84.5,39.08,-84.47,39.11\n")
        self.assertEqual(load_presets(self.path), [("Home", "-84.5,39.08,-84.47,39.11")])

    def test_saving_a_name_again_replaces_it_and_keeps_other_lines(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("# my notes\nWork: 1,2,3,4\nhome: -84.5,39.08,-84.47,39.11\n", encoding="utf-8")
        self.assertTrue(save_preset(self.path, "Home", "-84.6,39.0,-84.4,39.2"))
        self.assertEqual(self.path.read_text(encoding="utf-8"),
                         "# my notes\nWork: 1,2,3,4\nHome: -84.6,39,-84.4,39.2\n")
        self.assertEqual([name for name, _ in load_presets(self.path)], ["Home", "Work"])

    def test_removing_ignores_case_and_reports_a_missing_name(self):
        save_preset(self.path, "Home", "-84.5,39.08,-84.47,39.11")
        save_preset(self.path, "Cabin", "-81.6,28.3,-81.5,28.4")
        self.assertTrue(remove_preset(self.path, "home"))
        self.assertEqual(load_presets(self.path), [("Cabin", "-81.6,28.3,-81.5,28.4")])
        self.assertFalse(remove_preset(self.path, "Home"))
        self.assertFalse(remove_preset(self.path.with_name("missing.txt"), "Cabin"))

    def test_an_invalid_box_is_refused_before_anything_is_written(self):
        with self.assertRaises(ValueError):
            save_preset(self.path, "Nowhere", "-81.6,128.3,-81.5,128.4")
        self.assertFalse(self.path.exists())

    def test_names_fit_the_file_format(self):
        self.assertEqual(clean_name("  Paris:\tLeft Bank\n"), "Paris - Left Bank")
        self.assertEqual(clean_name("# Home"), "Home")
        self.assertEqual(len(clean_name("x" * 100)), 60)
        for name in ("", "  ", "#", "\n"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                clean_name(name)
        save_preset(self.path, "Paris: Left Bank", "2.3,48.84,2.36,48.86")
        self.assertEqual(load_presets(self.path)[0][0], "Paris - Left Bank")

    def test_unique_names(self):
        self.assertEqual(unique_name("My Area", []), "My Area")
        self.assertEqual(unique_name("My Area", ["my area"]), "My Area 2")
        self.assertEqual(unique_name("My Area", ["My Area", "My Area 2", "my area 3"]), "My Area 4")


if __name__ == "__main__":
    unittest.main()
