"""Which parts of the terrain are cut away as open water.

The terrain is cut along the water outlines themselves, so the questions asked
about the cut have to be answered against those outlines too: a channel
narrower than a terrain cell is still a hole in the print, even though no grid
node lies in it.  Two answers are kept.

* Every grid node is marked wet or dry by scanline, once across the rows.  The
  flattened river bed, the base thickness and the nearest-bank height all read
  these node bits.
* Every outline edge is filed under the grid rows it spans, and every cell it
  passes through is flagged.  A point in a cell no outline crosses has the
  state of that cell's corners; anywhere else it is tested against only the
  edges filed under its own row.  That keeps the exact test to a handful of
  edge checks rather than a walk around the whole river for every vertex of
  every riverside road.

Water polygons are united.  Footprints removed afterwards -- a pier, a quay, a
boathouse -- keep their ground inside that union.

All functions here are pure and Blender-free.
"""

from __future__ import annotations

import math
from typing import Dict, List, Sequence, Tuple

Point = Tuple[float, float]
Ring = Sequence[Point]

# Outline extents are widened by this fraction of a cell before flagging cells,
# so an edge lying exactly on a grid line flags the cells on both sides of it.
_CELL_MARGIN = 1.0e-6
_WATER_EDGE = 1
_GROUND_EDGE = 2
# A point this close to a kept-ground edge lies on it: far below float32 mesh
# precision, far above the rounding of a point interpolated along the edge.
_ON_EDGE = 1.0e-9


def _on_segment(x: float, y: float, ax: float, ay: float, bx: float, by: float) -> bool:
    if not (min(ax, bx) - _ON_EDGE <= x <= max(ax, bx) + _ON_EDGE
            and min(ay, by) - _ON_EDGE <= y <= max(ay, by) + _ON_EDGE):
        return False
    return abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) <= _ON_EDGE * math.hypot(bx - ax, by - ay)


def _line_crossings(rings: Sequence[Ring], value: float) -> List[float]:
    """Return where the horizontal line ``y = value`` meets *rings*, sorted.

    The half-open comparison counts a vertex exactly on the line once rather
    than twice, so parity stays correct where an edge ends on the scanline.
    """
    crossings: List[float] = []
    for ring in rings:
        count = len(ring)
        if count < 3:
            continue
        previous = ring[-1]
        for index in range(count):
            current = ring[index]
            a = previous[1]
            b = current[1]
            if (a <= value) != (b <= value):
                t = (value - a) / (b - a)
                crossings.append(previous[0] + t * (current[0] - previous[0]))
            previous = current
    crossings.sort()
    return crossings


class WaterMask:
    """Grid nodes under water, plus the exact outlines of the cut."""

    def __init__(
        self,
        columns: int,
        rows: int,
        min_x: float,
        min_y: float,
        step_x: float,
        step_y: float,
    ) -> None:
        if columns < 2 or rows < 2:
            raise ValueError("Water mask needs at least a 2x2 grid")
        if step_x <= 0.0 or step_y <= 0.0:
            raise ValueError("Water mask needs positive grid steps")
        self.columns = int(columns)
        self.rows = int(rows)
        self.min_x = float(min_x)
        self.min_y = float(min_y)
        self.step_x = float(step_x)
        self.step_y = float(step_y)
        self.max_x = self.min_x + self.step_x * (self.columns - 1)
        self.max_y = self.min_y + self.step_y * (self.rows - 1)
        self.wet = bytearray(self.columns * self.rows)
        self.polygons = 0
        # The polygons that define the cut, exactly as the terrain solid uses them.
        self.water_polygons: List[List[List[Point]]] = []
        self.ground_polygons: List[List[List[Point]]] = []
        self._is_water: List[bool] = []
        # Row band -> (polygon, ax, ay, bx, by) for every edge spanning it.
        self._bands: Dict[int, List[Tuple[int, float, float, float, float]]] = {}
        # Cell index -> which kinds of outline pass through the cell.
        self._outline_cells: Dict[int, int] = {}

    # ------------------------------------------------------------------ build

    def add_polygon(self, rings: Sequence[Ring]) -> int:
        """Unite one polygon-with-holes with the water. Returns nodes newly marked."""
        if self.ground_polygons:
            raise ValueError("Water must be added before ground is restored")
        return self._add(rings, water=True)

    def remove_polygon(self, rings: Sequence[Ring]) -> bool:
        """Keep the ground under one polygon-with-holes. Returns whether it met water.

        Some mapped surfaces are ground even though they sit out over water --
        a pier, a quay, a river dam.  The source maps the bank along the shore
        and the structure separately, so without this the cut runs straight
        under the pier and everything standing on it is left over a hole.
        A footprint clear of the water is ignored, so dry buildings add no
        outline edges to the queries.
        """
        return self._add(rings, water=False) > 0

    def _add(self, rings: Sequence[Ring], water: bool) -> int:
        if not rings or len(rings[0]) < 3:
            return 0
        usable = [[(float(x), float(y)) for x, y in ring] for ring in rings if len(ring) >= 3]
        window = self._window(usable[0])
        if window is None:
            return 0
        if not water and not self._window_has_water(window):
            return 0
        polygon = len(self._is_water)
        self._is_water.append(water)
        (self.water_polygons if water else self.ground_polygons).append(usable)
        self.polygons += 1
        changed = self._scan_rows(usable, window, 1 if water else 0)
        self._file_edges(usable, polygon, _WATER_EDGE if water else _GROUND_EDGE)
        return changed if water else max(changed, 1)

    def _window(self, ring: Ring):
        """Return the grid rows and columns a ring can possibly touch.

        Scanning the whole grid for every feature would make a few hundred
        small ponds cost as much as the river.  One extra line of margin keeps
        a boundary cell inside the window.
        """
        xs = [point[0] for point in ring]
        ys = [point[1] for point in ring]
        first_row = max(0, int(math.floor((min(ys) - self.min_y) / self.step_y)) - 1)
        last_row = min(self.rows - 1, int(math.ceil((max(ys) - self.min_y) / self.step_y)) + 1)
        first_column = max(0, int(math.floor((min(xs) - self.min_x) / self.step_x)) - 1)
        last_column = min(self.columns - 1, int(math.ceil((max(xs) - self.min_x) / self.step_x)) + 1)
        if first_row > last_row or first_column > last_column:
            return None
        return first_row, last_row, first_column, last_column

    def _window_has_water(self, window) -> bool:
        first_row, last_row, first_column, last_column = window
        for row in range(first_row, last_row + 1):
            offset = row * self.columns
            if 1 in self.wet[offset + first_column : offset + last_column + 1]:
                return True
        cells = self.columns - 1
        for row in range(first_row, min(last_row, self.rows - 2) + 1):
            for column in range(first_column, min(last_column, self.columns - 2) + 1):
                if self._outline_cells.get(row * cells + column, 0) & _WATER_EDGE:
                    return True
        return False

    def _scan_rows(self, rings: Sequence[Ring], window, target: int) -> int:
        first_row, last_row, first_column, last_column = window
        changed = 0
        for row in range(first_row, last_row + 1):
            crossings = _line_crossings(rings, self.min_y + self.step_y * row)
            offset = row * self.columns
            for index in range(0, len(crossings) - 1, 2):
                first = int(math.ceil((crossings[index] - self.min_x) / self.step_x))
                last = int(math.floor((crossings[index + 1] - self.min_x) / self.step_x))
                for column in range(max(first_column, first), min(last_column, last) + 1):
                    if self.wet[offset + column] != target:
                        self.wet[offset + column] = target
                        changed += 1
        return changed

    def _file_edges(self, rings: Sequence[Ring], polygon: int, flag: int) -> None:
        """File each edge under the row bands it spans and flag the cells it crosses."""
        cells = self.columns - 1
        last_band = self.rows - 2
        last_column = self.columns - 2
        for ring in rings:
            previous = ring[-1]
            for current in ring:
                (ax, ay), (bx, by) = previous, current
                previous = current
                low = (min(ay, by) - self.min_y) / self.step_y
                high = (max(ay, by) - self.min_y) / self.step_y
                first = max(0, int(math.floor(low - _CELL_MARGIN)))
                last = min(last_band, int(math.floor(high + _CELL_MARGIN)))
                for band in range(first, last + 1):
                    self._bands.setdefault(band, []).append((polygon, ax, ay, bx, by))
                    if ay == by:
                        left, right = min(ax, bx), max(ax, bx)
                    else:
                        bottom = self.min_y + self.step_y * band
                        t0 = min(max((bottom - ay) / (by - ay), 0.0), 1.0)
                        t1 = min(max((bottom + self.step_y - ay) / (by - ay), 0.0), 1.0)
                        x0 = ax + t0 * (bx - ax)
                        x1 = ax + t1 * (bx - ax)
                        left, right = min(x0, x1), max(x0, x1)
                    start = max(0, int(math.floor((left - self.min_x) / self.step_x - _CELL_MARGIN)))
                    end = min(last_column, int(math.floor((right - self.min_x) / self.step_x + _CELL_MARGIN)))
                    offset = band * cells
                    for column in range(start, end + 1):
                        self._outline_cells[offset + column] = self._outline_cells.get(offset + column, 0) | flag

    # ------------------------------------------------------------------ query

    @property
    def any_wet(self) -> bool:
        return 1 in self.wet

    @property
    def wet_nodes(self) -> int:
        return sum(self.wet)

    def is_wet(self, column: int, row: int) -> bool:
        if not (0 <= column < self.columns and 0 <= row < self.rows):
            return False
        return bool(self.wet[row * self.columns + column])

    def cell_of(self, x: float, y: float) -> Tuple[int, int]:
        """Return the ``(column, row)`` of the cell holding a point, clamped to the grid."""
        column = int(math.floor((x - self.min_x) / self.step_x))
        row = int(math.floor((y - self.min_y) / self.step_y))
        return min(max(column, 0), self.columns - 2), min(max(row, 0), self.rows - 2)

    def contains(self, x: float, y: float) -> bool:
        """Whether a point is cut away: inside the water and not on kept ground.

        This is the exact answer, judged against the same outlines the
        terrain solid is cut along.  Points beyond the frame are clamped to it.
        """
        x = min(max(x, self.min_x), self.max_x)
        y = min(max(y, self.min_y), self.max_y)
        column, row = self.cell_of(x, y)
        if not self._outline_cells.get(row * (self.columns - 1) + column):
            # Nothing crosses this cell, so its corners all share its state.
            return self.is_wet(column, row)
        inside: Dict[int, bool] = {}
        for polygon, ax, ay, bx, by in self._bands.get(row, ()):
            if not self._is_water[polygon] and _on_segment(x, y, ax, ay, bx, by):
                # Kept ground includes its own outline, so a footprint sampled
                # along its edges is not judged partly over the water.
                return False
            if (ay <= y) != (by <= y) and ax + (y - ay) * (bx - ax) / (by - ay) > x:
                inside[polygon] = not inside.get(polygon, False)
        water = ground = False
        for polygon, odd in inside.items():
            if odd:
                if self._is_water[polygon]:
                    water = True
                else:
                    ground = True
        return water and not ground

    def cell_wet_corners(self, x: float, y: float) -> int:
        """Return how many corners of the cell containing ``(x, y)`` are wet."""
        column, row = self.cell_of(x, y)
        return (
            int(self.is_wet(column, row))
            + int(self.is_wet(column + 1, row))
            + int(self.is_wet(column, row + 1))
            + int(self.is_wet(column + 1, row + 1))
        )

    def cell_touches_water(self, x: float, y: float) -> bool:
        """Whether the grid cell containing ``(x, y)`` has any water in it.

        Used to keep bridge piers and other ground-founded geometry out of a
        region that has been cut away.  It errs towards reporting water at the
        bank, because a pier that stops one cell short of the shore is merely
        missing whereas one standing in the void is visibly wrong.  A wet
        corner or a water outline crossing the cell both count, so a channel
        narrower than a cell is seen as well.
        """
        column, row = self.cell_of(x, y)
        if self._outline_cells.get(row * (self.columns - 1) + column, 0) & _WATER_EDGE:
            return True
        return self.cell_wet_corners(x, y) > 0

    def touches_water(self, rings: Sequence[Ring]) -> bool:
        """Whether any water lies inside a polygon's grid window."""
        usable = [ring for ring in rings if len(ring) >= 3]
        if not usable:
            return False
        window = self._window(usable[0])
        return window is not None and self._window_has_water(window)
