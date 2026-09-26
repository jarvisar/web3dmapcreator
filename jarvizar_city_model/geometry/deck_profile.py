"""Pure helpers for walking a solved deck profile.

The heights themselves are solved for the whole bridge network at once in
:mod:`jarvizar_city_model.geometry.deck_graph`; what lives here is how a
per-vertex profile is read back along a centerline -- interpolating it at a
station, placing pier stations along a span, and finding the point and
direction at a station -- so that mesh construction in
:mod:`jarvizar_city_model.geometry.bridges` can stay simple.

This module takes plain numbers and never Blender objects, so it is tested
without Blender.
"""

from __future__ import annotations

import math
from typing import Callable, List, Optional, Sequence, Tuple

from ..data.linework import cumulative_positions, polyline_length


Point = Tuple[float, float]


def interpolate_profile(
    positions: Sequence[float], values: Sequence[float], t: float
) -> float:
    """Linearly interpolate a per-vertex profile at normalized position *t*."""
    if not values:
        return 0.0
    if t <= positions[0]:
        return values[0]
    if t >= positions[-1]:
        return values[-1]
    for index in range(len(positions) - 1):
        start, end = positions[index], positions[index + 1]
        if start <= t <= end:
            span = end - start
            factor = 0.0 if span <= 0.0 else (t - start) / span
            return values[index] + (values[index + 1] - values[index]) * factor
    return values[-1]


def support_stations(
    points: Sequence[Point],
    spacing: float,
    end_exclusion: float,
) -> List[float]:
    """Return normalized positions for evenly distributed deck supports.

    Supports are omitted entirely on spans too short to need them, and are
    always held back from both ends so they never land on the abutments or in
    the intersection where the bridge meets its approach roads.
    """
    total = 0.0
    for index in range(len(points) - 1):
        total += math.dist(points[index], points[index + 1])
    if total <= 0.0:
        return []
    usable = total - 2.0 * end_exclusion
    if spacing <= 0.0 or usable <= spacing * 0.5:
        return []
    count = max(1, int(round(usable / spacing)))
    return [
        (end_exclusion + usable * (index / (count + 1))) / total
        for index in range(1, count + 1)
    ]


def point_and_direction(
    points: Sequence[Point], positions: Sequence[float], t: float
) -> Tuple[Point, Point]:
    """Return the point at *t* along the polyline plus its unit direction."""
    for index in range(len(positions) - 1):
        start, end = positions[index], positions[index + 1]
        if start <= t <= end:
            span = end - start
            factor = 0.0 if span <= 0.0 else (t - start) / span
            ax, ay = points[index]
            bx, by = points[index + 1]
            length = math.hypot(bx - ax, by - ay)
            direction = (
                ((bx - ax) / length, (by - ay) / length)
                if length > 1.0e-12
                else (1.0, 0.0)
            )
            return (ax + (bx - ax) * factor, ay + (by - ay) * factor), direction
    return points[-1], (1.0, 0.0)


def additional_support_stations(
    points: Sequence[Point],
    heights: Sequence[float],
    terrain_height: Callable[[float, float], float],
    thickness: float,
    maximum_span: float,
    existing: Sequence[float] = (),
    half_length: float = 0.0,
    is_void: Optional[Callable[[float, float], bool]] = None,
    is_obstructed: Optional[Callable[[float], bool]] = None,
) -> List[float]:
    """Fill excessive unsupported runs left between ground and built piers.

    Existing pier positions remain unchanged. End exclusions and minimum pier
    height are aesthetic choices, not evidence of support: if they leave a
    long gap, a low support is allowed there. Stations with no foundation or
    with a crossing road are unavailable, never filled with a floating pier.
    All distances use the caller's model units; returned stations are 0..1.
    """
    length = polyline_length(points)
    if length <= 0.0 or maximum_span <= 0.0:
        return []
    positions = cumulative_positions(points)
    count = max(1, math.ceil(length / min(0.25, maximum_span / 8.0)))
    stations = sorted(set(positions) | {i / count for i in range(count + 1)})
    gaps = []
    available = []
    for t in stations:
        xy, _direction = point_and_direction(points, positions, t)
        gap = interpolate_profile(positions, heights, t) - thickness - terrain_height(*xy)
        void = bool(is_void and is_void(*xy))
        gaps.append(max(gap, 1e-5) if void else gap)
        available.append(gap > 1e-6 and not void and not (is_obstructed and is_obstructed(t)))

    runs = []
    start = 0.0 if gaps[0] > 1e-6 else None
    for i in range(1, len(stations)):
        before, after = gaps[i - 1] > 1e-6, gaps[i] > 1e-6
        if before == after:
            continue
        fraction = (1e-6 - gaps[i - 1]) / (gaps[i] - gaps[i - 1])
        crossing = (stations[i - 1] + fraction * (stations[i] - stations[i - 1])) * length
        if after:
            start = crossing
        elif start is not None:
            runs.append((start, crossing))
            start = None
    if start is not None:
        runs.append((start, length))

    for station in existing:
        low, high = station * length - half_length, station * length + half_length
        remainder = []
        for a, b in runs:
            if high <= a or low >= b:
                remainder.append((a, b))
            else:
                if a < low:
                    remainder.append((a, low))
                if high < b:
                    remainder.append((high, b))
        runs = remainder

    candidates = [t * length for t, valid in zip(stations, available)
                  if valid and half_length <= t * length <= length - half_length]
    added = []
    while runs:
        a, b = runs.pop()
        if b - a <= maximum_span + 1e-6:
            continue
        # Divide the actual unsupported run, including low gaps which the
        # normal pier-height threshold intentionally omits.
        choices = [s for s in candidates if a + half_length < s < b - half_length]
        if not choices:
            continue
        target = a + (b - a) / max(2, math.ceil((b - a) / maximum_span))
        station = min(choices, key=lambda s: abs(s - target))
        added.append(station / length)
        runs.extend(((a, station - half_length), (station + half_length, b)))
    return sorted(added)
