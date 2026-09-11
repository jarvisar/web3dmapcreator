"""Print-space grid shared by all layers of a cropped miniature (no bpy)."""

from dataclasses import dataclass
import math


BAMBU_PLATE_SIZE = 256.0
BAMBU_MAX_PLATES = 36


@dataclass(frozen=True)
class Section:
    row: int
    column: int
    bounds: tuple  # west, south, east, north, in model millimetres
    tolerance: float = 1e-6

    @property
    def name(self):
        return f"Section R{self.row} C{self.column}"


def section_grid(bounds, max_width=210.0, max_height=210.0):
    """Equal rectangles, north to south then west to east; no skinny remainder.

    Compute each edge once. Adjacent cells reference precisely the same float,
    with no clearance or independent rounding at a seam.
    """
    if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds):
        raise ValueError("The final cutout must have finite dimensions")
    if not all(math.isfinite(v) and 0 < v <= BAMBU_PLATE_SIZE
               for v in (max_width, max_height)):
        raise ValueError("Maximum section dimensions must be greater than 0 and at most 256 mm")
    west, south, east, north = bounds
    if east <= west or north <= south:
        raise ValueError("The final cutout must have nonzero width and height")
    columns = math.ceil((east - west) / max_width)
    rows = math.ceil((north - south) / max_height)
    if rows * columns > BAMBU_MAX_PLATES:
        raise ValueError(f"The cutout needs a {rows} x {columns} grid; Bambu Studio supports "
                         "at most 36 plates. Increase the maximum section dimensions")
    xs = [west + (east - west) * i / columns for i in range(columns)] + [east]
    ys = [north - (north - south) * i / rows for i in range(rows)] + [south]
    # All cells must snap near-plane vertices using the *same* tolerance.
    tolerance = max(1.0, *(abs(v) for v in bounds), east - west, north - south) * 8e-7
    return [Section(r + 1, c + 1, (xs[c], ys[r + 1], xs[c + 1], ys[r]), tolerance)
            for r in range(rows) for c in range(columns)]


def plate_origin(index, count):
    """Bambu PartPlateList: ceil(sqrt(count)) columns, 20% bed spacing."""
    columns = math.ceil(math.sqrt(count))
    stride = BAMBU_PLATE_SIZE * 1.2
    return (index % columns * stride, -(index // columns) * stride)
