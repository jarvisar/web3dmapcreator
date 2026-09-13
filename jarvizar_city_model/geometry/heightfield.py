"""The single terrain surface every generated feature is aligned to.

Roads, water, land cover, and building foundations must agree with the terrain
mesh that is actually printed.  Sampling the analytic elevation provider
separately for each of them would not do that: the terrain mesh is a finite
grid, so a road draped on the underlying provider would sink into or float over
the very hillside it is supposed to sit on.

:class:`ModelHeightField` resolves that by resampling the provider once, in
model millimetres, on exactly the grid the terrain mesh is built from.  Every
other generator then interpolates this shared field.  Flat terrain is the same
code path with a constant zero grid, so no generator needs a special case.
"""

from __future__ import annotations

from typing import Iterable, List, Optional, Sequence, Tuple

from ..data.terrain import TerrainSampler
from .planar import point_in_polygon, ring_bounds
from .watermask import WaterMask

Ring = Sequence[Tuple[float, float]]


class ModelHeightField:
    """A regular grid of terrain heights in model millimetres."""

    def __init__(
        self,
        min_x: float,
        min_y: float,
        max_x: float,
        max_y: float,
        columns: int,
        rows: int,
        values: Sequence[float],
    ) -> None:
        if columns < 2 or rows < 2:
            raise ValueError("Height field must be at least 2x2")
        if len(values) != columns * rows:
            raise ValueError(
                f"Height field has {len(values)} samples, expected {columns * rows}"
            )
        if max_x <= min_x or max_y <= min_y:
            raise ValueError("Height field bounds are degenerate")
        self.min_x = float(min_x)
        self.min_y = float(min_y)
        self.max_x = float(max_x)
        self.max_y = float(max_y)
        self.columns = int(columns)
        self.rows = int(rows)
        self.values = list(float(value) for value in values)
        # Regions cut clean out of the printed terrain.  It lives here because
        # the height field is already what every generator asks about the
        # ground, and geometry founded over a hole has no ground to stand on.
        self.void_mask: Optional[WaterMask] = None
        # Footprints under which ground is kept inside the cut -- a causeway
        # under a bridge, a pedestal under a boathouse.  A pier stands on these
        # exactly as it stands on the bank.
        self._support_rings: List[Tuple[Tuple[float, float, float, float], List[Ring]]] = []
        # Mapped decks (piers, quays) that took their footprint back out of the
        # mask.  They are remembered so a raised pedestal can be built under
        # them where retained water would otherwise cover the kept ground.
        self.restored_footprints: List[List[Ring]] = []
        # Exact shallow basins retain solid ground and never enter void_mask.
        self.basins = []

    @classmethod
    def build(
        cls,
        transform,
        sampler: TerrainSampler,
        resolution: int = 192,
        progress_callback=None,
        smoothing: int = 0,
    ) -> "ModelHeightField":
        """Resample a terrain provider onto a model-space grid.

        *resolution* is the number of cells across the longer horizontal axis;
        the shorter axis keeps the model's aspect ratio so cells stay square.
        *smoothing* is the radius, in cells, of a mean filter applied to the
        sampled grid; see :meth:`smooth`.
        """
        bounds = transform.model_bounds
        resolution = max(2, min(1024, int(resolution)))
        if bounds.width_mm >= bounds.height_mm:
            columns = resolution
            rows = max(2, int(round(resolution * bounds.height_mm / bounds.width_mm)))
        else:
            rows = resolution
            columns = max(2, int(round(resolution * bounds.width_mm / bounds.height_mm)))

        values: List[float] = []
        step_x = (bounds.max_x_mm - bounds.min_x_mm) / (columns - 1)
        step_y = (bounds.max_y_mm - bounds.min_y_mm) / (rows - 1)
        for row in range(rows):
            y = bounds.min_y_mm + step_y * row
            for column in range(columns):
                x = bounds.min_x_mm + step_x * column
                longitude, latitude, _height = transform.model_to_geographic(x, y, 0.0)
                values.append(
                    transform.vertical_meters_to_model_mm(
                        sampler.sample_m(longitude, latitude)
                    )
                )
            if progress_callback is not None:
                progress_callback((row + 1) / rows)
        field = cls(
            bounds.min_x_mm,
            bounds.min_y_mm,
            bounds.max_x_mm,
            bounds.max_y_mm,
            columns,
            rows,
            values,
        )
        if smoothing > 0:
            field.smooth(int(smoothing))
        return field

    def smooth(self, radius: int) -> None:
        """Replace every node by the mean of its ``(2r + 1)``-square neighbourhood.

        The elevation tiles carry pixel-scale noise of a metre or two, and at
        this scale that is a fifth of a printed layer: a road draped over it
        flips between layers every few millimetres and prints as a scatter of
        one-layer coins.  A one-cell mean filter halves those on the sample
        city while moving the terrain by a few hundredths of a millimetre
        almost everywhere; only cliffs and the river banks, which the water
        cut re-sharpens anyway, change by more.  The window is clipped at the
        frame, so edge nodes average what is there rather than pulling in
        values from outside.
        """
        radius = int(radius)
        if radius <= 0:
            return
        columns, rows = self.columns, self.rows

        def box(values: List[float], stride: int, count: int, length: int) -> List[float]:
            """Mean along one axis: *count* lines of *length* samples, *stride* apart."""
            out = list(values)
            for line in range(count):
                base = line if stride != 1 else line * length
                for position in range(length):
                    low = max(0, position - radius)
                    high = min(length - 1, position + radius)
                    total = 0.0
                    for other in range(low, high + 1):
                        total += values[base + other * stride]
                    out[base + position * stride] = total / (high - low + 1)
            return out

        along_rows = box(self.values, 1, rows, columns)
        self.values = box(along_rows, columns, columns, rows)

    @classmethod
    def flat(
        cls, transform, height_mm: float = 0.0, resolution: int = 2
    ) -> "ModelHeightField":
        """Return a constant height field, used when DEM terrain is disabled.

        The default 2x2 grid is all a featureless base needs.  A caller that
        intends to cut water out of the base must ask for a real resolution,
        because a cut can only follow the grid it is rasterised onto.
        """
        bounds = transform.model_bounds
        resolution = max(2, min(1024, int(resolution)))
        if bounds.width_mm >= bounds.height_mm:
            columns = resolution
            rows = max(2, int(round(resolution * bounds.height_mm / bounds.width_mm)))
        else:
            rows = resolution
            columns = max(2, int(round(resolution * bounds.width_mm / bounds.height_mm)))
        return cls(
            bounds.min_x_mm,
            bounds.min_y_mm,
            bounds.max_x_mm,
            bounds.max_y_mm,
            columns,
            rows,
            [float(height_mm)] * (columns * rows),
        )

    @property
    def minimum_mm(self) -> float:
        return min(self.values)

    @property
    def maximum_mm(self) -> float:
        return max(self.values)

    @property
    def printed_minimum_mm(self) -> float:
        """The lowest height that survives into the printed solid.

        Once a river is cut away, the lowest grid value belongs to a bed that
        is no longer there, and founding the base on it would silently make the
        model thicker than asked.  A node under water still counts when any
        node of a cell it shares is dry, because shoreline vertices in that cell
        interpolate towards it and the base has to stay below them.
        """
        mask = self.void_mask
        if mask is None or not mask.any_wet:
            return min([self.minimum_mm] + [floor for _bounds, _rings, floor in self.basins])
        lowest = None
        for row in range(self.rows):
            offset = row * self.columns
            for column in range(self.columns):
                if mask.is_wet(column, row) and not self._borders_dry(column, row):
                    continue
                value = self.values[offset + column]
                if lowest is None or value < lowest:
                    lowest = value
        return min([self.minimum_mm if lowest is None else lowest]
                   + [floor for _bounds, _rings, floor in self.basins])

    def _borders_dry(self, column: int, row: int) -> bool:
        mask = self.void_mask
        if mask is None:
            return True
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            x, y = column + dx, row + dy
            if 0 <= x < self.columns and 0 <= y < self.rows and not mask.is_wet(x, y):
                return True
        return False

    @property
    def is_flat(self) -> bool:
        return self.maximum_mm - self.minimum_mm <= 1.0e-6

    @property
    def cell_size_mm(self) -> float:
        return min(
            (self.max_x - self.min_x) / (self.columns - 1),
            (self.max_y - self.min_y) / (self.rows - 1),
        )

    @property
    def step_x(self) -> float:
        return (self.max_x - self.min_x) / (self.columns - 1)

    @property
    def step_y(self) -> float:
        return (self.max_y - self.min_y) / (self.rows - 1)

    def new_void_mask(self) -> WaterMask:
        """Attach an empty cut mask matching this grid, and return it."""
        self.void_mask = WaterMask(
            self.columns, self.rows, self.min_x, self.min_y, self.step_x, self.step_y
        )
        return self.void_mask

    def is_void(self, x: float, y: float) -> bool:
        """Whether this point sits over a region cut out of the terrain solid.

        This is the whole-cell answer, which errs towards reporting water at
        the bank.  See :meth:`over_open_water` for the exact one.
        """
        mask = self.void_mask
        return mask is not None and mask.cell_touches_water(x, y)

    def in_cut_water(self, x: float, y: float) -> bool:
        """Whether the printed terrain has no surface at all under this point.

        The terrain solid is cut along the water outlines themselves, and this
        is judged against the same outlines, so the answer agrees with the
        printed surface exactly -- including channels narrower than a cell.
        """
        mask = self.void_mask
        return mask is not None and mask.contains(x, y)

    def add_support(self, rings: Sequence[Ring]) -> None:
        """Register a footprint that keeps its ground inside the cut."""
        if rings and len(rings[0]) >= 3:
            self._support_rings.append((ring_bounds(rings[0]), [list(r) for r in rings]))

    @property
    def support_count(self) -> int:
        return len(self._support_rings)

    def is_supported(self, x: float, y: float) -> bool:
        """Whether a registered support footprint lies under this point."""
        for (min_x, min_y, max_x, max_y), rings in self._support_rings:
            if min_x <= x <= max_x and min_y <= y <= max_y and point_in_polygon(
                (x, y), rings
            ):
                return True
        return False

    def over_open_water(self, x: float, y: float) -> bool:
        """Exact test: cut water below, and nothing put back to stand on."""
        return self.in_cut_water(x, y) and not self.is_supported(x, y)

    def has_ground(self, x: float, y: float) -> bool:
        """Whether a pier or foundation founded here would reach something.

        Conservative at the bank like :meth:`is_void`, because a pier that
        stops one cell short of the shore is merely missing whereas one hanging
        in the opening is visibly wrong -- unless a support was built there.
        """
        return not self.is_void(x, y) or self.is_supported(x, y)

    def ground_height_mm(self, x: float, y: float) -> float:
        """Terrain height, or the nearest surviving land's height over the cut.

        Under a cut river the field still holds the flattened bed, which is no
        longer printed.  Anchoring anything to it -- a deck whose piece happens
        to end mid-river -- sends that thing down into the opening, so the
        nearest dry node stands in for the ground instead.

        The test is the exact one: a point on the dry side of a shore cell is
        on printed terrain and takes the terrain's own height there, so a road
        running down a bank into the water follows the bank, instead of being
        held at the nearest node's height across the whole cell.
        """
        mask = self.void_mask
        if mask is None or not self.in_cut_water(x, y):
            return self.height_mm(x, y)
        column = int(round((x - self.min_x) / self.step_x))
        row = int(round((y - self.min_y) / self.step_y))
        column = min(max(column, 0), self.columns - 1)
        row = min(max(row, 0), self.rows - 1)
        limit = max(self.columns, self.rows)
        for radius in range(0, limit):
            best = None
            best_distance = None
            for dy in range(-radius, radius + 1):
                r = row + dy
                if not 0 <= r < self.rows:
                    continue
                columns = (
                    range(column - radius, column + radius + 1)
                    if abs(dy) == radius
                    else (column - radius, column + radius)
                )
                for c in columns:
                    if not 0 <= c < self.columns or mask.is_wet(c, r):
                        continue
                    distance = (self.min_x + self.step_x * c - x) ** 2 + (
                        self.min_y + self.step_y * r - y
                    ) ** 2
                    if best_distance is None or distance < best_distance:
                        best_distance = distance
                        best = self.values[r * self.columns + c]
            if best is not None:
                return best
        return self.height_mm(x, y)

    def height_mm(self, x: float, y: float) -> float:
        """Bilinear terrain height, clamped to the grid edge outside bounds."""
        fx = (x - self.min_x) / (self.max_x - self.min_x) * (self.columns - 1)
        fy = (y - self.min_y) / (self.max_y - self.min_y) * (self.rows - 1)
        fx = min(max(fx, 0.0), self.columns - 1.0)
        fy = min(max(fy, 0.0), self.rows - 1.0)
        x0 = int(fx)
        y0 = int(fy)
        x1 = min(x0 + 1, self.columns - 1)
        y1 = min(y0 + 1, self.rows - 1)
        tx = fx - x0
        ty = fy - y0
        values = self.values
        columns = self.columns
        lower = values[y0 * columns + x0] * (1.0 - tx) + values[y0 * columns + x1] * tx
        upper = values[y1 * columns + x0] * (1.0 - tx) + values[y1 * columns + x1] * tx
        height = lower * (1.0 - ty) + upper * ty
        for bounds, rings, floor in self.basins:
            if bounds[0] <= x <= bounds[2] and bounds[1] <= y <= bounds[3] and point_in_polygon((x, y), rings):
                height = min(height, floor)
        return height

    def register_basin(self, rings, floor_mm):
        """Share the actual recessed floor with later ground-aligned geometry."""
        self.basins.append((ring_bounds(rings[0]), rings, floor_mm))

    def minimum_over(self, points: Iterable[Tuple[float, float]]) -> float:
        samples = [self.height_mm(x, y) for x, y in points]
        return min(samples) if samples else 0.0

    def maximum_over(self, points: Iterable[Tuple[float, float]]) -> float:
        samples = [self.height_mm(x, y) for x, y in points]
        return max(samples) if samples else 0.0

    def percentile_over(
        self, points: Iterable[Tuple[float, float]], fraction: float = 0.5
    ) -> float:
        """Return an order statistic of terrain height across *points*.

        Water surfaces are solved with the median of samples taken inside the
        body, which recovers the flat plateau an elevation dataset reports for
        open water while ignoring the noisy cells near its banks.  A mean would
        be dragged by those outliers and the strict minimum by any single bad
        cell.
        """
        samples = sorted(self.height_mm(x, y) for x, y in points)
        if not samples:
            return 0.0
        index = int(max(0.0, min(1.0, fraction)) * (len(samples) - 1))
        return samples[index]

    def lower_inside(
        self, rings: Sequence[Sequence[Tuple[float, float]]], level_mm: float
    ) -> int:
        """Clamp every grid node inside a polygon down to *level_mm*.

        This is hydro-flattening.  An elevation dataset reports open water as a
        noisy near-flat plateau, and over a river that noise is metres tall: it
        pokes islands of terrain up through the water surface and leaves thin
        spikes inside the channel that are neither true nor printable.  Where a
        source polygon says "this is water", the terrain beneath it is carved
        down to the solved surface instead of being trusted.

        Only lowering is applied, never raising, so a bank that the polygon
        overlaps slightly is left alone rather than being flooded.
        """
        from .planar import point_in_polygon, ring_bounds

        if not rings or len(rings[0]) < 3:
            return 0
        min_x, min_y, max_x, max_y = ring_bounds(rings[0])
        step_x = (self.max_x - self.min_x) / (self.columns - 1)
        step_y = (self.max_y - self.min_y) / (self.rows - 1)
        first_column = max(0, int((min_x - self.min_x) / step_x))
        last_column = min(self.columns - 1, int((max_x - self.min_x) / step_x) + 1)
        first_row = max(0, int((min_y - self.min_y) / step_y))
        last_row = min(self.rows - 1, int((max_y - self.min_y) / step_y) + 1)

        lowered = 0
        for row in range(first_row, last_row + 1):
            y = self.min_y + step_y * row
            offset = row * self.columns
            for column in range(first_column, last_column + 1):
                index = offset + column
                if self.values[index] <= level_mm:
                    continue
                x = self.min_x + step_x * column
                if point_in_polygon((x, y), rings):
                    self.values[index] = level_mm
                    lowered += 1
        return lowered

    def rows_2d(self) -> List[List[float]]:
        """Return the grid as row-major nested lists for mesh construction."""
        return [
            self.values[row * self.columns : (row + 1) * self.columns]
            for row in range(self.rows)
        ]

    def sample_ring(
        self, ring: Sequence[Tuple[float, float]]
    ) -> List[Tuple[float, float, float]]:
        """Return ``(x, y, terrain_z)`` for each ring vertex."""
        return [(x, y, self.height_mm(x, y)) for x, y in ring]
