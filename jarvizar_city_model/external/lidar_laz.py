"""Staged LAS/LAZ acquisition adapter. No building processing lives here.

Output matches read_ept: WGS84 XY, metre Z, class, single return, capture
year and date confidence. A manifest is spatially indexed using LAS headers.
"""
from __future__ import annotations

import io
import math
import struct

import laspy
from laspy.errors import LaspyException
from lazrs import LazrsError
import numpy as np
from pyproj import CRS, Transformer

try:
    from .lidar_ept import BudgetExceeded
    from .lidar_selection import gps_capture_years
except ImportError:
    from lidar_ept import BudgetExceeded
    from lidar_selection import gps_capture_years


def coordinate_system(header):
    """Respect independent XY/Z units, including legacy GeoTIFF vertical keys."""
    crs = header.parse_crs()
    if crs is None or not (crs.is_projected or crs.is_geographic or crs.is_compound):
        raise ValueError('LAS header lacks a supported horizontal CRS')
    vertical = [c for c in crs.sub_crs_list if c.is_vertical] if crs.is_compound else []
    factor = vertical[0].axis_info[0].unit_conversion_factor if vertical else None
    if factor is None and len(crs.axis_info) == 3 and not crs.is_compound:
        factor = crs.axis_info[2].unit_conversion_factor
    keys = {k.id: k.value_offset for vlr in list(header.vlrs)+list(header.evlrs or [])
            for k in getattr(vlr, 'geo_keys', ()) if k.tiff_tag_location == 0}
    if factor is None and keys.get(4099):
        # GeoTIFF Linear_Meter, Linear_Foot, Linear_Foot_US_Survey.
        factor = {9001: 1.0, 9002: .3048, 9003: 1200/3937}.get(keys[4099])
    if factor is None and 0 < keys.get(4096, 0) < 32767:
        vertical_crs = CRS.from_epsg(keys[4096])
        if vertical_crs.is_vertical:
            factor = vertical_crs.axis_info[0].unit_conversion_factor
    if factor is None or not math.isfinite(factor) or factor <= 0:
        raise ValueError('Unknown LAS vertical units; a vertical CRS or unit key is required')
    return crs.to_2d(), factor


def validate_download_prefix(stream, limit):
    """Reject unusable CRS before streaming point records, without another GET.

    EVLR-only CRS must wait for the full file. Unusually large VLR regions
    likewise defer to the existing reader instead of rejecting valid data.
    """
    prefix = stream.read(min(227, limit+1))
    if len(prefix) < 227 or prefix[:4] != b'LASF':
        raise ValueError('Unreadable LAS header')
    point_offset = struct.unpack_from('<I', prefix, 96)[0]
    if not 227 <= point_offset <= min(4*1024**2, limit):
        return prefix
    prefix += stream.read(point_offset-len(prefix))
    if len(prefix) != point_offset:
        raise OSError('Incomplete LAS header download')
    try:
        header = laspy.LasHeader.read_from(io.BytesIO(prefix))
        try:
            coordinate_system(header)
        except ValueError:
            if not header.number_of_evlrs:
                raise
    except (LaspyException, LazrsError, struct.error, OverflowError) as exc:
        raise ValueError(f'Unreadable LAS header: {exc}') from exc
    return prefix


class HeaderStream(io.RawIOBase):
    """Seekable, metadata-only HTTP stream with a per-tile allocation guard."""
    def __init__(self, fetch, url):
        self.fetch, self.url, self.position, self.consumed = fetch, url, 0, 0

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        if whence not in (0, 1):
            raise ValueError('LAS metadata must use absolute/relative offsets')
        self.position = offset if whence == 0 else self.position+offset
        if self.position < 0:
            raise ValueError('Invalid LAS metadata offset')
        return self.position

    def read(self, size=-1):
        if size == 0:
            return b''
        if size < 0 or self.consumed+size > 4 * 1024 ** 2:
            raise ValueError('LAS header metadata exceeds 4 MiB')
        data = self.fetch.range(self.url, self.position, size)
        self.position += len(data)
        self.consumed += len(data)
        return data


def header_bounds(fetch, url):
    """Locate manifest tiles without fetching point records or parsing names."""
    stream = HeaderStream(fetch, url)
    try:
        header = laspy.LasHeader.read_from(stream)
        header.read_evlrs(stream)
    except (LaspyException, LazrsError, struct.error, OverflowError) as exc:
        raise ValueError(f'Unreadable LAS header: {exc}') from exc
    crs, factor = coordinate_system(header)
    bounds = (*header.mins[:2], *header.maxs[:2])
    if not np.all(np.isfinite(bounds)) or bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
        raise ValueError('Invalid LAS header bounds')
    bbox = Transformer.from_crs(crs, 4326, always_xy=True).transform_bounds(*bounds, densify_pts=21)
    return {'bbox': list(bbox), 'points': int(header.point_count),
            'horizontal_crs': crs.to_string(), 'z_to_metres': factor}


def normalized_chunk(points, header, bbox, query, to_lonlat, factor):
    x, y, z = np.asarray(points.x), np.asarray(points.y), np.asarray(points.z)
    cls = np.asarray(points.classification)
    mask = ((x >= query[0]) & (x <= query[2]) & (y >= query[1]) & (y <= query[3])
            & np.isin(cls, [1, 2, 6]) & (np.asarray(points.withheld) == 0)
            & np.isfinite(x) & np.isfinite(y) & np.isfinite(z))
    if 'overlap' in points.point_format.dimension_names:
        mask &= np.asarray(points.overlap) == 0
    if not mask.any():
        return np.empty((0, 7))
    lon, lat = to_lonlat.transform(x[mask], y[mask])
    years = np.zeros(int(mask.sum()))
    if 'gps_time' in points.point_format.dimension_names:
        years, _ = gps_capture_years(np.asarray(points.gps_time)[mask], header.global_encoding.gps_time_type)
    piece = np.column_stack((lon, lat, z[mask]*factor, cls[mask],
                             np.asarray(points.number_of_returns)[mask] == 1, years, years > 0))
    exact = ((piece[:, 0] >= bbox[0]) & (piece[:, 0] <= bbox[2])
             & (piece[:, 1] >= bbox[1]) & (piece[:, 1] <= bbox[3]))
    return piece[exact]


def read_laz(fetch, source, bbox, max_points=8_000_000, chunk_size=250_000):
    from shapely.geometry import box
    roi = box(*bbox)
    tiles = [t for t in source['tiles'] if box(*t['bbox']).intersects(roi)]
    pieces, retained, details = [], 0, []
    for tile in tiles:
        try:
            path = fetch.download(tile['url'], revision=tile.get('updated') or '')
            fetch.progress(f"Decoding and cropping LAZ tile: {tile['url'].rsplit('/', 1)[-1]}")
            with laspy.open(path) as reader:
                crs, factor = coordinate_system(reader.header)
                query = Transformer.from_crs(4326, crs, always_xy=True).transform_bounds(*bbox, densify_pts=21)
                to_lonlat = Transformer.from_crs(crs, 4326, always_xy=True)
                for chunk in reader.chunk_iterator(chunk_size):
                    piece = normalized_chunk(chunk, reader.header, bbox, query, to_lonlat, factor)
                    retained += len(piece)
                    if retained > max_points:
                        raise BudgetExceeded('Cropped LiDAR point budget reached; subdivide group')
                    if len(piece):
                        pieces.append(piece)
                details.append({**tile, 'horizontal_crs': crs.to_string(), 'z_to_metres': factor})
        except (LaspyException, LazrsError) as exc:
            raise ValueError(f"Unreadable LAZ tile {tile['url']}; use Refresh to retry: {exc}") from exc
    points = np.concatenate(pieces) if pieces else np.empty((0, 7))
    if len(tiles) > 1 and len(points):
        # Adjacent delivered tiles can repeat identical boundary returns.
        points = np.unique(points, axis=0)
    return points, {'url': source['url'], 'format': 'LAZ', 'tiles': details,
                    'points': len(points), 'vertical_reference': 'same-survey ground subtraction'}
