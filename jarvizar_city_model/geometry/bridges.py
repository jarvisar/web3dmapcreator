"""Blender mesh construction for bridge decks and their supports.

The heights are solved for the whole network in
:mod:`jarvizar_city_model.geometry.deck_graph` and read back along each
centerline by :mod:`jarvizar_city_model.geometry.deck_profile`.  This module
turns a solved profile into closed geometry.
"""

from __future__ import annotations

from typing import Callable, Optional, Sequence, Tuple

from ..blender.mesh_utils import MeshBuilder
from ..data.linework import cumulative_positions
from .deck_graph import point_segment_distance
from .deck_mesh import deck_strip_geometry
from .deck_profile import additional_support_stations, interpolate_profile, point_and_direction, support_stations
from .planar import (
    EPSILON,
    buffer_polyline_convex_pieces,
    offset_is_safe,
)


Point = Tuple[float, float]

# A pier's top is pushed this far up into the deck it carries.  The deck's
# underside between two ring vertices is a straight line while the profile
# the pier reads is the centerline's own, and on a tight curve the two differ
# by a few hundredths; a pier that stops that far short would print as a
# column with a hairline gap above it.  Inside the deck the overlap is unioned
# away by the slicer.
PIER_OVERLAP_MM = 0.1

__all__ = [
    "add_bridge_deck",
    "add_bridge_supports",
]


def _parameter_along(points: Sequence[Point], positions: Sequence[float], point: Point) -> float:
    """Normalised position along a polyline of the point nearest to *point*."""
    best = None
    for index in range(len(points) - 1):
        distance, s = point_segment_distance(point, points[index], points[index + 1])
        if best is None or distance < best[0]:
            best = (distance, index, s)
    if best is None:
        return 0.0
    _distance, index, s = best
    return positions[index] + (positions[index + 1] - positions[index]) * s


def add_bridge_deck(
    builder: MeshBuilder,
    points: Sequence[Point],
    half_width: float,
    deck_heights: Sequence[float],
    thickness: float,
) -> bool:
    """Add one closed deck solid whose height follows the solved profile.

    A deck whose centerline is too tight to offset into a simple ring -- a
    ramp looping onto an interchange -- is built from overlapping convex
    pieces instead, exactly as a tight surface road is, with every ring
    vertex taking the profile height at its nearest point on the centerline.
    Disjoint per-span slabs used to leave a wedge missing on the outside of
    every bend, where a pier could stand under nothing.
    """
    if offset_is_safe(points, half_width):
        vertices, faces = deck_strip_geometry(points, half_width, deck_heights, thickness)
        if vertices and builder.add_raw(vertices, faces):
            return True

    positions = cumulative_positions(points)
    added = False
    for ring in buffer_polyline_convex_pieces(
        points, half_width, arc_segments=4, epsilon=EPSILON
    ):
        if not ring:
            continue
        prism = []
        for x, y in ring:
            top = interpolate_profile(
                positions, deck_heights, _parameter_along(points, positions, (x, y))
            )
            prism.append((x, y, top - thickness, top))
        if builder.add_prism([prism]):
            added = True
    return added


def add_bridge_supports(
    builder: MeshBuilder,
    points: Sequence[Point],
    deck_heights: Sequence[float],
    terrain_height: Callable[[float, float], float],
    half_width: float,
    thickness: float,
    spacing: float,
    end_exclusion: float,
    minimum_height: float,
    embed: float,
    is_void: Optional[Callable[[float, float], bool]] = None,
    minimum_size: float = 0.0,
    is_obstructed: Optional[Callable[[float], bool]] = None,
) -> int:
    """Add schematic rectangular piers from the deck underside to the ground.

    Piers are deliberately plain: they must be watertight and above the minimum
    printable cross-section, and nothing more. Regular piers omit shallow
    gaps. If this leaves an excessive unsupported run, add a low abutment
    or another pier where there is ground and no crossing-road obstruction.

    Where the river a bridge crosses has been cut out of the terrain there is
    no ground to reach, so *is_void* suppresses the piers that would otherwise
    hang in the opening.  A caller that has built ground back under the deck
    passes a test that knows about it, and the piers come down onto that.

    *minimum_size* holds both plan dimensions of a pier at or above a printable
    column.  A footbridge deck at the minimum ribbon width would otherwise get
    piers a fraction of a nozzle across, which a slicer simply drops.
    """
    positions = cumulative_positions(points)
    added = 0
    pier_half_length = max(half_width * 0.35, minimum_size * 0.5, 1.0e-3)
    pier_half_width = max(half_width * 0.55, minimum_size * 0.5, 1.0e-3)
    built_stations = []

    def add_at(station, supplement=False):
        centre, direction = point_and_direction(points, positions, station)
        if is_void is not None and is_void(*centre):
            return False
        underside = interpolate_profile(positions, deck_heights, station) - thickness
        ground = terrain_height(*centre)
        gap = underside - ground
        if gap < (1e-6 if supplement else minimum_height):
            return False
        # A shallow gap wants a simple full-width abutment, not a tiny column.
        width = half_width if supplement and gap < minimum_height else pier_half_width
        top = underside + min(PIER_OVERLAP_MM, thickness * 0.5)
        normal = (-direction[1], direction[0])
        corners = [
            (
                centre[0]
                + direction[0] * sx * pier_half_length
                + normal[0] * sy * width,
                centre[1]
                + direction[1] * sx * pier_half_length
                + normal[1] * sy * width,
            )
            for sx, sy in ((-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0))
        ]
        return builder.add_flat_prism(corners, ground - embed, top)

    for station in support_stations(points, spacing, end_exclusion):
        if add_at(station):
            added += 1
            built_stations.append(station)
    for station in additional_support_stations(
        points, deck_heights, terrain_height, thickness, spacing,
        built_stations, pier_half_length, is_void, is_obstructed,
    ):
        if add_at(station, supplement=True):
            added += 1
    return added
