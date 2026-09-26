"""Building selection and vertical-profile logic.

The pure functions in this module deliberately do not import Blender.  Mesh
creation lives in :mod:`jarvizar_city_model.blender.mesh_utils`.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import re
from typing import Any, Dict, List, Mapping, Sequence, Set, Tuple

from ..data.geojson import feature_id, feature_properties, geometry_polygons, positive_number
from .planar import (
    effective_width,
    interior_grid_points,
    point_in_polygon,
    polygon_area,
    ring_bounds,
    signed_area,
)

# A building without parts whose footprint is at least this fraction inside
# another building's parts is that building's outline published twice.  On the
# sample bbox every such case is covered completely; the margin only absorbs
# vertices that differ by a survey's width.
DUPLICATE_COVERAGE = 0.9
# Two partless footprints that each cover this much of the other are one
# building mapped twice.
MUTUAL_COVERAGE = 0.85


# How tall a building of each Overture class is when the source says nothing.
#
# Without this every heightless feature gets one number, and on a downtown
# selection that is around a third of them: a stadium, a parking deck and a
# garden shed all come out the same height.  The values below are ordinary
# real-world heights for the class, in metres, and they are only ever a
# fallback -- an explicit height or floor count always wins.
CLASS_DEFAULT_HEIGHT_M: Dict[str, float] = {
    # Venues.  A seating bowl is low for its footprint but never one storey.
    "stadium": 30.0,
    "grandstand": 12.0,
    "sports_centre": 12.0,
    "sports_hall": 12.0,
    "pavilion": 6.0,
    "riding_hall": 10.0,
    # Housing.
    "house": 7.0,
    "detached": 7.0,
    "semidetached_house": 7.0,
    "terrace": 9.0,
    "bungalow": 4.0,
    "cabin": 4.0,
    "static_caravan": 3.0,
    "houseboat": 4.0,
    "apartments": 18.0,
    "residential": 12.0,
    "dormitory": 15.0,
    "hotel": 20.0,
    # Work and trade.
    "office": 20.0,
    "commercial": 12.0,
    "retail": 8.0,
    "supermarket": 8.0,
    "kiosk": 3.0,
    "industrial": 10.0,
    "warehouse": 10.0,
    "factory": 12.0,
    "hangar": 12.0,
    # Civic and institutional.
    "civic": 12.0,
    "public": 12.0,
    "government": 15.0,
    "hospital": 20.0,
    "school": 10.0,
    "college": 12.0,
    "university": 15.0,
    "kindergarten": 6.0,
    "museum": 14.0,
    "fire_station": 8.0,
    # Religious.
    "cathedral": 35.0,
    "church": 20.0,
    "chapel": 9.0,
    "mosque": 15.0,
    "synagogue": 14.0,
    "temple": 12.0,
    "religious": 12.0,
    # Transport and infrastructure.
    "parking": 15.0,
    "garage": 3.0,
    "garages": 3.0,
    "carport": 3.0,
    "train_station": 15.0,
    "transportation": 10.0,
    "water_tower": 30.0,
    "silo": 15.0,
    "storage_tank": 12.0,
    "service": 4.0,
    # Small structures.  A mapped roof is a canopy, not a floor.
    "roof": 4.0,
    "shed": 3.0,
    "hut": 3.0,
    "greenhouse": 4.0,
    "barn": 8.0,
    "farm": 8.0,
    "farm_auxiliary": 5.0,
    "outbuilding": 3.0,
    "container": 3.0,
}


@dataclass(frozen=True)
class VerticalProfile:
    """Where a mass starts and stops, in real metres above local ground.

    Overture reports ``height`` as the distance from the ground to the highest
    point of the feature, and ``min_height`` as the level the feature starts
    at, so a mass spans ``bottom_m`` to ``top_m`` and is ``thickness_m`` tall.
    Reading ``height`` as a thickness stacked on top of ``min_height`` instead
    is what turns a tower's crown section into a spire twice the height of the
    tower it sits on.
    """

    bottom_m: float
    top_m: float
    height_source: str
    min_height_source: str

    @property
    def thickness_m(self) -> float:
        return self.top_m - self.bottom_m

    @property
    def height_m(self) -> float:
        """The source's own height: ground to the top of the mass."""
        return self.top_m


@dataclass(frozen=True)
class BuildingSelection:
    buildings: Tuple[Dict[str, Any], ...]
    parts: Tuple[Dict[str, Any], ...]
    suppressed_parent_ids: frozenset
    duplicate_ids: frozenset = frozenset()


def _nonnegative_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0.0 else None


def length_metres(value: Any) -> float | None:
    """Read numeric Overture metres or an explicitly unit-tagged OSM length.

    Never strip a unit and accidentally treat feet as metres. Ambiguous lists
    and malformed values remain missing; they are not guessed.
    """
    number = _nonnegative_number(value)
    if number is not None:
        return number
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(m|metres|meters|ft|feet)\s*", value)
    if match:
        return float(match[1]) * (0.3048 if match[2] in ("ft", "feet") else 1.0)
    match = re.fullmatch(r'''\s*(\d+)'\s*(\d+(?:\.\d+)?)?"?\s*''', value)
    if match:
        return float(match[1]) * 0.3048 + float(match[2] or 0) * 0.0254
    return None


def class_default_height_m(
    properties: Mapping[str, Any], fallback_m: float
) -> Tuple[float, str]:
    """Return the fallback height for a feature's class, and where it came from."""
    for field in ("class", "subtype"):
        name = str(properties.get(field) or "").strip().lower()
        default = CLASS_DEFAULT_HEIGHT_M.get(name)
        if default is not None:
            return default, f"class_default:{name}"
    return fallback_m, "default"


def resolve_vertical_profile(
    properties: Mapping[str, Any], floor_height_m: float, default_height_m: float
) -> VerticalProfile:
    """Apply the documented, deterministic Overture height fallback chain.

    Both ``height`` and ``num_floors`` describe the whole feature measured from
    the ground, so each resolves to the *top* of the mass rather than to a
    thickness. Contradictory intervals remain invalid and are skipped by the
    generator. Never manufacture a new top above a suspect min_height.
    """
    explicit_height = positive_number(length_metres(properties.get("height")))
    floor_count = positive_number(properties.get("num_floors", properties.get("building:levels")))
    if explicit_height is not None:
        top_m = explicit_height
        height_source = "height"
    elif floor_count is not None:
        top_m = floor_count * floor_height_m
        height_source = "num_floors"
    else:
        top_m, height_source = class_default_height_m(properties, default_height_m)

    explicit_min_height = length_metres(properties.get("min_height"))
    min_floor = _nonnegative_number(properties.get("min_floor", properties.get("building:min_level")))
    if explicit_min_height is not None:
        bottom_m = explicit_min_height
        min_height_source = "min_height"
    elif min_floor is not None:
        bottom_m = min_floor * floor_height_m
        min_height_source = "min_floor"
    else:
        bottom_m = 0.0
        min_height_source = "ground"

    if top_m <= bottom_m:
        height_source = f"{height_source}+invalid_interval"

    return VerticalProfile(bottom_m, top_m, height_source, min_height_source)


def part_has_useful_vertical_data(feature: Mapping[str, Any]) -> bool:
    """Return whether Phase 1 can derive meaningful variable-height geometry."""
    properties = feature_properties(dict(feature))
    profile = resolve_vertical_profile(properties, 3.0, 10.0)
    return profile.thickness_m > 0.0 and profile.height_source in ("height", "num_floors")


def is_above_ground(feature: Mapping[str, Any]) -> bool:
    return feature_properties(dict(feature)).get("is_underground") is not True


def _outer_rings(feature: Mapping[str, Any]) -> List[List[Tuple[float, float]]]:
    """Every outer ring of a feature's polygon geometry, as ``(lon, lat)``."""
    rings: List[List[Tuple[float, float]]] = []
    for polygon in geometry_polygons(dict(feature).get("geometry") or {}):
        if not polygon:
            continue
        ring = [
            (float(point[0]), float(point[1]))
            for point in polygon[0]
            if isinstance(point, (list, tuple)) and len(point) >= 2
        ]
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def _bounds(rings: Sequence[Sequence[Tuple[float, float]]]):
    boxes = [ring_bounds(ring) for ring in rings]
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def footprint_admits_minimum_height(
    ring: Sequence[Tuple[float, float]], minimum_size_mm: float
) -> bool:
    """Whether a footprint is big enough to be stretched to a minimum height.

    A short mass can be raised so it reads over the roads, but only where the
    result still looks like a building.  The test is a *size* test in printed
    millimetres, and it has two halves because either one alone lets through
    the shape this is meant to avoid:

    * the footprint covers at least a ``minimum_size`` square, and
    * it is not a ribbon of that area.  A square of side S has an effective
      width -- twice area over perimeter -- of S/2, so anything thinner than
      that is a wall fragment, a covered walkway or a row of garages mapped as
      one strip.  Stretching one of those to the minimum height is exactly the
      skinny tower the threshold exists to prevent.

    A non-positive *minimum_size_mm* admits every footprint.
    """
    if minimum_size_mm <= 0.0:
        return True
    if len(ring) < 3:
        return False
    if abs(signed_area(ring)) < minimum_size_mm * minimum_size_mm:
        return False
    return effective_width(ring) >= 0.5 * minimum_size_mm


def _samples(rings: Sequence[Sequence[Tuple[float, float]]]) -> List[Tuple[float, float]]:
    """Interior sample points of the largest ring, a dozen across."""
    ring = max(rings, key=lambda r: abs(signed_area(r)))
    min_x, min_y, max_x, max_y = ring_bounds(ring)
    spacing = max(max_x - min_x, max_y - min_y) / 12.0
    if spacing <= 0.0:
        return []
    return interior_grid_points([ring], spacing, limit=200)


def _coverage(points, rings) -> float:
    if not points:
        return 0.0
    inside = sum(1 for p in points if any(point_in_polygon(p, [r]) for r in rings))
    return inside / len(points)


def _footprint_polygons(feature):
    """Polygon components with their courtyard rings, for duplicate checks."""
    polygons = []
    for polygon in geometry_polygons(feature.get("geometry") or {}):
        rings = [[(float(p[0]), float(p[1])) for p in ring
                  if isinstance(p, (list, tuple)) and len(p) >= 2] for ring in polygon]
        if rings and len(rings[0]) >= 3:
            polygons.append([ring for ring in rings if len(ring) >= 3])
    return polygons


def _footprint_samples(polygons):
    # Keep the existing sampling density and largest-component policy, but
    # never let a courtyard vote as if it were building material.
    return [p for p in _samples([polygon[0] for polygon in polygons])
            if any(point_in_polygon(p, polygon) for polygon in polygons)]


def _footprint_coverage(points, polygons):
    if not points:
        return 0.0
    return sum(any(point_in_polygon(p, polygon) for polygon in polygons)
               for p in points) / len(points)


def _overlap_fraction(a, b) -> float:
    """How much of box *a* lies inside box *b*."""
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    area = (a[2] - a[0]) * (a[3] - a[1])
    return (ix1 - ix0) * (iy1 - iy0) / area if area > 0.0 else 0.0


def _information_rank(feature: Mapping[str, Any]) -> Tuple[int, int, int]:
    """Which of two duplicate outlines to keep: the one that says more."""
    properties = feature_properties(dict(feature))
    names = properties.get("names") or {}
    return (
        int(positive_number(properties.get("height")) is not None),
        int(positive_number(properties.get("num_floors")) is not None),
        int(bool(isinstance(names, dict) and names.get("primary"))),
    )


def find_duplicate_outlines(
    buildings: Sequence[Dict[str, Any]],
    parts_by_parent: Mapping[str, Sequence[Dict[str, Any]]],
) -> Set[str]:
    """Return the ids of building footprints that are already modelled elsewhere.

    The source publishes some buildings twice: once as a plain footprint with
    a name and a height, and once as an outline that owns the parts.  The
    Scripps Center is one -- a 143 m named box standing exactly over the
    eleven tiered parts of an unnamed outline, hiding the tiers and the crown
    inside it.  A partless building whose footprint lies inside another
    building's parts is therefore that building over again, and is dropped.
    Two partless footprints that each cover the other are one building mapped
    twice; the one carrying less information goes.
    """
    ids = [feature_id(b) for b in buildings]
    rings = {}
    polygons = {}
    boxes = {}
    for building, identifier in zip(buildings, ids):
        outer = _outer_rings(building)
        if outer:
            rings[identifier] = outer
            polygons[identifier] = _footprint_polygons(building)
            boxes[identifier] = _bounds(outer)

    # Parts of each loaded parent, retaining holes, with the union's bounds.
    part_polygons = {}
    part_boxes = {}
    for parent_id, associated in parts_by_parent.items():
        if parent_id not in rings:
            continue
        collected = []
        for part in associated:
            collected.extend(_footprint_polygons(part))
        if collected:
            part_polygons[parent_id] = collected
            part_boxes[parent_id] = _bounds([polygon[0] for polygon in collected])

    duplicates: Set[str] = set()
    partless = [
        identifier
        for identifier in ids
        if identifier in rings and identifier not in parts_by_parent
    ]

    for identifier in partless:
        box = boxes[identifier]
        points = None
        for parent_id, parent_box in part_boxes.items():
            if parent_id == identifier or _overlap_fraction(box, parent_box) < 0.5:
                continue
            if points is None:
                points = _footprint_samples(polygons[identifier])
            if _footprint_coverage(points, part_polygons[parent_id]) >= DUPLICATE_COVERAGE:
                duplicates.add(identifier)
                break

    # Near-identical partless footprints, found through a coarse spatial hash.
    cell = 0.0005
    buckets: Dict[Tuple[int, int], List[str]] = {}
    for identifier in partless:
        if identifier in duplicates:
            continue
        x0, y0, x1, y1 = boxes[identifier]
        for gx in range(int(x0 / cell), int(x1 / cell) + 1):
            for gy in range(int(y0 / cell), int(y1 / cell) + 1):
                buckets.setdefault((gx, gy), []).append(identifier)
    by_id = dict(zip(ids, buildings))
    checked: Set[Tuple[str, str]] = set()
    for members in buckets.values():
        for index, first in enumerate(members):
            for second in members[index + 1 :]:
                pair = (first, second) if first < second else (second, first)
                if pair in checked or first in duplicates or second in duplicates:
                    continue
                checked.add(pair)
                a, b = boxes[first], boxes[second]
                if min(_overlap_fraction(a, b), _overlap_fraction(b, a)) < 0.7:
                    continue
                if (
                    _footprint_coverage(_footprint_samples(polygons[first]), polygons[second]) >= MUTUAL_COVERAGE
                    and _footprint_coverage(_footprint_samples(polygons[second]), polygons[first]) >= MUTUAL_COVERAGE
                ):
                    # On a tie the later id goes, so a rerun makes the same choice.
                    poorer = min(
                        sorted((first, second), reverse=True),
                        key=lambda i: _information_rank(by_id[i]),
                    )
                    duplicates.add(poorer)
    return duplicates


def _parent_supplies_main_mass(building, parts) -> bool:
    """A small upper roof section does not replace a recorded main mass.

    An explicitly lower part preserves a real setback. A heightless part or
    lower floor-derived estimate must not erase an explicit parent mass.
    Derived parent heights remain insufficient evidence for filling the
    footprint. Parts with usable height or floor data still count toward
    coverage, so complete assemblies keep their existing variable heights.
    """
    from ..external.lidar_source import estimated_height

    properties = feature_properties(building)
    profile = resolve_vertical_profile(properties, 3.0, 10.0)
    if (profile.height_source != "height" or profile.thickness_m <= 0
            or estimated_height(properties)):
        return False
    outlines = _outer_rings(building)
    if not outlines:
        return False
    part_rings = []
    for part in parts:
        top = resolve_vertical_profile(feature_properties(part), 3.0, 10.0)
        if top.height_source.split("+", 1)[0] not in ("height", "num_floors"):
            continue
        if top.thickness_m <= 0:
            return False
        # Floor heights vary, particularly in halls and other large rooms.
        # A lower estimate alone is not evidence of an actual mapped setback.
        if top.top_m < profile.top_m and top.height_source == "height":
            return False
        rings = _outer_rings(part)
        if not rings:
            return False
        part_rings.extend(rings)
    samples = _samples(outlines)
    return bool(samples) and _coverage(samples, part_rings) < MUTUAL_COVERAGE


def _sparse_parts_leave_main_mass(building, parts):
    """Retain a grounded parent when most of its footprint has no mapped parts.

    This deliberately accepts filled small setbacks. Part-only courtyards are
    ambiguous, so any part hole opts out; parent holes remain in its geometry.
    Count every part footprint, including those without height information.
    """
    profile = resolve_vertical_profile(feature_properties(building), 3., 10.)
    if profile.thickness_m <= 0 or profile.bottom_m > 0:
        return False
    parent_polygons = _footprint_polygons(building)
    part_polygons = [polygon for part in parts for polygon in _footprint_polygons(part)]
    if not parent_polygons or not part_polygons or any(len(polygon) > 1 for polygon in part_polygons):
        return False
    # Sample each component and weight by its material area, excluding holes.
    # This keeps small disconnected wings from deciding a whole complex's fate.
    total_area = covered_area = 0.0
    for polygon in parent_polygons:
        area = polygon_area(polygon)
        samples = _footprint_samples([polygon])
        if area <= 0 or not samples:
            return False
        total_area += area
        covered_area += area * _footprint_coverage(samples, part_polygons)
    return total_area > 0 and covered_area / total_area < .5


def select_building_geometry(
    buildings: Sequence[Dict[str, Any]], parts: Sequence[Dict[str, Any]],
    retain_sparse_parents: bool = False,
) -> BuildingSelection:
    """Choose parent masses versus parts without creating coincident duplicates.

    A parent is replaced only when it advertises ``has_parts`` and at least one
    associated part carries vertical data that Phase 1 actually uses.  Once that
    decision is made, all above-ground parts belonging to that parent are emitted
    so a part lacking a height can still receive the configured fallback. An
    explicit parent mass is retained when no explicitly lower part contradicts
    it and parts with usable vertical data leave substantial footprint uncovered.
    Heightless parts neither veto that mass nor count toward its coverage.
    Floor-derived parts count toward coverage but do not establish lower setbacks.

    A building whose footprint is already modelled by another building's parts,
    or by a better-described twin of itself, is dropped as a duplicate outline
    (see :func:`find_duplicate_outlines`).
    """
    parts_by_parent: Dict[str, List[Dict[str, Any]]] = {}
    for part in parts:
        if not is_above_ground(part):
            continue
        parent_id = str(feature_properties(part).get("building_id") or "")
        if parent_id:
            parts_by_parent.setdefault(parent_id, []).append(part)

    above_ground = [building for building in buildings if is_above_ground(building)]
    duplicates = find_duplicate_outlines(above_ground, parts_by_parent)

    selected_buildings: List[Dict[str, Any]] = []
    selected_parts: List[Dict[str, Any]] = []
    selected_part_ids: Set[str] = set()
    suppressed: Set[str] = set()
    loaded_parent_ids: Set[str] = set()

    for building in above_ground:
        parent_id = feature_id(building)
        loaded_parent_ids.add(parent_id)
        if parent_id in duplicates:
            continue
        properties = feature_properties(building)
        associated = parts_by_parent.get(parent_id, [])
        useful = any(part_has_useful_vertical_data(part) for part in associated)
        if properties.get("has_parts") is True and useful:
            if (_parent_supplies_main_mass(building, associated)
                    or (retain_sparse_parents and _sparse_parts_leave_main_mass(building, associated))):
                selected_buildings.append(building)
            else:
                suppressed.add(parent_id)
            for part in associated:
                part_id = feature_id(part)
                if part_id not in selected_part_ids:
                    selected_parts.append(part)
                    selected_part_ids.add(part_id)
        else:
            selected_buildings.append(building)

    # A part can intersect the query bbox while its parent footprint does not.
    # Keep only useful orphan parts; otherwise a default-height sliver would be
    # less truthful than omitting it.
    for parent_id, associated in parts_by_parent.items():
        if parent_id in loaded_parent_ids:
            continue
        for part in associated:
            part_id = feature_id(part)
            if part_has_useful_vertical_data(part) and part_id not in selected_part_ids:
                selected_parts.append(part)
                selected_part_ids.add(part_id)

    return BuildingSelection(
        tuple(selected_buildings),
        tuple(selected_parts),
        frozenset(suppressed),
        frozenset(duplicates),
    )
