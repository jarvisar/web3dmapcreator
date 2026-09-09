"""Adjacent source partitions must not be mistaken for isolated needles."""
import unittest

from jarvizar_city_model.geometry.building_printability import adjoining_part_widths, source_part_widths
from jarvizar_city_model.geometry.planar import effective_width


def rectangle(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def mass(ring, top=6, bottom=0):
    return ([ring], bottom, top)


class AdjoiningPartTests(unittest.TestCase):
    def test_thin_partitions_use_complete_footprint(self):
        masses = [mass(rectangle(i / 20, 0, (i + 1) / 20, 2)) for i in range(40)]
        self.assertTrue(all(effective_width(m[0][0]) < .08 for m in masses))
        for width in adjoining_part_widths(masses):
            self.assertAlmostEqual(width, 1)

    def test_detached_point_contacts_and_overlaps_do_not_gain_width(self):
        first = mass(rectangle(0, 0, .1, 2))
        for other in (rectangle(.11, 0, .21, 2), rectangle(.1, 2, .2, 4),
                      rectangle(0, 0, .1, 2), rectangle(.05, 0, .15, 2)):
            masses = [first, mass(other)]
            self.assertEqual(adjoining_part_widths(masses), [effective_width(m[0][0]) for m in masses])

    def test_actual_shared_length_not_bounding_box_contact(self):
        masses = [mass(rectangle(0, 0, .1, 2)), mass(rectangle(.1, 1.99, 2, 3))]
        self.assertEqual(adjoining_part_widths(masses), [effective_width(m[0][0]) for m in masses])

    def test_short_roof_step_is_supported(self):
        masses = [mass(rectangle(0, 0, .05, 2), 6.05), mass(rectangle(.05, 0, 2, 2), 6)]
        self.assertEqual(adjoining_part_widths(masses), [1, 1])

    def test_long_thin_extension_above_neighbor_is_not_supported(self):
        masses = [mass(rectangle(0, 0, .1, 2), 10), mass(rectangle(.1, 0, 2, 2), 1)]
        self.assertEqual(adjoining_part_widths(masses), [effective_width(m[0][0]) for m in masses])

    def test_tiny_seam_does_not_become_a_tall_tip(self):
        masses = [mass(rectangle(0, 0, .05, 2), 7), mass(rectangle(.05, 0, 2, 2), 6)]
        self.assertEqual(adjoining_part_widths(masses), [effective_width(m[0][0]) for m in masses])

    def test_elevated_facade_does_not_borrow_grounded_sibling_width(self):
        masses = [mass(rectangle(0, 0, .1, 2), 6, 1), mass(rectangle(.1, 0, 2, 2), 6)]
        self.assertEqual(adjoining_part_widths(masses), [effective_width(m[0][0]) for m in masses])

    def test_equal_elevated_bases_can_form_a_tier(self):
        masses = [mass(rectangle(0, 0, .1, 2), 6, 1), mass(rectangle(.1, 0, 2, 2), 6, 1)]
        self.assertEqual(adjoining_part_widths(masses), [1, 1])

    def test_partitioned_ribbon_remains_thin(self):
        masses = [mass(rectangle(i, 0, i + 1, .05)) for i in range(10)]
        self.assertTrue(all(width < .08 for width in adjoining_part_widths(masses)))

    def test_partial_edges_and_reversed_winding(self):
        masses = [mass(rectangle(0, 0, 1, 2)),
                  mass(list(reversed([(1, 0), (2, 0), (2, 2), (1, 2), (1, 1)])))]
        self.assertEqual(adjoining_part_widths(masses), [1, 1])

    def test_courtyard_is_not_solid_support(self):
        # Filling part of a courtyard retains the remaining hole perimeter.
        outer, hole = rectangle(0, 0, 4, 4), rectangle(1, 1, 3, 3)
        masses = [([outer, hole], 0, 6), mass(rectangle(1, 1, 1.1, 3))]
        result = adjoining_part_widths(masses)
        self.assertAlmostEqual(result[1], 2 * 12.2 / 23.8)

    def test_separate_parents_and_invalid_intervals_do_not_supply_support(self):
        def feature(identifier, parent, ring, **props):
            return {'id': identifier, 'properties': {'building_id': parent, 'height': 6, **props},
                    'geometry': {'coordinates': [ring]}}
        features = [feature('a', 'p', rectangle(0, 0, .1, 2)),
                    feature('b', 'q', rectangle(.1, 0, 2, 2)),
                    feature('invalid', 'p', rectangle(.1, 0, 2, 2), min_height=8)]
        widths = source_part_widths(features, lambda g: [g['coordinates']], lambda z: z, 3, 10, .08, 30)
        self.assertAlmostEqual(widths['a', 0], effective_width(features[0]['geometry']['coordinates'][0]))
        self.assertNotIn(('invalid', 0), widths)


if __name__ == '__main__':
    unittest.main()
