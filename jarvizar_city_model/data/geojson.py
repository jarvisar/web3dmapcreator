"""Small-area GeoJSON loading without GeoPandas or Shapely."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, Iterable, List


class GeoJSONError(ValueError):
    pass


def load_feature_collection(path: Path) -> List[Dict[str, Any]]:
    """Load and minimally validate an Overture GeoJSON FeatureCollection."""
    try:
        with path.open("r", encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise GeoJSONError(f"Could not read GeoJSON {path}: {exc}") from exc

    if document.get("type") != "FeatureCollection":
        raise GeoJSONError(f"{path} is not a GeoJSON FeatureCollection")
    features = document.get("features")
    if not isinstance(features, list):
        raise GeoJSONError(f"{path} has no features array")
    return [feature for feature in features if isinstance(feature, dict)]


def polygon_features(features: Iterable[Dict[str, Any]]) -> Iterable[Dict[str, Any]]:
    """Yield features whose geometry is Polygon or MultiPolygon."""
    for feature in features:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") in {"Polygon", "MultiPolygon"}:
            yield feature


def feature_properties(feature: Dict[str, Any]) -> Dict[str, Any]:
    properties = feature.get("properties")
    return properties if isinstance(properties, dict) else {}


def positive_number(value: Any) -> float | None:
    """Read a property value as a finite number above zero, else ``None``.

    Booleans are refused although Python treats them as numbers: a tag of
    ``true`` is not a height of one metre.
    """
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0.0 else None


def feature_id(feature: Dict[str, Any]) -> str:
    value = feature.get("id")
    if value is None:
        value = feature_properties(feature).get("id")
    return str(value or "unknown")


def geometry_polygons(geometry: Dict[str, Any]) -> List[List[List[List[float]]]]:
    """Return a uniform list of GeoJSON polygons (each a list of rings)."""
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list):
        return []
    if geometry_type == "Polygon":
        return [coordinates]
    if geometry_type == "MultiPolygon":
        return coordinates
    return []


def first_osm_id(properties: Dict[str, Any]) -> str:
    """Extract the first OSM source record id, if Overture exposes one."""
    sources = properties.get("sources")
    if not isinstance(sources, list):
        return ""
    for source in sources:
        if not isinstance(source, dict):
            continue
        dataset = str(source.get("dataset") or "").lower()
        provider = str(source.get("provider") or "").lower()
        if "openstreetmap" in dataset or dataset == "osm" or provider == "osm":
            return str(source.get("record_id") or "")
    return ""
