"""Tidy the road and path network before it is widened into ribbons.

Overture hands over every mapped way that intersects the selection: both
carriageways of a divided street, the cycle track laid along it, the footway
that is a sidewalk in all but tag, and a dozen fragments where one street was
split at every tag change.  Buffered independently, those print as ribbons
closer together than a nozzle line can separate, and once the sidewalks and
crossings are left out, the paths that used to reach them stop a few metres
short of the street.

This module ranks every piece by class, welds pieces that meet end to end
into routes for decision-making, drops routes that run close to and parallel
with a more important route already kept, pulls loose ends onto the line they
nearly meet, and prunes short fragments that lead nowhere.  It is the laser
plaque exporter's cleanup (``examples_and_inspiration``) reworked for ribbons
with width: "close" means the printed edges would be nearer than ``gap_mm``,
not that the centerlines would.  The order is the exporter's, and for its
reason: welding runs first so that whole-route culling judges a street, not
the fragment of it that happens to run beside its own ramp.

Everything here is pure Python over :class:`SubSegment` pieces in the metric
frame.  Thresholds are printed millimetres converted with the transform's
scale.  Pieces keep their own attributes: welding is a grouping for decisions,
never a merge of geometry, so widths, flags, levels and source ids survive
untouched on every piece that is kept.  Only three things change geometry: a
culled piece is dropped, a trimmed minor path keeps its unshadowed runs, and
a snapped end moves onto the line it nearly met.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from ..data.linework import (
    MINOR_ROAD_CLASSES,
    RAIL_CLASS,
    SubSegment,
    densify_polyline,
    polyline_length,
)


Point = Tuple[float, float]

# When two routes shadow each other the less important one goes, so a
# motorway is never dropped in favour of the service road beside it.  Lower
# wins.  Rail sits between the streets that structure a neighbourhood and the
# service roads and paths that follow it; a track beside a residential street
# yields to the street, a service road beside the track yields to the track.
ROAD_CLASS_RANK: Dict[str, int] = {
    "motorway": 0,
    "trunk": 1,
    "primary": 2,
    "secondary": 3,
    "tertiary": 4,
    "unclassified": 5,
    "residential": 6,
    "living_street": 6,
    RAIL_CLASS: 7,
    "pedestrian": 7,
    "service": 8,
    "driveway": 8,
    "parking_aisle": 8,
    "alley": 8,
    "track": 9,
    "cycleway": 10,
    "bridleway": 11,
    "footway": 11,
    "path": 11,
    "steps": 11,
    "sidewalk": 11,
    "crosswalk": 11,
}
UNRANKED = 12

# How much of a segment's samples have to lie beside another route before the
# segment counts as shadowed: most of it, so a piece that merely touches a
# road at a junction survives.
SEGMENT_SHADOW_NUMERATOR = 3
SEGMENT_SHADOW_DENOMINATOR = 5

# How close to the selection rectangle an end has to be to count as cut off
# by it rather than ending there, in printed millimetres.
BOUNDARY_TOLERANCE_MM = 0.05

# A piece of a losing route this much shadowed is doubled and goes; one less
# shadowed is a remnant that survives only as a link between kept routes.
# Both carriageways of a divided street converge on each intersection and
# the stem through it belongs to neither; welded to the losing side it was
# culled with it and the street broke at every crossing.
REMNANT_SHADOW_FRACTION = 0.3

# A piece of a surviving route this much shadowed is doubled, and a run of
# such pieces is dropped when both its ends land on kept geometry, so the
# route stays connected through what doubled it.  A carriageway welded to
# the stems either side of it was only three fifths shadowed as a route and
# survived whole, double road and all.
DOUBLED_SHADOW_FRACTION = 0.6

# At a junction a route continues into the one piece of its class that
# carries on within this many degrees of its own heading, provided no other
# piece there does.  Overture splits both carriageways of a divided street at
# every cross street; judged block by block the survivor hopped from one
# side to the other at each junction, so the printed road zigzagged.
CONTINUATION_ANGLE_DEG = 25.0

# Where only two ends meet, the pieces are one route through any bend short
# of turning back: a carriageway that leaves the same node as its twin and
# runs beside it doubles back on it, and welding the pair made one route of
# the two lines the cull exists to separate.
REVERSAL_ANGLE_DEG = 120.0


def rank_for_class(road_class: str) -> int:
    return ROAD_CLASS_RANK.get(str(road_class), UNRANKED)


@dataclass
class NetworkSettings:
    """Every tunable of the tidy pass, in printed millimetres."""

    # The narrowest strip of ground allowed between two printed ribbons that
    # run alongside each other.  One nozzle line: anything thinner cannot be
    # laid down as terrain between them and prints as a ragged seam.
    gap_mm: float = 0.4
    # A loose end whose ribbon would stop within this much ground of a road's
    # edge is pulled onto the road.  Wider than the gap: a park path used to
    # end on the sidewalk of a boulevard, which can be a dozen metres from
    # the centerline, and joining it costs nothing while leaving it costs a
    # visible stump.
    snap_gap_mm: float = 0.8
    # Within this many degrees of parallel is "alongside"; a path meeting a
    # road at a steeper angle is a junction and is never culled for it.
    parallel_angle_deg: float = 28.0
    # A route is dropped whole when at least this fraction of its length is
    # shadowed by routes already kept; below it the route stays entire, so
    # culling never opens a gap in the middle of a street.
    shadow_fraction: float = 0.68
    # A route shorter than this with a loose end leads nowhere: the kerb stub
    # left when a crossing was dropped, or a spur of the mapping itself.
    stub_length_mm: float = 0.7
    # Ends closer than this share a node.  Overture repeats a connector's
    # coordinates exactly, so this only has to absorb projection noise.
    node_tolerance_mm: float = 0.03
    # Footways, cycleways and the like lose only their shadowed sections
    # instead of being judged whole, so a cycle track that follows a street
    # and then turns into a park keeps the park.  Streets are always whole.
    trim_minor_classes: bool = True


@dataclass
class NetworkCounts:
    pieces_in: int = 0
    pieces_out: int = 0
    welded_joins: int = 0
    culled_pieces: int = 0
    trimmed_pieces: int = 0
    culled_length_mm: float = 0.0
    snapped_ends: int = 0
    pruned_stubs: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "network_pieces_in": self.pieces_in,
            "network_pieces_out": self.pieces_out,
            "network_welded_joins": self.welded_joins,
            "network_culled_pieces": self.culled_pieces,
            "network_trimmed_pieces": self.trimmed_pieces,
            "network_culled_length_mm": round(self.culled_length_mm, 3),
            "network_snapped_ends": self.snapped_ends,
            "network_pruned_stubs": self.pruned_stubs,
        }


@dataclass
class _Item:
    """One piece under consideration, with the facts the passes need."""

    piece: SubSegment
    points: List[Point]
    half_width: float
    rank: int
    deck: bool
    minor: bool
    origin: Tuple[int, int]
    trimmed_ends: Tuple[bool, bool] = (False, False)
    moved: bool = False

    @property
    def length(self) -> float:
        return polyline_length(self.points)


@dataclass
class _Chain:
    """Pieces welded end to end: one route for culling and pruning."""

    members: List[int]
    points: List[Point]
    rank: int
    length: float
    order: int


def _unit(a: Point, b: Point) -> Optional[Point]:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length = math.hypot(dx, dy)
    if length <= 1.0e-18:
        return None
    return dx / length, dy / length


def _distance_sq(point: Point, a: Point, b: Point) -> Tuple[float, Point]:
    """Squared distance from *point* to segment ``a -> b`` and the closest point."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= 1.0e-18:
        return (point[0] - a[0]) ** 2 + (point[1] - a[1]) ** 2, a
    t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length_sq
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    closest = (a[0] + t * dx, a[1] + t * dy)
    ex = point[0] - closest[0]
    ey = point[1] - closest[1]
    return ex * ex + ey * ey, closest


def _alongside_sq(point: Point, a: Point, b: Point) -> Optional[float]:
    """Squared distance to segment ``a -> b`` when *point* lies beside it.

    "Another line runs along this one" has to mean beside it, not past its
    end.  The stem through an intersection starts exactly where the kept
    carriageway ends, so measured to the nearest point of that carriageway
    its first samples are at distance zero and it read as doubled by the
    very piece it continues.  Only a closest point strictly inside the
    neighbour counts.
    """
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= 1.0e-18:
        return None
    t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length_sq
    if t <= 0.0 or t >= 1.0:
        return None
    ex = point[0] - (a[0] + t * dx)
    ey = point[1] - (a[1] + t * dy)
    return ex * ex + ey * ey


class _Grid:
    """Uniform grid over tagged segments, for "what is near this point" queries.

    Segments are added as a pass keeps them, so a route can only ever be
    judged against what is already staying.  The cell is at least as large
    as the widest threshold any query uses, so the 3x3 neighbourhood of a
    point's cell holds every segment that could be within reach of it.
    """

    def __init__(self, cell: float) -> None:
        self.cell = max(cell, 1.0e-9)
        self.cells: Dict[Tuple[int, int], List[Tuple[Any, ...]]] = {}
        self.empty = True

    def _key(self, x: float, y: float) -> Tuple[int, int]:
        return int(math.floor(x / self.cell)), int(math.floor(y / self.cell))

    def add(self, points: Sequence[Point], *tag: Any) -> None:
        for a, b in zip(points[:-1], points[1:]):
            direction = _unit(a, b)
            if direction is None:
                continue
            self.empty = False
            item = (a, b, direction) + tag
            steps = int(math.hypot(b[0] - a[0], b[1] - a[1]) / self.cell) + 1
            seen = set()
            for step in range(steps + 1):
                t = step / steps
                seen.add(self._key(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            for key in seen:
                self.cells.setdefault(key, []).append(item)

    def near(self, point: Point) -> List[Tuple[Any, ...]]:
        cx, cy = self._key(point[0], point[1])
        found: List[Tuple[Any, ...]] = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                bucket = self.cells.get((cx + dx, cy + dy))
                if bucket:
                    found.extend(bucket)
        return found


def _samples(a: Point, b: Point, spacing: float) -> List[Point]:
    """Evenly spaced points along a segment, both ends included.

    Overture draws a straight kilometre with two vertices, so sampling has to
    follow the length of a segment rather than its vertex count, or a piece
    that runs beside a road for half its length and then leaves it would be
    judged on a handful of points and misread either way.
    """
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    count = int(math.ceil(length / spacing)) if spacing > 0.0 else 1
    count = max(2, count)
    return [
        (a[0] + (b[0] - a[0]) * index / count, a[1] + (b[1] - a[1]) * index / count)
        for index in range(count + 1)
    ]


def _shadow(
    a: Point,
    b: Point,
    item: _Item,
    grid: _Grid,
    gap: float,
    cos_limit: float,
    spacing: float,
) -> Tuple[int, int]:
    """How many of a segment's samples lie alongside a kept ribbon.

    A sample is shadowed when a kept segment of the same kind (surface or
    deck) runs within the printed gap of it, edge to edge, and within the
    parallel angle of it.  Decks never shadow the ground beneath them, nor the
    ground a deck: an overpass and the street under it are a layer apart.
    """
    direction = _unit(a, b)
    if direction is None:
        return 0, 0
    samples = _samples(a, b, spacing)
    hits = 0
    for point in samples:
        for other_a, other_b, other_direction, other_half_width, other_deck in grid.near(point):
            if other_deck != item.deck:
                continue
            threshold = gap + item.half_width + other_half_width
            distance_sq = _alongside_sq(point, other_a, other_b)
            if distance_sq is None or distance_sq > threshold * threshold:
                continue
            dot = direction[0] * other_direction[0] + direction[1] * other_direction[1]
            if abs(dot) >= cos_limit:
                hits += 1
                break
    return hits, len(samples)


def _is_shadowed(hits: int, samples: int) -> bool:
    return hits * SEGMENT_SHADOW_DENOMINATOR >= samples * SEGMENT_SHADOW_NUMERATOR


def _node(point: Point, quantum: float) -> Tuple[int, int]:
    return round(point[0] / quantum), round(point[1] / quantum)


def _weld(items: Sequence[_Item], quantum: float) -> Tuple[List[_Chain], int]:
    """Join pieces that meet end to end into chains, by class.

    Overture splits one street wherever a rule changes, and a park walkway
    can be a dozen short pieces.  Welded, a real street is one route for the
    culling and pruning decisions and cannot be mistaken for a pile of stubs.
    Only pieces of one class join, so a footpath never becomes part of the
    road it ends on.  Where exactly two ends meet the pieces are one route.
    At a junction the route carries on into the single piece that continues
    its heading within :data:`CONTINUATION_ANGLE_DEG`, so a street stays one
    route across the cross streets it meets; where two pieces both continue
    it (a street splitting into two carriageways) there is no single correct
    continuation and the chain stops.
    """
    cos_limit = math.cos(math.radians(CONTINUATION_ANGLE_DEG))
    reversal_limit = math.cos(math.radians(REVERSAL_ANGLE_DEG))

    def leaving(other: int, other_tail: bool) -> Optional[Point]:
        """Direction in which *other* leaves the node it meets the chain at."""
        points = items[other].points
        if other_tail:
            return _unit(points[-1], points[-2])
        return _unit(points[0], points[1])

    def pick(heading, options):
        """The single option continuing *heading*, or None when none or two do."""
        scored = []
        for direction, key in options:
            if direction is None:
                continue
            scored.append((heading[0] * direction[0] + heading[1] * direction[1], key))
        scored.sort(key=lambda entry: entry[0], reverse=True)
        if not scored or scored[0][0] < cos_limit:
            return None
        if len(scored) > 1 and scored[1][0] >= cos_limit:
            return None
        return scored[0][1]

    def continuation(chain_points, forwards, here, used):
        """The one piece at this node that continues the chain, if any.

        The continuation has to be unambiguous from both sides.  Where a
        divided street merges into one stem at an intersection, the stem is
        the obvious continuation of either carriageway, but looking back
        from the stem both carriageways continue it.  Welded to one side,
        the stem was culled with that side when the other won, and the
        street broke at every intersection.  Left as its own route it has
        nothing beside it and survives.
        """
        unused = [(other, tail) for other, tail in here if other not in used]
        if not unused:
            return None
        heading = (
            _unit(chain_points[-2], chain_points[-1])
            if forwards
            else _unit(chain_points[1], chain_points[0])
        )
        if heading is None:
            return None
        # *here* excludes the chain's own end, so one entry means exactly two
        # ends meet at this node: the pieces are one route through any bend
        # short of doubling back.
        if len(here) == 1:
            direction = leaving(*unused[0])
            if direction is None:
                return None
            dot = heading[0] * direction[0] + heading[1] * direction[1]
            return unused[0] if dot >= reversal_limit else None
        options = [(leaving(other, tail), (other, tail)) for other, tail in here]
        best = pick(heading, options)
        if best is None or best[0] in used:
            return None
        back = leaving(*best)
        if back is None:
            return None
        chain_end = "chain"
        reverse_options = [((-heading[0], -heading[1]), chain_end)] + [
            (direction, key) for direction, key in options if key != best
        ]
        if pick((-back[0], -back[1]), reverse_options) != chain_end:
            return None
        return best
    groups: Dict[str, List[int]] = {}
    for index, item in enumerate(items):
        groups.setdefault(item.piece.road_class, []).append(index)

    chains: List[_Chain] = []
    joins = 0
    for road_class in sorted(groups):
        members = groups[road_class]
        at_node: Dict[Tuple[int, int], List[Tuple[int, bool]]] = {}
        for index in members:
            points = items[index].points
            at_node.setdefault(_node(points[0], quantum), []).append((index, False))
            at_node.setdefault(_node(points[-1], quantum), []).append((index, True))

        used: Set[int] = set()
        for start in sorted(members, key=lambda i: (-items[i].length, i)):
            if start in used:
                continue
            used.add(start)
            chain_points = list(items[start].points)
            chain_members = [start]
            rank = items[start].rank
            for forwards in (True, False):
                while True:
                    end_point = chain_points[-1] if forwards else chain_points[0]
                    here = [
                        entry for entry in at_node.get(_node(end_point, quantum), ())
                        if entry[0] not in chain_members
                    ]
                    found = continuation(chain_points, forwards, here, used)
                    if found is None:
                        break
                    other, other_tail = found
                    used.add(other)
                    piece = list(items[other].points)
                    if other_tail:
                        piece.reverse()
                    joins += 1
                    if forwards:
                        chain_points.extend(piece[1:])
                        chain_members.append(other)
                    else:
                        chain_points = list(reversed(piece[1:])) + chain_points
                        chain_members.insert(0, other)
                    rank = min(rank, items[other].rank)
            chains.append(
                _Chain(
                    members=chain_members,
                    points=chain_points,
                    rank=rank,
                    length=sum(items[index].length for index in chain_members),
                    order=min(chain_members),
                )
            )
    return chains, joins


def _run_points(chain: _Chain, items: Sequence[_Item], start: int, end: int) -> List[Point]:
    """The chain's welded points covering members ``start..end`` inclusive.

    Members are stored in chain order, but a member's own points may run
    against the chain's direction; the welded polyline settles it.
    """
    offset = 0
    for position, index in enumerate(chain.members):
        count = len(items[index].points)
        if position == start:
            first = offset
        if position == end:
            return chain.points[first:offset + count]
        offset += count - 1
    return chain.points


def _cull(
    items: List[_Item],
    chains: Sequence[_Chain],
    settings: NetworkSettings,
    gap: float,
    stub: float,
    spacing: float,
    quantum: float,
    counts: NetworkCounts,
) -> List[_Item]:
    """Drop routes that run alongside more important routes already kept.

    Routes enter the index in order of importance, longest first within a
    rank, so a route can only ever be culled by something at least as
    important as itself.  Streets are judged whole: a residential street
    beside a primary for a tenth of its length keeps that tenth, because the
    alternative is a street with a bite out of its middle.  A losing street
    loses the pieces that are doubled; a piece of it nothing else covers is
    a remnant, kept only when it still links kept routes at both ends (the
    stem of a divided street through an intersection) and dropped when it
    hangs free (the wide middle of a lens whose tips went).  Minor classes
    are trimmed segment by segment instead, so a cycle track that leaves the
    road it followed keeps the part that left.  A trimmed remnant shorter
    than a stub is not a route and goes with the shadowed part.
    """
    cos_limit = math.cos(math.radians(settings.parallel_angle_deg))
    grid = _Grid(spacing)
    kept: List[_Item] = []
    remnants: List[_Item] = []

    def keep(item: _Item) -> None:
        kept.append(item)
        grid.add(item.points, item.half_width, item.deck)

    def fraction(item: _Item) -> Tuple[float, float]:
        """Shadowed length and total length of one piece."""
        shadowed = 0.0
        total = 0.0
        for a, b in zip(item.points[:-1], item.points[1:]):
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            hits, samples = _shadow(a, b, item, grid, gap, cos_limit, spacing)
            total += length
            if samples:
                shadowed += length * hits / samples
        return shadowed, total

    def covered(point: Point, deck: bool) -> bool:
        """Whether *point* lies inside a kept ribbon of the same kind."""
        for a, b, _direction, half_width, other_deck in grid.near(point):
            if other_deck != deck:
                continue
            reach = max(half_width, quantum)
            if _distance_sq(point, a, b)[0] <= reach * reach:
                return True
        return False

    def drop(item: _Item, whole: float) -> None:
        counts.culled_pieces += 1
        counts.culled_length_mm += whole

    for chain in sorted(chains, key=lambda c: (c.rank, -c.length, c.order)):
        members = [items[index] for index in chain.members]
        if grid.empty:
            for item in members:
                keep(item)
            continue

        trim = settings.trim_minor_classes and all(item.minor for item in members)
        if not trim:
            fractions = [fraction(item) for item in members]
            shadowed = sum(part for part, _whole in fractions)
            total = sum(whole for _part, whole in fractions)
            if total > 0.0 and shadowed / total >= settings.shadow_fraction:
                for item, (part, whole) in zip(members, fractions):
                    if whole > 0.0 and part / whole < REMNANT_SHADOW_FRACTION:
                        # Not indexed yet: a later route must never be
                        # culled against a remnant that is dropped after.
                        remnants.append(item)
                    else:
                        drop(item, whole)
                continue

            # The route stays.  A run of doubled pieces inside it is still
            # redundant when both ends of the run land on what doubled it:
            # the road goes on through the winner, and only the seam is
            # gone.  A run whose end hangs in the open would be a bite out
            # of the street, so it is kept.
            doubled = [
                whole > 0.0 and part / whole >= DOUBLED_SHADOW_FRACTION
                for part, whole in fractions
            ]
            start = 0
            while start < len(members):
                if not doubled[start]:
                    keep(members[start])
                    start += 1
                    continue
                end = start
                while end + 1 < len(members) and doubled[end + 1]:
                    end += 1
                run = members[start:end + 1]
                # The chain's points run first to last, so the run's ends
                # are the first member's start and the last member's end
                # in chain order; either member may be reversed in it.
                run_points = _run_points(chain, items, start, end)
                if covered(run_points[0], run[0].deck) and covered(run_points[-1], run[-1].deck):
                    for item, (_part, whole) in zip(run, fractions[start:end + 1]):
                        drop(item, whole)
                else:
                    for item in run:
                        keep(item)
                start = end + 1
            continue

        for item in members:
            if item.deck:
                # A deck is whole or nothing: a footbridge cannot lose the
                # half of itself that runs beside the road bridge and keep
                # an end in the air over the water.
                shadowed = 0.0
                total = 0.0
                for a, b in zip(item.points[:-1], item.points[1:]):
                    length = math.hypot(b[0] - a[0], b[1] - a[1])
                    hits, samples = _shadow(a, b, item, grid, gap, cos_limit, spacing)
                    total += length
                    if samples:
                        shadowed += length * hits / samples
                if total > 0.0 and shadowed / total >= settings.shadow_fraction:
                    counts.culled_pieces += 1
                    counts.culled_length_mm += total
                else:
                    keep(item)
                continue

            # Trim at sample resolution: a two-vertex kilometre is split so
            # the part beside the road can go and the rest stay.
            dense = densify_polyline(item.points, spacing)
            flags = [
                _is_shadowed(*_shadow(a, b, item, grid, gap, cos_limit, spacing))
                for a, b in zip(dense[:-1], dense[1:])
            ]
            if not any(flags):
                keep(item)
                continue
            runs: List[List[Point]] = []
            run: List[Point] = []
            removed = 0.0
            for (a, b), shadowed_segment in zip(zip(dense[:-1], dense[1:]), flags):
                if shadowed_segment:
                    if len(run) >= 2:
                        runs.append(run)
                    run = []
                    removed += math.hypot(b[0] - a[0], b[1] - a[1])
                    continue
                run = [a, b] if not run else run + [b]
            if len(run) >= 2:
                runs.append(run)

            survivors = 0
            for number, run_points in enumerate(runs):
                length = polyline_length(run_points)
                if length < stub:
                    removed += length
                    continue
                first_original = run_points[0] == dense[0]
                last_original = run_points[-1] == dense[-1]
                keep(
                    _Item(
                        piece=item.piece,
                        points=run_points,
                        half_width=item.half_width,
                        rank=item.rank,
                        deck=item.deck,
                        minor=item.minor,
                        origin=(item.origin[0], number),
                        trimmed_ends=(not first_original, not last_original),
                        moved=True,
                    )
                )
                survivors += 1
            counts.culled_length_mm += removed
            if survivors:
                counts.trimmed_pieces += 1
            else:
                counts.culled_pieces += 1

    if remnants:
        # Remnants are judged again against everything that finally stays:
        # a shorter route processed later may double one, and the routes
        # its run has to link may not have been in the index at the time.
        grid = _Grid(spacing)
        for item in kept:
            grid.add(item.points, item.half_width, item.deck)
        survivors: List[_Item] = []
        for item in remnants:
            part, whole = fraction(item)
            if whole > 0.0 and part / whole >= REMNANT_SHADOW_FRACTION:
                drop(item, whole)
            else:
                survivors.append(item)

        # A remnant run survives only as a link: both of its ends have to
        # touch something that is staying in its own right.
        runs, _joins = _weld(survivors, quantum)
        for run in runs:
            deck = survivors[run.members[0]].deck
            if covered(run.points[0], deck) and covered(run.points[-1], deck):
                kept.extend(survivors[index] for index in run.members)
            else:
                for index in run.members:
                    drop(survivors[index], survivors[index].length)
    return kept


def _snap(
    items: List[_Item],
    settings: NetworkSettings,
    snap_gap: float,
    quantum: float,
    max_half_width: float,
    on_boundary: Callable[[Point], bool],
    counts: NetworkCounts,
) -> None:
    """Pull a loose end onto the surface road it nearly meets.

    Mapping is full of ways that stop a hair short of the road they join, and
    once the sidewalks are gone a park path ends at the kerb.  An end whose
    ribbon would leave less than the snap gap of ground before the road's
    edge is moved onto the road's centerline, so the two ribbons overlap and
    print as one junction.

    An end only joins a road at least as important as its own: a path is
    pulled onto the street, never the street onto the path.  It has to be
    heading into the road, not running beside it, or a parallel start would
    be dragged sideways.  An end already inside the other ribbon touches it
    and stays put, as do ends on the crop boundary and the ends of decks, and
    nothing is ever moved further than its reach, so this closes gaps
    without inventing junctions.
    """
    reach_limit = snap_gap + 2.0 * max_half_width
    grid = _Grid(max(reach_limit, quantum))
    for index, item in enumerate(items):
        if not item.deck:
            grid.add(item.points, item.half_width, item.rank, index)
    cos_limit = math.cos(math.radians(settings.parallel_angle_deg))

    for index, item in enumerate(items):
        if item.deck:
            continue
        # A piece no longer than the gap it would be snapped across is a nub,
        # not a road that stops short; snapping it collapses it.  The stub
        # pruner deals with those.
        if item.length <= snap_gap + 2.0 * item.half_width:
            continue
        for end in (0, -1):
            point = item.points[end]
            if on_boundary(point):
                continue
            neighbour = item.points[1] if end == 0 else item.points[-2]
            heading = _unit(neighbour, point)
            if heading is None:
                continue
            reach = snap_gap + item.half_width
            best: Optional[Tuple[float, Point]] = None
            touching = False
            for a, b, direction, other_half_width, other_rank, other in grid.near(point):
                if other == index or other_rank > item.rank:
                    continue
                distance_sq, closest = _distance_sq(point, a, b)
                touch = max(other_half_width, quantum)
                if distance_sq <= touch * touch:
                    touching = True
                    break
                limit = reach + other_half_width
                if distance_sq > limit * limit:
                    continue
                dot = heading[0] * direction[0] + heading[1] * direction[1]
                if abs(dot) >= cos_limit:
                    continue
                if best is None or distance_sq < best[0]:
                    best = (distance_sq, closest)
            if touching or best is None:
                continue
            target = best[1]
            # Never collapse the segment being moved.
            if math.hypot(target[0] - neighbour[0], target[1] - neighbour[1]) <= quantum:
                continue
            item.points[end] = target
            item.moved = True
            counts.snapped_ends += 1


def _prune(
    items: List[_Item],
    chains: Sequence[_Chain],
    stub: float,
    quantum: float,
    on_boundary: Callable[[Point], bool],
    counts: NetworkCounts,
) -> List[_Item]:
    """Remove short routes that lead nowhere.

    An end counts as connected when it lies inside another live route's
    ribbon, mid-span included: a side street almost always meets the middle
    of a welded main road, and judging by endpoints alone would declare
    every such junction dangling.  Ends on the crop boundary are clipped,
    not dangling.  A route connected at both ends is never removed, however
    short, so real links between roads survive.  Removing a stub can free
    the end of the route it hung from, so the test repeats over whoever
    leaned on it.
    """
    if stub <= 0.0 or not chains:
        return list(items)
    widths = [
        max((items[index].half_width for index in chain.members), default=0.0)
        for chain in chains
    ]
    cell = max(quantum * 4.0, max(widths, default=0.0), 1.0e-9)
    buckets: Dict[Tuple[int, int], List[Tuple[int, Point, Point]]] = {}

    def key(x: float, y: float) -> Tuple[int, int]:
        return int(math.floor(x / cell)), int(math.floor(y / cell))

    for number, chain in enumerate(chains):
        for a, b in zip(chain.points[:-1], chain.points[1:]):
            steps = int(math.hypot(b[0] - a[0], b[1] - a[1]) / cell) + 1
            seen = set()
            for step in range(steps + 1):
                t = step / steps
                seen.add(key(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            for k in seen:
                buckets.setdefault(k, []).append((number, a, b))

    def supporters(number: int, point: Point) -> Set[int]:
        cx, cy = key(point[0], point[1])
        found: Set[int] = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other, a, b in buckets.get((cx + dx, cy + dy), ()):
                    if other == number:
                        continue
                    tolerance = max(widths[other], quantum)
                    if _distance_sq(point, a, b)[0] <= tolerance * tolerance:
                        found.add(other)
        return found

    support = [
        (supporters(number, chain.points[0]), supporters(number, chain.points[-1]))
        for number, chain in enumerate(chains)
    ]
    anchored = [
        (on_boundary(chain.points[0]), on_boundary(chain.points[-1])) for chain in chains
    ]
    dependents: Dict[int, Set[int]] = {}
    for number, (first, last) in enumerate(support):
        for other in first | last:
            dependents.setdefault(other, set()).add(number)

    removed = [False] * len(chains)

    def is_stub(number: int) -> bool:
        if removed[number] or chains[number].length >= stub:
            return False
        first, last = support[number]
        free_first = not any(not removed[other] for other in first)
        free_last = not any(not removed[other] for other in last)
        return (free_first and not anchored[number][0]) or (
            free_last and not anchored[number][1]
        )

    queue = [number for number in range(len(chains)) if is_stub(number)]
    while queue:
        number = queue.pop()
        if not is_stub(number):
            continue
        removed[number] = True
        counts.pruned_stubs += len(chains[number].members)
        for other in dependents.get(number, ()):
            if not removed[other] and is_stub(other):
                queue.append(other)

    gone: Set[int] = set()
    for number, chain in enumerate(chains):
        if removed[number]:
            gone.update(chain.members)
    return [item for index, item in enumerate(items) if index not in gone]


def tidy_network(
    pieces: Iterable[SubSegment],
    scale_mm_per_m: float,
    bounds_m: Optional[Tuple[float, float, float, float]],
    half_width_m: Callable[[SubSegment], float],
    is_deck: Callable[[SubSegment], bool],
    settings: NetworkSettings | None = None,
) -> Tuple[List[SubSegment], NetworkCounts]:
    """Weld, cull, snap and prune the clipped centerline pieces of a selection.

    *half_width_m* returns the printed half width of a piece in metres, so
    the gap is measured between ribbon edges.  *is_deck* says whether a piece
    will be built as an elevated deck; decks and surface pieces never shadow
    each other and deck ends are never moved.  *bounds_m* is the metric crop
    rectangle ``(min_x, min_y, max_x, max_y)``: ends on it were clipped, not
    dangling.  Returns the surviving pieces in their original order and the
    counts of what each pass did.
    """
    settings = settings or NetworkSettings()
    counts = NetworkCounts()
    originals = list(pieces)
    counts.pieces_in = len(originals)
    if scale_mm_per_m <= 0.0 or not originals:
        counts.pieces_out = len(originals)
        return originals, counts

    scale = float(scale_mm_per_m)
    gap = max(0.0, float(settings.gap_mm)) / scale
    snap_gap = max(0.0, float(settings.snap_gap_mm)) / scale
    stub = max(0.0, float(settings.stub_length_mm)) / scale
    quantum = max(float(settings.node_tolerance_mm), 1.0e-6) / scale
    boundary = BOUNDARY_TOLERANCE_MM / scale

    items: List[_Item] = []
    for number, piece in enumerate(originals):
        if len(piece.points) < 2:
            continue
        items.append(
            _Item(
                piece=piece,
                points=list(piece.points),
                half_width=max(0.0, float(half_width_m(piece))),
                rank=rank_for_class(piece.road_class),
                deck=bool(is_deck(piece)),
                minor=piece.road_class in MINOR_ROAD_CLASSES,
                origin=(number, 0),
            )
        )
    if not items:
        counts.pieces_out = 0
        return [], counts

    max_half_width = max(item.half_width for item in items)
    # The widest corridor any pair can need; also the sampling stride, so a
    # segment is tested at least once per corridor width along its length.
    spacing = max(gap + 2.0 * max_half_width, quantum * 4.0, 1.0e-6)

    if bounds_m is None:
        def on_boundary(point: Point) -> bool:
            return False
    else:
        min_x, min_y, max_x, max_y = bounds_m

        def on_boundary(point: Point) -> bool:
            x, y = point
            return (
                x - min_x <= boundary
                or max_x - x <= boundary
                or y - min_y <= boundary
                or max_y - y <= boundary
            )

    chains, joins = _weld(items, quantum)
    counts.welded_joins += joins
    items = _cull(items, chains, settings, gap, stub, spacing, quantum, counts)

    if snap_gap > 0.0:
        _snap(items, settings, snap_gap, quantum, max_half_width, on_boundary, counts)

    # Weld again: trimming split pieces and snapping brought ends together,
    # and both leave joins the first pass could not have seen.  The pruner
    # has to judge the routes as they now are.
    chains, _rejoined = _weld(items, quantum)
    items = _prune(items, chains, stub, quantum, on_boundary, counts)

    items.sort(key=lambda item: item.origin)
    result: List[SubSegment] = []
    for item in items:
        if item.moved:
            result.append(replace(item.piece, points=tuple(item.points)))
        else:
            result.append(item.piece)
    counts.pieces_out = len(result)
    counts.culled_length_mm *= scale
    return result, counts
