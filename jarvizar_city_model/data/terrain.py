"""Terrain sampling interfaces independent of Blender mesh creation."""

from __future__ import annotations

from abc import ABC, abstractmethod


class TerrainSampler(ABC):
    """Samples real-world elevation in metres for WGS84 coordinates."""

    @abstractmethod
    def sample_m(self, lon: float, lat: float) -> float:
        """Return terrain elevation in metres at ``lon, lat``."""
        raise NotImplementedError


class FlatTerrain(TerrainSampler):
    """Terrain with a constant elevation."""

    def __init__(self, elevation_m: float = 0.0) -> None:
        self.elevation_m = float(elevation_m)

    def sample_m(self, lon: float, lat: float) -> float:
        del lon, lat
        return self.elevation_m

