"""Cached elevation grid loading and sampling inside Blender.

The heavy work (tile download, PNG decode, resampling) happens in
:mod:`jarvizar_city_model.external.download_dem`.  Blender only reads a
small regular grid of float32 metres and interpolates it, so this module needs
nothing beyond the standard library.

Geometry code depends on the abstract :class:`~jarvizar_city_model.data.terrain.TerrainSampler`
interface, never on this provider directly.
"""

from __future__ import annotations

import array
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Tuple

from .terrain import TerrainSampler


GRID_FORMAT = "jcm_elevation_grid"
GRID_VERSION = 1


class ElevationGridError(RuntimeError):
    pass


@dataclass(frozen=True)
class ElevationGrid:
    """A regular WGS84 grid of orthometric elevations in metres."""

    west: float
    south: float
    east: float
    north: float
    columns: int
    rows: int
    values: array.array
    zoom: int = 0
    ground_resolution_m: float = 0.0
    source: str = ""

    def __post_init__(self) -> None:
        if self.columns < 2 or self.rows < 2:
            raise ElevationGridError("Elevation grid must be at least 2x2")
        if len(self.values) != self.columns * self.rows:
            raise ElevationGridError(
                f"Elevation grid has {len(self.values)} samples, "
                f"expected {self.columns * self.rows}"
            )
        if self.east <= self.west or self.north <= self.south:
            raise ElevationGridError("Elevation grid bounds are degenerate")

    @property
    def minimum_m(self) -> float:
        return min(self.values)

    @property
    def maximum_m(self) -> float:
        return max(self.values)

    @classmethod
    def load(cls, directory: Path) -> "ElevationGrid":
        directory = Path(directory)
        header_path = directory / "terrain.json"
        binary_path = directory / "terrain.f32"
        try:
            header = json.loads(header_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ElevationGridError(f"Could not read {header_path}: {exc}") from exc
        if header.get("format") != GRID_FORMAT:
            raise ElevationGridError(f"{header_path} is not a {GRID_FORMAT} header")
        if int(header.get("version", 0)) != GRID_VERSION:
            raise ElevationGridError(
                f"Unsupported elevation grid version {header.get('version')}"
            )
        columns = int(header["columns"])
        rows = int(header["rows"])
        values = array.array("f")
        try:
            with binary_path.open("rb") as handle:
                values.fromfile(handle, columns * rows)
        except (OSError, EOFError, ValueError) as exc:
            raise ElevationGridError(f"Could not read {binary_path}: {exc}") from exc
        if sys.byteorder != "little":
            values.byteswap()
        return cls(
            west=float(header["west"]),
            south=float(header["south"]),
            east=float(header["east"]),
            north=float(header["north"]),
            columns=columns,
            rows=rows,
            values=values,
            zoom=int(header.get("zoom", 0)),
            ground_resolution_m=float(header.get("ground_resolution_m", 0.0)),
            source=str(header.get("source", "")),
        )

    def matches(self, west: float, south: float, east: float, north: float) -> bool:
        """Return whether the grid covers a bbox to within a grid cell."""
        tolerance_x = (self.east - self.west) / (self.columns - 1)
        tolerance_y = (self.north - self.south) / (self.rows - 1)
        return (
            west >= self.west - tolerance_x
            and east <= self.east + tolerance_x
            and south >= self.south - tolerance_y
            and north <= self.north + tolerance_y
        )

    def sample_raw_m(self, longitude: float, latitude: float) -> float:
        """Bilinear elevation lookup, clamped to the grid edge outside bounds.

        Clamping rather than raising keeps clipped features continuous right at
        the selection boundary, where a source polygon legitimately extends a
        little past the requested bbox.
        """
        fx = (longitude - self.west) / (self.east - self.west) * (self.columns - 1)
        fy = (latitude - self.south) / (self.north - self.south) * (self.rows - 1)
        fx = min(max(fx, 0.0), self.columns - 1.0)
        fy = min(max(fy, 0.0), self.rows - 1.0)
        x0 = int(math.floor(fx))
        y0 = int(math.floor(fy))
        x1 = min(x0 + 1, self.columns - 1)
        y1 = min(y0 + 1, self.rows - 1)
        tx = fx - x0
        ty = fy - y0
        values = self.values
        columns = self.columns
        lower = (
            values[y0 * columns + x0] * (1.0 - tx) + values[y0 * columns + x1] * tx
        )
        upper = (
            values[y1 * columns + x0] * (1.0 - tx) + values[y1 * columns + x1] * tx
        )
        return lower * (1.0 - ty) + upper * ty


class DEMTerrain(TerrainSampler):
    """Terrain sampler backed by a cached elevation grid.

    Elevations are reported relative to a reference height (by default the
    grid minimum) so the generated miniature sits just above Z=0 regardless of
    the city's absolute altitude, and so the orthometric/ellipsoid datum
    difference becomes a constant that cancels out.
    """

    def __init__(
        self,
        grid: ElevationGrid,
        reference_m: float | None = None,
        exaggeration: float = 1.0,
    ) -> None:
        self.grid = grid
        self.reference_m = (
            float(grid.minimum_m) if reference_m is None else float(reference_m)
        )
        exaggeration = float(exaggeration)
        if not math.isfinite(exaggeration) or exaggeration < 0.0:
            raise ValueError("exaggeration must be a finite, non-negative number")
        self.exaggeration = exaggeration

    def sample_m(self, lon: float, lat: float) -> float:
        return (
            self.grid.sample_raw_m(lon, lat) - self.reference_m
        ) * self.exaggeration

    @property
    def relief_m(self) -> float:
        """Total modelled vertical relief after exaggeration."""
        return (self.grid.maximum_m - self.grid.minimum_m) * self.exaggeration

    def minimum_over(self, coordinates: Iterable[Tuple[float, float]]) -> float:
        """Return the lowest sampled elevation, or 0.0 for an empty input.

        A building footprint on a slope must be founded at its lowest corner,
        otherwise the uphill side of the mass floats above the terrain mesh.
        """
        samples = [self.sample_m(lon, lat) for lon, lat in coordinates]
        return min(samples) if samples else 0.0

    def describe(self) -> str:
        return (
            f"{self.grid.source or 'elevation grid'} "
            f"{self.grid.columns}x{self.grid.rows} "
            f"@ z{self.grid.zoom} "
            f"({self.grid.ground_resolution_m:.1f} m/px)"
        )
