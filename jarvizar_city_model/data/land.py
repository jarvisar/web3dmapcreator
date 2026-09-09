"""Classification policy for Overture base land, land use, land cover, and water.

Overture spreads ground-surface information across four types with overlapping
vocabularies.  This module maps them onto the small set of printable surface
categories the miniature actually renders, and it is deliberately an allowlist:
an unrecognized class produces no geometry rather than a guessed surface.

All functions are pure and Blender-free.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Tuple

from .geojson import feature_properties


# Printable surface categories.  Each maps to one material and one draped slab.
GREEN = "green"
FOREST = "forest"
SAND = "sand"
ROCK = "rock"
PAVED = "paved"

SURFACE_CATEGORIES = (GREEN, FOREST, SAND, ROCK, PAVED)
DEFAULT_SURFACE_PRIORITY = (PAVED, SAND, ROCK, GREEN, FOREST)

# Categories whose polygons are dense enough with vegetation to justify
# scattering trees inside them when explicit tree points are unavailable.
TREE_BEARING_CATEGORIES = frozenset({FOREST})

# base/land: physical ground cover, including individual tree points.
LAND_CLASS_CATEGORIES: Dict[str, str] = {
    "forest": FOREST,
    "wood": FOREST,
    "tree_row": FOREST,
    "scrub": GREEN,
    "shrub": GREEN,
    "heath": GREEN,
    "grass": GREEN,
    "grassland": GREEN,
    "meadow": GREEN,
    "wetland": GREEN,
    "sand": SAND,
    "beach": SAND,
    "shingle": SAND,
    "dune": SAND,
    "rock": ROCK,
    "bare_rock": ROCK,
    "scree": ROCK,
    "cliff": ROCK,
}

# base/land_use: how humans use the ground.
LAND_USE_CLASS_CATEGORIES: Dict[str, str] = {
    "park": GREEN,
    "grass": GREEN,
    "garden": GREEN,
    "forest": FOREST,
    "wood": FOREST,
    "meadow": GREEN,
    "orchard": GREEN,
    "vineyard": GREEN,
    "farmland": GREEN,
    "allotments": GREEN,
    "village_green": GREEN,
    "recreation_ground": GREEN,
    "golf_course": GREEN,
    "cemetery": GREEN,
    "grave_yard": GREEN,
    "pitch": GREEN,
    "playground": GREEN,
    "flowerbed": GREEN,
    "dog_park": GREEN,
    "nature_reserve": GREEN,
    "stadium": GREEN,
    "pedestrian": PAVED,
    "plaza": PAVED,
}

# base/land_cover: coarse satellite-derived cover.  Only categories that read
# as vegetation are accepted; "urban" would blanket the entire selection and
# "snow"/"crop" would misrepresent a city miniature.
LAND_COVER_SUBTYPE_CATEGORIES: Dict[str, str] = {
    "forest": FOREST,
    "mangrove": FOREST,
    "shrub": GREEN,
    "grass": GREEN,
    "moss": GREEN,
    "wetland": GREEN,
}

# base/water classes that are not printable open water at city-miniature scale.
EXCLUDED_WATER_CLASSES = frozenset({"swimming_pool", "fountain"})

# Mapped ground that sits out over water: a pier deck, a quay, a dam crest.
# The source maps the bank along the shore and the structure separately, so a
# cut that trusts the water polygon alone runs straight under the pier and
# leaves it, and everything standing on it, hanging over a hole.  Overture
# publishes these in ``base/infrastructure`` (subtype ``pier`` or ``water``);
# the land types are still checked for older caches and other vocabularies.
# A marina describes a facility's land AND water area, not a physical deck.
# Restoring that footprint fills entire harbors and creates matching terrain
# support slabs. Only the separately mapped piers/quays keep their ground.
WATER_DECK_CLASSES = frozenset(
    {"pier", "breakwater", "quay", "dam", "weir", "boardwalk", "groyne"}
)
WATER_DECK_TYPES = frozenset({"land", "land_use", "infrastructure"})

# Open water below this real area is not cut out of the terrain.  A river or a
# lake is a feature of the landscape; a garden pond, a fountain basin, or a
# rooftop pool is a hole a few tenths of a millimetre across that only weakens
# the print.  Half a hectare separates the two cleanly.
MINIMUM_WATER_CUT_AREA_M2 = 5000.0

# Overture's bbox filter returns every feature that *intersects* the selection,
# including regional and continental polygons.  A single land_cover "forest"
# polygon over a small city bbox has been observed at roughly 500000 times the
# selection area: draping it produces a green sheet over the entire model and
# buries the water and terrain underneath it.  A feature whose own extent is
# wildly larger than the selection is describing a region, not this place.
MAXIMUM_EXTENT_RATIO = 8.0


def geometry_extent(geometry: Mapping[str, Any]) -> Optional[Tuple[float, float]]:
    """Return a Polygon/MultiPolygon's ``(width, height)`` extent in degrees."""
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list):
        return None
    if geometry_type == "Polygon":
        polygons = [coordinates]
    elif geometry_type == "MultiPolygon":
        polygons = coordinates
    else:
        return None

    longitudes = []
    latitudes = []
    for polygon in polygons:
        if not polygon:
            continue
        for point in polygon[0]:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                try:
                    longitudes.append(float(point[0]))
                    latitudes.append(float(point[1]))
                except (TypeError, ValueError):
                    continue
    if not longitudes or not latitudes:
        return None
    return max(longitudes) - min(longitudes), max(latitudes) - min(latitudes)


def extent_ratio(
    geometry: Mapping[str, Any], bounds: Tuple[float, float, float, float]
) -> float:
    """Return how many times the feature's own extent exceeds the selection.

    A value of 1.0 means the feature is about as large as the selection.  The
    comparison uses unclipped source geometry on purpose, because clipping a
    continental polygon makes it look exactly like a local one.
    """
    extent = geometry_extent(geometry)
    if extent is None:
        return 0.0
    west, south, east, north = bounds
    selection = max((east - west) * (north - south), 1.0e-12)
    return (extent[0] * extent[1]) / selection


def is_regional_feature(
    geometry: Mapping[str, Any],
    bounds: Tuple[float, float, float, float],
    maximum_ratio: float = MAXIMUM_EXTENT_RATIO,
) -> bool:
    """Return whether a feature is far too large to describe this selection."""
    return extent_ratio(geometry, bounds) > maximum_ratio


def _class_and_subtype(properties: Mapping[str, Any]) -> Tuple[str, str]:
    return (
        str(properties.get("class") or "").strip().lower(),
        str(properties.get("subtype") or "").strip().lower(),
    )


def classify_surface(feature_type: str, feature: Mapping[str, Any]) -> Optional[str]:
    """Return the printable surface category for a base feature, or ``None``.

    ``feature_type`` is the Overture type the feature was downloaded as, since
    the same class string means different things in different types.
    """
    properties = feature_properties(dict(feature))
    class_name, subtype = _class_and_subtype(properties)

    if feature_type == "land":
        return LAND_CLASS_CATEGORIES.get(class_name) or LAND_CLASS_CATEGORIES.get(
            subtype
        )
    if feature_type == "land_use":
        return LAND_USE_CLASS_CATEGORIES.get(class_name) or LAND_USE_CLASS_CATEGORIES.get(
            subtype
        )
    if feature_type == "land_cover":
        # land_cover carries its vocabulary on subtype; class is normally null.
        return LAND_COVER_SUBTYPE_CATEGORIES.get(
            subtype
        ) or LAND_COVER_SUBTYPE_CATEGORIES.get(class_name)
    return None


def is_tree_point(feature: Mapping[str, Any]) -> bool:
    """Return whether a base/land feature is an individually mapped tree."""
    geometry = feature.get("geometry") or {}
    if geometry.get("type") != "Point":
        return False
    properties = feature_properties(dict(feature))
    class_name, subtype = _class_and_subtype(properties)
    return "tree" in (class_name, subtype)


def tree_point_coordinates(
    feature: Mapping[str, Any]
) -> Optional[Tuple[float, float]]:
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, (list, tuple)) or len(coordinates) < 2:
        return None
    try:
        return float(coordinates[0]), float(coordinates[1])
    except (TypeError, ValueError):
        return None


def is_printable_water(feature: Mapping[str, Any]) -> bool:
    """Return whether a base/water feature should become a water surface.

    Only polygonal features qualify.  Overture also publishes water centerlines
    and points, which carry no printable extent, and small human-made basins
    that would read as noise at this scale.
    """
    geometry = feature.get("geometry") or {}
    if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        return False
    properties = feature_properties(dict(feature))
    class_name, _subtype = _class_and_subtype(properties)
    return class_name not in EXCLUDED_WATER_CLASSES


def recessed_water_kind(feature: Mapping[str, Any]) -> Optional[str]:
    """Identify mapped ponds/fountain basins, never by size or feature name.

    Overture preserves OSM tags as ``source_tags`` key/value pairs. Also accept
    dictionaries and raw properties used by GeoJSON importers. Explicit OSM
    water types take precedence over the normalized class/subtype fallback.
    A point fountain carries no basin footprint and cannot recess terrain.
    """
    if (feature.get("geometry") or {}).get("type") not in {"Polygon", "MultiPolygon"}:
        return None
    properties = feature_properties(dict(feature))
    tags = {key: properties[key] for key in ("natural", "water", "amenity", "waterway")
            if key in properties}
    for key in ("tags", "source_tags"):
        source = properties.get(key)
        if isinstance(source, Mapping):
            tags.update(source)
        elif isinstance(source, (list, tuple)):
            for item in source:
                if isinstance(item, (list, tuple)) and len(item) == 2:
                    tags[str(item[0])] = item[1]
                elif isinstance(item, Mapping) and "key" in item and "value" in item:
                    tags[str(item["key"])] = item["value"]
    tags = {str(key).strip().lower(): str(value).strip().lower() for key, value in tags.items()}
    # A tagged river/canal/etc. must not become a basin through a fallback.
    if tags.get("waterway") in {"river", "stream", "canal", "drain", "ditch"}:
        return None
    if tags.get("water") and tags["water"] != "pond":
        return None
    if tags.get("amenity") == "fountain":
        return "fountain"
    if tags.get("natural") == "water" and tags.get("water") == "pond":
        return "pond"
    class_name, subtype = _class_and_subtype(properties)
    if class_name in {"river", "stream", "lake", "reservoir", "canal", "ocean",
                      "bay", "sea", "strait", "drain", "ditch", "swimming_pool"}:
        return None
    if class_name in {"pond", "fountain"}:
        return class_name
    if subtype in {"pond", "fountain"}:
        return subtype
    return None


def is_water_deck(feature_type: str, feature: Mapping[str, Any]) -> bool:
    """Return whether a mapped feature is a structure standing over open water."""
    if feature_type not in WATER_DECK_TYPES:
        return False
    geometry = feature.get("geometry") or {}
    if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        return False
    properties = feature_properties(dict(feature))
    class_name, subtype = _class_and_subtype(properties)
    return class_name in WATER_DECK_CLASSES or subtype in WATER_DECK_CLASSES


def surface_priority(category: str) -> int:
    """Higher priority owns overlapping land-surface footprints."""
    return (len(DEFAULT_SURFACE_PRIORITY) - 1 - DEFAULT_SURFACE_PRIORITY.index(category)
            if category in DEFAULT_SURFACE_PRIORITY else 1)
