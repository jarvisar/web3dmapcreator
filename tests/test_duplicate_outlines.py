"""Buildings the source publishes twice."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.geometry.buildings import (
    find_duplicate_outlines,
    select_building_geometry,
)


def square(identifier, x, y, size, **properties):
    return {
        "type": "Feature",
        "id": identifier,
        "properties": properties,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]
            ],
        },
    }


class DuplicateOutlineTests(unittest.TestCase):
    def courtyard(self, feature):
        feature['geometry']['coordinates'].append(
            [[.0002, .0002], [.0002, .0008], [.0008, .0008], [.0008, .0002], [.0002, .0002]])
        return feature

    def test_building_inside_part_courtyard_is_not_a_duplicate(self):
        parent = square('parent', 0, 0, .001, has_parts=True)
        part = self.courtyard(square('part', 0, 0, .001, building_id='parent', height=20))
        inner = square('inner', .0004, .0004, .0002, height=10)
        selection = select_building_geometry([parent, inner], [part])
        self.assertNotIn('inner', selection.duplicate_ids)
        self.assertIn(inner, selection.buildings)
        # Another part can genuinely fill the courtyard; holes are per polygon.
        filling = square('filling', .0002, .0002, .0006, building_id='parent', height=10)
        self.assertIn('inner', select_building_geometry([parent, inner], [part, filling]).duplicate_ids)

    def test_partless_courtyard_and_solid_footprint_are_not_twins(self):
        hollow = self.courtyard(square('hollow', 0, 0, .001, height=20))
        solid = square('solid', 0, 0, .001, height=10)
        self.assertFalse(find_duplicate_outlines([hollow, solid], {}))

    def test_actual_courtyard_twins_still_deduplicate(self):
        one = self.courtyard(square('one', 0, 0, .001, height=20))
        two = self.courtyard(square('two', 0, 0, .001))
        self.assertEqual(find_duplicate_outlines([one, two], {}), {'two'})

    def test_a_named_box_over_another_buildings_parts_is_dropped(self):
        """The Scripps Center case: a plain box standing over tiered parts."""
        outline = square("outline", 0.0, 0.0, 0.001, has_parts=True)
        named = square("named", 0.0, 0.0, 0.001, height=143.0, names={"primary": "Scripps"})
        parts = [
            square("p1", 0.0, 0.0, 0.0005, building_id="outline", height=100.0),
            square("p2", 0.0005, 0.0, 0.0005, building_id="outline", height=120.0),
            square("p3", 0.0, 0.0005, 0.001, building_id="outline", height=143.0),
        ]
        # p3 is a 0.001 x 0.001 square offset by half; together the parts cover
        # the named box completely.
        parts[2]["geometry"]["coordinates"] = [
            [[0.0, 0.0005], [0.001, 0.0005], [0.001, 0.001], [0.0, 0.001], [0.0, 0.0005]]
        ]
        selection = select_building_geometry([outline, named], parts)
        self.assertEqual(selection.duplicate_ids, frozenset({"named"}))
        self.assertEqual([b["id"] for b in selection.buildings], [])
        self.assertEqual(len(selection.parts), 3)
        self.assertIn("outline", selection.suppressed_parent_ids)

    def test_a_separate_building_beside_the_parts_is_kept(self):
        outline = square("outline", 0.0, 0.0, 0.001, has_parts=True)
        annex = square("annex", 0.0012, 0.0, 0.0005, height=8.0)
        parts = [square("p1", 0.0, 0.0, 0.001, building_id="outline", height=30.0)]
        selection = select_building_geometry([outline, annex], parts)
        self.assertEqual(selection.duplicate_ids, frozenset())
        self.assertEqual([b["id"] for b in selection.buildings], ["annex"])

    def test_a_building_only_partly_under_the_parts_is_kept(self):
        outline = square("outline", 0.0, 0.0, 0.001, has_parts=True)
        # Half inside the parts, half outside: a real neighbour, not a twin.
        neighbour = square("neighbour", 0.0005, 0.0, 0.001, height=8.0)
        parts = [square("p1", 0.0, 0.0, 0.001, building_id="outline", height=30.0)]
        selection = select_building_geometry([outline, neighbour], parts)
        self.assertEqual(selection.duplicate_ids, frozenset())

    def test_twin_partless_footprints_keep_the_better_described_one(self):
        described = square("described", 0.0, 0.0, 0.001, height=24.0)
        vague = square("vague", 0.00002, 0.00002, 0.00098, names={"primary": "Centre"})
        duplicates = find_duplicate_outlines([described, vague], {})
        self.assertEqual(duplicates, {"vague"})
        selection = select_building_geometry([described, vague], [])
        self.assertEqual([b["id"] for b in selection.buildings], ["described"])

    def test_twins_with_nothing_to_choose_between_are_resolved_deterministically(self):
        one = square("b", 0.0, 0.0, 0.001)
        two = square("a", 0.0, 0.0, 0.001)
        self.assertEqual(find_duplicate_outlines([one, two], {}), {"b"})
        self.assertEqual(find_duplicate_outlines([two, one], {}), {"b"})


if __name__ == "__main__":
    unittest.main()
