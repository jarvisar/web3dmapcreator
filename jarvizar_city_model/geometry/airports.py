"""Airport paving: runways, taxiways, aprons and helipads as areas.

Overture's ``base/infrastructure`` (subtype ``airport``) maps aprons and
helipads as polygons but runways, stopways, taxiways and taxilanes as
centerlines.  On a miniature they are paved ground rather than routes: a
45 m runway is over three printed millimetres wide.  Each centerline is
widened by its mapped width, or a typical width for its class, into a
polygon in WGS84, and the road generator builds every such area as one
batched paving object.

The whole-airport boundary (``airport``, ``international_airport`` and the
like) is not paving: it would cover the grass between the runways.

Pure Python; no Blender dependency.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Tuple

from ..data.geojson import feature_properties
from .buildings import length_metres
from .planar import buffer_polyline, buffer_polyline_convex_pieces, offset_is_safe


Point = Tuple[float, float]

AIRPORT_SUBTYPE = "airport"

# Mapped as areas.
AIRPORT_AREA_CLASSES = frozenset({"apron", "helipad"})

# Mapped as centerlines.  A width tag wins; these are typical widths for the
# untagged ones, in metres.
AIRPORT_LINE_WIDTH_M: Dict[str, float] = {
    "runway": 45.0,
    "stopway": 45.0,
    "taxiway": 23.0,
    "taxilane": 15.0,
}

# Runways and stopways end square; taxiways meet other paving, so round.
SQUARE_ENDED_CLASSES = frozenset({"runway", "stopway"})


def _class_name(properties: Mapping[str, Any]) -> str:
    return str(properties.get("class") or "").strip().lower()


def _is_airport(properties: Mapping[str, Any]) -> bool:
    return str(properties.get("subtype") or "").strip().lower() == AIRPORT_SUBTYPE


def _tag(properties: Mapping[str, Any], key: str) -> Any:
    if key in properties:
        return properties[key]
    tags = properties.get("source_tags")
    if isinstance(tags, Mapping):
        return tags.get(key)
    if isinstance(tags, (list, tuple)):
        for item in tags:
            if isinstance(item, (list, tuple)) and len(item) == 2 and item[0] == key:
                return item[1]
    return None


def is_airport_area(feature: Mapping[str, Any]) -> bool:
    """Whether *feature* is an apron or helipad polygon."""
    properties = feature_properties(feature)
    geometry = feature.get("geometry") or {}
    return (
        _is_airport(properties)
        and _class_name(properties) in AIRPORT_AREA_CLASSES
        and geometry.get("type") in {"Polygon", "MultiPolygon"}
    )


def airport_line_width_m(properties: Mapping[str, Any]) -> Optional[float]:
    """Width in metres of an airport centerline, or None for anything else."""
    if not _is_airport(properties):
        return None
    default = AIRPORT_LINE_WIDTH_M.get(_class_name(properties))
    if default is None:
        return None
    width = length_metres(_tag(properties, "width"))
    return width if width is not None and width > 0.0 else default


def _lines(geometry: Mapping[str, Any]) -> Iterator[List[Sequence[float]]]:
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates") or []
    if kind == "LineString":
        yield coordinates
    elif kind == "MultiLineString":
        yield from coordinates


def airport_surface_polygons(features: Iterable[Dict[str, Any]], projection) -> List[Dict[str, Any]]:
    """Return polygon features for every airport centerline in *features*.

    *projection* converts WGS84 to local metres and back (``forward`` and
    ``inverse``), so widths are applied in metres whatever the latitude.
    Each result keeps the source feature's id and properties.
    """
    result: List[Dict[str, Any]] = []
    for feature in features:
        properties = feature_properties(feature)
        width = airport_line_width_m(properties)
        if width is None:
            continue
        half_width = width * 0.5
        square = _class_name(properties) in SQUARE_ENDED_CLASSES
        polygons = []
        for line in _lines(feature.get("geometry") or {}):
            points: List[Point] = []
            for position in line:
                if isinstance(position, (list, tuple)) and len(position) >= 2:
                    east, north, _up = projection.forward(float(position[0]), float(position[1]), 0.0)
                    if not points or (east, north) != points[-1]:
                        points.append((east, north))
            if len(points) < 2:
                continue
            if offset_is_safe(points, half_width):
                rings = [buffer_polyline(points, half_width, round_caps=not square, epsilon=1.0e-6)]
            else:
                rings = buffer_polyline_convex_pieces(points, half_width, epsilon=1.0e-6)
            for ring in rings:
                if len(ring) < 3:
                    continue
                outline = [list(projection.inverse(east, north, 0.0)[:2]) for east, north in ring]
                outline.append(list(outline[0]))
                polygons.append([outline])
        if polygons:
            result.append({
                "type": "Feature",
                "id": feature.get("id"),
                "properties": dict(properties),
                "geometry": {"type": "MultiPolygon", "coordinates": polygons},
            })
    return result


def airport_surface_features(features: Iterable[Dict[str, Any]], projection) -> List[Dict[str, Any]]:
    """Every airport paving area in *features*: mapped areas, widened lines."""
    features = list(features)
    return [feature for feature in features if is_airport_area(feature)] + airport_surface_polygons(
        features, projection
    )
