"""Download and rasterize public elevation tiles into a cached height grid.

This file deliberately uses only the Python standard library.  It is executed
through the same external interpreter as the Overture downloader so that no
network access or heavy decoding happens inside Blender, but it has no
third-party dependency of its own and would also run under a bare Python.

Source
------
Terrarium-encoded terrain tiles published by the AWS Open Data ``Registry of
Open Data`` bucket ``elevation-tiles-prod``.  The dataset is an open,
keyless composite whose primary global component is SRTM/NED derived data.
Terrarium encodes metres above sea level as::

    elevation = (red * 256 + green + blue / 256) - 32768

These are orthometric (sea-level) heights, not WGS84 ellipsoid heights.  For a
relative miniature that distinction only shifts the whole model in Z, so the
grid is normalized against its own minimum and the offset is recorded in the
header rather than silently discarded.

Output
------
Two files are written next to each other:

``terrain.json``
    Header describing the grid extent, shape, and provenance.
``terrain.f32``
    ``rows * columns`` little-endian float32 metres, row-major, starting at the
    south-west corner and increasing north.
"""

from __future__ import annotations

import argparse
import array
import json
import math
import struct
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Tuple


TILE_SIZE = 256
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
EARTH_CIRCUMFERENCE_M = 40_075_016.685_578_49
GRID_FORMAT = "jcm_elevation_grid"
GRID_VERSION = 1
MINIMUM_ZOOM = 8
MAXIMUM_ZOOM = 14
MAXIMUM_TILES = 256


class DemError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Minimal PNG decoding
# --------------------------------------------------------------------------


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode_png_rgb(data: bytes) -> Tuple[int, int, bytearray]:
    """Decode a non-interlaced 8-bit truecolour PNG into raw RGB bytes.

    Terrarium tiles are always 256x256 8-bit RGB.  Rejecting anything else is
    safer than guessing, because a misdecoded tile would silently become
    plausible-looking but wrong terrain.
    """
    import zlib

    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise DemError("Response is not a PNG image")
    position = 8
    width = height = 0
    compressed = bytearray()
    seen_header = False
    while position + 8 <= len(data):
        (length,) = struct.unpack(">I", data[position : position + 4])
        chunk_type = data[position + 4 : position + 8]
        body = data[position + 8 : position + 8 + length]
        if chunk_type == b"IHDR":
            width, height, depth, colour, compression, filtering, interlace = (
                struct.unpack(">IIBBBBB", body)
            )
            if depth != 8 or colour != 2:
                raise DemError(
                    f"Unsupported PNG format: bit depth {depth}, colour type {colour}"
                )
            if compression != 0 or filtering != 0 or interlace != 0:
                raise DemError("Unsupported PNG compression, filter, or interlacing")
            seen_header = True
        elif chunk_type == b"IDAT":
            compressed.extend(body)
        elif chunk_type == b"IEND":
            break
        position += 12 + length

    if not seen_header or not compressed:
        raise DemError("PNG is missing an IHDR or IDAT chunk")

    raw = zlib.decompress(bytes(compressed))
    bytes_per_pixel = 3
    stride = width * bytes_per_pixel
    if len(raw) < height * (stride + 1):
        raise DemError("PNG pixel data is truncated")

    output = bytearray(height * stride)
    previous = bytearray(stride)
    position = 0
    for row in range(height):
        filter_type = raw[position]
        position += 1
        line = bytearray(raw[position : position + stride])
        position += stride
        if filter_type == 1:
            for index in range(bytes_per_pixel, stride):
                line[index] = (line[index] + line[index - bytes_per_pixel]) & 0xFF
        elif filter_type == 2:
            for index in range(stride):
                line[index] = (line[index] + previous[index]) & 0xFF
        elif filter_type == 3:
            for index in range(stride):
                left = line[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                line[index] = (line[index] + ((left + previous[index]) >> 1)) & 0xFF
        elif filter_type == 4:
            for index in range(stride):
                if index >= bytes_per_pixel:
                    left = line[index - bytes_per_pixel]
                    upper_left = previous[index - bytes_per_pixel]
                else:
                    left = 0
                    upper_left = 0
                line[index] = (
                    line[index] + _paeth(left, previous[index], upper_left)
                ) & 0xFF
        elif filter_type != 0:
            raise DemError(f"Unknown PNG filter type {filter_type}")
        output[row * stride : (row + 1) * stride] = line
        previous = line
    return width, height, output


# --------------------------------------------------------------------------
# Slippy-tile arithmetic
# --------------------------------------------------------------------------


def tile_fraction(longitude: float, latitude: float, zoom: int) -> Tuple[float, float]:
    """Return fractional slippy-tile coordinates for a WGS84 position."""
    count = float(2**zoom)
    x = (longitude + 180.0) / 360.0 * count
    clamped = max(-85.05112878, min(85.05112878, latitude))
    radians = math.radians(clamped)
    y = (
        (1.0 - math.log(math.tan(radians) + 1.0 / math.cos(radians)) / math.pi)
        / 2.0
        * count
    )
    return x, y


def ground_resolution_m(latitude: float, zoom: int) -> float:
    """Metres per tile pixel at a latitude and zoom level."""
    return (
        EARTH_CIRCUMFERENCE_M
        * math.cos(math.radians(latitude))
        / (TILE_SIZE * float(2**zoom))
    )


def choose_zoom(
    west: float,
    south: float,
    east: float,
    north: float,
    target_spacing_m: float,
    maximum_tiles: int = MAXIMUM_TILES,
) -> int:
    """Pick the coarsest zoom that still resolves *target_spacing_m*.

    Downloading finer tiles than the printed model can express only costs time
    and produces noise, so the search stops as soon as the requirement is met
    and always respects the tile budget.
    """
    latitude = (south + north) * 0.5
    chosen = MINIMUM_ZOOM
    for zoom in range(MINIMUM_ZOOM, MAXIMUM_ZOOM + 1):
        if _tile_count(west, south, east, north, zoom) > maximum_tiles:
            break
        chosen = zoom
        if ground_resolution_m(latitude, zoom) <= target_spacing_m:
            break
    return chosen


def _tile_range(west, south, east, north, zoom):
    min_x, max_y_fraction = tile_fraction(west, south, zoom)
    max_x, min_y_fraction = tile_fraction(east, north, zoom)
    return (
        int(math.floor(min_x)),
        int(math.floor(min_y_fraction)),
        int(math.floor(max_x)),
        int(math.floor(max_y_fraction)),
    )


def _tile_count(west, south, east, north, zoom) -> int:
    x0, y0, x1, y1 = _tile_range(west, south, east, north, zoom)
    return (x1 - x0 + 1) * (y1 - y0 + 1)


# --------------------------------------------------------------------------
# Mosaic assembly and resampling
# --------------------------------------------------------------------------


def _fetch_tile(zoom: int, x: int, y: int, timeout: float) -> bytes | None:
    url = TILE_URL.format(z=zoom, x=x, y=y)
    request = urllib.request.Request(url, headers={"User-Agent": "jarvizar-city-model"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code in (403, 404):
            return None
        raise DemError(f"Elevation tile {zoom}/{x}/{y} failed: HTTP {error.code}")
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise DemError(f"Elevation tile {zoom}/{x}/{y} failed: {error}")


def build_mosaic(
    west: float,
    south: float,
    east: float,
    north: float,
    zoom: int,
    timeout: float = 60.0,
) -> Dict[str, object]:
    """Fetch every covering tile and decode it into one elevation mosaic."""
    x0, y0, x1, y1 = _tile_range(west, south, east, north, zoom)
    columns = (x1 - x0 + 1) * TILE_SIZE
    rows = (y1 - y0 + 1) * TILE_SIZE
    mosaic = array.array("f", [0.0]) * (columns * rows)
    covered = 0
    missing = 0
    for tile_y in range(y0, y1 + 1):
        for tile_x in range(x0, x1 + 1):
            payload = _fetch_tile(zoom, tile_x, tile_y, timeout)
            if payload is None:
                missing += 1
                continue
            width, height, pixels = decode_png_rgb(payload)
            if width != TILE_SIZE or height != TILE_SIZE:
                raise DemError(
                    f"Elevation tile {zoom}/{tile_x}/{tile_y} is {width}x{height}, "
                    f"expected {TILE_SIZE}x{TILE_SIZE}"
                )
            covered += 1
            offset_x = (tile_x - x0) * TILE_SIZE
            offset_y = (tile_y - y0) * TILE_SIZE
            for row in range(TILE_SIZE):
                source = row * TILE_SIZE * 3
                destination = (offset_y + row) * columns + offset_x
                for column in range(TILE_SIZE):
                    base = source + column * 3
                    mosaic[destination + column] = (
                        pixels[base] * 256.0
                        + pixels[base + 1]
                        + pixels[base + 2] / 256.0
                        - 32768.0
                    )
    if covered == 0:
        raise DemError(
            "No elevation tiles were available for this bounding box; "
            "use flat terrain instead"
        )
    return {
        "values": mosaic,
        "columns": columns,
        "rows": rows,
        "tile_x0": x0,
        "tile_y0": y0,
        "tiles_used": covered,
        "tiles_missing": missing,
    }


def _sample_mosaic(mosaic, pixel_x: float, pixel_y: float) -> float:
    """Bilinear sample of the mosaic in its own pixel coordinates."""
    columns = mosaic["columns"]
    rows = mosaic["rows"]
    values = mosaic["values"]
    x = min(max(pixel_x, 0.0), columns - 1.0)
    y = min(max(pixel_y, 0.0), rows - 1.0)
    x0 = int(math.floor(x))
    y0 = int(math.floor(y))
    x1 = min(x0 + 1, columns - 1)
    y1 = min(y0 + 1, rows - 1)
    fx = x - x0
    fy = y - y0
    top = values[y0 * columns + x0] * (1.0 - fx) + values[y0 * columns + x1] * fx
    bottom = values[y1 * columns + x0] * (1.0 - fx) + values[y1 * columns + x1] * fx
    return top * (1.0 - fy) + bottom * fy


def resample_to_grid(
    mosaic,
    west: float,
    south: float,
    east: float,
    north: float,
    zoom: int,
    columns: int,
    rows: int,
) -> array.array:
    """Resample the tile mosaic onto a regular WGS84 grid over the bbox.

    Row 0 is the southern edge so the grid matches the model's +Y = north
    convention and can be indexed without a vertical flip later.
    """
    grid = array.array("f", [0.0]) * (columns * rows)
    origin_x = mosaic["tile_x0"] * TILE_SIZE
    origin_y = mosaic["tile_y0"] * TILE_SIZE
    for row in range(rows):
        latitude = south + (north - south) * (
            row / (rows - 1) if rows > 1 else 0.0
        )
        for column in range(columns):
            longitude = west + (east - west) * (
                column / (columns - 1) if columns > 1 else 0.0
            )
            tile_x, tile_y = tile_fraction(longitude, latitude, zoom)
            grid[row * columns + column] = _sample_mosaic(
                mosaic, tile_x * TILE_SIZE - origin_x, tile_y * TILE_SIZE - origin_y
            )
    return grid


def write_grid(
    output_dir: Path,
    grid: array.array,
    header: Dict[str, object],
) -> Dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    binary_path = output_dir / "terrain.f32"
    header_path = output_dir / "terrain.json"
    temporary = binary_path.with_suffix(".f32.partial")
    with temporary.open("wb") as handle:
        if sys.byteorder != "little":
            flipped = array.array("f", grid)
            flipped.byteswap()
            flipped.tofile(handle)
        else:
            grid.tofile(handle)
    temporary.replace(binary_path)
    payload = dict(header)
    payload["format"] = GRID_FORMAT
    payload["version"] = GRID_VERSION
    header_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return payload


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", nargs=4, type=float, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--columns", type=int, default=256)
    parser.add_argument("--target-spacing-m", type=float, default=25.0)
    parser.add_argument("--zoom", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args(argv)

    try:
        west, south, east, north = args.bbox
        if east <= west or north <= south:
            raise DemError("Require west < east and south < north")
        columns = max(2, min(2048, int(args.columns)))
        latitude = (south + north) * 0.5
        width_m = (
            math.radians(east - west)
            * 6_378_137.0
            * math.cos(math.radians(latitude))
        )
        height_m = math.radians(north - south) * 6_378_137.0
        rows = max(2, min(2048, int(round(columns * height_m / max(width_m, 1.0)))))

        zoom = (
            int(args.zoom)
            if args.zoom
            else choose_zoom(west, south, east, north, args.target_spacing_m)
        )
        zoom = max(MINIMUM_ZOOM, min(MAXIMUM_ZOOM, zoom))
        mosaic = build_mosaic(west, south, east, north, zoom, timeout=args.timeout)
        grid = resample_to_grid(
            mosaic, west, south, east, north, zoom, columns, rows
        )
        minimum = min(grid)
        maximum = max(grid)
        header = write_grid(
            args.output_dir,
            grid,
            {
                "west": west,
                "south": south,
                "east": east,
                "north": north,
                "columns": columns,
                "rows": rows,
                "min_m": minimum,
                "max_m": maximum,
                "zoom": zoom,
                "tiles_used": mosaic["tiles_used"],
                "tiles_missing": mosaic["tiles_missing"],
                "source": "AWS elevation-tiles-prod terrarium",
                "vertical_datum": "orthometric (sea level), not WGS84 ellipsoid",
                "ground_resolution_m": ground_resolution_m(latitude, zoom),
            },
        )
        print(json.dumps({"ok": True, **header}))
        return 0
    except Exception as exc:  # noqa: BLE001 - reported as machine-readable JSON
        print(json.dumps({"ok": False, "error": type(exc).__name__, "detail": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
