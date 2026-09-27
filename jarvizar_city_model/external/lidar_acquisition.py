"""Discover, rank and read LiDAR surveys from every configured provider.

`discover_sources` queries USGS, the lazily loaded adapters in `PROVIDERS` and
any STAC endpoints, enriches their metadata and ranks them. Streamed EPT/COPC
ranks ahead of staged LAS/LAZ unless metadata shows a material advantage.
Lower-ranked sources are retained for unresolved coverage and measurement gaps.
"""
from __future__ import annotations

from shapely.geometry import box

try:
    from .lidar_storage import StorageFull
    from . import lidar_ept, lidar_laz
    from .lidar_selection import project_year
    from .lidar_metadata import enrich_sources
    from .lidar_usgs_projects import enrich_usgs_projects
    from .lidar_ranking import rank_sources
    from .lidar_tiles import building_tile_plan, batch_source, tile_audit
    from .lidar_provenance import enrich_provenance, enrich_asset_provenance
except ImportError:
    from lidar_storage import StorageFull
    import lidar_ept, lidar_laz
    from lidar_selection import project_year
    from lidar_metadata import enrich_sources
    from lidar_usgs_projects import enrich_usgs_projects
    from lidar_ranking import rank_sources
    from lidar_tiles import building_tile_plan, batch_source, tile_audit
    from lidar_provenance import enrich_provenance, enrich_asset_provenance


try:
    from .lidar_usgs import TNM_URL, DISCOVERY_ERRORS, tnm_tiles, manifest_tiles, grouped_laz, discover_usgs
    from .lidar_stac import discover_stac
    from .lidar_candidates import candidate, asset_format, discovery_settings, staged, SOURCE_FIELDS, STREAM_FORMATS
    from .lidar_copc import read_copc
except ImportError:
    from lidar_usgs import TNM_URL, DISCOVERY_ERRORS, tnm_tiles, manifest_tiles, grouped_laz, discover_usgs
    from lidar_stac import discover_stac
    from lidar_candidates import candidate, asset_format, discovery_settings, staged, SOURCE_FIELDS, STREAM_FORMATS
    from lidar_copc import read_copc

def _provider(module, function):
    # A missing optional index reader must not disable working USGS acquisition.
    def discover(*args):
        from importlib import import_module
        adapter = import_module('.' + module, __package__) if __package__ else import_module(module)
        yield from getattr(adapter, function)(*args)
    return discover


PROVIDERS = {'usgs': discover_usgs,
             'flai': _provider('lidar_flai', 'discover_flai'),
             'opentopography': _provider('lidar_opentopography', 'discover_opentopography'),
             'ign_france': _provider('lidar_france', 'discover_france'),
             'nrcan': _provider('lidar_canada', 'discover_canada'),
             'ea_england': _provider('lidar_england', 'discover_england'),
             'scotland': _provider('lidar_scotland', 'discover_scotland'),
             'geobasis_nrw': _provider('lidar_germany', 'discover_nrw'),
             'bavaria': _provider('lidar_germany', 'discover_bavaria'),
             'pnoa_clm': _provider('lidar_spain', 'discover_spain_clm')}


def discover_sources(fetch, bbox, source_url='', manifest_url='', progress=lambda _: None, thresholds=None,
                     discovery=None, vertical_units=''):
    sources, tiles, failures = [], [], []
    settings = discovery_settings(**{k: v for k, v in (discovery or {}).items() if k != 'version'})
    if source_url:
        format = asset_format(source_url)
        if format not in STREAM_FORMATS:
            raise ValueError('Explicit streaming source must be EPT or COPC')
        sources.append(candidate('Explicit', source_url, source_url.split('/')[-2] if format == 'EPT' else source_url.rsplit('/', 1)[-1],
                                 source_url, format, box(*bbox)))
    else:
        for name in settings['providers']:
            progress(f'Discovering LiDAR provider: {name}')
            before = len(sources)
            try:
                sources.extend(PROVIDERS[name](fetch, bbox, failures, progress))
            except StorageFull:
                raise
            except Exception as exc:
                # Provider boundary: malformed third-party catalogs/indexes are optional.
                failures.append({'source': name, 'reason': str(exc), 'buildings': 0})
                progress(f'LiDAR provider {name} unavailable: {exc}; continuing with other sources')
            progress(f'LiDAR provider {name}: {len(sources) - before} candidate surveys')
        for endpoint in settings['stac_urls']:
            try:
                sources.extend(discover_stac(fetch, bbox, endpoint, failures, progress))
            except DISCOVERY_ERRORS as exc:
                failures.append({'source': endpoint, 'reason': str(exc), 'buildings': 0})
    if manifest_url:
        try:
            catalog_tiles = [t for s in sources if s.get('provider') == 'USGS' for t in s.get('tiles', [])]
            tiles.extend(manifest_tiles(fetch, manifest_url, bbox, failures, progress,
                                        catalog_tiles if not source_url else None))
        except DISCOVERY_ERRORS as exc:
            failures.append({'source': manifest_url, 'reason': str(exc), 'buildings': 0})
    sources.extend(grouped_laz(tiles))
    if vertical_units:
        for source in sources:
            source['vertical_units'] = source.get('vertical_units') or vertical_units
            source['vertical_units_basis'] = 'user-declared fallback for missing vertical units'
    sources = list({s['url']: s for s in sources}.values())
    enrich_sources(fetch, sources, failures, progress)
    enrich_usgs_projects(fetch, sources, bbox, failures, progress)
    enrich_provenance(fetch, sources, bbox, progress)
    enrich_asset_provenance(sources, progress)
    roi = box(*bbox)
    for source in sources:
        source['catalog_coverage'] = source['coverage'].intersection(roi).area/roi.area
        source['project_year_hint'] = project_year(source['name'])
        sizes = [t.get('size_bytes') for t in source.get('tiles', [])]
        if sizes and all(isinstance(n, (int, float)) and n > 0 for n in sizes):
            source['estimated_bytes'] = sum(sizes)
    ranked = rank_sources(sources, thresholds)
    sources = [s for s, _ in ranked]
    for rank, (source, reason) in enumerate(ranked, 1):
        source.update(rank=rank, ranking_reason=reason)
        meta = source.get('survey_metadata', {})
        def value(key):
            return meta.get(key, 'unknown')
        accuracy = ', '.join(f"{key}={value(key)}" +
            (f" ({value(key.replace('_m', '_basis'))})" if 'accuracy' in key else '') for key in
            ('horizontal_rmse_m', 'vertical_rmse_m', 'horizontal_accuracy_m', 'vertical_accuracy_m'))
        progress(f"LiDAR rank {rank}: {source.get('provider', 'unknown provider')} {source['format']} {source['name']}; acquisition="
                 f"{value('acquisition_start')}..{value('acquisition_end')}; "
                 f"spacing={value('point_spacing_m')} m; density={value('point_density_m2')} pts/m2; "
                 f"{accuracy}; ground={value('ground_class')}, buildings={value('building_class')}; "
                 f"classification quality={value('classification_quality')} ({value('classification_basis')}); "
                 f"coverage={source['catalog_coverage']:.1%}; "
                 f"survey={','.join(source.get('survey_identity', {}).get('datasets', []) or source.get('survey_identity', {}).get('projects', [])) or 'unknown'}; {reason}")
    return sources, failures


def read_source(fetch, source, bbox):
    if staged(source):
        points, info = lidar_laz.read_laz(fetch, source, bbox)
    elif source['format'] == 'COPC':
        points, info = read_copc(fetch, source, bbox)
    else:
        points, info = lidar_ept.read_ept(fetch, source['url'], bbox, source=source)
    # A reported single-year acquisition can date undated returns. Never
    # overwrite GPS evidence or collapse a multi-year survey into one epoch.
    meta = source.get('survey_metadata', {})
    start, end = meta.get('acquisition_start', ''), meta.get('acquisition_end', '')
    if len(points) and not (points[:, 5] > 0).any() and start and end and start[:4] == end[:4]:
        points[:, 5], points[:, 6] = int(start[:4]), .75
    roof = ((points[:, 3] == 1) & (points[:, 4] == 1)) | (points[:, 3] == 6)
    classified = float((points[:, 3] == 6).sum()/roof.sum()) if roof.any() else 0.0
    return points, {**{k: source[k] for k in SOURCE_FIELDS if k in source}, **info, 'format': source['format'], 'classified_roof_fraction': classified}


def source_audit(sources):
    return [{k: s[k] for k in SOURCE_FIELDS + ('url', 'format', 'catalog_coverage', 'project_year_hint',
                              'survey_metadata', 'rank', 'ranking_reason', 'metadata_note',
                              'unusable_reason', 'acquired_buildings', 'acquisition_reasons',
                              'skipped_fallback_reasons', 'survey_identity', 'selected_tiles',
                              'possible_duplicates', 'provenance_matches', 'provenance_note',
                              'incremental_acquisition', 'estimated_bytes', 'vertical_units_basis') if k in s}
            | {'tile_count': len(s.get('tiles', []))} for s in sources]
