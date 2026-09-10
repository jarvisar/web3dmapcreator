"""Bounded spatial-index utilities shared by discovery adapters."""
import io
import struct
import zipfile

import shapefile
from pyproj import CRS, Transformer
from shapely.geometry import box, shape
from shapely.ops import transform

INDEX_LIMIT = 64 * 1024**2


def indexed_shapes(shp, crs, bbox):
    crs = CRS.from_user_input(crs)
    local = Transformer.from_crs(4326, crs, always_xy=True).transform_bounds(*bbox, densify_pts=21)
    geographic = Transformer.from_crs(crs, 4326, always_xy=True).transform
    reader = shapefile.Reader(shp=io.BytesIO(shp))
    for feature in reader.iterShapes(bbox=local):
        geometry = transform(geographic, shape(feature.__geo_interface__))
        if not geometry.is_valid:
            raise ValueError('Invalid tile index geometry')
        if geometry.intersects(box(*bbox)):
            yield feature.oid, geometry


class RemoteDbf:
    """Read only selected attribute rows; national DBFs can be hundreds of MB."""
    def __init__(self, fetch, url):
        self.fetch, self.url = fetch, url
        prefix = fetch.range(url, 0, 32)
        self.count, self.header_size, self.row_size = struct.unpack_from('<IHH', prefix, 4)
        if not 33 <= self.header_size <= 32768 or not 1 <= self.row_size <= 32768:
            raise ValueError('Invalid tile attribute index header')
        self.header = bytearray(fetch.range(url, 0, self.header_size))
        struct.pack_into('<I', self.header, 4, 1)

    def row(self, index):
        if not 0 <= index < self.count:
            raise ValueError('Tile geometry/attribute index mismatch')
        data = self.fetch.range(self.url, self.header_size + index * self.row_size, self.row_size)
        reader = shapefile.Reader(dbf=io.BytesIO(self.header + data + b'\x1a'), encodingErrors='replace')
        record = reader.record(0)
        return record.as_dict() if record else {}


def zip_index(fetch, url, bbox):
    data = fetch.get(url, limit=INDEX_LIMIT)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(i.file_size for i in archive.infolist()) > 2 * INDEX_LIMIT:
            raise ValueError('Expanded tile index exceeds metadata budget')
        names = archive.namelist()
        for name in names:
            if not name.lower().endswith('.shp'):
                continue
            base = name[:-4]
            lookup = {n.lower(): n for n in names}
            def read(ext):
                return archive.read(lookup[(base + ext).lower()])
            crs = CRS.from_wkt(read('.prj').decode('utf-8-sig'))
            records = shapefile.Reader(dbf=io.BytesIO(read('.dbf')), encodingErrors='replace')
            for index, geometry in indexed_shapes(read('.shp'), crs, bbox):
                record = records.record(index)
                if record:
                    yield record.as_dict(), geometry
