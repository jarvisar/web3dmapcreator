"""Road, rail, and bridge surface generation.

Centerlines are buffered in the shared local metric frame, because widths are
metric and must not inherit the millimetre footprint's aspect handling.  The
resulting rings are then scaled into model millimetres with the one shared
transform, exactly like every other feature.

Output is batched by class rather than by feature.  A 1-3 km selection produces
tens of thousands of subsegments, and one Blender object each would make the
scene unusable long before the geometry itself became a problem.

Bridges are not solved one subsegment at a time.  Overture splits a bridge
wherever a scoped rule changes, and those splits fall mid-river and at every
fork of an interchange; every deck vertex becomes a node of one graph and the
whole network is solved together (see
:mod:`jarvizar_city_model.geometry.deck_graph`), anchored to the road surface
wherever a deck meets an ordinary road and brought down to the ground
wherever nothing continues it.  A surface road that crosses cut-out
water without a bridge flag has the crossing recovered as a deck, and every
deck standing over the opening gets a causeway of terrain built back
underneath it so its piers have ground.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from ..blender.mesh_utils import MeshBuilder
from ..data.geojson import feature_id, feature_properties
from ..data.linework import (
    MINOR_ROAD_CLASSES,
    SIDEPATH_SUBCLASSES,
    RAIL_CLASS,
    RAIL_WIDTH_M,
    SubSegment,
    clip_polyline_to_rectangle,
    cumulative_positions,
    densify_polyline,
    linestring_coordinates,
    polyline_length,
    printable_width_m,
    simplify_polyline,
    split_segment,
)
from .bridge_network import node_key, open_water_corridors, split_at_open_water
from .bridges import add_bridge_deck, add_bridge_supports
from .deck_graph import SegmentIndex, solve_deck_network
from .deck_profile import interpolate_profile, point_and_direction
from .planar import (
    EPSILON,
    buffer_polyline,
    buffer_polyline_convex_pieces,
    offset_is_safe,
    oriented_ring,
    parametric_ribbon,
)


# Flags that mean the feature is not a visible surface in a printed miniature.
HIDDEN_FLAGS = frozenset({"is_tunnel"})

# Evidence strings recorded on decks, so the audit trail says why a piece is
# elevated rather than merely that it is.
EVIDENCE_FLAG = "road_flags.is_bridge"
EVIDENCE_RAIL_FLAG = "rail_flags.is_bridge"
EVIDENCE_CROSSING = "crosses_cut_water"

# How close to the selection rectangle a deck end has to be to count as cut
# off by it rather than ending there.  Clipping puts the vertex on the edge
# to floating-point precision; the slack is a fraction of a road width.
BOUNDARY_TOLERANCE_MM = 0.05


@dataclass
class RoadSettings:
    """Every tunable the road and bridge generators need, in real units."""

    road_thickness_mm: float = 0.6
    # How far a ribbon reaches below the ground it is draped on.  Enough to
    # overlap the terrain in a slicer and no more: every layer the road's
    # colour occupies inside the hill is a filament change nobody sees.
    road_embed_mm: float = 0.15
    minimum_width_mm: float = 0.45
    # Widths are clamped into [minimum, maximum]; a motorway at true scale is
    # nearly a millimetre wide and dominates the streets it runs between.
    maximum_width_mm: float = 0.7
    include_minor_roads: bool = True
    # Sidewalks and crossings are dropped by default; park paths, trails, and
    # footbridges are footways too and stay.
    skip_sidepaths: bool = True
    include_rail: bool = True
    include_bridges: bool = True
    # A deck is as thick as a road, so a bridge continues the road it carries
    # with the same number of printed layers.
    bridge_deck_thickness_mm: float = 0.6
    # The printed gap between a deck's underside and whatever it crosses: two
    # 0.2 mm layers of daylight is what makes a bridge read as one.
    bridge_clearance_mm: float = 0.4
    # The steepest a deck may climb or fall, rise over run. Simple short
    # bridges only rise above their approaches to clear a crossing or terrain.
    bridge_maximum_grade: float = 0.08
    # A deck whose whole network never rises this far above the road surface
    # would print as a bump; it is built as an ordinary road instead.
    bridge_minimum_lift_mm: float = 0.2
    bridge_support_spacing_m: float = 30.0
    bridge_support_end_exclusion_m: float = 12.0
    bridge_minimum_support_height_mm: float = 0.4
    # A pier is a free-standing column, so it is held wider than the minimum
    # road ribbon, which only has to survive as a line on the ground.
    bridge_support_minimum_size_mm: float = 0.6
    minimum_bridge_length_m: float = 12.0
    drape_spacing_mm: float = 1.5
    arc_segments: int = 4
    # Ground kept under decks that stand over cut-out water.
    support_over_water: bool = True
    causeway_margin_mm: float = 0.3
    # How far a causeway runs on past the water's edge, so it overlaps the
    # bank solidly instead of merely touching it.  At least most of a terrain
    # cell, since that is how far the bank can be from where the mask says.
    causeway_overlap_mm: float = 1.5
    # A recovered crossing is extended this far onto the land at each end so
    # the deck starts on the bank, where a real abutment stands.
    crossing_extension_m: float = 6.0


@dataclass
class RoadCounts:
    surface_roads: int = 0
    bridge_decks: int = 0
    bridge_supports: int = 0
    bridge_components: int = 0
    bridge_anchored_ends: int = 0
    bridge_touchdown_ends: int = 0
    bridge_open_ends: int = 0
    bridge_stacked_crossings: int = 0
    bridge_road_crossing_components: int = 0
    bridge_span_adapted_components: int = 0
    bridge_decks_demoted: int = 0
    bridge_causeways: int = 0
    crossings_recovered: int = 0
    skipped_tunnels: int = 0
    skipped_minor: int = 0
    skipped_sidepaths: int = 0
    skipped_over_void: int = 0
    decomposed_ribbons: int = 0
    rejected_geometry: int = 0
    classes: Dict[str, int] = field(default_factory=dict)
    evidence: Dict[str, int] = field(default_factory=dict)
    # Which flagged pieces were built as roads because they could not rise a
    # printed layer, keyed by class and evidence: the honest record of what
    # the print does not show as a bridge.
    demoted: Dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "surface_roads": self.surface_roads,
            "bridge_decks": self.bridge_decks,
            "bridge_supports": self.bridge_supports,
            "bridge_components": self.bridge_components,
            "bridge_anchored_ends": self.bridge_anchored_ends,
            "bridge_touchdown_ends": self.bridge_touchdown_ends,
            "bridge_open_ends": self.bridge_open_ends,
            "bridge_stacked_crossings": self.bridge_stacked_crossings,
            "bridge_road_crossing_components": self.bridge_road_crossing_components,
            "bridge_span_adapted_components": self.bridge_span_adapted_components,
            "bridge_decks_demoted": self.bridge_decks_demoted,
            "bridge_demoted_by_class": dict(sorted(self.demoted.items())),
            "bridge_causeways": self.bridge_causeways,
            "bridge_crossings_recovered": self.crossings_recovered,
            "bridge_evidence": dict(sorted(self.evidence.items())),
            "skipped_tunnels": self.skipped_tunnels,
            "skipped_minor": self.skipped_minor,
            "skipped_sidepaths": self.skipped_sidepaths,
            "skipped_over_void": self.skipped_over_void,
            "decomposed_ribbons": self.decomposed_ribbons,
            "roads_rejected_geometry": self.rejected_geometry,
            "classes": dict(sorted(self.classes.items())),
        }


def _project_metric(coordinates, transform) -> List[Tuple[float, float]]:
    points = []
    for longitude, latitude in coordinates:
        east, north, _up = transform.projection.forward(longitude, latitude, 0.0)
        points.append((east, north))
    return points


def _metric_ring_to_model(ring, transform) -> List[Tuple[float, float]]:
    return [
        (east * transform.scale_x_mm_per_m, north * transform.scale_y_mm_per_m)
        for east, north in ring
    ]


def _replace(piece: SubSegment, **changes) -> SubSegment:
    values = {
        "source_id": piece.source_id,
        "points": piece.points,
        "start_t": piece.start_t,
        "end_t": piece.end_t,
        "road_class": piece.road_class,
        "subclass": piece.subclass,
        "width_m": piece.width_m,
        "width_source": piece.width_source,
        "flags": piece.flags,
        "level": piece.level,
        "evidence": piece.evidence,
    }
    values.update(changes)
    return SubSegment(**values)


def _subsegments(features, transform, settings: RoadSettings, counts: RoadCounts):
    """Yield clipped, rule-resolved metric subsegments for every road feature."""
    metric_bounds = transform.metric_bounds
    for feature in features:
        properties = feature_properties(feature)
        subtype = str(properties.get("subtype") or "")
        if subtype == "rail":
            if not settings.include_rail:
                continue
        elif subtype != "road":
            continue

        coordinates = linestring_coordinates(feature.get("geometry") or {})
        if len(coordinates) < 2:
            continue
        source_id = feature_id(feature)
        points = _project_metric(coordinates, transform)

        if subtype == "rail":
            # Rail has no width rules; every track class shares one width and
            # one batch.  Its scoped rail_flags still split it, so a railway
            # bridge is a bridge.
            split = split_segment(
                source_id,
                points,
                properties,
                class_defaults={RAIL_CLASS: RAIL_WIDTH_M},
                road_class=RAIL_CLASS,
            )
            evidence = EVIDENCE_RAIL_FLAG
        else:
            split = split_segment(source_id, points, properties)
            evidence = EVIDENCE_FLAG

        for piece in split:
            if piece.flags & HIDDEN_FLAGS:
                counts.skipped_tunnels += 1
                continue
            if (
                subtype == "road"
                and not settings.include_minor_roads
                and piece.road_class in MINOR_ROAD_CLASSES
            ):
                counts.skipped_minor += 1
                continue
            if (
                subtype == "road"
                and settings.skip_sidepaths
                and piece.subclass in SIDEPATH_SUBCLASSES
            ):
                counts.skipped_sidepaths += 1
                continue
            for clipped in clip_polyline_to_rectangle(
                piece.points,
                metric_bounds.min_east_m,
                metric_bounds.min_north_m,
                metric_bounds.max_east_m,
                metric_bounds.max_north_m,
            ):
                yield _replace(
                    piece,
                    points=tuple(clipped),
                    width_source=(
                        "rail_default" if subtype == "rail" else piece.width_source
                    ),
                    evidence=evidence,
                )


def _is_over_open_water(points, transform, heightfield) -> bool:
    """Whether every vertex of a metric centerline stands over cut-out water."""
    if getattr(heightfield, "void_mask", None) is None or not hasattr(
        heightfield, "over_open_water"
    ):
        return False
    for east, north in points:
        x = east * transform.scale_x_mm_per_m
        y = north * transform.scale_y_mm_per_m
        if not heightfield.over_open_water(x, y):
            return False
    return True


def _half_width_m(piece: SubSegment, transform, settings: RoadSettings) -> float:
    return 0.5 * printable_width_m(
        piece.width_m,
        settings.minimum_width_mm,
        settings.maximum_width_mm,
        transform.scale_x_mm_per_m,
    )


def _is_deck(piece: SubSegment, settings: RoadSettings) -> bool:
    return (
        settings.include_bridges
        and piece.is_bridge
        and polyline_length(piece.points) >= settings.minimum_bridge_length_m
    )


def _recover_crossings(
    pieces: List[SubSegment],
    transform,
    heightfield,
    settings: RoadSettings,
    counts: RoadCounts,
) -> List[SubSegment]:
    """Split surface pieces where they cross open water, and lift that part.

    The test is exact rather than per cell: a road along a riverbank sits in
    shore cells for its whole length, and a per-cell test would have hoisted
    the entire bank onto a deck.
    """
    if getattr(heightfield, "void_mask", None) is None or not settings.include_bridges:
        return pieces
    scale = transform.scale_x_mm_per_m
    # Sample finely enough to resolve the bank: a fraction of a terrain cell.
    spacing_m = max(0.5, heightfield.cell_size_mm * 0.35 / max(scale, 1.0e-12))

    def over_water(east: float, north: float) -> bool:
        return heightfield.over_open_water(east * scale, north * scale)

    result: List[SubSegment] = []
    for piece in pieces:
        if piece.is_bridge or piece.is_tunnel:
            result.append(piece)
            continue
        dense = densify_polyline(piece.points, spacing_m)
        parts = split_at_open_water(
            dense,
            over_water,
            settings.minimum_bridge_length_m,
            settings.crossing_extension_m,
        )
        if not any(crossing for _points, crossing in parts):
            result.append(piece)
            continue
        for points, crossing in parts:
            if len(points) < 2:
                continue
            if crossing:
                counts.crossings_recovered += 1
                result.append(
                    _replace(
                        piece,
                        points=tuple(points),
                        flags=frozenset(piece.flags | {"is_bridge"}),
                        evidence=EVIDENCE_CROSSING,
                    )
                )
            else:
                result.append(_replace(piece, points=tuple(points)))
    return result


def _deck_centerline(piece: SubSegment, transform, settings: RoadSettings, drape_spacing_m: float):
    """Return a deck's model-space centerline, simplified before widening.

    Simplifying first matters for the same reason it does for surface roads:
    a narrow class widened to the printability floor keeps corners far tighter
    than its new width can turn through.
    """
    half_width_m = _half_width_m(piece, transform, settings)
    return _metric_ring_to_model(
        densify_polyline(
            simplify_polyline(piece.points, half_width_m * 2.0),
            drape_spacing_m * 2.0,
        ),
        transform,
    )


def _stands_over_open_water(centerline, heightfield) -> bool:
    """Whether any point of a model-space deck centerline is over cut water.

    Sampled finely enough to resolve a creek narrower than the centerline's
    own vertex spacing, the same way the causeway corridors are found.
    """
    if getattr(heightfield, "void_mask", None) is None or not hasattr(
        heightfield, "over_open_water"
    ):
        return False
    dense = densify_polyline(centerline, max(0.5, heightfield.cell_size_mm * 0.25))
    return any(heightfield.over_open_water(x, y) for x, y in dense)


def _on_boundary(point, bounds, tolerance: float) -> bool:
    """Whether a model-space point lies on the selection rectangle's edge."""
    x, y = point
    return (
        x - bounds.min_x_mm <= tolerance
        or bounds.max_x_mm - x <= tolerance
        or y - bounds.min_y_mm <= tolerance
        or bounds.max_y_mm - y <= tolerance
    )


def _solve_deck_heights(
    decks: List[Tuple[SubSegment, List[Tuple[float, float]]]],
    surface_pieces: Iterable[SubSegment],
    transform,
    heightfield,
    settings: RoadSettings,
    counts: RoadCounts,
) -> Tuple[List[List[float]], Set[int]]:
    """Solve every deck's top profile together; see :mod:`deck_graph`.

    Returns one height per centerline vertex for each deck, plus the indices
    of the decks that never rise a printed layer above the road surface,
    which the caller builds as ordinary roads instead.
    """
    scale_x = transform.scale_x_mm_per_m
    scale_y = transform.scale_y_mm_per_m
    blocked: Set = set()
    roads = SegmentIndex(max(2.0, settings.maximum_width_mm * 4.0))
    for piece in surface_pieces:
        model = [(east * scale_x, north * scale_y) for east, north in piece.points]
        blocked.add(node_key(model[0]))
        blocked.add(node_key(model[-1]))
        roads.add_polyline(model, piece.road_class)
    ground = getattr(heightfield, "ground_height_mm", heightfield.height_mm)
    # A deck the selection rectangle cut through goes on past the edge; its
    # end there is the only kind of loose end allowed to stay in the air.
    model = transform.model_bounds
    open_ends: Set = set()
    for _piece, centerline in decks:
        for point in (centerline[0], centerline[-1]):
            if _on_boundary(point, model, BOUNDARY_TOLERANCE_MM):
                open_ends.add(node_key(point))
    solution = solve_deck_network(
        [centerline for _piece, centerline in decks],
        [piece.level for piece, _centerline in decks],
        [_half_width_m(piece, transform, settings) * scale_x for piece, _centerline in decks],
        heightfield.height_mm,
        ground,
        blocked,
        roads,
        settings.maximum_width_mm * 0.5,
        settings.road_thickness_mm,
        settings.bridge_deck_thickness_mm,
        settings.bridge_clearance_mm,
        settings.bridge_maximum_grade,
        settings.bridge_minimum_lift_mm,
        open_ends=open_ends,
    )
    counts.bridge_components = solution.components
    counts.bridge_anchored_ends = solution.anchors
    counts.bridge_touchdown_ends = solution.touchdowns
    counts.bridge_open_ends = solution.open_ends
    counts.bridge_stacked_crossings = solution.stacked_constraints
    counts.bridge_road_crossing_components = solution.road_crossing_components
    counts.bridge_span_adapted_components = solution.span_adapted_components
    # A deck standing over the cut water is a deck because the water is
    # there, whatever its lift: built as a road it would hang in the opening.
    # That covers a crossing recovered from the water and a flagged bridge
    # whose ends now touch down on banks barely above the water level; the
    # whole component is kept so its joints stay at one height.
    protected = {
        solution.deck_components[index]
        for index, (piece, centerline) in enumerate(decks)
        if piece.evidence == EVIDENCE_CROSSING
        or _stands_over_open_water(centerline, heightfield)
    }
    demoted = {
        index
        for index in solution.demoted
        if solution.deck_components[index] not in protected
    }
    counts.bridge_decks_demoted = len(demoted)
    for index in demoted:
        piece = decks[index][0]
        key = f"{piece.road_class}/{piece.evidence}"
        counts.demoted[key] = counts.demoted.get(key, 0) + 1
    return solution.heights, demoted


def generate_roads(
    segment_features: Iterable[Dict[str, Any]],
    transform,
    heightfield,
    surface_collection,
    bridge_collection,
    support_collection,
    materials: Dict[str, Any],
    settings: RoadSettings | None = None,
    progress_callback=None,
    ground_support=None,
) -> Dict[str, Any]:
    """Generate surface roads, bridge decks, bridge supports, and causeways.

    *ground_support* is the :class:`~jarvizar_city_model.geometry.support.SupportBuilder`
    that keeps terrain under decks standing over cut water.  Without it, piers
    over the opening are dropped as before.
    """
    settings = settings or RoadSettings()
    counts = RoadCounts()

    surface_builders: Dict[str, MeshBuilder] = {}
    bridge_builders: Dict[str, MeshBuilder] = {}
    support_builder = MeshBuilder("BRIDGE_SUPPORTS")

    thickness = float(settings.road_thickness_mm)
    embed = float(settings.road_embed_mm)
    deck_thickness = float(settings.bridge_deck_thickness_mm)
    drape_spacing_m = max(
        settings.drape_spacing_mm / max(transform.scale_x_mm_per_m, 1.0e-12), 0.5
    )
    support_spacing_mm = settings.bridge_support_spacing_m * transform.scale_x_mm_per_m
    support_exclusion_mm = (
        settings.bridge_support_end_exclusion_m * transform.scale_x_mm_per_m
    )
    # Where the cut is in force, the ground for draping is the nearest land
    # that survived; a riverside road with a few vertices over the water then
    # keeps the bank's grade instead of dipping to a bed that is not printed.
    if ground_support is not None and settings.support_over_water:
        heightfield = ground_support.structure_heightfield
    ground_height = getattr(heightfield, "ground_height_mm", heightfield.height_mm)

    pieces = list(_subsegments(segment_features, transform, settings, counts))
    pieces = _recover_crossings(pieces, transform, heightfield, settings, counts)

    decks: List[Tuple[SubSegment, List[Tuple[float, float]]]] = []
    surface: List[SubSegment] = []
    for piece in pieces:
        if _is_deck(piece, settings):
            decks.append((piece, _deck_centerline(piece, transform, settings, drape_spacing_m)))
        else:
            surface.append(piece)

    deck_heights, demoted = _solve_deck_heights(
        decks, surface, transform, heightfield, settings, counts
    )
    # A flagged piece that cannot rise a printed layer at the allowed grade
    # is a bump, not a bridge: it is built as the road it continues.
    for index in sorted(demoted):
        surface.append(decks[index][0])

    # Supplemental low supports must leave the road/rail opening clear. This
    # index affects only new supports; established interchange piers keep
    # their placement. Use each crossing road's actual printed width.
    support_obstacles = SegmentIndex(max(2.0, settings.maximum_width_mm * 4.0))
    obstacle_width = 0.0
    for piece in surface:
        width = _half_width_m(piece, transform, settings) * transform.scale_x_mm_per_m
        obstacle_width = max(obstacle_width, width)
        line = _metric_ring_to_model(piece.points, transform)
        support_obstacles.add_polyline(line, width)

    lower_decks = SegmentIndex(support_obstacles.cell_size)
    for deck, ((piece, line), profile) in enumerate(zip(decks, deck_heights)):
        if deck in demoted:
            continue
        width = _half_width_m(piece, transform, settings) * transform.scale_x_mm_per_m
        for a, b, za, zb in zip(line, line[1:], profile, profile[1:]):
            lower_decks.add_segment(a, b, (deck, width, za, zb))

    total = max(1, len(pieces))
    progress_index = 0

    def tick():
        nonlocal progress_index
        progress_index += 1
        if progress_callback is not None and progress_index % 64 == 0:
            progress_callback(progress_index / total)

    def has_no_ground(x: float, y: float) -> bool:
        if hasattr(heightfield, "has_ground"):
            return not heightfield.has_ground(x, y)
        return heightfield.is_void(x, y)

    def foundation_height(x: float, y: float) -> float:
        height = heightfield.height_mm(x, y)
        # Over cut water the printed causeway is below the sampled field.
        # Even a deck resting at field height still has that gap beneath it.
        if ground_support is not None and heightfield.in_cut_water(x, y):
            return max(height - ground_support.top_offset_mm, ground_support.bottom_z + 0.05)
        if ground_support is not None:
            physical = ground_support.heightfield.height_mm(x, y)
            if physical < height - 1e-6:
                if ground_support.heightfield.is_supported(x, y):
                    return max(height - ground_support.top_offset_mm, ground_support.bottom_z + 0.05)
                return physical
        return height

    for index, ((piece, centerline), heights) in enumerate(zip(decks, deck_heights)):
        if index in demoted:
            tick()
            continue
        half_width_mm = _half_width_m(piece, transform, settings) * transform.scale_x_mm_per_m
        builder = bridge_builders.setdefault(
            piece.road_class, MeshBuilder(f"BRIDGE_{piece.road_class}")
        )
        if not add_bridge_deck(builder, centerline, half_width_mm, heights, deck_thickness):
            counts.rejected_geometry += 1
            tick()
            continue
        counts.bridge_decks += 1
        counts.classes[piece.road_class] = counts.classes.get(piece.road_class, 0) + 1
        counts.evidence[piece.evidence] = counts.evidence.get(piece.evidence, 0) + 1

        # Retain ground below mapped decks over shallow basins too. Use the
        # deck's printed outline, including its width at the shoreline.
        if ground_support is not None and settings.support_over_water:
            if offset_is_safe(centerline, half_width_mm):
                ring, _parameters = parametric_ribbon(centerline, half_width_mm)
                basin_rings = [ring] if ring else []
            else:
                basin_rings = buffer_polyline_convex_pieces(
                    centerline, half_width_mm, arc_segments=4, epsilon=EPSILON)
            for ring in basin_rings:
                if ground_support.overlaps_basin([ring]):
                    ground_support.footprint([ring], "bridge_causeway")

        # The causeway is built before the piers are placed, so a pier station
        # over the water finds ground under it.
        if (
            ground_support is not None
            and settings.support_over_water
            and getattr(heightfield, "void_mask", None) is not None
        ):
            # The deck centerline is only as dense as draping needs; the
            # water's edge has to be found more finely than that, or the
            # causeway could stop short of the bank.
            corridor_line = densify_polyline(
                centerline, max(0.5, heightfield.cell_size_mm * 0.25)
            )
            for corridor in open_water_corridors(
                corridor_line, heightfield.over_open_water, settings.causeway_overlap_mm
            ):
                if ground_support.corridor(
                    corridor, half_width_mm + settings.causeway_margin_mm, "bridge_causeway"
                ):
                    counts.bridge_causeways += 1

        positions = cumulative_positions(centerline)
        minimum_half_size = settings.bridge_support_minimum_size_mm * 0.5
        support_radius = math.hypot(
            max(half_width_mm * 0.35, minimum_half_size),
            max(half_width_mm, minimum_half_size),
        )

        def obstructed(station):
            point, _direction = point_and_direction(centerline, positions, station)
            if any(distance <= support_radius + width
                   for distance, width, _t in support_obstacles.within(
                       point, support_radius + obstacle_width)):
                return True
            underside = interpolate_profile(positions, heights, station) - deck_thickness
            return any(other != index and distance <= support_radius + width
                       and za + (zb - za) * t < underside
                       for distance, (other, width, za, zb), t in lower_decks.within(
                           point, support_radius + settings.maximum_width_mm * 0.5))

        counts.bridge_supports += add_bridge_supports(
            support_builder,
            centerline,
            heights,
            foundation_height,
            half_width_mm,
            deck_thickness,
            support_spacing_mm,
            support_exclusion_mm,
            settings.bridge_minimum_support_height_mm,
            embed,
            has_no_ground,
            settings.bridge_support_minimum_size_mm,
            is_obstructed=obstructed,
        )
        tick()

    for piece in surface:
        if _is_over_open_water(piece.points, transform, heightfield):
            # Only reachable with bridges disabled or below the minimum span:
            # a ribbon with no ground anywhere under it is left out rather
            # than hung across the opening.
            counts.skipped_over_void += 1
            tick()
            continue
        half_width_m = _half_width_m(piece, transform, settings)
        simplified = simplify_polyline(piece.points, half_width_m * 2.0)
        densified = densify_polyline(simplified, drape_spacing_m)
        # Minor classes are widened to the printability floor while keeping
        # their metre-scale zigzags, so their corners can be too tight to
        # offset into one simple ring.  Those fall back to overlapping
        # convex pieces, which stay closed where a folded ring would not.
        if offset_is_safe(densified, half_width_m):
            rings = [
                buffer_polyline(
                    densified,
                    half_width_m,
                    arc_segments=settings.arc_segments,
                    epsilon=1.0e-6,
                )
            ]
        else:
            rings = buffer_polyline_convex_pieces(
                densified,
                half_width_m,
                arc_segments=settings.arc_segments,
                epsilon=1.0e-6,
            )
            counts.decomposed_ribbons += 1

        builder = surface_builders.setdefault(
            piece.road_class, MeshBuilder(f"ROAD_{piece.road_class}")
        )
        added = False
        model_rings = []
        for ring in filter(None, rings):
            # The ring is buffered in metres but printed in millimetres,
            # and the scale factor is roughly 1/30000.  Vertices safely
            # apart in metres can collapse once scaled, so the ring must be
            # re-cleaned at the tolerance of the frame it ends up in;
            # otherwise degenerate triangles are dropped and leave open caps.
            model_ring = oriented_ring(
                _metric_ring_to_model(ring, transform),
                counter_clockwise=True,
                epsilon=EPSILON,
            )
            if not model_ring:
                continue
            model_rings.append(model_ring)
        minimum_ground = None
        if ground_support is not None and settings.support_over_water:
            minimum_ground = max((z for ring in model_rings
                                  if (z := ground_support.minimum_ground([ring], 'road')) is not None),
                                 default=None)

        def road_ground(x, y):
            height = ground_height(x, y)
            return max(height, minimum_ground) if minimum_ground is not None else height

        def draped(x, y):
            height = road_ground(x, y)
            return height - embed, height + thickness

        for model_ring in model_rings:
            prism = [
                (x, y, height - embed, height + thickness)
                for x, y, height in (
                    (x, y, road_ground(x, y)) for x, y in model_ring
                )
            ]
            # A triangulator may span a run of ring vertices with one long
            # triangle; refining to the drape spacing keeps the ribbon on the
            # ground along its whole length, not only at its vertices.
            if builder.add_prism([prism], refine=(settings.drape_spacing_mm, draped)):
                added = True
                if (ground_support is not None and settings.support_over_water
                        and (minimum_ground is not None or ground_support.overlaps_basin([model_ring]))):
                    ground_support.footprint([model_ring], "road", minimum_ground=minimum_ground)
        if added:
            counts.surface_roads += 1
            counts.classes[piece.road_class] = (
                counts.classes.get(piece.road_class, 0) + 1
            )
        else:
            counts.rejected_geometry += 1
        tick()

    for road_class, builder in sorted(surface_builders.items()):
        obj = builder.build(surface_collection, materials.get("road"))
        if obj is not None:
            obj["feature_type"] = "surface_road"
            obj["road_class"] = road_class
            obj["source"] = "Overture transportation/segment"

    for road_class, builder in sorted(bridge_builders.items()):
        obj = builder.build(bridge_collection, materials.get("bridge"))
        if obj is not None:
            obj["feature_type"] = "bridge_deck"
            obj["road_class"] = road_class
            obj["bridge_evidence"] = ", ".join(
                f"{key}: {value}" for key, value in sorted(counts.evidence.items())
            )
            obj["source"] = "Overture transportation/segment"

    support_object = support_builder.build(
        support_collection, materials.get("bridge_support")
    )
    if support_object is not None:
        support_object["feature_type"] = "bridge_support"
        support_object["support_placement_source"] = "derived_spacing"

    if progress_callback is not None:
        progress_callback(1.0)
    return counts.as_dict()
