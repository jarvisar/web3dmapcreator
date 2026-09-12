"""Choose a complete, compatible survey measurement for each building.

Dates describe observations, never OSM edit timestamps. No roofs, ground
references, tiers or vertices are averaged between candidate measurements.
"""
from datetime import datetime, timezone
import math
import re

try:
    from .lidar_records import has_roof_surface, roof_faces
except ImportError:
    from lidar_records import has_roof_surface, roof_faces


POLICY = 'format-neutral EPT/LAZ comparison; source footprints and spatial height confidence; complete survey observations with capture-age preference; classification availability breaks quality ties; no mixed geometry'
CONTRADICTIONS = frozenset({'source_height_conflict', 'footprint_roof_mismatch',
    'roof_extends_outside_footprint', 'observed_ground_in_footprint',
    'predates_building', 'mixed_capture_epochs'})


def project_year(name):
    # A later LAS/publication year is not the flight year. This remains a
    # clearly labelled hint and is not sufficient to veto older observations.
    match = re.search(r'(?<!\d)((?:19|20)\d{2})(?!\d)', name or '')
    return int(match[1]) if match else None


def construction_year(properties):
    # Only explicit construction/start fields, not sources[].update_time or
    # the Overture release/version. Most Overture features have no such date.
    for key in ('start_date', 'building:start_date', 'construction_date', 'year_built'):
        value = properties.get(key)
        if value is None or isinstance(value, bool):
            continue
        match = re.fullmatch(r'((?:19|20)\d{2})(?:-\d{2}(?:-\d{2})?)?', str(value).strip())
        if match:
            return int(match[1])
    return None


def top_height(record):
    return max([record['height_m']] + [t['top_m'] for t in record['tiers']]
               + list(record.get('part_heights', {}).values())
               + [v[2] for ring in roof_faces(record) for v in ring])


def height_conflict(a, b):
    return min(a,b) > 0 and max(a,b)-min(a,b) > 20 and min(a,b) < max(a,b)*.65


def profiles_conflict(a, b, footprint=None):
    if height_conflict(top_height(a), top_height(b)):
        return True
    if a.get('method') == 'source_parts' or b.get('method') == 'source_parts':
        if a.get('method') != b.get('method'):
            # Different reconstruction modes cannot establish that an older
            # observation still describes the same complete building.
            return True
        for key in set(a.get('part_heights', {})) & set(b.get('part_heights', {})):
            if height_conflict(a['part_heights'][key], b['part_heights'][key]):
                return True
    if footprint is None or has_roof_surface(a) or has_roof_surface(b):
        return False
    from shapely.geometry import shape
    def regions(record):
        shapes = [footprint]+[shape(t['geometry']).intersection(footprint) for t in record['tiers']]
        heights = [record['height_m']]+[t['top_m'] for t in record['tiers']]
        return [(p.difference(shapes[i+1]) if i+1<len(shapes) else p,heights[i]) for i,p in enumerate(shapes)]
    threshold = max(5, max(top_height(a),top_height(b))*.15)
    disagreement = sum(p.intersection(q).area for p,h in regions(a) for q,k in regions(b) if abs(h-k)>threshold)
    return disagreement > footprint.area*.2


def quality(record):
    coverage = max(0.0, min(1.0, record.get('coverage',0)))
    explained = max(0.0, min(1.0, record.get('explained_fraction',coverage)))
    density = max(0.0, record.get('roof_support_density_m2',0))
    # More fitted tiers are not inherently better data (they can be noise).
    # Saturating density avoids letting facade-heavy/dense scans dominate.
    support = min(1.0, math.log2(1+density)/math.log2(5))
    return .6*coverage + .25*explained + .15*support


def choose_measurement(candidates, observations=(), footprint=None, prefer_lidar=False):
    """Choose one usable survey; optionally retain it despite conflicting data."""
    if not candidates:
        return None, {'reason':'no_compatible_measurement', 'candidates':0}
    known = [r['capture_year'] for r in candidates if r.get('capture_year')]
    newest = max(known, default=0)
    def score(record):
        year = record.get('capture_year')
        age = min(8, newest-year) if year and newest else 0
        # Quality has priority over sparse/new data. Among comparable usable
        # observations, prefer recent capture; unknown age earns no bonus.
        recency = .12 - age*.015 if year else 0
        return quality(record)+recency
    ordered = sorted(candidates, key=lambda r:(-score(r), -quality(r),
        -r.get('classified_roof_fraction', 0), r.get('source',''), r.get('source_url','')))
    selected = ordered[0]
    year = selected.get('capture_year')
    conflicts = []
    for observation in observations:
        newer = observation.get('capture_year')
        if observation.get('reason') in CONTRADICTIONS and (not newer or not year or newer >= year):
            conflict = {'reason':'newer_or_same_age_conflict', 'source':observation.get('source',''),
                        'capture_year':newer, 'conflict':observation['reason'], 'candidates':len(candidates)}
            if not prefer_lidar:
                return None, conflict
            conflicts.append(conflict)
    # Do not pick between two materially different buildings just because a
    # scan has more points when their chronology is missing or indistinct.
    for other in ordered[1:]:
        if profiles_conflict(selected, other, footprint):
            other_year = other.get('capture_year')
            reason = ('conflicting_surveys_unknown_order' if not year or not other_year or year == other_year
                      else 'newer_survey_building_changed' if other_year > year else None)
            if reason:
                conflict = {'reason':reason, 'source':other.get('source',''), 'candidates':len(candidates)}
                if not prefer_lidar:
                    return None, conflict
                conflicts.append(conflict)
    return selected, {'reason':'best_usable_survey' if prefer_lidar else 'best_compatible_survey',
        'ignored_conflicts':conflicts, 'candidates':len(candidates),
        'source':selected.get('source',''), 'source_url':selected.get('source_url',''),
        'source_format':selected.get('source_format',''), 'capture_year':year,
        'classified_roof_fraction':selected.get('classified_roof_fraction', 0),
        'date_basis':selected.get('date_basis','unknown'), 'quality':round(quality(selected),4),
        'score':round(score(selected),4), 'alternatives':[
            {'source':r.get('source',''), 'source_url':r.get('source_url',''),
             'source_format':r.get('source_format',''), 'capture_year':r.get('capture_year'),
             'classified_roof_fraction':r.get('classified_roof_fraction', 0),
             'quality':round(quality(r),4), 'score':round(score(r),4)} for r in ordered[1:]]}


def gps_capture_years(values, encoding, known_ept=False):
    """Decode capture years; EPT can discard the source GPS encoding bit.

    Valid GPS-week values cannot identify an absolute year. On the known USGS
    EPT mirror, values outside a week that decode to plausible adjusted-GPS
    dates are retained as inferred, not declared, dates. No file creation or
    upload timestamps are used. Invalid/missing values remain zero.
    """
    import numpy as np
    values = np.asarray(values, dtype=float)
    years = np.zeros(len(values), dtype=float)
    basis = 'unknown'
    valid = np.isfinite(values) & (values != 0)
    if int(encoding) == 1:
        basis = 'gps_declared'
    elif known_ept:
        valid &= (values < 0) | (values > 604800)
        basis = 'gps_inferred_ept'
    else:
        return years, basis
    seconds = values[valid]+1_000_000_000
    plausible = (seconds >= 315964800) & (seconds < (datetime.now(timezone.utc).year-1979)*366*86400)
    positions = np.flatnonzero(valid)[plausible]
    # Year precision only; using GPS scale avoids inventing exact UTC dates.
    stamps = np.datetime64('1980-01-06') + np.floor(seconds[plausible]).astype('timedelta64[s]')
    decoded = stamps.astype('datetime64[Y]').astype(int)+1970
    okay = (decoded >= 1990) & (decoded <= datetime.now(timezone.utc).year)
    years[positions[okay]] = decoded[okay]
    return years, basis if np.any(years) else 'unknown'
