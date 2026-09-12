"""USGS work-unit collection dates for known EPT and staged LPC deliveries.

Read the spatial project index used by 3DEP, without downloading point data.
Match complete work-unit identifiers, never a city name or spatial overlap alone.
"""
from datetime import datetime, timezone
import math
from shapely.errors import ShapelyError

try:
    from .lidar_identity import project_key, usgs_project
    from .lidar_metadata import date_interval, normalized_metadata
    from .lidar_services import features
except ImportError:
    from lidar_identity import project_key, usgs_project
    from lidar_metadata import date_interval, normalized_metadata
    from lidar_services import features


PROJECT_QUERY = 'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/24/query'


def _workunit_key(value):
    # The USGS EPT mirror prefixes some delivery identifiers with USGS_LPC.
    # Retain every remaining token, including subunit and edition/year.
    return project_key(value).removeprefix('usgs_lpc_')


def _collection_date(value):
    # ArcGIS dates are milliseconds since the Unix epoch, in UTC. Local-time
    # conversion would turn a midnight collection date into the previous day.
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    try:
        day = datetime.fromtimestamp(value / 1000, timezone.utc).date().isoformat()
    except (ValueError, OverflowError, OSError):
        return None
    return day if date_interval(day) else None


def enrich_usgs_projects(fetch, sources, bbox, failures, progress):
    eligible = []
    for source in sources:
        key = usgs_project(source['url']) if source.get('provider') == 'USGS' else None
        if key:
            eligible.append((source, _workunit_key(key)))
    if not eligible:
        return
    progress('Reading USGS work-unit collection dates and quality levels')
    try:
        # Shared service reader bounds time/bytes and validates pagination,
        # geographic polygons and error responses. It caches metadata for 24 h.
        rows = list(features(fetch, PROJECT_QUERY, bbox, arcgis=True))
    except (ValueError, OSError, RuntimeError, KeyError, TypeError, AttributeError, ShapelyError) as exc:
        failures.append({'source': PROJECT_QUERY, 'reason': f'USGS project metadata unavailable: {exc}', 'buildings': 0})
        progress('USGS project dates unavailable; retaining existing survey metadata')
        return
    matched = 0
    for source, key in eligible:
        matches = [row for row, geometry in rows
                   if isinstance(row.get('workunit'), str)
                   and _workunit_key(row['workunit']) == key
                   and geometry.intersection(source['coverage']).area > 0]
        if len(matches) != 1:
            # Multiple editions with the same name are ambiguous; do not
            # promote a partial work unit's dates to a different survey.
            continue
        row = matches[0]
        dates = normalized_metadata({
            'acquisition_start': _collection_date(row.get('collect_start')),
            'acquisition_end': _collection_date(row.get('collect_end')),
        })
        meta = source.setdefault('survey_metadata', {})
        if dates:
            # Retain any wider interval already established by source reports.
            # A single newer date cannot narrow a known multi-year acquisition.
            for field, combine in (('acquisition_start', min), ('acquisition_end', max)):
                if field in dates:
                    meta[field] = combine(meta[field], dates[field]) if meta.get(field) else dates[field]
            meta['date_basis'] = 'reported acquisition; USGS work-unit index'
        meta['usgs_workunit'] = row['workunit']
        meta['usgs_workunit_id'] = row.get('workunit_id')
        meta['usgs_project_metadata_url'] = PROJECT_QUERY
        meta['usgs_collection_start'] = dates.get('acquisition_start')
        meta['usgs_collection_end'] = dates.get('acquisition_end')
        if isinstance(row.get('ql'), str):
            # QL is a survey quality category, not measured classification
            # quality or point spacing; keep it as reported audit information.
            meta['usgs_quality_level'] = row['ql']
        matched += 1
    progress(f'USGS work-unit metadata matched {matched}/{len(eligible)} survey deliveries')
