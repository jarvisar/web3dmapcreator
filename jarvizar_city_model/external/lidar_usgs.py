"""Existing USGS EPT / TNM discovery adapter; no point processing."""
import hashlib
import json
import math
from urllib.parse import urlencode, urlparse, unquote
from urllib.error import HTTPError
from shapely.geometry import box, shape
from shapely.ops import unary_union
from shapely.errors import ShapelyError
try:
    from . import lidar_ept
    from .lidar_metadata import normalized_metadata
    from .lidar_identity import metadata_identity
except ImportError:
    import lidar_ept
    from lidar_metadata import normalized_metadata
    from lidar_identity import metadata_identity

TNM_URL = 'https://tnmaccess.nationalmap.gov/api/v1/products'
DISCOVERY_ERRORS = (ValueError, OSError, RuntimeError, KeyError, TypeError, IndexError, AttributeError, ShapelyError)


def valid_bbox(values):
    values = list(map(float, values))
    if (len(values) != 4 or not all(math.isfinite(v) for v in values)
            or not -180 <= values[0] < values[2] <= 180
            or not -90 <= values[1] < values[3] <= 90):
        raise ValueError('Invalid LPC tile bounds')
    return values


def laz_url(item):
    urls = item.get('urls') or {}
    if not isinstance(urls, dict):
        urls = {}
    for url in (urls.get('LAZ'), item.get('downloadLazURL'), item.get('downloadURL')):
        if isinstance(url, str) and urlparse(url).scheme == 'https' and urlparse(url).path.lower().endswith('.laz'):
            return url
    return None


def tnm_tiles(fetch, bbox, failures, page_size=100):
    """Page every bbox result. An incomplete catalog is reported, never empty success."""
    offset, seen = 0, set()
    roi = box(*bbox)
    while True:
        url = TNM_URL+'?'+urlencode({'datasets': 'Lidar Point Cloud (LPC)',
            'bbox': ','.join(map(str, bbox)), 'prodFormats': 'LAZ',
            'max': page_size, 'offset': offset})
        try:
            page = fetch.json(url, fresh=True)
        except HTTPError as exc:
            # The transport already retries transient HTTP errors. TNM can
            # still fail a large page while a smaller request succeeds. Keep
            # the exact offset so recovery never skips unreturned products.
            if exc.code in (500, 502, 503, 504) and page_size > 10:
                page_size = max(10, page_size // 2)
                continue
            raise
        if not isinstance(page, dict) or page.get('errorMessage') or page.get('errors'):
            raise ValueError(f'TNMAccess query failed: {page}')
        items, total = page['items'], int(page['total'])
        if not isinstance(items, list) or total < 0:
            raise ValueError('Invalid TNMAccess product page')
        if not items:
            if offset < total:
                raise ValueError('TNMAccess returned an incomplete product listing')
            break
        new = 0
        for item in items:
            try:
                identity = item.get('sourceId') or laz_url(item) or json.dumps(item, sort_keys=True)
                if identity in seen:
                    continue
                seen.add(identity)
                new += 1
                tile_url = laz_url(item)
                if not tile_url:
                    raise ValueError('LPC product lacks a direct HTTPS LAZ URL')
                bounds = item['boundingBox']
                bounds = valid_bbox(bounds[k] for k in ('minX', 'minY', 'maxX', 'maxY'))
                if box(*bounds).intersects(roi):
                    yield {'url': tile_url, 'bbox': bounds, 'id': item.get('sourceId'),
                           'publication_date': item.get('publicationDate'),
                           'updated': item.get('lastUpdated'), 'size_bytes': item.get('sizeInBytes'),
                           'survey_metadata': normalized_metadata(item),
                           'survey_identity': metadata_identity(item),
                           'metadata_url': item.get('vendorMetaUrl') or item.get('metaUrl')}
            except DISCOVERY_ERRORS as exc:
                failures.append({'source': 'TNMAccess product', 'reason': str(exc), 'buildings': 0})
        offset += len(items)
        if offset >= total:
            break
        if not new:
            raise ValueError('TNMAccess pagination repeated a page without advancing')


def manifest_tiles(fetch, url, bbox, failures, progress, catalog_tiles=None):
    text = fetch.get(url, fresh=True).decode('utf-8-sig')
    urls = sorted({line.strip() for line in text.splitlines()
                   if line.strip() and not line.lstrip().startswith('#')})
    # A plain URL list contains no locations. Match authoritative catalog
    # bounds instead of silently fetching bytes from every standalone LAZ.
    if catalog_tiles is None:
        catalog_tiles = list(tnm_tiles(fetch, bbox, failures))
    located = {tile['url']: tile for tile in catalog_tiles}
    missing = 0
    for i, tile_url in enumerate(urls):
        if i % 25 == 0:
            progress(f'Locating manifest tiles: {i}/{len(urls)} catalog matches checked')
        try:
            if urlparse(tile_url).scheme != 'https' or not urlparse(tile_url).path.lower().endswith('.laz'):
                raise ValueError('Manifest entries must be direct HTTPS LAZ URLs')
            if tile_url in located:
                yield located[tile_url]
            else:
                missing += 1
        except DISCOVERY_ERRORS as exc:
            failures.append({'source': tile_url, 'reason': str(exc), 'buildings': 0})
    if missing:
        failures.append({'source': url, 'reason': f'{missing} manifest tiles lack intersecting catalog bounds; LAZ headers were not downloaded', 'buildings': 0})


def grouped_laz(tiles):
    groups = {}
    for tile in tiles:
        # Directory identity groups delivered survey/subproject tiles. It is
        # never interpreted as a grid: every location comes from metadata.
        key = tile['url'].rsplit('/', 1)[0]+'/'
        group = groups.setdefault(key, {})
        group[tile['url']] = {**group.get(tile['url'], {}), **tile}
    sources = []
    for url, by_url in sorted(groups.items()):
        tiles = sorted(by_url.values(), key=lambda t: t['url'])
        name = unquote(urlparse(url).path.rstrip('/'))
        # Identity only changes admission, not these independently measured points.
        fingerprint = hashlib.sha256(json.dumps([
            {k: v for k, v in t.items() if k != 'survey_identity'} for t in tiles], sort_keys=True).encode()).hexdigest()
        sources.append({'url': url, 'name': name, 'format': 'LAZ', 'tiles': tiles,
            'coverage': unary_union([box(*t['bbox']) for t in tiles]), 'fingerprint': fingerprint})
    return sources


def discover_usgs(fetch, bbox, failures, progress):
    progress('Discovering USGS EPT and TNM LAZ coverage')
    try:
        catalog = fetch.json(lidar_ept.CATALOG_URL, fresh=True)
        for feature in catalog['features']:
            try:
                coverage = shape(feature['geometry'])
                if not coverage.is_valid or coverage.is_empty:
                    raise ValueError('Invalid EPT coverage geometry')
                if coverage.intersects(box(*bbox)):
                    source = feature['properties']
                    yield {**source, 'url': source['url'], 'name': source['name'],
                           'format': 'EPT', 'coverage': coverage, 'provider': 'USGS',
                           'attribution': 'USGS 3DEP; EPT mirror by Hobu',
                           'source_page': lidar_ept.CATALOG_URL}
            except DISCOVERY_ERRORS as exc:
                failures.append({'source': 'EPT catalog entry', 'reason': str(exc), 'buildings': 0})
    except DISCOVERY_ERRORS as exc:
        failures.append({'source': 'EPT catalog', 'reason': str(exc), 'buildings': 0})
    tiles = []
    try:
        tiles.extend(tnm_tiles(fetch, bbox, failures))
    except DISCOVERY_ERRORS as exc:
        failures.append({'source': 'TNMAccess', 'reason': str(exc), 'buildings': 0})
    for source in grouped_laz(tiles):
        yield {**source, 'provider': 'USGS', 'attribution': 'USGS 3DEP / The National Map',
               'source_page': TNM_URL}
