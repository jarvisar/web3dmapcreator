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
