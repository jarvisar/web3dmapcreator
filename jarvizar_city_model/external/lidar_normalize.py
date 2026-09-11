"""Normalize provider metadata and point classifications at the reader boundary."""
import math
import numpy as np
from pyproj import CRS

UNITS = {'m': 1., 'metre': 1., 'meter': 1., 'metres': 1., 'meters': 1.,
         'ft': .3048, 'foot': .3048, 'feet': .3048,
         'us survey feet': 1200 / 3937, 'us-ft': 1200 / 3937}
SEMANTICS = {'ground': 2, 'building': 6, 'buildings': 6,
             'unclassified': 1, 'unassigned': 1}
# Ground, building and unclassified returns establish every measurement.
# Vegetation classes are retained as well because automated classifiers file a
# large share of articulated and glazed facade returns under them; downstream
# reconstruction admits those only where the structural envelope already
# reaches that level. Noise and withheld returns are never retained.
RETAINED_CLASSES = (1, 2, 3, 4, 5, 6)
STRUCTURAL_CLASSES = (1, 2, 6)
SECONDARY_CLASSES = (3, 4, 5)


def vertical_factor(metadata):
    """Only explicit units/vertical axes; horizontal metres do not imply Z units."""
    value = metadata.get('vertical_units')
    factor = UNITS.get(str(value).lower())
    if factor is None and metadata.get('vertical_crs'):
        crs = CRS.from_user_input(metadata['vertical_crs'])
        if crs.is_vertical:
            factor = crs.axis_info[0].unit_conversion_factor
    if factor is None and metadata.get('horizontal_crs'):
        crs = CRS.from_user_input(metadata['horizontal_crs'])
        vertical = [c for c in crs.sub_crs_list if c.is_vertical]
        if vertical:
            factor = vertical[0].axis_info[0].unit_conversion_factor
        elif len(crs.axis_info) == 3:
            factor = crs.axis_info[2].unit_conversion_factor
    if factor is None or not math.isfinite(factor) or factor <= 0:
        return None
    return factor


def classifications(points, header=None, metadata=None):
    """Map declared semantics to internal 1/2/6; unknown custom codes are noise.

    LAS has standard class meanings unless a catalog or ClassificationLookup VLR
    declares another convention. Class zero is *not* usable unclassified data.
    Explicit custom conventions without a mapping cannot be interpreted safely.
    """
    policy = (metadata or {}).get('classification') or {}
    mapping = policy.get('mapping')
    if mapping is None and header is not None:
        for vlr in list(header.vlrs) + list(header.evlrs or []):
            lookups = getattr(vlr, 'lookups', None)
            if lookups:
                mapping = {str(code): str(label).strip().lower() for code, label in lookups.items()}
                break
    raw = np.asarray(points.classification)
    if mapping is not None:
        out = np.zeros(raw.shape, dtype=np.uint8)
        for code, label in mapping.items():
            target = SEMANTICS.get(str(label).strip().lower())
            if target is not None:
                out[raw == int(code)] = target
        return out
    if policy.get('convention', 'asprs').lower() not in ('asprs', 'las', 'standard'):
        raise ValueError('Unknown classification convention; explicit ground/building mapping required')
    return raw


def source_metadata(source, tile=None):
    return {**source, **(tile or {})}


def header_metadata(header):
    """Retain actual header references and class labels alongside catalog claims."""
    result = {}
    crs = header.parse_crs()
    if crs:
        result['declared_crs'] = crs.to_string()
        vertical = [c for c in crs.sub_crs_list if c.is_vertical]
        if vertical:
            result['vertical_datum'] = vertical[0].name
        elif len(crs.axis_info) == 3:
            result['vertical_datum'] = crs.name
    for vlr in list(header.vlrs) + list(header.evlrs or []):
        lookups = getattr(vlr, 'lookups', None)
        if lookups:
            result['classification'] = {'convention': 'LAS ClassificationLookup VLR',
                'mapping': {str(k): str(v) for k, v in lookups.items()}}
    return result
