"""The network deck solver: joints, cones, anchors, stacking, and demotion."""

from __future__ import annotations

import math
import unittest

from jarvizar_city_model.geometry.bridge_network import node_key
from jarvizar_city_model.geometry.deck_graph import (
    SegmentIndex,
    build_deck_graph,
    lowest_cones,
    point_segment_distance,
    solve_deck_network,
    solve_heights,
)


def line(x0, x1, y=0.0, step=1.0):
    count = max(1, int(round(abs(x1 - x0) / step)))
    return [(x0 + (x1 - x0) * index / count, y) for index in range(count + 1)]


def vertical(y0, y1, x=0.0, step=1.0):
    count = max(1, int(round(abs(y1 - y0) / step)))
    return [(x, y0 + (y1 - y0) * index / count) for index in range(count + 1)]


FLAT = lambda x, y: 0.0  # noqa: E731

# Print-scale numbers: a 0.6 mm road, a 0.6 mm deck, two layers of daylight,
# and an 8 % grade.
ROAD, DECK, GAP, GRADE, LIFT = 0.6, 0.6, 0.4, 0.08, 0.2


def solve(
    centerlines,
    levels=None,
    blocked=(),
    roads=None,
    terrain=FLAT,
    half_width=0.35,
    open_ends=(),
):
    return solve_deck_network(
        centerlines,
        levels or [1] * len(centerlines),
        [half_width] * len(centerlines),
        terrain,
        terrain,
        set(blocked),
        roads,
        0.35,
        ROAD,
        DECK,
        GAP,
        GRADE,
        LIFT,
        open_ends=set(open_ends),
    )


def ends_of(*centerlines):
    """Node keys of every centerline end, for decks cut off by the bbox."""
    return [node_key(point) for line in centerlines for point in (line[0], line[-1])]


class GeometryHelperTests(unittest.TestCase):
    def test_point_segment_distance(self):
        distance, t = point_segment_distance((5.0, 3.0), (0.0, 0.0), (10.0, 0.0))
        self.assertAlmostEqual(distance, 3.0)
        self.assertAlmostEqual(t, 0.5)
        distance, t = point_segment_distance((-4.0, 0.0), (0.0, 0.0), (10.0, 0.0))
        self.assertAlmostEqual(distance, 4.0)
        self.assertAlmostEqual(t, 0.0)

    def test_segment_index_finds_only_what_is_within_reach(self):
        index = SegmentIndex(2.0)
        index.add_polyline([(0.0, 0.0), (10.0, 0.0)], "road")
        hit = index.nearest((5.0, 0.5), 1.0)
        self.assertIsNotNone(hit)
        self.assertAlmostEqual(hit[0], 0.5)
        self.assertEqual(hit[1], "road")
        self.assertIsNone(index.nearest((5.0, 3.0), 1.0))


class GraphTests(unittest.TestCase):
    def test_decks_meeting_at_a_joint_share_one_node(self):
        graph = build_deck_graph([line(0.0, 10.0), line(10.0, 20.0)])
        self.assertEqual(graph.deck_nodes[0][-1], graph.deck_nodes[1][0])
        self.assertEqual(len(graph.nodes), 21, "interior vertices are not merged")
        self.assertEqual(max(graph.components()), 0)

    def test_separate_decks_are_separate_components(self):
        graph = build_deck_graph([line(0.0, 10.0), line(0.0, 10.0, y=5.0)])
        self.assertEqual(max(graph.components()), 1)


class ConeTests(unittest.TestCase):
    def test_a_seed_spreads_at_the_grade(self):
        graph = build_deck_graph([line(0.0, 10.0)])
        cones = lowest_cones(graph, {graph.deck_nodes[0][0]: 0.0}, 0.1)
        self.assertAlmostEqual(cones[graph.deck_nodes[0][5]], 0.5)
        self.assertAlmostEqual(cones[graph.deck_nodes[0][10]], 1.0)

    def test_unreachable_nodes_stay_infinite(self):
        graph = build_deck_graph([line(0.0, 10.0), line(0.0, 10.0, y=5.0)])
        cones = lowest_cones(graph, {graph.deck_nodes[0][0]: 0.0}, 0.1)
        self.assertTrue(math.isinf(cones[graph.deck_nodes[1][3]]))


class SolveHeightsTests(unittest.TestCase):
    def test_anchors_are_met_exactly_and_the_floor_is_reached(self):
        graph = build_deck_graph([line(0.0, 40.0)])
        nodes = graph.deck_nodes[0]
        heights = solve_heights(graph, [1.0] * len(nodes), {nodes[0]: 0.6, nodes[-1]: 0.6}, GRADE)
        self.assertAlmostEqual(heights[nodes[0]], 0.6)
        self.assertAlmostEqual(heights[nodes[-1]], 0.6)
        self.assertAlmostEqual(heights[nodes[20]], 1.0)
        # The ramp rises at exactly the grade until it reaches the floor.
        self.assertAlmostEqual(heights[nodes[2]], 0.6 + 2 * GRADE)
        for a, b in zip(nodes, nodes[1:]):
            self.assertLessEqual(abs(heights[a] - heights[b]), GRADE + 1.0e-9)

    def test_a_short_deck_humps_as_high_as_the_grade_allows(self):
        graph = build_deck_graph([line(0.0, 4.0)])
        nodes = graph.deck_nodes[0]
        heights = solve_heights(graph, [1.0] * len(nodes), {nodes[0]: 0.6, nodes[-1]: 0.6}, GRADE)
        self.assertAlmostEqual(max(heights), 0.6 + 2 * GRADE)

    def test_a_high_anchor_descends_at_the_grade(self):
        graph = build_deck_graph([line(0.0, 40.0)])
        nodes = graph.deck_nodes[0]
        heights = solve_heights(graph, [0.0] * len(nodes), {nodes[0]: 10.0}, GRADE)
        self.assertAlmostEqual(heights[nodes[0]], 10.0)
        self.assertAlmostEqual(heights[nodes[20]], 10.0 - 20 * GRADE)

    def test_without_anchors_the_deck_sits_on_its_floors(self):
        graph = build_deck_graph([line(0.0, 10.0)])
        nodes = graph.deck_nodes[0]
        heights = solve_heights(graph, [2.0] * len(nodes), {}, GRADE)
        self.assertTrue(all(abs(h - 2.0) < 1.0e-9 for h in heights))


class NetworkTests(unittest.TestCase):
    def test_short_bridge_does_not_hump_over_bare_ground_or_a_parallel_road(self):
        deck = line(0, 8)
        roads = SegmentIndex(2)
        roads.add_polyline(line(0, 8, y=0.4), 'parallel')
        solution = solve([deck], roads=roads)
        self.assertEqual(solution.span_adapted_components, 1)
        self.assertEqual(solution.road_crossing_components, 0)
        self.assertTrue(all(abs(h-ROAD) < 1e-9 for h in solution.heights[0]))

    def test_short_bridge_clears_the_crossed_road_at_its_actual_height(self):
        deck = line(0, 12)
        roads = SegmentIndex(2)
        roads.add_polyline(vertical(-5, 5, x=6), 'crossing')
        terrain = lambda x, y: max(0, 0.6-0.1*min(x, 12-x))
        solution = solve([deck], terrain=terrain, roads=roads)
        heights = solution.heights[0]
        self.assertEqual(solution.span_adapted_components, 1)
        self.assertEqual(solution.road_crossing_components, 1)
        self.assertAlmostEqual(heights[6]-DECK, terrain(6, 0)+ROAD+GAP)
        self.assertAlmostEqual(heights[0], terrain(0, 0)+ROAD)
        self.assertAlmostEqual(heights[-1], terrain(12, 0)+ROAD)
        self.assertTrue(all(abs(a-b) <= GRADE+1e-9 for a, b in zip(heights, heights[1:])))

    def test_short_water_bridge_connects_bank_heights_without_an_extra_hump(self):
        terrain = lambda x, y: 0.0 if x==0 else (0.2 if x==8 else -1.0)
        solution = solve([line(0, 8)], terrain=terrain)
        self.assertEqual(solution.demoted, set())
        for i, height in enumerate(solution.heights[0]):
            self.assertAlmostEqual(height, ROAD+0.2*i/8)

    def test_a_road_crossing_between_profile_stations_still_gets_clearance(self):
        roads = SegmentIndex(2)
        roads.add_polyline(vertical(-5, 5, x=4.5), 'crossing')
        terrain = lambda x, y: 0.8 if x in (0, 12) else 0.0
        result = solve([line(0, 12, step=3)], terrain=terrain, roads=roads)
        self.assertEqual(result.road_crossing_components, 1)
        self.assertEqual(result.demoted, set())
        self.assertGreaterEqual((result.heights[0][1]+result.heights[0][2])*0.5-DECK, ROAD+GAP)

    def test_split_short_bridge_uses_whole_component_length_and_one_joint_height(self):
        terrain = lambda x, y: -0.3 if 2<x<10 else 0.0
        whole = solve([line(0, 12)], terrain=terrain)
        split = solve([line(0, 6), line(6, 12)], terrain=terrain)
        self.assertEqual(split.span_adapted_components, 1)
        self.assertEqual(split.heights[0][-1], split.heights[1][0])
        self.assertEqual(whole.heights[0], split.heights[0]+split.heights[1][1:])

    def test_long_branched_and_stacked_components_keep_the_existing_height_policy(self):
        long = solve([line(0, 40)])
        branched = solve([line(0, 4), line(4, 8), vertical(0, 4, x=4)])
        stacked = solve([line(0, 8), vertical(-4, 4, x=4)], levels=[1, 2])
        for result in (long, branched, stacked):
            self.assertEqual(result.span_adapted_components, 0)
        self.assertAlmostEqual(long.heights[0][20], GAP+DECK)
        self.assertGreater(branched.heights[0][-1], ROAD)
        self.assertGreater(stacked.stacked_constraints, 0)

    def test_an_interior_road_anchor_keeps_the_existing_network_policy(self):
        result = solve([line(0, 6), line(6, 12)], blocked=[node_key((6, 0))])
        self.assertEqual(result.span_adapted_components, 0)

    def test_a_deck_cut_off_at_both_edges_gets_gap_plus_thickness(self):
        # A viaduct passing through the selection: both ends on the boundary.
        deck = line(0.0, 20.0)
        solution = solve([deck], open_ends=ends_of(deck))
        self.assertTrue(all(abs(h - (GAP + DECK)) < 1.0e-9 for h in solution.heights[0]))
        self.assertEqual(solution.road_crossing_components, 0)
        self.assertEqual(solution.demoted, set())
        self.assertEqual(solution.open_ends, 2)
        self.assertEqual(solution.touchdowns, 0)

    def test_a_road_underneath_lifts_the_whole_component_by_its_thickness(self):
        roads = SegmentIndex(2.0)
        roads.add_polyline([(10.0, -5.0), (10.0, 5.0)], "residential")
        deck = line(0.0, 20.0)
        solution = solve([deck], roads=roads, open_ends=ends_of(deck))
        self.assertEqual(solution.road_crossing_components, 1)
        self.assertTrue(all(abs(h - (ROAD + GAP + DECK)) < 1.0e-9 for h in solution.heights[0]))

    def test_a_loose_end_touches_down(self):
        # A ramp whose approach was never mapped: a road at one end only.
        deck = line(0.0, 40.0)
        solution = solve([deck], blocked=[node_key(deck[0])])
        self.assertEqual(solution.anchors, 1)
        self.assertEqual(solution.touchdowns, 1)
        self.assertEqual(solution.open_ends, 0)
        heights = solution.heights[0]
        self.assertAlmostEqual(heights[-1], ROAD, msg="the loose end is on the ground")
        self.assertAlmostEqual(heights[20], GAP + DECK)
        self.assertAlmostEqual(heights[-3], ROAD + 2 * GRADE)

    def test_a_stub_with_nothing_at_either_end_becomes_a_path(self):
        # A skywalk between two buildings: touched down at both ends, it
        # cannot climb a layer and is handed back as a surface path.
        solution = solve([line(0.0, 3.0)])
        self.assertEqual(solution.touchdowns, 2)
        self.assertEqual(solution.demoted, {0})

    def test_a_joint_between_decks_is_not_a_loose_end(self):
        first, second = line(0.0, 20.0), line(20.0, 40.0)
        solution = solve(
            [first, second], blocked=[node_key(first[0]), node_key(second[-1])]
        )
        self.assertEqual(solution.anchors, 2)
        self.assertEqual(solution.touchdowns, 0)

    def test_the_road_beside_a_touchdown_is_not_counted_as_crossed(self):
        # The primary road the ramp joins runs right past its loose end.
        deck = line(0.0, 40.0)
        roads = SegmentIndex(2.0)
        roads.add_polyline([(40.0, -5.0), (40.0, 5.0)], "primary")
        solution = solve([deck], blocked=[node_key(deck[0])], roads=roads)
        self.assertEqual(solution.touchdowns, 1)
        self.assertEqual(solution.road_crossing_components, 0)

    def test_a_deck_meets_the_road_surface_where_a_surface_road_ends(self):
        deck = line(0.0, 40.0)
        solution = solve([deck], blocked=[node_key(deck[0]), node_key(deck[-1])])
        heights = solution.heights[0]
        self.assertEqual(solution.anchors, 2)
        self.assertAlmostEqual(heights[0], ROAD, msg="the deck top is the road top")
        self.assertAlmostEqual(heights[-1], ROAD)
        self.assertAlmostEqual(heights[20], GAP + DECK)

    def test_the_approach_road_at_the_anchor_does_not_count_as_a_crossing(self):
        deck = line(0.0, 40.0)
        roads = SegmentIndex(2.0)
        roads.add_polyline([(-20.0, 0.0), (0.0, 0.0)], "primary")
        solution = solve([deck], blocked=[node_key(deck[0])], roads=roads)
        self.assertEqual(solution.road_crossing_components, 0)

    def test_a_fork_gets_one_height(self):
        trunk = line(0.0, 10.0)
        left = line(10.0, 20.0, y=0.0)
        right = vertical(0.0, 10.0, x=10.0)
        solution = solve([trunk, left, right], blocked=[node_key(trunk[0])])
        joint = solution.heights[0][-1]
        self.assertAlmostEqual(solution.heights[1][0], joint)
        self.assertAlmostEqual(solution.heights[2][0], joint)
        self.assertEqual(solution.components, 1)

    def test_a_higher_level_deck_is_stacked_over_the_one_it_crosses(self):
        lower = line(0.0, 20.0)
        upper = vertical(-10.0, 10.0, x=10.0)
        solution = solve([lower, upper], levels=[1, 2], open_ends=ends_of(lower, upper))
        self.assertGreater(solution.stacked_constraints, 0)
        self.assertTrue(all(abs(h - (GAP + DECK)) < 1.0e-9 for h in solution.heights[0]))
        crossing = solution.heights[1][10]
        self.assertAlmostEqual(crossing, (GAP + DECK) + GAP + DECK)
        self.assertAlmostEqual(solution.heights[1][0], max(GAP + DECK, crossing - 10 * GRADE))

    def test_decks_sharing_a_joint_are_not_stacked(self):
        first = line(0.0, 10.0)
        second = line(10.0, 20.0)
        solution = solve([first, second], levels=[1, 2])
        self.assertEqual(solution.stacked_constraints, 0)

    def test_a_piece_that_cannot_rise_a_layer_is_demoted(self):
        short = line(0.0, 4.0)
        solution = solve([short], blocked=[node_key(short[0]), node_key(short[-1])])
        self.assertEqual(solution.demoted, {0})
        long = line(0.0, 40.0)
        solution = solve([long], blocked=[node_key(long[0]), node_key(long[-1])])
        self.assertEqual(solution.demoted, set())

    def test_a_deck_over_low_ground_is_never_demoted(self):
        # A river: the bed is far below the banks the deck is anchored to.
        def terrain(x, y):
            return -2.0 if 2.0 < x < 8.0 else 0.0

        deck = line(0.0, 10.0)
        solution = solve([deck], blocked=[node_key(deck[0]), node_key(deck[-1])], terrain=terrain)
        self.assertEqual(solution.demoted, set())
        # The deck stays level at the bank road surface rather than dipping.
        self.assertTrue(all(h >= ROAD - 1.0e-9 for h in solution.heights[0]))


if __name__ == "__main__":
    unittest.main()
