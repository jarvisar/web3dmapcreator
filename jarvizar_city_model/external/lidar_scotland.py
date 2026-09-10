"""Scottish Government National LiDAR: spatial prefixes in its public S3 index.

Only published keys are used as downloads. OS grid prefixes are queries, not
guessed tile URLs. Unknown acquisition epochs remain separate candidates.
"""
import math
import re
import time
from urllib.parse import quote

from pyproj import CRS, Transformer
from shapely.geometry import box
from shapely.ops import transform

try:
    from .lidar_services import metadata, query_url, grouped, tile
    from .lidar_metadata import xml_root
except ImportError:
    from lidar_services import metadata, query_url, grouped, tile
    from lidar_metadata import xml_root

BUCKET = 'https://srsp-open-data.s3.eu-west-2.amazonaws.com/'
PREFIX = 'lidar/national-lidar-programme/laz/27700/gridded/'


def grid_ref(east, north):
    """OS National Grid 1 km reference, lower-left projected metres."""
    e, n = east // 100000, north // 100000
    if not (0 <= e < 7 and 0 <= n < 13):
        raise ValueError('Outside OS National Grid')
    first = (19 - n) - (19 - n) % 5 + (e + 10) // 5
    second = (19 - n) * 5 % 25 + e % 5
    letters = ''.join(chr(65 + i + (i >= 8)) for i in (first, second))
    return f'{letters}{east % 100000 // 1000:02d}{north % 100000 // 1000:02d}'


def discover_scotland(fetch, bbox, failures, progress):
    area = CRS(27700).area_of_use
    roi = box(*bbox)
    if not box(area.west, area.south, area.east, area.north).intersects(roi):
        return
    w, s, e, n = Transformer.from_crs(4326, 27700, always_xy=True).transform_bounds(*bbox, densify_pts=21)
    xs = range(max(0, math.floor(w / 1000)), min(700, math.floor(e / 1000) + 1))
    ys = range(max(0, math.floor(s / 1000)), min(1300, math.floor(n / 1000) + 1))
    if len(xs) * len(ys) > 128:
        raise ValueError('Scottish tile-query budget exceeded; use a smaller map area')
    to_geo = Transformer.from_crs(27700, 4326, always_xy=True).transform
    records = []
    deadline = time.monotonic() + 60
    for x in xs:
        for y in ys:
            if time.monotonic() > deadline:
                raise ValueError('Scottish spatial catalog time budget reached')
            ref = grid_ref(x * 1000, y * 1000)
            geom = transform(to_geo, box(x * 1000, y * 1000, (x + 1) * 1000, (y + 1) * 1000).segmentize(100))
            if not geom.intersects(roi):
                continue
            root = xml_root(metadata(fetch, query_url(BUCKET, {'list-type': 2,
                'prefix': PREFIX + ref + '_', 'max-keys': 20})))
            if root.tag != 'ListBucketResult' or root.findtext('IsTruncated') != 'false':
                raise ValueError('Scottish public tile index is invalid or incomplete')
            for entry in root.findall('Contents'):
                key = entry.findtext('Key', '')
                match = re.fullmatch(re.escape(PREFIX + ref) + r'_(\d+)PPM_LAZ_ScotlandNationalLiDAR\.laz', key)
                if not match:
                    continue
                records.append((key, 'Scottish National LiDAR ' + ref, tile(
                    BUCKET + quote(key, safe='/'), geom, size_bytes=int(entry.findtext('Size')),
                    updated=entry.findtext('ETag'), horizontal_crs='EPSG:27700',
                    classification={'mapping': {'1': 'unclassified', '2': 'ground', '6': 'building'},
                                    'basis': 'Scottish National LiDAR LAS classification'},
                    survey_metadata={'point_density_m2': int(match[1])}), geom))
    yield from grouped('Scottish Government', records,
        source_page='https://remotesensingdata.gov.scot/', vertical_units='m',
        vertical_units_basis='Scottish National LiDAR published LAS metadata',
        license='Open Government Licence v3.0',
        attribution='Scottish Government Crown copyright and database right')
