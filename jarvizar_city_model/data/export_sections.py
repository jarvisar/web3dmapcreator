"""Print-space grid shared by all layers of a cropped miniature (no bpy)."""

from dataclasses import dataclass
import math


BAMBU_MAX_PLATES = 36
# Bambu PartPlateList: virtual plates are one bed apart plus a fifth of a bed
# (LOGICAL_PART_PLATE_GAP), in columns of ceil(sqrt(count)), rows downward.
PLATE_STRIDE = 1.2


@dataclass(frozen=True)
class Section:
    row: int
    column: int
    bounds: tuple  # west, south, east, north, in grid millimetres
    tolerance: float = 1e-6
    # Heading of the grid's X axis in world XY, radians counter-clockwise from
    # east. Grid coordinates are world XY rotated by -angle.
    angle: float = 0.0

    @property
    def name(self):
        return f"Section R{self.row} C{self.column}"


def grid_angle(ring):
    """Heading of an outline's dominant edge direction, folded into (-45, 45] degrees.

    Every edge votes with its length for its heading modulo 90 degrees, so a
    rectangle aligns the grid exactly whether it was rotated as an object or
    in its mesh data, and a bevelled rectangle still follows its long edges.
    Outlines without a dominant direction, such as circles, keep world
    east/north. An axis-aligned outline returns exactly 0.
    """
    real = imag = total = 0.0
    for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        if length <= 0:
            continue
        # (dx + i dy)^4 / |d|^3: four times the heading, weighted by length.
        # Products keep an axis-aligned edge's imaginary part exactly zero.
        real += (dx ** 4 - 6 * dx * dx * dy * dy + dy ** 4) / length ** 3
        imag += 4 * (dx ** 3 * dy - dx * dy ** 3) / length ** 3
        total += length
    if total <= 0 or math.hypot(real, imag) < 0.25 * total:
        return 0.0
    angle = math.atan2(imag, real) / 4
    return 0.0 if abs(angle) < 1e-9 else angle


def section_grid(bounds, max_width=210.0, max_height=210.0, *,
                 plate_width=256.0, plate_depth=256.0, angle=0.0):
    """Equal rectangles, north to south then west to east; no skinny remainder.

    ``bounds`` are grid coordinates: world XY rotated by ``-angle``. Compute
    each edge once. Adjacent cells reference precisely the same float, with no
    clearance or independent rounding at a seam.
    """
    if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds):
        raise ValueError("The final cutout must have finite dimensions")
    if not all(math.isfinite(v) and v > 0 for v in (plate_width, plate_depth)):
        raise ValueError("The printer bed must have positive dimensions")
    if not all(math.isfinite(v) and v > 0 for v in (max_width, max_height)):
        raise ValueError("Maximum section dimensions must be greater than 0")
    if max_width > plate_width or max_height > plate_depth:
        raise ValueError(f"Maximum section dimensions exceed the {plate_width:g} x {plate_depth:g} mm bed")
    if not math.isfinite(angle):
        raise ValueError("The section grid needs a finite rotation")
    west, south, east, north = bounds
    if east <= west or north <= south:
        raise ValueError("The final cutout must have nonzero width and height")
    columns = math.ceil((east - west) / max_width)
    rows = math.ceil((north - south) / max_height)
    if rows * columns > BAMBU_MAX_PLATES:
        raise ValueError(f"The cutout needs a {rows} x {columns} grid; Bambu Studio supports "
                         f"at most {BAMBU_MAX_PLATES} plates. Increase the maximum section dimensions")
    xs = [west + (east - west) * i / columns for i in range(columns)] + [east]
    ys = [north - (north - south) * i / rows for i in range(rows)] + [south]
    # All cells must snap near-plane vertices using the *same* tolerance.
    tolerance = max(1.0, *(abs(v) for v in bounds), east - west, north - south) * 8e-7
    return [Section(r + 1, c + 1, (xs[c], ys[r + 1], xs[c + 1], ys[r]), tolerance, angle)
            for r in range(rows) for c in range(columns)]


def plate_origin(index, count, plate_width=256.0, plate_depth=256.0):
    """Bambu PartPlateList: ceil(sqrt(count)) columns, 20% bed spacing, rows downward."""
    columns = math.ceil(math.sqrt(count))
    return (index % columns * plate_width * PLATE_STRIDE,
            -(index // columns) * plate_depth * PLATE_STRIDE)
