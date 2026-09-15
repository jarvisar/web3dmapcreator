"""Welding, ranked culling, end snapping and stub pruning of road centerlines."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data.linework import RAIL_CLASS, SubSegment
from jarvizar_city_model.geometry.road_network import (
    NetworkSettings,
    UNRANKED,
    rank_for_class,
    tidy_network,
)


SCALE = 0.07  # mm per metre, the default print scale
HALF_WIDTH_M = 3.0  # every ribbon 6 m wide, 0.42 mm printed
GAP_M = 0.4 / SCALE  # 5.71 m of ground between ribbon edges
# Two centerlines closer than this, edge to edge, are "alongside".
CORRIDOR_M = GAP_M + 2 * HALF_WIDTH_M
# A loose end within this of a road's centerline is joined to it.
SNAP_REACH_M = 0.8 / SCALE + 2 * HALF_WIDTH_M
BOUNDS = (0.0, 0.0, 1000.0, 1000.0)


def piece(source_id, points, road_class="residential", flags=(), width_m=6.0):
    return SubSegment(
        source_id=source_id,
        points=tuple((float(x), float(y)) for x, y in points),
        start_t=0.0,
        end_t=1.0,
        road_class=road_class,
        subclass="",
        width_m=width_m,
        width_source="class_default",
        flags=frozenset(flags),
        level=0,
    )


def tidy(pieces, decks=(), settings=None, bounds=BOUNDS):
    return tidy_network(
        pieces,
        SCALE,
        bounds,
        lambda p: HALF_WIDTH_M,
        lambda p: p.source_id in decks,
        settings,
    )


def ids(pieces):
    return [p.source_id for p in pieces]


class RankTests(unittest.TestCase):
    def test_hierarchy_orders_streets_over_paths(self):
        self.assertLess(rank_for_class("motorway"), rank_for_class("primary"))
        self.assertLess(rank_for_class("residential"), rank_for_class("service"))
        self.assertLess(rank_for_class("service"), rank_for_class("footway"))
        self.assertLess(rank_for_class("residential"), rank_for_class(RAIL_CLASS))
        self.assertLess(rank_for_class(RAIL_CLASS), rank_for_class("service"))
        self.assertEqual(rank_for_class("something_new"), UNRANKED)


class CullTests(unittest.TestCase):
    def test_duplicate_carriageway_is_dropped(self):
        # Both carriageways of a divided street, 4 m apart: their ribbons
        # overlap, so only one prints.
        kept, counts = tidy([
            piece("east", [(100, 100), (400, 100)]),
            piece("west", [(100, 104), (400, 104)]),
        ])
        self.assertEqual(len(kept), 1)
        self.assertEqual(counts.culled_pieces, 1)
        self.assertAlmostEqual(counts.culled_length_mm, 300 * SCALE, places=6)

    def test_streets_with_ground_between_them_both_stay(self):
        kept, counts = tidy([
            piece("a", [(100, 100), (400, 100)]),
            piece("b", [(100, 100 + CORRIDOR_M + 1.0), (400, 100 + CORRIDOR_M + 1.0)]),
        ])
        self.assertEqual(ids(kept), ["a", "b"])
        self.assertEqual(counts.culled_pieces, 0)

    def test_less_important_class_loses(self):
        # The service road is listed first and is longer, and still loses to
        # the primary beside it: three quarters of it is shadowed.
        kept, _ = tidy([
            piece("service", [(50, 104), (450, 104)], road_class="service"),
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
        ])
        self.assertEqual(ids(kept), ["main"])

    def test_an_untagged_sidewalk_beside_its_street_is_dropped(self):
        kept, counts = tidy([
            piece("walk", [(100, 104), (400, 104)], road_class="footway"),
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
        ])
        self.assertEqual(ids(kept), ["main"])
        self.assertEqual(counts.culled_pieces, 1)

    def test_crossing_at_an_angle_is_a_junction_not_a_duplicate(self):
        kept, counts = tidy([
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
            piece("cross", [(250, 50), (250, 150)], road_class="footway"),
        ])
        self.assertEqual(ids(kept), ["main", "cross"])
        self.assertEqual(counts.culled_pieces, 0)

    def test_a_street_partly_beside_another_is_kept_whole(self):
        # Only a third of the residential street runs beside the primary; a
        # whole-route decision keeps it entire rather than biting its middle.
        kept, counts = tidy([
            piece("main", [(100, 100), (200, 100)], road_class="primary"),
            piece("side", [(100, 104), (400, 104)]),
        ])
        self.assertEqual(ids(kept), ["main", "side"])
        self.assertEqual(kept[1].points, piece("side", [(100, 104), (400, 104)]).points)
        self.assertEqual(counts.trimmed_pieces, 0)

    def test_a_welded_street_is_judged_as_one_route(self):
        # Four fragments of one street; only the first runs beside the
        # primary.  Unwelded, that fragment would be culled on its own.
        kept, counts = tidy([
            piece("main", [(100, 100), (200, 100)], road_class="primary"),
            piece("s1", [(100, 104), (200, 104)]),
            piece("s2", [(200, 104), (300, 104)]),
            piece("s3", [(300, 104), (400, 104)]),
            piece("s4", [(400, 104), (500, 104)]),
        ])
        self.assertEqual(ids(kept), ["main", "s1", "s2", "s3", "s4"])
        self.assertEqual(counts.welded_joins, 3)

    def test_a_divided_street_keeps_one_carriageway_straight_through(self):
        # Both carriageways are split at every cross street, and the piece
        # lengths alternate in favour of one side then the other.  Judged
        # block by block the survivor would zigzag between the two sides;
        # welded through the junctions each carriageway is one route and
        # one side survives whole.
        pieces = [
            piece("a1", [(100, 100), (200, 100)]),
            piece("a2", [(200, 100), (300, 100)]),
            piece("a3", [(300, 100), (400, 100)]),
            piece("b1", [(100, 108), (205, 108)]),
            piece("b2", [(205, 108), (295, 108)]),
            piece("b3", [(295, 108), (400, 108)]),
        ]
        for x, bx in ((200, 205), (300, 295)):
            pieces += [
                piece(f"c{x}s", [(x, 50), (x, 100)], road_class="tertiary"),
                piece(f"c{x}m", [(x, 100), (bx, 108)], road_class="tertiary"),
                piece(f"c{x}n", [(bx, 108), (bx, 160)], road_class="tertiary"),
            ]
        kept, counts = tidy(pieces)
        survivors = [p for p in kept if p.road_class == "residential"]
        self.assertEqual(len(survivors), 3)
        # One side survives entire: every kept piece shares the same y.
        self.assertEqual(len({p.points[0][1] for p in survivors}), 1)
        self.assertEqual(counts.culled_pieces, 3)

    def test_continuation_through_a_junction_must_be_unambiguous(self):
        # Where a single street splits into two carriageways, neither branch
        # is the obvious continuation, so the chain stops there and the two
        # branches are judged against each other rather than as one route.
        kept, _ = tidy([
            piece("stem", [(0, 104), (100, 104)]),
            piece("a", [(100, 104), (400, 100)]),
            piece("b", [(100, 104), (450, 108)]),
        ])
        self.assertEqual(ids(kept), ["stem", "b"])

    def test_a_street_that_merges_at_each_intersection_stays_connected(self):
        # A divided street whose carriageways merge into one stem through
        # every intersection.  The stems belong to neither side, so whichever
        # side loses, the street still runs through the intersections.
        pieces = [
            piece("stem1", [(0, 104), (100, 104)]),
            piece("stem2", [(300, 104), (400, 104)]),
            piece("a1", [(100, 104), (115, 100)]),
            piece("a2", [(115, 100), (285, 100)]),
            piece("a3", [(285, 100), (300, 104)]),
            piece("b1", [(100, 104), (115, 108)]),
            piece("b2", [(115, 108), (290, 108)]),
            piece("b3", [(290, 108), (300, 104)]),
        ]
        kept, counts = tidy(pieces)
        self.assertIn("stem1", ids(kept))
        self.assertIn("stem2", ids(kept))
        self.assertEqual(len(kept), 5)
        sides = {p.source_id[0] for p in kept if p.source_id[0] in "ab"}
        self.assertEqual(len(sides), 1)

    def test_the_stem_of_a_divided_street_survives_its_losing_side(self):
        # N Broadway: the carriageways converge on each intersection and a
        # straight stem runs through it.  The winning side turns into the
        # node steeply, so the stem welds to the straighter losing side.
        # Losing, that side gives up only what is doubled; the stem, which
        # nothing covers, still links the two winning pieces.
        kept, _ = tidy([
            piece("w1", [(-100, 100), (195, 100), (200, 104)]),
            piece("w2", [(230, 104), (235, 100), (430, 100)]),
            piece("l1", [(0, 100), (60, 108), (140, 108), (200, 104)]),
            piece("stem", [(200, 104), (230, 104)]),
            piece("l2", [(230, 104), (280, 108)]),
        ])
        self.assertEqual(ids(kept), ["w1", "w2", "stem"])

    def test_a_doubled_block_goes_even_when_its_route_is_mostly_unique(self):
        # The losing carriageway welded to long stems is under two thirds
        # shadowed as a route, so the route survives; the doubled block
        # inside it still goes because both its ends land on the winner.
        kept, _ = tidy([
            piece("w1", [(-300, 100), (195, 100), (200, 104)]),
            piece("w2", [(400, 104), (405, 100), (600, 100)]),
            piece("l1", [(0, 100), (60, 108), (140, 108), (200, 104)]),
            piece("stem", [(200, 104), (400, 104)]),
            piece("l2", [(400, 104), (450, 108)]),
        ])
        self.assertEqual(ids(kept), ["w1", "w2", "stem", "l2"])

    def test_a_losing_route_remnant_hanging_free_is_dropped(self):
        kept, _ = tidy([
            piece("w1", [(-100, 100), (195, 100), (200, 104)]),
            piece("l1", [(0, 100), (60, 108), (140, 108), (200, 104)]),
            piece("stem", [(200, 104), (230, 104)]),
        ])
        self.assertEqual(ids(kept), ["w1"])

    def test_the_wide_middle_of_a_lost_lens_does_not_float(self):
        # A carriageway that bows out just beyond the corridor mid-block:
        # its long converging tips are doubled and go, and the middle,
        # touching nothing that stays, goes with them instead of floating.
        wide = 100 + CORRIDOR_M + 1.0
        kept, _ = tidy([
            piece("winner", [(0, 100), (400, 100)]),
            piece("tip1", [(0, 100), (150, wide)]),
            piece("middle", [(150, wide), (190, wide)]),
            piece("tip2", [(190, wide), (340, 100)]),
        ])
        self.assertEqual(ids(kept), ["winner"])

    def test_a_minor_path_keeps_the_part_that_leaves_the_road(self):
        # A cycleway follows the street for 200 m then turns north for 200 m.
        kept, counts = tidy([
            piece("main", [(100, 100), (300, 100)], road_class="primary"),
            piece("cycle", [(100, 104), (300, 104), (300, 304)], road_class="cycleway"),
        ])
        self.assertEqual(ids(kept), ["main", "cycle"])
        cycle = kept[1]
        self.assertEqual(counts.trimmed_pieces, 1)
        self.assertAlmostEqual(cycle.points[-1][1], 304.0)
        # The section along the street is gone and the trimmed end has been
        # pulled onto the street's centerline, so the ribbons meet.
        self.assertGreater(min(y for _x, y in cycle.points), 99.0)
        self.assertAlmostEqual(cycle.points[0][1], 100.0, places=6)
        self.assertEqual(counts.snapped_ends, 1)
        self.assertEqual(cycle.source_id, "cycle")
        self.assertEqual(cycle.road_class, "cycleway")
        # The street is never pulled onto the path it meets.
        self.assertEqual(kept[0].points, ((100.0, 100.0), (300.0, 100.0)))

    def test_trimming_can_be_turned_off_for_minor_classes(self):
        kept, counts = tidy(
            [
                piece("main", [(100, 100), (300, 100)], road_class="primary"),
                piece("cycle", [(100, 104), (300, 104), (300, 304)], road_class="cycleway"),
            ],
            settings=NetworkSettings(trim_minor_classes=False),
        )
        self.assertEqual(ids(kept), ["main", "cycle"])
        self.assertEqual(len(kept[1].points), 3)
        self.assertEqual(counts.trimmed_pieces, 0)

    def test_a_trimmed_remnant_shorter_than_a_stub_goes_too(self):
        # 6 m of path turns off the street at the end: shorter than a stub,
        # so not a route.
        kept, counts = tidy([
            piece("main", [(100, 100), (300, 100)], road_class="primary"),
            piece("walk", [(100, 104), (300, 104), (300, 110)], road_class="footway"),
        ])
        self.assertEqual(ids(kept), ["main"])
        self.assertEqual(counts.culled_pieces, 1)

    def test_decks_and_ground_never_shadow_each_other(self):
        # A footway under an elevated primary is a layer below it.
        kept, _ = tidy(
            [
                piece("viaduct", [(100, 100), (400, 100)], road_class="primary",
                      flags=["is_bridge"]),
                piece("walk", [(100, 102), (400, 102)], road_class="footway"),
            ],
            decks={"viaduct"},
        )
        self.assertEqual(ids(kept), ["viaduct", "walk"])

    def test_a_footbridge_beside_a_road_bridge_goes_whole(self):
        kept, counts = tidy(
            [
                piece("road", [(100, 100), (400, 100)], road_class="primary",
                      flags=["is_bridge"]),
                piece("foot", [(100, 104), (400, 104)], road_class="footway",
                      flags=["is_bridge"]),
            ],
            decks={"road", "foot"},
        )
        self.assertEqual(ids(kept), ["road"])
        self.assertEqual(counts.trimmed_pieces, 0)

    def test_equal_rank_keeps_the_longer_route(self):
        kept, _ = tidy([
            piece("short", [(150, 104), (250, 104)]),
            piece("long", [(100, 100), (400, 100)]),
        ])
        self.assertEqual(ids(kept), ["long"])


class SnapTests(unittest.TestCase):
    def test_a_path_stopping_short_of_a_street_is_joined_to_it(self):
        kept, counts = tidy([
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
            piece("walk", [(250, 300), (250, 108)], road_class="footway"),
        ])
        self.assertEqual(counts.snapped_ends, 1)
        walk = kept[1]
        self.assertEqual(walk.points[0], (250.0, 300.0))
        self.assertAlmostEqual(walk.points[-1][0], 250.0)
        self.assertAlmostEqual(walk.points[-1][1], 100.0)

    def test_an_end_beyond_reach_is_left_alone(self):
        far = 100 + SNAP_REACH_M + 5.0
        kept, counts = tidy([
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
            piece("walk", [(250, 300), (250, far)], road_class="footway"),
        ])
        self.assertEqual(counts.snapped_ends, 0)
        self.assertEqual(kept[1].points[-1], (250.0, far))

    def test_an_end_on_the_crop_boundary_is_clipped_not_dangling(self):
        kept, counts = tidy([
            piece("main", [(100, 0), (400, 0)], road_class="primary"),
            piece("edge", [(250, 300), (250, 0)]),
            piece("near", [(320, 300), (320, 4)]),
        ])
        self.assertEqual(ids(kept), ["main", "edge", "near"])
        self.assertEqual(kept[1].points[-1], (250.0, 0.0))
        self.assertEqual(kept[2].points[-1], (320.0, 0.0))
        self.assertEqual(counts.snapped_ends, 1)

    def test_an_end_already_inside_the_other_ribbon_stays_put(self):
        kept, counts = tidy([
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
            piece("walk", [(250, 300), (250, 102)], road_class="footway"),
        ])
        self.assertEqual(counts.snapped_ends, 0)
        self.assertEqual(kept[1].points[-1], (250.0, 102.0))

    def test_a_parallel_start_is_not_dragged_sideways(self):
        kept, counts = tidy([
            piece("main", [(100, 100), (200, 100)], road_class="primary"),
            piece("side", [(100, 108), (400, 108)]),
        ])
        self.assertEqual(counts.snapped_ends, 0)
        self.assertEqual(kept[1].points[0], (100.0, 108.0))

    def test_a_street_is_not_pulled_onto_a_path(self):
        kept, counts = tidy([
            piece("walk", [(100, 100), (400, 100)], road_class="footway"),
            piece("street", [(250, 300), (250, 108)]),
        ])
        self.assertEqual(counts.snapped_ends, 0)
        self.assertEqual(kept[1].points[-1], (250.0, 108.0))

    def test_deck_ends_are_never_moved(self):
        kept, counts = tidy(
            [
                piece("main", [(100, 100), (400, 100)], road_class="primary"),
                piece("bridge", [(250, 300), (250, 108)], road_class="footway",
                      flags=["is_bridge"]),
            ],
            decks={"bridge"},
        )
        self.assertEqual(counts.snapped_ends, 0)
        self.assertEqual(kept[1].points[-1], (250.0, 108.0))

    def test_an_end_is_not_snapped_onto_a_deck(self):
        kept, counts = tidy(
            [
                piece("viaduct", [(100, 100), (400, 100)], road_class="primary",
                      flags=["is_bridge"]),
                piece("walk", [(250, 300), (250, 108)], road_class="footway"),
            ],
            decks={"viaduct"},
        )
        self.assertEqual(counts.snapped_ends, 0)
        self.assertEqual(kept[1].points[-1], (250.0, 108.0))


class PruneTests(unittest.TestCase):
    def test_a_kerb_stub_is_removed(self):
        # 6 m of footway hanging off the street: the remnant of a crossing.
        kept, counts = tidy([
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
            piece("stub", [(250, 100), (250, 106)], road_class="footway"),
        ])
        self.assertEqual(ids(kept), ["main"])
        self.assertEqual(counts.pruned_stubs, 1)

    def test_a_short_link_between_two_streets_survives(self):
        kept, counts = tidy([
            piece("a", [(100, 100), (400, 100)], road_class="primary"),
            piece("b", [(100, 130), (400, 130)], road_class="primary"),
            piece("link", [(250, 100), (250, 130)], road_class="service"),
        ])
        self.assertEqual(ids(kept), ["a", "b", "link"])
        self.assertEqual(counts.pruned_stubs, 0)

    def test_a_stub_meeting_the_middle_of_a_street_is_connected_there(self):
        # 300 m of footway ending on a street mid-span at one end and free at
        # the other is a route, not a stub, and stays.
        kept, _ = tidy([
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
            piece("walk", [(250, 100), (250, 400)], road_class="footway"),
        ])
        self.assertEqual(ids(kept), ["main", "walk"])

    def test_removing_a_stub_can_free_the_stub_it_hung_from(self):
        # A 6 m spur forking into two 7 m spurs: the fork is a junction, so
        # nothing welds; the branches go first, then the spur they freed.
        kept, counts = tidy([
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
            piece("spur", [(250, 100), (250, 106)], road_class="footway"),
            piece("left", [(250, 106), (246, 112)], road_class="footway"),
            piece("right", [(250, 106), (254, 112)], road_class="footway"),
        ])
        self.assertEqual(ids(kept), ["main"])
        self.assertEqual(counts.pruned_stubs, 3)

    def test_a_street_of_short_fragments_is_not_eaten_from_its_end(self):
        # A dead-end street mapped in 5 m fragments: welded it is 40 m of
        # route and stays, though every fragment is shorter than a stub.
        fragments = [
            piece(f"f{i}", [(250 + 5 * i, 100), (255 + 5 * i, 100)]) for i in range(8)
        ]
        kept, counts = tidy([piece("main", [(250, 50), (250, 150)], road_class="primary")]
                            + fragments)
        self.assertEqual(len(kept), 9)
        self.assertEqual(counts.pruned_stubs, 0)

    def test_a_boundary_end_anchors_a_short_piece(self):
        # 6 m of footway from the crop edge onto the street: clipped by the
        # selection, not a stub.
        kept, counts = tidy([
            piece("main", [(100, 6), (400, 6)], road_class="primary"),
            piece("edge", [(250, 0), (250, 6)], road_class="footway"),
        ])
        self.assertEqual(ids(kept), ["main", "edge"])
        self.assertEqual(counts.pruned_stubs, 0)

    def test_a_short_piece_entering_from_the_edge_and_stopping_is_a_stub(self):
        kept, counts = tidy([
            piece("main", [(100, 100), (400, 100)], road_class="primary"),
            piece("edge", [(0, 200), (6, 200)], road_class="footway"),
        ])
        self.assertEqual(ids(kept), ["main"])
        self.assertEqual(counts.pruned_stubs, 1)


class PassThroughTests(unittest.TestCase):
    def test_attributes_and_order_survive(self):
        pieces = [
            piece("z", [(100, 300), (400, 300)], road_class="service", width_m=4.5),
            piece("a", [(100, 100), (400, 100)], road_class="primary", width_m=11.0,
                  flags=["is_bridge"]),
        ]
        kept, counts = tidy(pieces)
        self.assertEqual(kept, pieces)
        self.assertEqual(counts.pieces_in, 2)
        self.assertEqual(counts.pieces_out, 2)

    def test_no_scale_or_no_pieces_is_a_no_op(self):
        self.assertEqual(tidy([])[0], [])
        pieces = [piece("a", [(0, 0), (1, 1)])]
        self.assertEqual(tidy_network(pieces, 0.0, None, lambda p: 1.0, lambda p: False)[0],
                         pieces)

    def test_counts_are_reported(self):
        _, counts = tidy([
            piece("east", [(100, 100), (400, 100)]),
            piece("west", [(100, 104), (400, 104)]),
        ])
        report = counts.as_dict()
        self.assertEqual(report["network_culled_pieces"], 1)
        self.assertEqual(report["network_pieces_in"], 2)
        self.assertEqual(report["network_pieces_out"], 1)

    def test_result_is_deterministic(self):
        pieces = [
            piece(f"p{i}", [(100 + i, 100 + 2 * i), (400 - i, 100 + 2 * i)])
            for i in range(6)
        ] + [piece(f"w{i}", [(150 + 40 * i, 50), (150 + 40 * i, 120)], road_class="footway")
             for i in range(5)]
        first = ids(tidy(pieces)[0])
        second = ids(tidy(list(reversed(pieces)))[0])
        self.assertEqual(sorted(first), sorted(second))


if __name__ == "__main__":
    unittest.main()
