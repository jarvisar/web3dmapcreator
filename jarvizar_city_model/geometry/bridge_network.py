"""How decks relate to the water they cross, and how their joints are named.

A road that crosses cut-out water without being flagged as a bridge is still a
crossing: the water is there and the road is there.  The portion of it
standing over open water is recovered as a deck rather than being draped into
the opening, and the recovery is recorded as the deck's evidence.  The same
run-finding tells a deck where it needs ground built back under it.

Joints between deck pieces are named by :func:`node_key`, which is what lets
:mod:`jarvizar_city_model.geometry.deck_graph` join every piece of an
interchange into one graph and solve the heights of the whole network at once.

Everything here is pure and Blender-free, and works in whatever planar unit
the caller passes.
"""

from __future__ import annotations

import math
from typing import Callable, List, Sequence, Tuple

from ..data.linework import dedupe_points, polyline_length, split_polyline_at_distances

Point = Tuple[float, float]
NodeKey = Tuple[int, int]

# Endpoints closer than this are the same junction.  Overture segments that
# share a connector project to identical coordinates, and pieces split at a
# rule boundary share their cut vertex exactly, so the tolerance only has to
# absorb floating-point noise.
NODE_TOLERANCE = 1.0e-3


def node_key(point: Point, tolerance: float = NODE_TOLERANCE) -> NodeKey:
    return (int(round(point[0] / tolerance)), int(round(point[1] / tolerance)))


def _distances(points: Sequence[Point]) -> List[float]:
    travelled = [0.0]
    for index in range(len(points) - 1):
        travelled.append(travelled[-1] + math.dist(points[index], points[index + 1]))
    return travelled


def open_water_runs(
    points: Sequence[Point], over_open_water: Callable[[float, float], bool]
) -> List[Tuple[int, int]]:
    """Return inclusive vertex-index runs of a polyline standing over open water."""
    runs: List[Tuple[int, int]] = []
    start = None
    for index, point in enumerate(points):
        wet = over_open_water(*point)
        if wet and start is None:
            start = index
        elif not wet and start is not None:
            runs.append((start, index - 1))
            start = None
    if start is not None:
        runs.append((start, len(points) - 1))
    return runs


def _run_intervals(
    points: Sequence[Point],
    runs: Sequence[Tuple[int, int]],
    minimum_length: float,
    extension: float,
) -> List[Tuple[float, float]]:
    """Turn vertex runs into merged distance intervals along the polyline.

    Each run is widened by *extension* at both ends so the recovered deck
    begins on the bank rather than at the water's edge, and overlapping
    intervals are merged so two nearby channels become one span.
    """
    travelled = _distances(points)
    total = travelled[-1] if travelled else 0.0
    intervals: List[Tuple[float, float]] = []
    for start, end in runs:
        length = travelled[end] - travelled[start]
        if length < minimum_length:
            continue
        low = max(0.0, travelled[start] - extension)
        high = min(total, travelled[end] + extension)
        if intervals and low <= intervals[-1][1]:
            intervals[-1] = (intervals[-1][0], max(intervals[-1][1], high))
        else:
            intervals.append((low, high))
    return intervals


def split_at_open_water(
    points: Sequence[Point],
    over_open_water: Callable[[float, float], bool],
    minimum_length: float,
    extension: float,
) -> List[Tuple[List[Point], bool]]:
    """Split a surface centerline into ``(piece, crosses_water)`` parts.

    *points* must already be dense enough to resolve the water's edge, since
    only vertices are tested.  A run shorter than *minimum_length* is mapping
    slop -- a riverside road whose centerline strays inside the water polygon
    -- and is left in place rather than being lifted onto a deck.
    """
    points = dedupe_points(points)
    if len(points) < 2:
        return []
    runs = open_water_runs(points, over_open_water)
    if not runs:
        return [(list(points), False)]
    intervals = _run_intervals(points, runs, minimum_length, extension)
    if not intervals:
        return [(list(points), False)]

    cuts: List[float] = []
    for low, high in intervals:
        cuts.extend((low, high))
    pieces = split_polyline_at_distances(points, cuts)

    result: List[Tuple[List[Point], bool]] = []
    travelled = 0.0
    for piece in pieces:
        length = polyline_length(piece)
        midpoint = travelled + length * 0.5
        crossing = any(low - 1.0e-9 <= midpoint <= high + 1.0e-9 for low, high in intervals)
        result.append((piece, crossing))
        travelled += length
    return result


def open_water_corridors(
    points: Sequence[Point],
    over_open_water: Callable[[float, float], bool],
    overlap: float,
) -> List[List[Point]]:
    """Return the parts of a deck centerline that need ground built under them.

    Each part is the run over open water extended by *overlap* onto the land at
    either end, so the causeway built from it overlaps the bank solidly instead
    of merely touching it.
    """
    points = dedupe_points(points)
    if len(points) < 2:
        return []
    runs = open_water_runs(points, over_open_water)
    if not runs:
        return []
    intervals = _run_intervals(points, runs, 0.0, overlap)
    cuts: List[float] = []
    for low, high in intervals:
        cuts.extend((low, high))
    pieces = split_polyline_at_distances(points, cuts)
    corridors: List[List[Point]] = []
    travelled = 0.0
    for piece in pieces:
        length = polyline_length(piece)
        midpoint = travelled + length * 0.5
        if any(low - 1.0e-9 <= midpoint <= high + 1.0e-9 for low, high in intervals):
            corridors.append(piece)
        travelled += length
    return corridors


