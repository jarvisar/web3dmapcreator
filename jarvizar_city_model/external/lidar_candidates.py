"""Provider-neutral acquisition contract and settings (safe inside Blender).

Candidates are dictionaries so existing checkpoints/audits remain ordinary JSON.
Discovery adds a WGS84 Shapely ``coverage`` in the external process only. Tiles
belong to one survey/epoch; readers never combine independently acquired surveys.
"""
import hashlib
import json
from urllib.parse import urlparse

STREAM_FORMATS = frozenset({'EPT', 'COPC'})
STAGED_FORMATS = frozenset({'LAZ', 'LAS'})
DEFAULT_PROVIDERS = ('usgs', 'flai', 'opentopography', 'ign_france', 'nrcan',
                     'ea_england', 'scotland', 'geobasis_nrw', 'bavaria', 'pnoa_clm')
PROVIDER_VERSION = 2
SOURCE_FIELDS = ('provider', 'dataset_id', 'name', 'license', 'attribution',
                 'source_page', 'horizontal_crs', 'vertical_datum',
                 'vertical_units', 'vertical_units_basis', 'vertical_crs', 'classification', 'survey_metadata',
                 'authoritative', 'delivery_note')


def streamable(source):
    return source['format'] in STREAM_FORMATS


def staged(source):
    return source['format'] in STAGED_FORMATS


def asset_format(url, media_type='', encoding=''):
    path = urlparse(url).path.lower()
    media = (str(media_type) + ' ' + str(encoding)).lower()
    if path.endswith('ept.json') or 'vnd.entwine' in media or encoding == 'ept':
        return 'EPT'
    if path.endswith(('.copc.laz', '.copc.las', '.copc')) or 'copc' in media:
        return 'COPC'
    if path.endswith('.laz') or 'vnd.laszip' in media:
        return 'LAZ'
    if path.endswith('.las') or 'vnd.las' in media:
        return 'LAS'
    return None


def https_url(url):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('LiDAR sources require a public HTTPS URL without embedded credentials')
    return url


def discovery_settings(providers=None, stac_urls=()):
    providers = DEFAULT_PROVIDERS if providers is None else tuple(providers)
    if set(providers) - set(DEFAULT_PROVIDERS):
        raise ValueError('Unknown LiDAR provider')
    if isinstance(stac_urls, str):
        stac_urls = stac_urls.splitlines()
    urls = sorted({https_url(u.strip()) for u in stac_urls if u.strip()})
    if len(urls) > 8:
        raise ValueError('Use at most eight STAC catalogs')
    return {'version': PROVIDER_VERSION, 'providers': sorted(set(providers)), 'stac_urls': urls}


def candidate(provider, dataset_id, name, url, format, coverage, tiles=None, **metadata):
    """Single boundary for provider adapters; fail closed on invalid candidates."""
    https_url(url)
    if format not in STREAM_FORMATS | STAGED_FORMATS:
        raise ValueError('Unsupported point cloud format')
    if coverage.is_empty or not coverage.is_valid:
        raise ValueError('Invalid point cloud coverage')
    result = dict(provider=provider, dataset_id=str(dataset_id), name=str(name),
                  url=url, format=format, coverage=coverage, **metadata)
    if tiles is not None:
        result['tiles'] = sorted(tiles, key=lambda t: t['url'])
    # Every normalization choice and dataset revision participates in cache and
    # consent identity. Exclude only runtime geometry; each tile has JSON bounds.
    identity = {k: v for k, v in result.items() if k != 'coverage'}
    result['fingerprint'] = hashlib.sha256(json.dumps(identity, sort_keys=True,
                                                     allow_nan=False).encode()).hexdigest()
    return result
