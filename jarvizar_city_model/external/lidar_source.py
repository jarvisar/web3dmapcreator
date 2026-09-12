"""Height confidence for source footprints and parts (no historical database).

A mapped podium height constrains that podium, never the unmapped tower above
another part. Explicit heights of unknown provenance remain trusted. Derived
Overture estimates and missing values can yield to well-supported measurements.
"""
import math
import re

try:
    from .lidar_selection import height_conflict, top_height
except ImportError:
    from lidar_selection import height_conflict, top_height


def positive(value):
    if isinstance(value, bool):
        return 0.0
    try:
        value = float(value)
        return value if math.isfinite(value) and value > 0 else 0.0
    except (ValueError, TypeError, OverflowError):
        return 0.0


def height_metres(properties):
    value = properties.get('height')
    if isinstance(value, str):
        match = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*(m|metres|meters|ft|feet)\s*', value)
        if match:
            return float(match[1]) * (.3048 if match[2] in ('ft', 'feet') else 1)
        match = re.fullmatch(r'''\s*(\d+)'\s*(\d+(?:\.\d+)?)?"?\s*''', value)
        if match:
            return float(match[1])*.3048 + float(match[2] or 0)*.0254
    return positive(value)


def floor_count(properties):
    return positive(properties.get('num_floors', properties.get('building:levels')))


def source_top_hint(properties):
    return height_metres(properties) or floor_count(properties)*3


def estimated_height(properties):
    sources = [s for s in properties.get('sources') or () if isinstance(s, dict)
               and s.get('property') == '/properties/height']
    # Do not infer height provenance from the footprint's provider, confidence
    # number, release date or OSM edit timestamp.
    return bool(sources) and all(s.get('dataset') in ('Microsoft ML Buildings', 'USGS Lidar')
                                for s in sources)


def strong_measurement(record):
    return (record.get('coverage', 0) >= .9
            and record.get('explained_fraction', 0) >= .8
            and record.get('roof_support_density_m2', 0) >= 1
            and record.get('method') in ('flat_regions', 'roof_planes', 'supported_roof_height', 'faceted_roof'))


def height_decision(properties, observed, strong, corroborated=False):
    """Return a rejection reason or an auditable permission to use the height.

    Large disagreements with credible explicit heights or floor counts retain
    the source in either direction. This protects a new short replacement from
    stale tall LiDAR even when construction dates are unavailable.
    """
    height = height_metres(properties)
    floors = floor_count(properties)
    derived = estimated_height(properties)
    conflict = height and height_conflict(height, observed)
    # An explicit architectural height agreeing with the scan outranks an
    # inconsistent floor count (churches, double-height public buildings).
    if height and not derived and not conflict:
        return 'measured_height'
    # Floor counts are a broad sanity range, not a second height estimate.
    floor_conflict = floors and (observed < floors*2-10 or observed > floors*5+15)
    if floor_conflict:
        return 'source_height_conflict'
    if conflict:
        internally_wrong = floors and (height < floors*2-10 or height > floors*5+15)
        if not (derived or internally_wrong):
            return 'source_height_conflict'
        supported = strong or (derived and (corroborated or internally_wrong))
        return 'corrected_estimated_height' if supported else 'weak_height_correction'
    return 'measured_height'


def regional_top(record, geometry, footprint):
    """Robust top within a mapped part; narrow edge spill cannot veto a podium."""
    from shapely.geometry import shape
    remaining = geometry.intersection(footprint)
    area = remaining.area
    if area <= 0:
        return None
    regions = []
    for tier in reversed(record['tiers']):
        overlap = remaining.intersection(shape(tier['geometry']))
        if overlap.is_empty:
            continue
        regions.append((tier['top_m'], overlap.area))
        remaining = remaining.difference(overlap)
    if record.get('roof_surfaces'):
        for surface in record['roof_surfaces']:
            overlap = remaining.intersection(shape(surface['geometry']))
            if overlap.is_empty:
                continue
            regions.append((max(v[2] for ring in surface['geometry']['coordinates'] for v in ring), overlap.area))
            remaining = remaining.difference(overlap)
    regions.append((record['height_m'], remaining.area))
    covered = 0
    for height, size in sorted(regions):
        covered += size
        if covered >= area*.9:
            return height
    return top_height(record)


def check_source(feature, parts, record, footprint):
    """Validate complete measured envelopes against spatial source evidence."""
    from shapely.ops import unary_union
    observed_top = top_height(record)
    corroborated = False
    mapped = [(part, geometry, source_top_hint(part.get('properties') or {})) for part, geometry in parts]
    for part, geometry, height in mapped:
        props = part.get('properties') or {}
        # A low podium can extend underneath mapped upper floors. Only its
        # exposed roof constrains the scan, not the tower that covers it.
        upper = [g for p,g,top in mapped if p is not part and (not top or top > height+2)]
        exposed = geometry.difference(unary_union(upper)) if upper else geometry
        observed = regional_top(record, exposed, footprint)
        if observed is None:
            continue
        check = height_decision(props, observed, strong_measurement(record))
        if check in ('source_height_conflict', 'weak_height_correction'):
            return check
        if (height_metres(props) and not estimated_height(props)
                and abs(height_metres(props)-observed_top) <= max(10, observed_top*.1)
                and exposed.intersection(footprint).area >= footprint.area*.03):
            corroborated = True
    return height_decision(feature.get('properties') or {}, observed_top,
                           strong_measurement(record), corroborated=corroborated)
