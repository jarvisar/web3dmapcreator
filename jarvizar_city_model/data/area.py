"""Real size of a bounding box, and boxes of a chosen size around a point (no ``bpy``).

Sizes are measured the way the model transform measures them: the local ENU
extent of the box's perimeter (:mod:`data.projection`). A box made here for a
print size therefore generates at that size.
"""

from __future__ import annotations

from functools import lru_cache
import math
from urllib.parse import urlencode

from .projection import (
    WGS84_ECCENTRICITY_SQUARED,
    WGS84_SEMI_MAJOR_AXIS_M,
    LocalENUProjection,
    WGS84Bounds,
    format_degrees,
)

# The elevation tiles are Web Mercator and end here; data/dem.py clamps to it.
MAX_LATITUDE = 85.05112878
MIN_SIDE_M = 1.0
MAX_SIDE_M = 1_000_000.0
# Per side. 200 x 200 mm on a 256 mm bed also clears the 18 x 28 mm
# front-left exclusion zone of P1 and X1 printers.
BED_MARGIN_MM = 28.0
LARGE_AREA_KM2 = 50.0
SMALL_PRINT_MM = 25.0

OSM_URL = "https://www.openstreetmap.org/"
BBOXFINDER_URL = "https://bboxfinder.com/"


def _finite(value, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number") from None
    if not math.isfinite(number):
        raise ValueError(f"{name} must be a finite number")
    return number


@lru_cache(maxsize=256)
def _extent(west: float, south: float, east: float, north: float) -> tuple[float, float]:
    metric = LocalENUProjection(WGS84Bounds(west, south, east, north)).horizontal_bounds()
    return metric.width_m, metric.height_m


def real_size_m(bounds: WGS84Bounds) -> tuple[float, float]:
    """East-west and north-south extent in metres, as the model transform measures it."""
    return _extent(bounds.west, bounds.south, bounds.east, bounds.north)


def real_area_km2(bounds: WGS84Bounds) -> float:
    width_m, height_m = real_size_m(bounds)
    return width_m * height_m / 1e6


def model_size_mm(width_m: float, height_m: float, mm_per_metre: float | None = None,
                  target_mm: tuple[float, float] | None = None,
                  preserve_aspect: bool = True) -> tuple[float, float, float]:
    """Printed width, height and horizontal scale in mm per metre.

    ``mm_per_metre`` is the fixed print scale; without it the size is fitted
    into ``target_mm`` as :class:`data.projection.MiniatureTransform` does.
    """
    if mm_per_metre is not None:
        return width_m * mm_per_metre, height_m * mm_per_metre, mm_per_metre
    target_width, target_height = target_mm
    fit_x, fit_y = target_width / width_m, target_height / height_m
    if preserve_aspect:
        scale = min(fit_x, fit_y)
        return width_m * scale, height_m * scale, scale
    return target_width, target_height, fit_x


def bounds_around(latitude, longitude, width_m, height_m) -> WGS84Bounds:
    """The box centred on a point whose real size is ``width_m`` x ``height_m``.

    Starts from the ellipsoid's radii of curvature, then corrects against the
    transform's own measurement until they agree. An edge beyond
    ``MAX_LATITUDE`` is held there and the other edge moves to keep the size.
    A box crossing the 180th meridian is refused.
    """
    lat = _finite(latitude, "Latitude")
    lon = _finite(longitude, "Longitude")
    if not -MAX_LATITUDE <= lat <= MAX_LATITUDE:
        raise ValueError(f"Latitude must be between -{MAX_LATITUDE:.2f} and {MAX_LATITUDE:.2f} degrees")
    if not -180.0 <= lon <= 180.0:
        raise ValueError("Longitude must be between -180 and 180 degrees")
    width = _finite(width_m, "Width")
    height = _finite(height_m, "Height")
    if min(width, height) < MIN_SIDE_M:
        raise ValueError(f"Width and height must be at least {MIN_SIDE_M:.0f} m")
    if max(width, height) > MAX_SIDE_M:
        raise ValueError(f"Width and height are limited to {MAX_SIDE_M / 1000:.0f} km")

    sin_lat = math.sin(math.radians(lat))
    curvature = 1.0 - WGS84_ECCENTRICITY_SQUARED * sin_lat * sin_lat
    meridian_m = WGS84_SEMI_MAJOR_AXIS_M * (1.0 - WGS84_ECCENTRICITY_SQUARED) / curvature ** 1.5
    parallel_m = WGS84_SEMI_MAJOR_AXIS_M / math.sqrt(curvature) * math.cos(math.radians(lat))
    half_height = math.degrees(height / meridian_m) / 2.0
    half_width = math.degrees(width / parallel_m) / 2.0
    for _ in range(12):
        west, east = lon - half_width, lon + half_width
        if west < -180.0 or east > 180.0:
            raise ValueError("The area would cross the 180th meridian, which is not supported; "
                             "move the centre or make the area narrower")
        south, north = lat - half_height, lat + half_height
        if north > MAX_LATITUDE:
            north = MAX_LATITUDE
            south = north - 2.0 * half_height
        elif south < -MAX_LATITUDE:
            south = -MAX_LATITUDE
            north = south + 2.0 * half_height
        bounds = WGS84Bounds(west, south, east, north)
        actual_width, actual_height = real_size_m(bounds)
        width_ratio, height_ratio = width / actual_width, height / actual_height
        if abs(width_ratio - 1.0) < 1e-10 and abs(height_ratio - 1.0) < 1e-10:
            break
        half_width *= width_ratio
        half_height *= height_ratio
    return bounds


def rounded(bounds: WGS84Bounds, decimals: int = 7) -> WGS84Bounds:
    """The box as the text fields or a preset file store it."""
    return WGS84Bounds(*(round(value, decimals) for value in
                         (bounds.west, bounds.south, bounds.east, bounds.north)))


def bed_fit_mm(bed_width: float, bed_depth: float, margin: float = BED_MARGIN_MM) -> tuple[float, float]:
    """The largest size in whole centimetres that leaves ``margin`` on every side."""
    return tuple(max(10.0, math.floor((side - 2.0 * margin) / 10.0) * 10.0)
                 for side in (bed_width, bed_depth))


def fits_bed(width_mm: float, height_mm: float, bed_width: float, bed_depth: float) -> bool:
    """Whether a model fits the bed, turned if necessary."""
    tolerance = 1e-6
    return ((width_mm <= bed_width + tolerance and height_mm <= bed_depth + tolerance)
            or (width_mm <= bed_depth + tolerance and height_mm <= bed_width + tolerance))


def format_size(width_m: float, height_m: float) -> str:
    """``850 x 600 m`` or ``3.27 x 2.60 km``, with fewer decimals for larger areas."""
    largest = max(width_m, height_m)
    if largest < 1000.0:
        return f"{width_m:.0f} x {height_m:.0f} m"
    digits = 2 if largest < 10_000.0 else 1 if largest < 100_000.0 else 0
    return f"{width_m / 1000.0:.{digits}f} x {height_m / 1000.0:.{digits}f} km"


def format_area(width_m: float, height_m: float) -> str:
    square_m = width_m * height_m
    if square_m < 10_000.0:
        return f"{square_m:,.0f} m²"
    square_km = square_m / 1e6
    digits = 2 if square_km < 1.0 else 1 if square_km < 10.0 else 0
    return f"{square_km:,.{digits}f} km²"


def size_line(width_m: float, height_m: float) -> str:
    return f"{format_size(width_m, height_m)}, {format_area(width_m, height_m)}"


def print_line(width_mm: float, height_mm: float, mm_per_metre: float) -> str:
    return f"{width_mm:.0f} x {height_mm:.0f} mm at 1:{1000.0 / mm_per_metre:,.0f}"


def size_notes(width_m: float, height_m: float, model_mm: tuple[float, float],
               bed_mm: tuple[float, float], printer: str, cutout: bool = False,
               multi_plate: bool = False) -> list[tuple[str, str]]:
    """Hints about the area's size as (icon, text) pairs; the ERROR icon marks a warning.

    A cutout frame with Multi-Plate Export already handles a model larger
    than the bed, so that combination gets no bed hint.
    """
    notes = []
    if not fits_bed(*model_mm, *bed_mm) and not (multi_plate and cutout):
        larger = f"Larger than the {printer} bed"
        if multi_plate:
            notes.append(("ERROR", f"{larger}: Multi-Plate Export needs a cutout frame"))
        elif cutout:
            notes.append(("INFO", f"{larger}: the export is cropped to the cutout frame"))
        else:
            notes.append(("ERROR", f"{larger}: use a cutout frame and/or Multi-Plate Export, "
                                   "or a smaller area or scale"))
    if width_m * height_m / 1e6 > LARGE_AREA_KM2:
        notes.append(("INFO", "Large area: download and generation can take a long time "
                              "and a lot of memory"))
    if min(model_mm) < SMALL_PRINT_MM:
        notes.append(("INFO", "Very small area: check the coordinates"))
    return notes


def osm_url(bounds: WGS84Bounds) -> str:
    """openstreetmap.org fitted to the box, with a marker at its centre."""
    return OSM_URL + "?" + urlencode({
        "minlon": format_degrees(bounds.west), "minlat": format_degrees(bounds.south),
        "maxlon": format_degrees(bounds.east), "maxlat": format_degrees(bounds.north),
        "mlat": format_degrees(bounds.center_latitude), "mlon": format_degrees(bounds.center_longitude),
    })


def bboxfinder_url(bounds: WGS84Bounds | None = None) -> str:
    """bboxfinder.com showing the box; its URL hash is south,west,north,east."""
    if bounds is None:
        return BBOXFINDER_URL
    return BBOXFINDER_URL + "#" + ",".join(
        format_degrees(value) for value in (bounds.south, bounds.west, bounds.north, bounds.east))
