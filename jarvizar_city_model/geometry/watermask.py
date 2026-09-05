"""Which parts of the terrain grid are open water, and where the shore crosses it.

Cutting a river out of the terrain solid needs two things the height field on
its own does not carry: which grid nodes lie under water, and where exactly the
bank crosses each grid line.  Without the second, the cut can only follow whole
cells and the riverbank comes out as a staircase with steps the size of a
terrain cell -- roughly two millimetres on a city selection, which is glaring
next to a 0.45 mm road.

Testing every node against every polygon edge would be quadratic.  Instead each
polygon is rasterised by scanline: once across the rows and once down the
columns.  That costs one pass over the edges per grid line, and the exact
crossing positions fall out of the same pass, so the shoreline can be placed
where it really is at no extra cost.

All functions here are pure and Blender-free.
"""

from __future__ import annotations

import math
from typing import Dict, List, Sequence, Tuple

Point = Tuple[float, float]
Ring = Sequence[Point]

# A shoreline crossing is pulled this far away from the grid node it lands on,
# as a fraction of the cell.  A crossing exactly on a node would produce two
# vertices at the same position and a zero-area face between them, which is
# precisely the kind of degenerate the terrain solid must never contain.
SHORE_INSET = 0.02


def _line_crossings(rings: Sequence[Ring], value: float, axis: int) -> List[float]:
    """Return where the horizontal or vertical line at *value* meets *rings*.

    *axis* 1 scans a horizontal line (constant y) and returns x positions;
    axis 0 scans a vertical line (constant x) and returns y positions.  The
    half-open comparison counts a vertex exactly on the line once rather than
    twice, so parity stays correct where an edge ends on the scanline.
    """
    other = 1 - axis
    crossings: List[float] = []
    for ring in rings:
        count = len(ring)
        if count < 3:
            continue
        previous = ring[-1]
        for index in range(count):
            current = ring[index]
            a = previous[axis]
            b = current[axis]
            if (a <= value) != (b <= value):
                span = b - a
                if span != 0.0:
                    t = (value - a) / span
                    crossings.append(previous[other] + t * (current[other] - previous[other]))
            previous = current
    crossings.sort()
    return crossings


class WaterMask:
    """Grid nodes under water, plus the shoreline's exact grid-line crossings."""

    def __init__(
        self,
        columns: int,
        rows: int,
        min_x: float,
        min_y: float,
        step_x: float,
        step_y: float,
        prefer_dry_end: bool = False,
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
        self.wet = bytearray(self.columns * self.rows)
        self.polygons = 0
        # Which recorded crossing a mixed edge transitions at.  The terrain
        # takes the one nearest the *wet* node: only water is ever added and
        # what is taken back out (a pier) extends the land, so the far
        # crossing keeps the most land.  A mask built the other way round --
        # a slab taken out of an all-wet grid and the water put back in over
        # it -- must take the crossing nearest the *dry* node, because from
        # the dry node whichever outline is met first ends the dry run, and
        # the far one would stretch the slab out over the water.
        self.prefer_dry_end = bool(prefer_dry_end)
        # Crossings bucketed by the grid edge they land on.  A horizontal key
        # is the edge between nodes (row, column) and (row, column + 1).
        self._row_crossings: Dict[Tuple[int, int], List[float]] = {}
        self._column_crossings: Dict[Tuple[int, int], List[float]] = {}
        self._dry_polygons: Dict[Tuple[int, int], List[Point]] = {}

    # ------------------------------------------------------------------ build

    def add_polygon(self, rings: Sequence[Ring]) -> int:
        """Mark one polygon-with-holes as water. Returns nodes newly marked."""
        return self._rasterise(rings, wet=True)

    def fill_wet(self) -> None:
        """Mark every node wet, recording no shoreline.

        A slab that must be clipped to dry land starts from an all-wet mask,
        takes its own outline back out, and then has the water cut through it
        again.  Starting from a rectangle polygon instead would put crossings
        exactly on the frame's edge nodes, which is the one place a crossing
        must never sit.
        """
        self.wet = bytearray(b"\x01") * (self.columns * self.rows)
        self._dry_polygons.clear()

    def remove_polygon(self, rings: Sequence[Ring]) -> int:
        """Mark one polygon-with-holes back as dry land. Returns nodes cleared.

        Some mapped surfaces are ground even though they sit out over water --
        a pier, a quay, a river dam.  The source maps the bank along the shore
        and the structure separately, so without this the cut runs straight
        under the pier and everything standing on it is left over a hole.
        """
        return self._rasterise(rings, wet=False)

    def _rasterise(self, rings: Sequence[Ring], wet: bool) -> int:
        if not rings or len(rings[0]) < 3:
            return 0
        usable = [ring for ring in rings if len(ring) >= 3]
        if not usable:
            return 0
        window = self._window(usable[0])
        if window is None:
            return 0
        if not wet and not self._window_has_water(window):
            # Nothing to take back, and recording this polygon's crossings would
            # only add candidate shorelines on edges that belong to the river.
            return 0
        self.polygons += 1
        self._dry_polygons.clear()
        changed = self._scan_rows(usable, window, wet)
        self._scan_columns(usable, window)
        return changed

    def _window(self, ring: Ring):
        """Return the grid rows and columns a ring can possibly touch.

        Scanning the whole grid for every feature would make a few hundred
        small ponds cost as much as the river.  One extra line of margin keeps
        the crossing on a boundary cell inside the window.
        """
        xs = [point[0] for point in ring]
        ys = [point[1] for point in ring]
        first_row = int(math.floor((min(ys) - self.min_y) / self.step_y)) - 1
        last_row = int(math.ceil((max(ys) - self.min_y) / self.step_y)) + 1
        first_column = int(math.floor((min(xs) - self.min_x) / self.step_x)) - 1
        last_column = int(math.ceil((max(xs) - self.min_x) / self.step_x)) + 1
        first_row = max(0, first_row)
        last_row = min(self.rows - 1, last_row)
        first_column = max(0, first_column)
        last_column = min(self.columns - 1, last_column)
        if first_row > last_row or first_column > last_column:
            return None
        return first_row, last_row, first_column, last_column

    def _window_has_water(self, window) -> bool:
        first_row, last_row, first_column, last_column = window
        for row in range(first_row, last_row + 1):
            offset = row * self.columns
            if 1 in self.wet[offset + first_column : offset + last_column + 1]:
                return True
        return False

    def _scan_rows(self, rings: Sequence[Ring], window, wet: bool) -> int:
        first_row, last_row, first_column, last_column = window
        target = 1 if wet else 0
        changed = 0
        for row in range(first_row, last_row + 1):
            y = self.min_y + self.step_y * row
            crossings = _line_crossings(rings, y, axis=1)
            if not crossings:
                continue
            for x in crossings:
                column = int(math.floor((x - self.min_x) / self.step_x))
                if 0 <= column < self.columns - 1:
                    self._row_crossings.setdefault((row, column), []).append(x)
            offset = row * self.columns
            for index in range(0, len(crossings) - 1, 2):
                left, right = crossings[index], crossings[index + 1]
                first = int(math.ceil((left - self.min_x) / self.step_x))
                last = int(math.floor((right - self.min_x) / self.step_x))
                for column in range(
                    max(first_column, first), min(last_column, last) + 1
                ):
                    if self.wet[offset + column] != target:
                        self.wet[offset + column] = target
                        changed += 1
        return changed

    def _scan_columns(self, rings: Sequence[Ring], window) -> None:
        """Record crossings on vertical grid lines. Wetness is already known."""
        _first_row, _last_row, first_column, last_column = window
        for column in range(first_column, last_column + 1):
            x = self.min_x + self.step_x * column
            for y in _line_crossings(rings, x, axis=0):
                row = int(math.floor((y - self.min_y) / self.step_y))
                if 0 <= row < self.rows - 1:
                    self._column_crossings.setdefault((row, column), []).append(y)

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

    def cell_dry_polygon(self, column: int, row: int) -> List[Point]:
        """Return the dry part of one cell, exactly as the terrain solid builds it.

        The corners are walked counter-clockwise, a dry corner is kept, and
        the recorded shoreline crossing is inserted wherever the state changes
        -- the same Sutherland-Hodgman walk the terrain mesh performs, using
        the same crossings.  A point judged against this polygon is therefore
        judged against the printed surface itself.  A whole cell returns its
        four corners and a removed cell returns nothing.
        """
        key = (column, row)
        polygon = self._dry_polygons.get(key)
        if polygon is not None:
            return polygon
        corners = (
            (row, column),
            (row, column + 1),
            (row + 1, column + 1),
            (row + 1, column),
        )
        flags = [self.is_wet(c, r) for r, c in corners]
        polygon = []
        for index in range(4):
            following = (index + 1) % 4
            r, c = corners[index]
            if not flags[index]:
                polygon.append((self.min_x + self.step_x * c, self.min_y + self.step_y * r))
            if flags[index] != flags[following]:
                polygon.append(
                    self._crossing_point(corners[index], corners[following], flags[index])
                )
        self._dry_polygons[key] = polygon
        return polygon

    def _crossing_point(self, corner, other, corner_wet: bool) -> Point:
        """The shoreline vertex on the grid edge between two nodes, as ``(x, y)``."""
        (row_a, column_a), (row_b, column_b) = corner, other
        if row_a == row_b:
            column = min(column_a, column_b)
            wet_on_left = corner_wet if column_a < column_b else not corner_wet
            return (
                self.row_crossing(row_a, column, wet_on_left),
                self.min_y + self.step_y * row_a,
            )
        row = min(row_a, row_b)
        wet_below = corner_wet if row_a < row_b else not corner_wet
        return (
            self.min_x + self.step_x * column_a,
            self.column_crossing(row, column_a, wet_below),
        )

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
        """Whether the grid cell containing ``(x, y)`` has any wet corner.

        Used to keep bridge piers and other ground-founded geometry out of a
        region that has been cut away.  It errs towards reporting water at the
        bank, because a pier that stops one cell short of the shore is merely
        missing whereas one standing in the void is visibly wrong.
        """
        return self.cell_wet_corners(x, y) > 0

    def touches_water(self, rings: Sequence[Ring]) -> bool:
        """Whether any node inside a polygon's grid window is currently wet."""
        usable = [ring for ring in rings if len(ring) >= 3]
        if not usable:
            return False
        window = self._window(usable[0])
        return window is not None and self._window_has_water(window)

    def row_crossing(self, row: int, column: int, wet_on_left: bool) -> float:
        """Return the shore's x on the horizontal edge right of ``(row, column)``.

        The edge is known to be mixed, so the transition sits at the recorded
        crossing nearest the wet end.  A mixed edge with no recorded crossing
        can only come from a rounding disagreement between the scan and the
        caller's own wetness bits, and the cell midpoint is the honest answer.
        """
        low = self.min_x + self.step_x * column
        values = self._row_crossings.get((row, column))
        if not values:
            position = low + self.step_x * 0.5
        elif wet_on_left != self.prefer_dry_end:
            position = min(values)
        else:
            position = max(values)
        return _inset(position, low, self.step_x)

    def column_crossing(self, row: int, column: int, wet_below: bool) -> float:
        """Return the shore's y on the vertical edge above ``(row, column)``."""
        low = self.min_y + self.step_y * row
        values = self._column_crossings.get((row, column))
        if not values:
            position = low + self.step_y * 0.5
        elif wet_below != self.prefer_dry_end:
            position = min(values)
        else:
            position = max(values)
        return _inset(position, low, self.step_y)


def _inset(position: float, low: float, step: float) -> float:
    """Clamp a crossing into the cell, held clear of both grid nodes."""
    return min(max(position, low + step * SHORE_INSET), low + step * (1.0 - SHORE_INSET))
