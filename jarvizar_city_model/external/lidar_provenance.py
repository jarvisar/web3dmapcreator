"""Bounded EPT input provenance, verified locally against staged LAS headers.

No tile filenames or year suffixes establish equivalence. A partial/mixed
manifest or bounded sample can confirm only its own matched spatial region.
"""
import hashlib
import json
import math
import struct
from urllib.parse import unquote, urljoin, urlparse
from uuid import UUID

from pyproj import Transformer
from shapely.geometry import box
from shapely.ops import unary_union

try:
    from .lidar_identity import metadata_identity, common_identity, merge_identities, same_survey, possible_duplicate
    from .lidar_ept import ept_coordinate_system
except ImportError:
    from lidar_identity import metadata_identity, common_identity, merge_identities, same_survey, possible_duplicate
    from lidar_ept import ept_coordinate_system

MANIFEST_LIMIT = 4 * 1024 ** 2
INPUT_LIMIT = 256 * 1024
MAX_INPUTS = 32
MAX_HEADERS = 32
PROVENANCE_BUDGET = 8 * 1024 ** 2
ERRORS = (ValueError, OSError, RuntimeError, KeyError, TypeError, IndexError, AttributeError, struct.error)


def enrich_asset_provenance(sources, progress):
    """Metadata-only aliases, restricted to the matched original tiles' area.

    Exact delivery URLs also catch assets repeated in STAC/aggregator catalogs.
    A bare grid filename, similar survey title or overlapping extent is never
    enough. No staged point headers are fetched to establish these aliases.
    """
    assets = {}
    for source in sources:
        for tile in source.get('tiles', [source]):
            geom = box(*tile['bbox']).intersection(source['coverage']) if tile.get('bbox') else source['coverage']
            keys = {tile['url'], tile.get('original_asset_id'), tile.get('original_asset_url')} - {None, ''}
            for key in keys:
                assets.setdefault(key, []).append((source, geom))
    regions = {}
    for members in assets.values():
        for i, (a, ga) in enumerate(members):
            for b, gb in members[i + 1:]:
                if a['url'] == b['url']:
                    continue
                region = ga.intersection(gb)
                if not region.is_empty:
                    for left, right in ((a, b), (b, a)):
                        regions.setdefault((left['url'], right['url']), []).append(region)
    lookup = {s['url']: s for s in sources}
    for (a, b), polygons in regions.items():
        lookup[a].setdefault('provenance_coverage', {})[b] = unary_union(polygons)
        progress(f"Shared original point-cloud tiles: {lookup[a]['name']} / {lookup[b]['name']}; duplicate suppression applies inside matched coverage")


def header_signature(fetch, tile, allow_network=False):
    """Read only the fixed LAS header, at most 375 bytes (no VLR/point reads)."""
    url, revision = tile['url'], tile.get('updated') or ''
    key = url + ('#revision=' + revision if revision else '')
    path = fetch.cache / hashlib.sha256(key.encode()).hexdigest() if hasattr(fetch, 'cache') else None
    if path is not None and path.is_file() and not fetch.refresh:
        with path.open('rb') as stream:
            prefix = stream.read(227)
            size = struct.unpack_from('<H', prefix, 94)[0]
            if not 227 <= size <= 375:
                raise ValueError('Unsupported LAS public header size')
            prefix += stream.read(size - 227)
    else:
        if not allow_network:
            raise ValueError('LAZ header not cached; no automatic LAZ reads')
        prefix = fetch.range(url, 0, 227)
        size = struct.unpack_from('<H', prefix, 94)[0]
        if not 227 <= size <= 375:
            raise ValueError('Unsupported LAS public header size')
        if size > 227:
            prefix += fetch.range(url, 227, size - 227)
    if prefix[:4] != b'LASF' or len(prefix) != size or prefix[24] != 1 or prefix[25] > 4:
        raise ValueError('Invalid LAS public header')
    if struct.unpack_from('<I', prefix, 96)[0] < size:
        raise ValueError('Invalid LAS point offset')
    count = struct.unpack_from('<Q', prefix, 247)[0] if prefix[25] == 4 else struct.unpack_from('<I', prefix, 107)[0]
    raw_bounds = struct.unpack_from('<6d', prefix, 179)
    return {'project_id': str(UUID(bytes_le=prefix[8:24])), 'count': count,
            'bounds': [raw_bounds[i] for i in (1, 3, 5, 0, 2, 4)],
            'scales': list(struct.unpack_from('<3d', prefix, 131)),
            'dataformat_id': prefix[104] & 63, 'global_encoding': struct.unpack_from('<H', prefix, 6)[0]}


def same_input(document, header):
    """A nonzero project GUID plus count, XYZ extents, quantization and format.

    Legacy EPT input metadata also serialized GUID fields in raw byte order.
    Accept that representation only with all the independent header facts.
    Creation/publication years are never treated as acquisition dates.
    """
    meta = document.get('metadata') or {}
    try:
        project, other = UUID(meta['project_id']), UUID(header['project_id'])
        if not project.int or not other.int or other not in (project, UUID(bytes_le=project.bytes)):
            return False
        if (meta['count'] != header['count'] or meta['count'] <= 0
                or meta['dataformat_id'] != header['dataformat_id']
                or meta['global_encoding'] != header['global_encoding']):
            return False
        bounds = [meta[key] for key in ('minx', 'miny', 'minz', 'maxx', 'maxy', 'maxz')]
        scales = [meta['scale_' + axis] for axis in 'xyz']
        if any(not math.isfinite(v) for v in bounds + scales + header['bounds'] + header['scales']):
            return False
        return (all(s > 0 and math.isclose(s, t, rel_tol=1e-10, abs_tol=1e-12) for s, t in zip(scales, header['scales']))
                and all(math.isclose(x, y, rel_tol=0, abs_tol=1e-6) for x, y in zip(bounds, header['bounds'])))
    except (KeyError, ValueError, TypeError, AttributeError):
        return False


def input_metadata_url(base, value):
    if not isinstance(value, str):
        raise ValueError('Missing EPT input metadata link')
    url = urljoin(base, value)
    if (urlparse(url).scheme != 'https' or not url.startswith(base)
            or urlparse(url).query or not urlparse(url).path.endswith('.json')
            or '..' in unquote(urlparse(url).path).split('/') or '\\' in unquote(value)):
        raise ValueError('EPT input metadata link escapes ept-sources')
    return url


def enrich_provenance(fetch, sources, bbox, progress, allow_header_reads=False):
    laz_sources = [s for s in sources if s['format'] == 'LAZ']
    if not laz_sources:
        return
    headers, header_attempts = {}, 0
    remaining = PROVENANCE_BUDGET
    def document(url, limit):
        nonlocal remaining
        if remaining <= 0:
            raise ValueError('EPT provenance byte budget exhausted')
        data = fetch.get(url, limit=min(limit, remaining))
        if len(data) > min(limit, remaining):
            raise ValueError('EPT provenance document exceeds limit')
        remaining -= len(data)
        return json.loads(data)
    roi = box(*bbox)
    for ept in sorted((s for s in sources if s['format'] == 'EPT' and not s.get('unusable_reason')), key=lambda s: s['url']):
        candidates = [s for s in laz_sources if not same_survey(s, ept) and s['coverage'].intersects(ept['coverage'])]
        if not candidates:
            continue
        for laz in candidates:
            if possible_duplicate(laz, ept):
                laz.setdefault('possible_duplicates', []).append(ept['url'])
                progress(f"Possible duplicate survey: {laz['name']} / {ept['name']}; verifying EPT input provenance")
        base = ept['url'].rsplit('/', 1)[0] + '/ept-sources/'
        try:
            try:
                manifest = document(base + 'manifest.json', MANIFEST_LIMIT)
            except ERRORS:
                manifest = document(base + 'list.json', MANIFEST_LIMIT)
            if not isinstance(manifest, list) or not manifest:
                raise ValueError('EPT source manifest is empty or invalid')
            root = fetch.json(ept['url'], limit=MANIFEST_LIMIT)
            crs, _, _ = ept_coordinate_system(root, ept['url'])
            to_geo = Transformer.from_crs(crs, 4326, always_xy=True)
            local, all_identities = [], []
            for index, entry in enumerate(manifest):
                if not isinstance(entry, dict):
                    all_identities.append({})
                    continue
                inserted = (entry.get('inserted') is True or entry.get('status') == 'inserted') and not entry.get('error')
                identity = metadata_identity(entry) if inserted else {}
                all_identities.append(identity)
                bounds = entry.get('bounds')
                if (not inserted or not isinstance(bounds, list) or len(bounds) != 6
                        or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in bounds)
                        or bounds[0] >= bounds[3] or bounds[1] >= bounds[4]):
                    continue
                coverage = box(*to_geo.transform_bounds(bounds[0], bounds[1], bounds[3], bounds[4], densify_pts=21))
                if coverage.intersects(roi):
                    local.append((index, entry, coverage, identity))
            # Only complete, uniformly identified manifests may establish a global alias.
            ept['survey_identity'] = merge_identities(ept.get('survey_identity', {}), common_identity(all_identities))
            matched = {s['url']: [] for s in candidates}
            for index, entry, coverage, identity in local[:MAX_INPUTS]:
                metadata_url = None
                metadata = None
                for laz in candidates:
                    if same_survey({'survey_identity': identity}, laz):
                        matched[laz['url']].append(coverage.intersection(laz['coverage']))
                        laz.setdefault('provenance_matches', []).append({'ept_url': ept['url'], 'manifest': base,
                            'path': entry.get('path'), 'basis': 'original project identifier', 'bbox': list(coverage.bounds)})
                        continue
                    for tile in laz['tiles']:
                        tile_coverage = box(*tile['bbox'])
                        if not tile_coverage.intersects(coverage):
                            continue
                        if metadata is None:
                            link = entry.get('metadataPath') or (str(index) + '.json' if entry.get('status') == 'inserted' else None)
                            try:
                                metadata_url = input_metadata_url(base, link)
                                metadata = document(metadata_url, INPUT_LIMIT)
                                if not isinstance(metadata, dict):
                                    raise ValueError('Invalid EPT input metadata')
                                if metadata.get('path') and metadata['path'] != entry.get('path'):
                                    raise ValueError('EPT metadata describes a different input')
                            except ERRORS:
                                metadata = {}
                        if same_survey({'survey_identity': metadata_identity(metadata)}, laz):
                            region = coverage.intersection(tile_coverage).intersection(ept['coverage'])
                            matched[laz['url']].append(region)
                            laz.setdefault('provenance_matches', []).append({'ept_url': ept['url'], 'metadata_url': metadata_url,
                                'laz_url': tile['url'], 'basis': 'original input dataset/project metadata', 'bbox': list(region.bounds)})
                            continue
                        # Don't make header requests without a usable original GUID.
                        try:
                            if not UUID((metadata.get('metadata') or {}).get('project_id', '')).int:
                                continue
                        except (ValueError, AttributeError, TypeError):
                            continue
                        key = tile['url'], tile.get('updated') or ''
                        if key not in headers and header_attempts < MAX_HEADERS:
                            header_attempts += 1
                            try:
                                headers[key] = header_signature(fetch, tile, allow_network=allow_header_reads)
                            except ERRORS:
                                headers[key] = {}
                        if same_input(metadata, headers.get(key, {})):
                            region = coverage.intersection(tile_coverage).intersection(ept['coverage'])
                            matched[laz['url']].append(region)
                            laz.setdefault('provenance_matches', []).append({'ept_url': ept['url'], 'metadata_url': metadata_url,
                                'laz_url': tile['url'], 'project_id': headers[key]['project_id'],
                                'basis': 'original LAS project GUID, point count, XYZ extents, scales, format and encoding',
                                'bbox': list(region.bounds)})
            for laz in candidates:
                regions = matched[laz['url']]
                if regions:
                    laz.setdefault('provenance_coverage', {})[ept['url']] = unary_union(regions)
                    progress(f"Verified EPT input provenance: {laz['name']}; {len(regions)} matched input regions; applies only inside verified coverage")
            ept['provenance_note'] = f'{len(local)} local inputs; inspected at most {MAX_INPUTS}; missing/unverified regions retain unknown identity'
        except ERRORS as exc:
            ept['provenance_note'] = f'EPT input provenance unavailable: {exc}'
            progress(ept['provenance_note'])
