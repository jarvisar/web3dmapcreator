"""Bounded public spatial services shared by official provider adapters.

Only catalog metadata is fetched here. No point-file probes or downloads.
WFS uses explicit longitude-first CRS84; ArcGIS returns RFC7946 GeoJSON.
"""
import hashlib
import json
import time
from urllib.parse import urlencode

from shapely.geometry import box, shape
from shapely.ops import unary_union

try:
    from .lidar_candidates import candidate, asset_format, https_url
    from .lidar_metadata import aggregate_metadata, normalized_metadata
except ImportError:
    from lidar_candidates import candidate, asset_format, https_url
    from lidar_metadata import aggregate_metadata, normalized_metadata

PAGE_SIZE = 500
MAX_FEATURES = 10000
METADATA_TTL = 24 * 3600


def metadata(fetch, url, limit=8 * 1024**2):
    return fetch.get(url, limit=limit, ttl=METADATA_TTL, timeout=20, attempts=1)


def query_url(endpoint, params):
    return endpoint + ('&' if '?' in endpoint else '?') + urlencode(params)


def features(fetch, endpoint, bbox, *, layer=None, arcgis=False):
    """Page a spatial query; detect ignored pagination/CRS and truncate visibly."""
    roi, seen, offset = box(*bbox), set(), 0
    deadline = time.monotonic() + 60
    while offset < MAX_FEATURES:
        if time.monotonic() > deadline:
            raise ValueError('Spatial catalog time budget reached; partial discovery')
        if arcgis:
            params = dict(f='geojson', where='1=1', geometry=','.join(map(str, bbox)),
                          geometryType='esriGeometryEnvelope', inSR=4326, outSR=4326,
                          spatialRel='esriSpatialRelIntersects', outFields='*',
                          resultOffset=offset, resultRecordCount=PAGE_SIZE,
                          orderByFields='OBJECTID')
        else:
            params = dict(service='WFS', version='2.0.0', request='GetFeature',
                          typeNames=layer, outputFormat='application/json',
                          srsName='CRS:84', bbox=','.join(map(str, bbox)) + ',CRS:84',
                          count=PAGE_SIZE, startIndex=offset)
        document = json.loads(metadata(fetch, query_url(endpoint, params)))
        if document.get('type') != 'FeatureCollection' or not isinstance(document.get('features'), list):
            raise ValueError('Spatial catalog returned an invalid FeatureCollection')
        crs = document.get('crs', {}).get('properties', {}).get('name', '')
        if crs and not (crs.endswith((':4326', ':CRS84', ':CRS:84', ':CRS::84', '/CRS84'))):
            raise ValueError('Spatial catalog ignored requested geographic CRS')
        rows = document['features']
        for row in rows:
            key = str(row.get('id') or hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest())
            if key in seen:
                raise ValueError('Spatial catalog repeated a feature/page')
            seen.add(key)
            geom = shape(row['geometry'])
            if not geom.is_valid or geom.is_empty or geom.geom_type not in ('Polygon', 'MultiPolygon'):
                raise ValueError('Invalid spatial catalog tile polygon')
            if not box(-180, -90, 180, 90).covers(geom):
                raise ValueError('Spatial catalog coordinates are not geographic')
            if geom.intersects(roi):
                yield row['properties'], geom
        offset += len(rows)
        total = document.get('numberMatched', document.get('totalFeatures'))
        more = document.get('exceededTransferLimit', False) or document.get('properties', {}).get('exceededTransferLimit', False)
        if isinstance(total, str) and total.isdecimal():
            total = int(total)
        if not rows:
            if more or (isinstance(total, int) and offset < total):
                raise ValueError('Spatial catalog ended before its reported feature count')
            return
        if isinstance(total, int) and offset >= total:
            return
        if not isinstance(total, int) and len(rows) < PAGE_SIZE and not more:
            return
    raise ValueError('Spatial catalog feature budget reached; partial discovery')


def tile(url, geometry, **metadata_fields):
    https_url(url)
    return dict(url=url, bbox=list(geometry.bounds), **metadata_fields)


def grouped(provider, records, **defaults):
    """Group compatible tiles by survey, classification policy, format and CRS.

    Adapters provide (survey_id, display_name, tile_metadata, geometry). A survey
    never spans independent project epochs or incompatible normalization choices.
    """
    groups = {}
    for survey, name, member, geom in records:
        fmt = member.get('format') or asset_format(member['url'])
        if not fmt:
            raise ValueError('Catalog asset is not a supported point cloud')
        key = (str(survey), fmt, member.get('horizontal_crs'), member.get('vertical_datum'),
               json.dumps(member.get('classification', {}), sort_keys=True))
        groups.setdefault(key, []).append((name, member, geom))
    for key, members in groups.items():
        survey, fmt, crs, datum, _ = key
        tiles = list({m['url']: m for _, m, _ in members}.values())
        # Stable survey URL independent of the requested subset of tiles.
        source_url = defaults['source_page'].split('#')[0] + '#survey=' + hashlib.sha256(repr(key).encode()).hexdigest()[:20]
        meta = aggregate_metadata([normalized_metadata(m) for m in tiles])
        yield candidate(provider, survey, members[0][0], source_url, fmt,
                        unary_union([g for _, _, g in members]), tiles=tiles,
                        **{**defaults, 'horizontal_crs': crs, 'vertical_datum': datum or 'unknown',
                           'classification': tiles[0].get('classification', defaults.get('classification', {})),
                           'survey_metadata': meta, 'authoritative': True})
