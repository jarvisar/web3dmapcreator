"""Spatial COPC reads through the existing cache and strict HTTP range transport.

laspy is pinned: the guarded decode hook prevents allocation before inspecting
octree counts. No requests dependency, unbounded file reads, or whole-file fallback.
"""
import math
import struct

import laspy
from laspy.errors import LaspyException
from lazrs import LazrsError
import numpy as np
from pyproj import Transformer
from shapely.geometry import box

try:
    from .lidar_ept import BudgetExceeded
    from .lidar_laz import coordinate_system, normalized_chunk
    from .lidar_normalize import source_metadata, header_metadata
except ImportError:
    from lidar_ept import BudgetExceeded
    from lidar_laz import coordinate_system, normalized_chunk
    from lidar_normalize import source_metadata, header_metadata


class RangeStream:
    def __init__(self, fetch, url, max_bytes=256 * 1024**2):
        self.fetch, self.url, self.position = fetch, url, 0
        self.remaining = max_bytes
        self.hierarchy_mode = True
        self.reads = 0

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        if whence not in (0, 1):
            raise ValueError('COPC must use bounded absolute/relative offsets')
        self.position = offset if whence == 0 else self.position + offset
        if self.position < 0:
            raise ValueError('Invalid COPC offset')
        return self.position

    def read(self, size=-1):
        self.reads += 1
        if self.reads > 8192 or (self.hierarchy_mode and size > 4 * 1024**2):
            raise BudgetExceeded('COPC hierarchy limit reached; subdivide group')
        if size < 0 or size > self.remaining:
            raise BudgetExceeded('COPC group transfer limit reached; subdivide group')
        pieces = []
        while size:
            count = min(size, 4 * 1024**2)
            data = self.fetch.range(self.url, self.position, count)
            if len(data) != count:
                raise ValueError('Incomplete COPC range')
            pieces.append(data)
            self.position += count
            self.remaining -= count
            size -= count
        return b''.join(pieces)

    def close(self):
        pass


def read_crs_evlrs(header, stream):
    """Read CRS EVLRs, never the potentially huge COPC hierarchy EVLR body."""
    from laspy.vlrs.vlrlist import VLRList
    from laspy.vlrs.vlr import VLR
    from laspy.vlrs.known import vlr_factory
    if header.number_of_evlrs > 64:
        raise ValueError('Too many COPC extended metadata records')
    header.evlrs = VLRList()
    offset = header.start_of_first_evlr
    for _ in range(header.number_of_evlrs):
        stream.seek(offset)
        raw = stream.read(60)
        user = raw[2:18].split(b'\0', 1)[0].decode('ascii', errors='replace')
        record, length = struct.unpack_from('<HQ', raw, 18)
        if user == 'LASF_Projection' and record in (2111, 2112):
            if length > 1024 * 1024:
                raise ValueError('Oversized COPC CRS metadata')
            header.evlrs.append(vlr_factory(VLR(user, record, record_data=stream.read(length))))
        offset += 60 + length


class BoundedCopcReader(laspy.CopcReader):
    max_query_points = 8_000_000
    queried_nodes = 0

    def _fetch_and_decompress_points_of_nodes(self, nodes):
        self.queried_nodes = sum(n.point_count > 0 for n in nodes)
        if (len(nodes) > 4096 or any(n.point_count < 0 or n.byte_size < 0 for n in nodes)
                or sum(n.point_count for n in nodes) > self.max_query_points):
            raise BudgetExceeded('COPC node/point budget reached; subdivide group')
        if sum(n.byte_size for n in nodes) > self.source.remaining:
            raise BudgetExceeded('COPC group transfer limit reached; subdivide group')
        self.source.hierarchy_mode = False
        return super()._fetch_and_decompress_points_of_nodes(nodes)


def read_copc(fetch, source, bbox, max_points=8_000_000, resolution_m=.35):
    tiles = source.get('tiles', [{'url': source['url'], 'bbox': bbox}])
    pieces, details, retained, nodes = [], [], 0, 0
    for position, tile in enumerate(tiles, 1):
        if not box(*tile['bbox']).intersects(box(*bbox)):
            continue
        metadata = source_metadata(source, tile)
        fetch.progress(f"Streaming COPC tile {position}/{len(tiles)}: {tile['url'].rsplit('/', 1)[-1]}")
        try:
            stream = RangeStream(fetch, tile['url'], max_bytes=4 * 1024**2)
            with BoundedCopcReader(stream) as reader:
                read_crs_evlrs(reader.header, stream)
                crs, factor = coordinate_system(reader.header, metadata)
                stream.remaining = 256 * 1024**2
                to_cloud = Transformer.from_crs(4326, crs, always_xy=True)
                query = to_cloud.transform_bounds(*bbox, densify_pts=21)
                if not all(math.isfinite(v) for v in query):
                    raise ValueError('Invalid projected COPC query')
                to_lonlat = Transformer.from_crs(crs, 4326, always_xy=True)
                # A horizontal angular CRS cannot use a metre LOD directly.
                resolution = None
                if crs.is_projected:
                    resolution = resolution_m / crs.axis_info[0].unit_conversion_factor
                    if crs.to_epsg() == 3857:
                        resolution /= math.cos(math.radians((bbox[1] + bbox[3]) / 2))
                reader.max_query_points = max_points - retained
                points = reader.query(bounds=laspy.copc.Bounds(np.array(query[:2]), np.array(query[2:])),
                                      resolution=resolution)
                piece = normalized_chunk(points, reader.header, bbox, query, to_lonlat, factor, metadata)
                retained += len(piece)
                nodes += reader.queried_nodes
                if len(piece):
                    pieces.append(piece)
                details.append({**header_metadata(reader.header), 'url': tile['url'], 'horizontal_crs': crs.to_string(),
                                'z_to_metres': factor, 'points': len(piece)})
        except (LaspyException, LazrsError, struct.error, OverflowError) as exc:
            raise ValueError(f"Unreadable COPC {tile['url']}: {exc}") from exc
    points = np.concatenate(pieces) if pieces else np.empty((0, 7))
    if len(pieces) > 1:
        points = np.unique(points, axis=0)
    return points, {'url': source['url'], 'format': 'COPC', 'tiles': details,
                    'points': len(points), 'nodes': nodes, 'requested_spacing_m': resolution_m,
                    'vertical_reference': 'same-survey ground subtraction'}
