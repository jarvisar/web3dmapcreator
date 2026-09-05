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
from typing import List, Sequence, Tuple


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
