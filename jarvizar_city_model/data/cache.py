"""Deterministic local cache layout for downloaded source data."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Tuple


CACHE_FORMAT_VERSION = 1

# Overture types grouped by the feature they produce.  Groups are downloaded
# independently so enabling roads later does not force a fresh building
# download, and so a partially populated cache reports honestly.
BUILDING_TYPES = ("building", "building_part")
ROAD_TYPES = ("segment", "connector")
WATER_TYPES = ("water",)
LAND_TYPES = ("land", "land_use", "land_cover")
INFRASTRUCTURE_TYPES = ("infrastructure",)

ALL_TYPES = (
    BUILDING_TYPES + ROAD_TYPES + WATER_TYPES + LAND_TYPES + INFRASTRUCTURE_TYPES
)

DEM_FILES = ("terrain.json", "terrain.f32")


@dataclass(frozen=True)
class Bounds:
    west: float
    south: float
    east: float
    north: float

    def validate(self) -> "Bounds":
        values = (self.west, self.south, self.east, self.north)
        if not all(isinstance(value, (int, float)) for value in values):
            raise ValueError("Bounding-box values must be numeric")
        if not (-180.0 <= self.west < self.east <= 180.0):
            raise ValueError("Require -180 <= west < east <= 180")
        if not (-90.0 <= self.south < self.north <= 90.0):
            raise ValueError("Require -90 <= south < north <= 90")
        return self

    def as_tuple(self) -> Tuple[float, float, float, float]:
        return self.west, self.south, self.east, self.north

    def canonical(self) -> str:
        return ",".join(f"{value:.7f}" for value in self.as_tuple())


def cache_key(bounds: Bounds) -> str:
    bounds.validate()
    digest = hashlib.sha256(bounds.canonical().encode("ascii")).hexdigest()[:12]
    return f"bbox_{digest}"


class CacheBundle:
    def __init__(self, cache_root: Path, bounds: Bounds) -> None:
        self.cache_root = Path(cache_root).expanduser()
        self.bounds = bounds.validate()
        self.path = self.cache_root / cache_key(bounds)

    @property
    def manifest_path(self) -> Path:
        return self.path / "manifest.json"

    def data_path(self, feature_type: str) -> Path:
        if not feature_type.replace("_", "").isalnum():
            raise ValueError(f"Invalid feature type: {feature_type!r}")
        return self.path / f"{feature_type}.geojson"

    def read_manifest(self) -> Dict[str, Any]:
        try:
            with self.manifest_path.open("r", encoding="utf-8") as handle:
                value = json.load(handle)
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _is_current(self, manifest: Dict[str, Any]) -> bool:
        """Whether a manifest was written in this format for these bounds."""
        return manifest.get("cache_format") == CACHE_FORMAT_VERSION and manifest.get(
            "bbox"
        ) == list(self.bounds.as_tuple())

    def is_complete(self, feature_types: Iterable[str] = BUILDING_TYPES) -> bool:
        if not self._is_current(self.read_manifest()):
            return False
        return all(self.data_path(item).is_file() for item in feature_types)

    def missing_types(self, feature_types: Iterable[str]) -> Tuple[str, ...]:
        """Return the requested types that are not cached for these bounds."""
        if not self._is_current(self.read_manifest()):
            return tuple(feature_types)
        return tuple(
            item for item in feature_types if not self.data_path(item).is_file()
        )

    def has_dem(self) -> bool:
        return all((self.path / name).is_file() for name in DEM_FILES)

    def ensure_directory(self) -> None:
        self.path.mkdir(parents=True, exist_ok=True)

    def write_manifest(self, manifest: Dict[str, Any]) -> None:
        self.ensure_directory()
        target = self.manifest_path
        temporary = target.with_suffix(".json.partial")
        payload = dict(manifest)
        payload["cache_format"] = CACHE_FORMAT_VERSION
        payload["bbox"] = list(self.bounds.as_tuple())
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(str(temporary), str(target))

    def merge_manifest(self, update: Dict[str, Any]) -> Dict[str, Any]:
        """Merge one download group's provenance into the existing manifest.

        Feature groups are fetched separately, so replacing the manifest
        wholesale would erase the counts and observed fields recorded by an
        earlier group.  Nested count/field dictionaries are merged key-wise and
        the recorded type list becomes the union.
        """
        merged = self.read_manifest()
        if merged.get("bbox") != list(self.bounds.as_tuple()):
            merged = {}
        for key, value in update.items():
            if key in ("feature_counts", "observed_fields") and isinstance(value, dict):
                existing = merged.get(key)
                combined = dict(existing) if isinstance(existing, dict) else {}
                combined.update(value)
                merged[key] = combined
            elif key == "feature_types" and isinstance(value, (list, tuple)):
                existing = merged.get(key)
                combined = list(existing) if isinstance(existing, list) else []
                for item in value:
                    if item not in combined:
                        combined.append(item)
                merged[key] = combined
            else:
                merged[key] = value
        self.write_manifest(merged)
        return merged

