"""Bounded STAC API/static-catalog discovery; only metadata is fetched here."""
import hashlib
import json
from urllib.parse import urljoin

from pyproj import CRS
from shapely.geometry import box, shape
from shapely.ops import unary_union

try:
    from .lidar_candidates import candidate, asset_format, https_url
    from .lidar_metadata import normalized_metadata, aggregate_metadata, positive
    from .lidar_services import query_url
except ImportError:
    from lidar_candidates import candidate, asset_format, https_url
    from lidar_metadata import normalized_metadata, aggregate_metadata, positive
    from lidar_services import query_url

MAX_DOCUMENTS = 256


def stac_metadata(properties):
    meta = normalized_metadata(properties)
    crs = properties.get('proj:wkt2') or properties.get('proj:code')
    if not crs and properties.get('proj:epsg'):
        crs = f"EPSG:{int(properties['proj:epsg'])}"
    # STAC datetime is the observation time, unlike created/updated timestamps.
    dates = normalized_metadata({'acquisition_start': properties.get('start_datetime') or properties.get('datetime'),
                                 'acquisition_end': properties.get('end_datetime') or properties.get('datetime')})
    meta.update(dates)
    density = positive(properties.get('pc:density'))
    if density and crs:
        parsed = CRS.from_user_input(crs).to_2d()
        if parsed.is_projected:
            meta['point_density_m2'] = density / parsed.axis_info[0].unit_conversion_factor**2
    policy = properties.get('classification', {})
    if not isinstance(policy, dict):
        policy = {'convention': str(policy)}
    labels = properties.get('classification:classes')
    if isinstance(labels, list) and labels:
        policy = {'convention': 'declared', 'mapping': {
            str(c['value']): str(c.get('name', '')).lower() for c in labels}}
    if policy.get('mapping'):
        meanings = set(policy['mapping'].values())
        meta.update(ground_class='ground' in meanings,
                    building_class=bool(meanings & {'building', 'buildings'}))
    result = {'survey_metadata': meta, 'classification': policy,
              'vertical_datum': properties.get('vertical_datum', 'unknown'),
              'license': properties.get('license', 'unknown'),
              'attribution': properties.get('sci:citation') or properties.get('attribution', '')}
    if crs:
        result['horizontal_crs'] = crs
    for key in ('vertical_units', 'vertical_crs'):
        if properties.get(key):
            result[key] = properties[key]
    return result


def item_assets(item, document_url, provider, inherited=None):
    if item.get('type') != 'Feature' or not item.get('geometry'):
        return
    coverage = shape(item['geometry'])
    props = {**(inherited or {}), **(item.get('properties') or {})}
    collection = item.get('collection')
    scope = next((urljoin(document_url, l['href']) for l in item.get('links', [])
                  if l.get('rel') == 'collection'), document_url.split('/search')[0])
    dataset_id = f"{scope}#{collection or item['id']}"
    for key, asset in (item.get('assets') or {}).items():
        roles = set(asset.get('roles', []))
        if roles and 'data' not in roles:
            continue
        url = https_url(urljoin(document_url, asset['href']))
        inherited_encoding = props.get('pc:encoding', '') if (asset_format(url) or 'data' in roles) else ''
        format = asset_format(url, asset.get('type', ''), asset.get('pc:encoding', inherited_encoding))
        if not format:
            continue
        values = {**props, **asset}
        if values.get('pc:type') not in (None, 'lidar'):
            continue
        metadata = stac_metadata(values)
        tile = {'url': url, 'bbox': list(coverage.bounds),
                'id': str(item['id']), 'updated': values.get('updated') or values.get('file:checksum', ''),
                'size_bytes': positive(asset.get('file:size')), **metadata}
        # Epoch and normalization metadata are part of grouping. A collection
        # can contain several independent surveys and incompatible datums.
        grouping = json.dumps([dataset_id, metadata], sort_keys=True)
        yield {'group': grouping, 'provider': provider, 'dataset_id': dataset_id,
               'name': props.get('title') or collection or str(item['id']), 'url': url,
               'format': format, 'coverage': coverage, 'tile': tile,
               'source_page': next((urljoin(document_url, l['href']) for l in item.get('links', [])
                                    if l.get('rel') == 'via'), document_url), **metadata}


def grouped_assets(assets):
    groups = {}
    for asset in assets:
        key = (asset['group'], asset['format']) if asset['format'] != 'EPT' else (asset['url'], 'EPT')
        groups.setdefault(key, {})[asset['url']] = asset
    for (_, format), members in sorted(groups.items()):
        values = list(members.values())
        first = values[0]
        tiles = [v['tile'] for v in values]
        metadata = {k: first[k] for k in ('survey_metadata', 'classification', 'horizontal_crs',
            'vertical_datum', 'vertical_units', 'vertical_crs', 'license', 'attribution', 'source_page') if k in first}
        metadata['survey_metadata'] = aggregate_metadata([v['survey_metadata'] for v in values])
        # Actual asset URL identifies a single EPT/COPC; multi-tile datasets use
        # a stable metadata scope, with format suffix so alternate deliveries coexist.
        url = first['url'] if len(tiles) == 1 else first['dataset_id'].split('#')[0] + '#delivery=' + format + '-' + hashlib.sha256(first['group'].encode()).hexdigest()[:16]
        yield candidate(first['provider'], first['dataset_id'], first['name'], url, format,
                        unary_union([v['coverage'] for v in values]),
                        tiles=tiles if format != 'EPT' else None,
                        identity_is_delivery=True, **metadata)


def discover_stac(fetch, bbox, endpoint, failures, progress, provider='STAC'):
    """GET/POST Item Search, next links, and bounded static child/item traversal."""
    pending = [(https_url(endpoint), None, {})]
    seen, assets = set(), []
    roi = box(*bbox)
    while pending:
        url, body, inherited = pending.pop(0)
        key = (url, json.dumps(body, sort_keys=True))
        if key in seen:
            failures.append({'source': provider, 'reason': 'Repeated STAC page/link skipped', 'buildings': 0})
            continue
        if len(seen) >= MAX_DOCUMENTS:
            failures.append({'source': provider, 'reason': 'STAC traversal limit reached; coverage listing is incomplete', 'buildings': 0})
            break
        seen.add(key)
        try:
            progress(f'Discovering {provider}: catalog page {len(seen)}')
            document = fetch.json(url, fresh=True) if body is None else fetch.json_request(url, body)
            kind = document.get('type')
            if kind not in ('Feature', 'FeatureCollection', 'Catalog', 'Collection'):
                raise ValueError('Not a STAC catalog or item response')
            if kind == 'Collection':
                extents = document.get('extent', {}).get('spatial', {}).get('bbox', [])
                if extents and not any(box(*(b if len(b) == 4 else [b[0], b[1], b[3], b[4]])).intersects(roi) for b in extents):
                    continue
                inherited = {**inherited, **document.get('properties', {}),
                             'license': document.get('license', 'unknown'),
                             'attribution': document.get('sci:citation', '')}
            items = document.get('features', []) if kind == 'FeatureCollection' else [document] if kind == 'Feature' else []
            for item in items:
                try:
                    if item.get('geometry') and shape(item['geometry']).intersects(roi):
                        assets.extend(item_assets(item, url, provider, inherited))
                except (ValueError, KeyError, TypeError, AttributeError) as exc:
                    failures.append({'source': provider, 'reason': f'Invalid STAC item: {exc}', 'buildings': 0})
            links = document.get('links', [])
            searches = [l for l in links if l.get('rel') == 'search']
            if searches and kind in ('Catalog', 'Collection'):
                search = next((l for l in searches if l.get('method', 'GET') == 'GET'), searches[0])
                target = urljoin(url, search['href'])
                query = {'bbox': list(bbox), 'limit': 100}
                if kind == 'Collection':
                    query['collections'] = [document['id']]
                if search.get('method', 'GET') == 'POST':
                    pending.append((target, query, inherited))
                else:
                    query['bbox'] = ','.join(map(str, bbox))
                    if 'collections' in query:
                        query['collections'] = ','.join(query['collections'])
                    pending.append((query_url(target, query), None, inherited))
            else:
                for link in links:
                    rel = link.get('rel')
                    if rel not in ('next', 'child', 'item', 'items'):
                        continue
                    target = https_url(urljoin(url, link['href']))
                    if rel == 'items':
                        target = query_url(target, {'bbox': ','.join(map(str, bbox)), 'limit': 100})
                    method = link.get('method', 'GET')
                    if method not in ('GET', 'POST'):
                        raise ValueError('Unsupported STAC pagination method')
                    next_body = None
                    if method == 'POST':
                        next_body = {**((body or {}) if link.get('merge') else {}), **link.get('body', {})}
                    pending.append((target, next_body, inherited))
        except (ValueError, OSError, RuntimeError, KeyError, TypeError, AttributeError) as exc:
            failures.append({'source': provider, 'reason': f'STAC discovery unavailable: {exc}', 'buildings': 0})
    yield from grouped_assets(assets)
