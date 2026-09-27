"""Linear geometry helpers and Overture linear-referencing rule resolution.

Overture scopes many transportation properties to a portion of a segment using
``between: [start, end]`` normalized positions.  A correct importer must split
each centerline at the union of *all* rule boundaries before resolving width,
flags, or level, otherwise a partial bridge or a partial width change is
silently lost.

Every function here is pure and Blender-free.  Callers project WGS84
coordinates into the shared local metric frame first, so positions along a
polyline are measured in real metres rather than degrees.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, Iterable, List, Mapping, Sequence, Tuple

from .geojson import positive_number


Point = Tuple[float, float]

# Overture road classes with no explicit width_rules still need a printable
# width.  These are conservative edge-to-edge carriageway estimates in metres,
# chosen to read correctly at miniature scale rather than to be survey-accurate.
DEFAULT_ROAD_WIDTH_M: Dict[str, float] = {
    "motorway": 14.0,
    "trunk": 12.0,
    "primary": 11.0,
    "secondary": 9.5,
    "tertiary": 8.0,
    "residential": 6.5,
    "living_street": 5.5,
    "unclassified": 6.0,
    "service": 4.5,
    "pedestrian": 4.0,
    "footway": 2.0,
    "sidewalk": 2.0,
    "crosswalk": 2.5,
    "steps": 1.6,
    "path": 1.5,
    "track": 3.0,
    "cycleway": 2.0,
    "bridleway": 2.0,
    "driveway": 3.0,
    "parking_aisle": 3.5,
    "alley": 3.5,
    "unknown": 5.0,
}
FALLBACK_ROAD_WIDTH_M = 5.0

# Rail is a separate Overture subtype whose classes (standard_gauge, tram,
# funicular) carry no width rules at all.  One modest default reads correctly
# as track at miniature scale, and every rail piece is batched under this one
# class name so it stays a single object in the scene.
RAIL_CLASS = "rail"
RAIL_WIDTH_M = 4.0

# The scoped rule fields that can split a segment.  Roads flag bridges and
# tunnels in ``road_flags``; rail carries the same evidence in ``rail_flags``.
# Reading only the road field is how a railway bridge across a river came out
# as ordinary track draped into the water.
FLAG_FIELDS = ("road_flags", "rail_flags")
RULE_FIELDS = FLAG_FIELDS + ("width_rules", "level_rules", "subclass_rules")

# Pedestrian geometry mapped alongside a street rather than as a route of its
# own: the pavement on each side and the crossings at each corner.  Overture
# carries them as the subclass of a footway or cycleway.  On a miniature they
# triple the ribbons along every street without adding a route that was not
# already there, which is the density that made a downtown grid unreadable.
SIDEPATH_SUBCLASSES = frozenset({"sidewalk", "crosswalk", "cycle_crossing"})

# Pedestrian-scale classes.  They are real geometry, but a miniature usually
# wants them optional because they dominate the generated object count.
MINOR_ROAD_CLASSES = frozenset(
    {
        "footway",
        "sidewalk",
        "crosswalk",
        "steps",
        "path",
        "track",
        "cycleway",
        "bridleway",
    }
)


@dataclass(frozen=True)
class SubSegment:
    """One centerline piece over which every resolved rule value is constant."""

    source_id: str
    points: Tuple[Point, ...]
    start_t: float
    end_t: float
    road_class: str
    subclass: str
    width_m: float
    width_source: str
    flags: FrozenSet[str]
    level: int
    # Why this piece is (or is not) a bridge.  Overture's flag is the primary
    # evidence; a crossing of cut-out water recovered by the generator records
    # that instead, so the audit trail on the object stays truthful.
    evidence: str = "road_flags.is_bridge"

    @property
    def is_bridge(self) -> bool:
        return "is_bridge" in self.flags

    @property
    def is_tunnel(self) -> bool:
        return "is_tunnel" in self.flags


def linestring_coordinates(geometry: Mapping[str, Any]) -> List[Tuple[float, float]]:
    """Return ``[(lon, lat), ...]`` for a LineString, or ``[]`` for anything else."""
    if geometry.get("type") != "LineString":
        return []
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list):
        return []
    result = []
    for item in coordinates:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            try:
                result.append((float(item[0]), float(item[1])))
            except (TypeError, ValueError):
                continue
    return result


def polyline_length(points: Sequence[Point]) -> float:
    return sum(
        math.dist(points[index], points[index + 1]) for index in range(len(points) - 1)
    )


def cumulative_positions(points: Sequence[Point]) -> List[float]:
    """Return the normalized distance along *points* for each vertex."""
    if len(points) < 2:
        return [0.0] * len(points)
    distances = [0.0]
    total = 0.0
    for index in range(len(points) - 1):
        total += math.dist(points[index], points[index + 1])
        distances.append(total)
    if total <= 0.0:
        return [0.0] * len(points)
    return [value / total for value in distances]


def interpolate_at(
    points: Sequence[Point], positions: Sequence[float], t: float
) -> Point:
    """Return the point at normalized position *t* along the polyline."""
    if not points:
        raise ValueError("points must not be empty")
    if len(points) == 1:
        return points[0]
    if t <= positions[0]:
        return points[0]
    if t >= positions[-1]:
        return points[-1]
    for index in range(len(positions) - 1):
        start, end = positions[index], positions[index + 1]
        if start <= t <= end:
            span = end - start
            factor = 0.0 if span <= 0.0 else (t - start) / span
            ax, ay = points[index]
            bx, by = points[index + 1]
            return (ax + (bx - ax) * factor, ay + (by - ay) * factor)
    return points[-1]


def slice_polyline(points: Sequence[Point], t0: float, t1: float) -> List[Point]:
    """Return the polyline portion between two normalized positions."""
    if len(points) < 2 or t1 <= t0:
        return []
    positions = cumulative_positions(points)
    result = [interpolate_at(points, positions, t0)]
    for point, position in zip(points, positions):
        if t0 < position < t1:
            result.append(point)
    result.append(interpolate_at(points, positions, t1))
    return dedupe_points(result)


def dedupe_points(points: Sequence[Point], tolerance: float = 1.0e-9) -> List[Point]:
    clean: List[Point] = []
    for point in points:
        if not clean or math.dist(point, clean[-1]) > tolerance:
            clean.append(point)
    return clean


def _rules(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _between(rule: Mapping[str, Any]) -> Tuple[float, float]:
    """Return the rule's normalized span, defaulting to the whole segment."""
    span = rule.get("between")
    if not isinstance(span, (list, tuple)) or len(span) != 2:
        return 0.0, 1.0
    try:
        start, end = float(span[0]), float(span[1])
    except (TypeError, ValueError):
        return 0.0, 1.0
    if not (math.isfinite(start) and math.isfinite(end)) or end <= start:
        return 0.0, 1.0
    return max(0.0, start), min(1.0, end)


def collect_boundaries(
    properties: Mapping[str, Any], fields: Iterable[str]
) -> List[float]:
    """Return the sorted union of all scoped-rule boundaries, including 0 and 1."""
    boundaries = {0.0, 1.0}
    for field in fields:
        for rule in _rules(properties.get(field)):
            if rule.get("between") is None:
                continue
            start, end = _between(rule)
            boundaries.add(start)
            boundaries.add(end)
    ordered = sorted(value for value in boundaries if 0.0 <= value <= 1.0)
    # Collapse boundaries that would otherwise create zero-length pieces.
    collapsed = [ordered[0]]
    for value in ordered[1:]:
        if value - collapsed[-1] > 1.0e-9:
            collapsed.append(value)
    return collapsed


def _covers(rule: Mapping[str, Any], midpoint: float) -> bool:
    """Whether the rule's scope contains *midpoint*."""
    start, end = _between(rule)
    return start - 1.0e-9 <= midpoint <= end + 1.0e-9


def active_rule(rules: Any, midpoint: float) -> Dict[str, Any] | None:
    """Return the first rule whose scope contains *midpoint*."""
    for rule in _rules(rules):
        if _covers(rule, midpoint):
            return rule
    return None


def active_flag_values(rules: Any, midpoint: float) -> FrozenSet[str]:
    """Return the union of ``values`` from every rule active at *midpoint*."""
    active = set()
    for rule in _rules(rules):
        if not _covers(rule, midpoint):
            continue
        values = rule.get("values")
        if isinstance(values, str):
            active.add(values)
        elif isinstance(values, list):
            active.update(str(item) for item in values if isinstance(item, str))
    return frozenset(active)


def resolve_width_m(
    properties: Mapping[str, Any],
    midpoint: float,
    road_class: str,
    class_defaults: Mapping[str, float] | None = None,
) -> Tuple[float, str]:
    """Apply the documented width precedence: explicit rule, then class default."""
    rule = active_rule(properties.get("width_rules"), midpoint)
    if rule is not None:
        explicit = positive_number(rule.get("value"))
        if explicit is not None:
            return explicit, "width_rules"
    defaults = DEFAULT_ROAD_WIDTH_M if class_defaults is None else class_defaults
    return float(defaults.get(road_class, FALLBACK_ROAD_WIDTH_M)), "class_default"


def printable_width_m(
    width_m: float,
    minimum_mm: float,
    maximum_mm: float,
    scale_mm_per_m: float,
) -> float:
    """Clamp a real width into the printable band, in metres.

    Below the minimum a ribbon is thinner than the slicer can lay down, so it
    is widened.  Above the maximum a motorway at true scale reads as a runway
    next to the streets around it on a miniature, so it is narrowed; the
    hierarchy of classes is kept below the cap and flattened at it.
    """
    scale = max(scale_mm_per_m, 1.0e-12)
    low = minimum_mm / scale
    high = maximum_mm / scale if maximum_mm and maximum_mm > 0.0 else float("inf")
    if high < low:
        high = low
    return min(max(float(width_m), low), high)


def resolve_level(properties: Mapping[str, Any], midpoint: float) -> int:
    rule = active_rule(properties.get("level_rules"), midpoint)
    if rule is None:
        return 0
    value = rule.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if not math.isfinite(float(value)):
        return 0
    return int(value)


def split_segment(
    source_id: str,
    points: Sequence[Point],
    properties: Mapping[str, Any],
    class_defaults: Mapping[str, float] | None = None,
    road_class: str | None = None,
) -> List[SubSegment]:
    """Split one projected centerline at every scoped-rule boundary.

    *road_class* overrides the feature's own class.  Rail uses it to batch
    every track class under one name while still being split at its scoped
    ``rail_flags`` and ``level_rules`` like a road.
    """
    points = dedupe_points(points)
    if len(points) < 2 or polyline_length(points) <= 0.0:
        return []

    if road_class is None:
        road_class = str(properties.get("class") or "unknown")
    boundaries = collect_boundaries(properties, RULE_FIELDS)
    # Road and rail flags are one rule list for resolution purposes.
    flag_rules = [rule for field in FLAG_FIELDS for rule in _rules(properties.get(field))]
    results: List[SubSegment] = []
    for index in range(len(boundaries) - 1):
        start, end = boundaries[index], boundaries[index + 1]
        midpoint = (start + end) * 0.5
        piece = slice_polyline(points, start, end)
        if len(piece) < 2:
            continue
        width_m, width_source = resolve_width_m(
            properties, midpoint, road_class, class_defaults
        )
        subclass_rule = active_rule(properties.get("subclass_rules"), midpoint)
        subclass = str(
            (subclass_rule or {}).get("value") or properties.get("subclass") or ""
        )
        results.append(
            SubSegment(
                source_id=source_id,
                points=tuple(piece),
                start_t=start,
                end_t=end,
                road_class=road_class,
                subclass=subclass,
                width_m=width_m,
                width_source=width_source,
                flags=active_flag_values(flag_rules, midpoint),
                level=resolve_level(properties, midpoint),
            )
        )
    return results


def split_polyline_at_distances(
    points: Sequence[Point], distances: Sequence[float]
) -> List[List[Point]]:
    """Cut a polyline at the given distances along it, returning the pieces.

    Distances are measured from the start in the polyline's own units; ones
    outside ``(0, length)`` and duplicates are ignored.  Consecutive pieces
    share their cut vertex, which is what lets a deck and the road it grows out
    of meet exactly.
    """
    points = dedupe_points(points)
    if len(points) < 2:
        return [list(points)] if points else []
    total = polyline_length(points)
    cuts = sorted({d for d in distances if 1.0e-9 < d < total - 1.0e-9})
    if not cuts:
        return [list(points)]

    pieces: List[List[Point]] = []
    current: List[Point] = [points[0]]
    travelled = 0.0
    cut_index = 0
    for index in range(len(points) - 1):
        a, b = points[index], points[index + 1]
        span = math.dist(a, b)
        while cut_index < len(cuts) and cuts[cut_index] <= travelled + span:
            factor = (cuts[cut_index] - travelled) / span if span > 0.0 else 0.0
            cut = (a[0] + (b[0] - a[0]) * factor, a[1] + (b[1] - a[1]) * factor)
            current.append(cut)
            pieces.append(dedupe_points(current))
            current = [cut]
            cut_index += 1
        current.append(b)
        travelled += span
    pieces.append(dedupe_points(current))
    return [piece for piece in pieces if len(piece) >= 2]


def clip_polyline_to_rectangle(
    points: Sequence[Point],
    min_x: float,
    min_y: float,
    max_x: float,
    max_y: float,
) -> List[List[Point]]:
    """Clip a polyline to an axis-aligned rectangle, returning contiguous pieces.

    Overture's bbox filter returns intersecting features rather than clipped
    features, so centerlines routinely leave the requested rectangle.
    """
    if len(points) < 2:
        return []

    pieces: List[List[Point]] = []
    current: List[Point] = []
    for index in range(len(points) - 1):
        clipped = _clip_edge(
            points[index], points[index + 1], min_x, min_y, max_x, max_y
        )
        if clipped is None:
            if len(current) >= 2:
                pieces.append(current)
            current = []
            continue
        start, end = clipped
        if not current:
            current = [start, end]
        elif math.dist(current[-1], start) <= 1.0e-9:
            current.append(end)
        else:
            if len(current) >= 2:
                pieces.append(current)
            current = [start, end]
    if len(current) >= 2:
        pieces.append(current)

    result = []
    for piece in pieces:
        clean = dedupe_points(piece)
        if len(clean) >= 2:
            result.append(clean)
    return result


def _clip_edge(a: Point, b: Point, min_x, min_y, max_x, max_y):
    """Liang-Barsky clip of one edge, or ``None`` when fully outside."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    t0, t1 = 0.0, 1.0
    for direction, difference in (
        (-dx, a[0] - min_x),
        (dx, max_x - a[0]),
        (-dy, a[1] - min_y),
        (dy, max_y - a[1]),
    ):
        if abs(direction) <= 1.0e-12:
            if difference < 0.0:
                return None
            continue
        factor = difference / direction
        if direction < 0.0:
            if factor > t1:
                return None
            t0 = max(t0, factor)
        else:
            if factor < t0:
                return None
            t1 = min(t1, factor)
    if t1 < t0:
        return None
    return (
        (a[0] + dx * t0, a[1] + dy * t0),
        (a[0] + dx * t1, a[1] + dy * t1),
    )


def simplify_polyline(points: Sequence[Point], minimum_spacing_m: float) -> List[Point]:
    """Drop vertices closer than *minimum_spacing_m*, always keeping both ends.

    Offsetting a centerline whose vertex spacing is smaller than half the road
    width produces self-intersecting inner corners.  Thinning first is cheaper
    and far more robust than repairing the offset ring afterwards.
    """
    points = dedupe_points(points)
    if len(points) < 3 or minimum_spacing_m <= 0.0:
        return list(points)
    result = [points[0]]
    for point in points[1:-1]:
        if math.dist(point, result[-1]) >= minimum_spacing_m:
            result.append(point)
    result.append(points[-1])
    if len(result) >= 3 and math.dist(result[-1], result[-2]) < minimum_spacing_m * 0.5:
        # Avoid leaving a very short final span beside the retained endpoint.
        del result[-2]
    return result


def densify_polyline(points: Sequence[Point], maximum_spacing_m: float) -> List[Point]:
    """Insert vertices so no span exceeds *maximum_spacing_m*.

    Terrain draping samples elevation per vertex, so long spans must be
    subdivided before a road can follow a hillside.
    """
    points = dedupe_points(points)
    if len(points) < 2 or maximum_spacing_m <= 0.0:
        return list(points)
    result = [points[0]]
    for index in range(len(points) - 1):
        a, b = points[index], points[index + 1]
        distance = math.dist(a, b)
        steps = max(1, int(math.ceil(distance / maximum_spacing_m)))
        for step in range(1, steps + 1):
            factor = step / steps
            result.append(
                (a[0] + (b[0] - a[0]) * factor, a[1] + (b[1] - a[1]) * factor)
            )
    return dedupe_points(result)
