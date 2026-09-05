"""Deck heights solved across the whole bridge network at once.

Why not one span at a time
--------------------------
Overture splits an interchange into dozens of short flagged pieces that meet
at forks and merge back into each other.  Solving each piece, or each chain
of pieces, on its own gives every joint whatever height each side happened to
reach: a ramp meets its viaduct half a millimetre off, a fork is anchored to
the ground under it, and the heights of the whole tangle come from how the
data was cut rather than from what the bridges cross.  On the sample city the
old single-span solver also lifted decks by a multiple of their tag's level
and humped them to three times the clearance, which put motorway ramps four
millimetres in the air over a one-millimetre-high city.

The solve
---------
Every vertex of every deck centerline is a node; pieces meeting at a joint
share the node, so a fork is simply a node with three edges and gets one
height.  Three ingredients decide the profile:

* **anchors** -- a joint where an ordinary surface road ends is where the deck
  comes back down to the ground, and its height is pinned to the road surface
  there (terrain plus road thickness) so the deck continues the road without a
  step.  A deck end that nothing continues at all -- no road, no other deck --
  has nothing to hold it in the air either, so it touches down the same way;
  only an end on the model boundary, where the bridge is cut off by the
  selection rather than by the data, keeps its solved height;
* **floors** -- the lowest a deck top may be at each node: the terrain, plus a
  printable gap, plus the deck's own thickness; plus one road thickness when a
  surface road passes under the deck's connected component (the deck has to
  clear the road's top, not the ground); plus, at a crossing over a lower
  deck, that deck's top, the gap, and the thickness again;
* **grade** -- the deck may not rise or fall faster than this.

The lowest profile that respects the floors and the grade is the upper
envelope of cones falling away from every floor value at the grade, which is
one multi-source shortest-path pass over the graph.  The highest profile the
anchors allow is the lower envelope of cones rising from the anchors at the
same grade.  The deck takes the smaller of the two at every node: it is as low
as it can be, it meets every anchor exactly, and a piece too short to reach
its floor at the allowed grade simply humps as high as the grade lets it.
A component that never gets a printed layer above the road surface is not a
bridge anyone could see, and is handed back to be built as a surface road.

Everything here is pure and works in the caller's planar unit.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Set, Tuple

from .bridge_network import NODE_TOLERANCE, node_key

Point = Tuple[float, float]

# Decks are matched against the things under them a little more generously
# than their widths: a road ten metres to the side of a viaduct is what the
# viaduct is elevated over, not a neighbour it could have been built beside.
CROSSING_MARGIN = 0.2

# Two decks stack only where they actually cross.  The two carriageways of a
# double-deck bridge run side by side for their whole length with different
# level tags -- and on the Brent Spence Bridge the tags swap between pieces --
# so treating a parallel neighbour as "the deck below" made each carriageway
# lift the other, a millimetre per round, until the bridge stood five
# millimetres over the river.  A crossing has to meet at least this angle,
# as the sine of the angle between the two centerlines.
MINIMUM_CROSSING_SINE = math.sin(math.radians(25.0))


def point_segment_distance(point: Point, a: Point, b: Point) -> Tuple[float, float]:
    """Return ``(distance, t)`` from *point* to segment ``a -> b``, ``t`` in [0, 1]."""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    length_squared = dx * dx + dy * dy
    if length_squared <= 0.0:
        return math.dist(point, a), 0.0
    t = ((point[0] - ax) * dx + (point[1] - ay) * dy) / length_squared
    t = min(max(t, 0.0), 1.0)
    return math.dist(point, (ax + dx * t, ay + dy * t)), t


class SegmentIndex:
    """Polyline segments in a grid hash, for nearest-segment queries."""

    def __init__(self, cell_size: float) -> None:
        if cell_size <= 0.0:
            raise ValueError("cell_size must be positive")
        self.cell_size = float(cell_size)
        self.segments: List[Tuple[Point, Point, Any]] = []
        self._cells: Dict[Tuple[int, int], List[int]] = {}

    def _cell(self, x: float, y: float) -> Tuple[int, int]:
        return int(math.floor(x / self.cell_size)), int(math.floor(y / self.cell_size))

    def add_polyline(self, points: Sequence[Point], tag: Any) -> None:
        """Add every segment of a polyline under one *tag*.

        The tag is stored as given; a caller that needs to know which segment
        of the polyline was hit can pass ``(identity, segment_number)`` itself.
        """
        for index in range(len(points) - 1):
            self.add_segment(points[index], points[index + 1], tag)

    def add_segment(self, a: Point, b: Point, tag: Any) -> None:
        index = len(self.segments)
        self.segments.append((a, b, tag))
        (x0, y0), (x1, y1) = self._cell(*a), self._cell(*b)
        for cx in range(min(x0, x1), max(x0, x1) + 1):
            for cy in range(min(y0, y1), max(y0, y1) + 1):
                self._cells.setdefault((cx, cy), []).append(index)

    def within(self, point: Point, radius: float) -> Iterator[Tuple[float, Any, float]]:
        """Yield ``(distance, tag, t)`` for every segment within *radius*."""
        reach = int(math.ceil(radius / self.cell_size))
        cx, cy = self._cell(*point)
        seen: Set[int] = set()
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                for index in self._cells.get((cx + dx, cy + dy), ()):
                    if index in seen:
                        continue
                    seen.add(index)
                    a, b, tag = self.segments[index]
                    distance, t = point_segment_distance(point, a, b)
                    if distance <= radius:
                        yield distance, tag, t

    def nearest(self, point: Point, radius: float) -> Optional[Tuple[float, Any, float]]:
        best = None
        for hit in self.within(point, radius):
            if best is None or hit[0] < best[0]:
                best = hit
        return best


@dataclass
class DeckGraph:
    """Deck centerlines as one graph: shared joints, one node per vertex."""

    nodes: List[Point] = field(default_factory=list)
    adjacency: List[List[Tuple[int, float]]] = field(default_factory=list)
    deck_nodes: List[List[int]] = field(default_factory=list)

    def components(self) -> List[int]:
        """Return a component id per node, by breadth-first search."""
        component = [-1] * len(self.nodes)
        current = 0
        for start in range(len(self.nodes)):
            if component[start] >= 0:
                continue
            component[start] = current
            queue = [start]
            while queue:
                node = queue.pop()
                for neighbour, _length in self.adjacency[node]:
                    if component[neighbour] < 0:
                        component[neighbour] = current
                        queue.append(neighbour)
            current += 1
        return component


def build_deck_graph(
    centerlines: Sequence[Sequence[Point]], tolerance: float = NODE_TOLERANCE
) -> DeckGraph:
    """Join deck centerlines into one graph through their shared endpoints.

    Only endpoints are matched: Overture pieces that meet share a connector
    coordinate exactly, and an interior vertex of one deck passing under
    another is a crossing, not a joint.
    """
    graph = DeckGraph()
    shared: Dict[Tuple[int, int], int] = {}

    def endpoint(point: Point) -> int:
        key = node_key(point, tolerance)
        index = shared.get(key)
        if index is None:
            index = len(graph.nodes)
            graph.nodes.append((float(point[0]), float(point[1])))
            graph.adjacency.append([])
            shared[key] = index
        return index

    for line in centerlines:
        indices: List[int] = []
        last = len(line) - 1
        for position, point in enumerate(line):
            if position == 0 or position == last:
                index = endpoint(point)
            else:
                index = len(graph.nodes)
                graph.nodes.append((float(point[0]), float(point[1])))
                graph.adjacency.append([])
            indices.append(index)
        for a, b in zip(indices, indices[1:]):
            if a == b:
                continue
            length = math.dist(graph.nodes[a], graph.nodes[b])
            graph.adjacency[a].append((b, length))
            graph.adjacency[b].append((a, length))
        graph.deck_nodes.append(indices)
    return graph


def lowest_cones(graph: DeckGraph, seeds: Mapping[int, float], grade: float) -> List[float]:
    """For every node, the least of ``seed value + grade * graph distance``.

    Multi-source Dijkstra with the seed values as starting costs.  Nodes no
    seed can reach keep ``inf``.
    """
    best = [math.inf] * len(graph.nodes)
    heap: List[Tuple[float, int]] = []
    for node, value in seeds.items():
        if value < best[node]:
            best[node] = value
            heap.append((value, node))
    heapq.heapify(heap)
    while heap:
        value, node = heapq.heappop(heap)
        if value > best[node]:
            continue
        for neighbour, length in graph.adjacency[node]:
            candidate = value + grade * length
            if candidate < best[neighbour]:
                best[neighbour] = candidate
                heapq.heappush(heap, (candidate, neighbour))
    return best


def solve_heights(
    graph: DeckGraph,
    floors: Sequence[float],
    anchors: Mapping[int, float],
    grade: float,
) -> List[float]:
    """The lowest grade-limited profile above *floors* that meets *anchors*.

    The upper envelope of cones falling from every floor is the lowest profile
    that clears them all without exceeding the grade; the lower envelope of
    cones rising from the anchors is the highest one the anchors allow.  An
    anchor is also a floor, so the deck never dips below the road it meets.
    """
    seeds = {
        node: -max(floor, anchors.get(node, -math.inf))
        for node, floor in enumerate(floors)
    }
    free = [-value for value in lowest_cones(graph, seeds, grade)]
    if not anchors:
        return free
    ramp = lowest_cones(graph, anchors, grade)
    return [min(f, r) for f, r in zip(free, ramp)]


@dataclass
class DeckSolution:
    heights: List[List[float]]
    demoted: Set[int]
    components: int
    # Deck ends pinned to the surface road they continue.
    anchors: int
    stacked_constraints: int
    road_crossing_components: int
    # Deck ends that nothing continued, brought down to the ground.
    touchdowns: int = 0
    # Deck ends on the model boundary, left at their solved height.
    open_ends: int = 0
    # Which connected component each deck belongs to, so a caller that keeps
    # one deck of a component can keep the joints it shares as well.
    deck_components: List[int] = field(default_factory=list)


def solve_deck_network(
    centerlines: Sequence[Sequence[Point]],
    levels: Sequence[int],
    half_widths: Sequence[float],
    terrain: Callable[[float, float], float],
    anchor_height: Callable[[float, float], float],
    blocked: Set[Tuple[int, int]],
    roads: Optional[SegmentIndex],
    road_half_width: float,
    road_thickness: float,
    deck_thickness: float,
    clearance: float,
    grade: float,
    demote_below: float,
    rounds: int = 8,
    open_ends: Optional[Set[Tuple[int, int]]] = None,
) -> DeckSolution:
    """Solve every deck's top profile against the terrain, the roads, and each other.

    *blocked* holds the node keys where surface roads end; a deck endpoint on
    one is an anchor at ``anchor_height + road_thickness``.  A deck endpoint
    that is neither a joint with another deck nor on a surface road is
    anchored the same way, unless its key is in *open_ends*, which names the
    ends the selection rectangle cut through.  *roads* indexes
    the surface road centerlines so a component that passes over one is
    lifted by the road's thickness as well.  Decks of different ``level`` that
    cross are stacked: the upper one's floor at the crossing is the lower's
    solved top plus the gap and thickness, iterated to a fixed point.
    """
    graph = build_deck_graph(centerlines)
    count = len(graph.nodes)
    if count == 0:
        return DeckSolution([], set(), 0, 0, 0, 0, 0, 0)
    component_of = graph.components()
    component_count = max(component_of) + 1

    # Anchors: deck ends standing where a surface road ends, and deck ends
    # that nothing continues.  A skywalk stub, a ramp whose approach was not
    # mapped, a footbridge landing three metres from the path it serves: left
    # free they hang at floor height, and a short one is a box in the air on
    # a pier.  Touching down is the one thing such an end can honestly do,
    # and a piece too short to climb a layer from there is then built as a
    # path on the ground.  An end on the model boundary is the exception:
    # the bridge goes on past the edge, so it keeps its height.
    open_ends = open_ends or set()
    anchors: Dict[int, float] = {}
    road_anchors = touchdowns = boundary_ends = 0
    for indices in graph.deck_nodes:
        for end in (indices[0], indices[-1]):
            key = node_key(graph.nodes[end])
            if key in blocked:
                if end not in anchors:
                    road_anchors += 1
            elif len(graph.adjacency[end]) >= 2:
                continue
            elif key in open_ends:
                boundary_ends += 1
                continue
            else:
                touchdowns += 1
            anchors[end] = anchor_height(*graph.nodes[end]) + road_thickness

    # A component passing over any surface road has to clear the road's top.
    crosses_road: Set[int] = set()
    if roads is not None:
        for deck, indices in enumerate(graph.deck_nodes):
            reach = half_widths[deck] + road_half_width + CROSSING_MARGIN
            for node in indices:
                if node in anchors or component_of[node] in crosses_road:
                    continue
                if roads.nearest(graph.nodes[node], reach) is not None:
                    crosses_road.add(component_of[node])

    terrain_at = [terrain(x, y) for x, y in graph.nodes]
    floors = [
        terrain_at[node]
        + clearance
        + deck_thickness
        + (road_thickness if component_of[node] in crosses_road else 0.0)
        for node in range(count)
    ]

    # Crossings between decks of different levels, upper node against the
    # lower deck's segment.  Decks that share a joint are not crossing.
    joined: Set[Tuple[int, int]] = set()
    end_owner: Dict[int, List[int]] = {}
    for deck, indices in enumerate(graph.deck_nodes):
        for end in (indices[0], indices[-1]):
            end_owner.setdefault(end, []).append(deck)
    for owners in end_owner.values():
        for first in owners:
            for second in owners:
                if first != second:
                    joined.add((first, second))
    index = SegmentIndex(max(1.0, 2.0 * (max(half_widths) if half_widths else 1.0)))
    for deck, indices in enumerate(graph.deck_nodes):
        for position in range(len(indices) - 1):
            index.add_segment(
                graph.nodes[indices[position]],
                graph.nodes[indices[position + 1]],
                (deck, position),
            )
    def direction(a: Point, b: Point) -> Optional[Point]:
        length = math.dist(a, b)
        if length <= 0.0:
            return None
        return ((b[0] - a[0]) / length, (b[1] - a[1]) / length)

    stacked: List[Tuple[int, int, int, float]] = []
    for deck, indices in enumerate(graph.deck_nodes):
        level = int(levels[deck])
        reach = half_widths[deck] + max(half_widths) + CROSSING_MARGIN
        for position, node in enumerate(indices):
            heading = direction(
                graph.nodes[indices[max(0, position - 1)]],
                graph.nodes[indices[min(len(indices) - 1, position + 1)]],
            )
            for distance, (other, other_position), t in index.within(graph.nodes[node], reach):
                if other == deck or (deck, other) in joined:
                    continue
                if int(levels[other]) >= level:
                    continue
                if distance > half_widths[deck] + half_widths[other] + CROSSING_MARGIN:
                    continue
                lower_nodes = graph.deck_nodes[other]
                across = direction(
                    graph.nodes[lower_nodes[other_position]],
                    graph.nodes[lower_nodes[other_position + 1]],
                )
                if heading is not None and across is not None:
                    sine = abs(heading[0] * across[1] - heading[1] * across[0])
                    if sine < MINIMUM_CROSSING_SINE:
                        continue
                stacked.append((node, other, other_position, t))

    heights = solve_heights(graph, floors, anchors, grade)
    for _round in range(rounds):
        if not stacked:
            break
        changed = False
        for node, other, position, t in stacked:
            lower_nodes = graph.deck_nodes[other]
            below = (
                heights[lower_nodes[position]] * (1.0 - t)
                + heights[lower_nodes[position + 1]] * t
            )
            needed = below + clearance + deck_thickness
            if needed > floors[node] + 1.0e-9:
                floors[node] = needed
                changed = True
        if not changed:
            break
        heights = solve_heights(graph, floors, anchors, grade)

    # A component that never rises a printed layer above the road surface
    # would print as a bump; it goes back to being a road.
    lift: Dict[int, float] = {}
    for node in range(count):
        value = heights[node] - terrain_at[node] - road_thickness
        component = component_of[node]
        lift[component] = max(lift.get(component, -math.inf), value)
    demoted = {
        deck
        for deck, indices in enumerate(graph.deck_nodes)
        if lift[component_of[indices[0]]] < demote_below
    }

    return DeckSolution(
        heights=[[heights[node] for node in indices] for indices in graph.deck_nodes],
        demoted=demoted,
        components=component_count,
        anchors=road_anchors,
        stacked_constraints=len(stacked),
        road_crossing_components=len(crosses_road),
        touchdowns=touchdowns,
        open_ends=boundary_ends,
        deck_components=[component_of[indices[0]] for indices in graph.deck_nodes],
    )
