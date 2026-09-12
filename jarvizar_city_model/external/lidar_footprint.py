"""Cheap building admission before LiDAR acquisition; no native imports."""
import math

DEFAULT_MINIMUM_FOOTPRINT_AREA_MM2 = 0.7
FOOTPRINT_SKIP_REASON = 'footprint_below_minimum'


def minimum_footprint_area_m2(area_mm2, area_scale):
    """Convert printed area with both horizontal axes, independent of height."""
    if not math.isfinite(area_mm2) or area_mm2 < 0:
        raise ValueError('Minimum LiDAR footprint area must be finite and nonnegative')
    if not math.isfinite(area_scale) or area_scale <= 0:
        raise ValueError('LiDAR footprint area scale must be finite and positive')
    return round(round(float(area_mm2), 6) / float(area_scale), 6)


def select_footprints(features, geometries, minimum_area_m2):
    """Use full mapped polygon area: holes excluded, components summed.

    Selection is by parent building, so small parts of a large landmark remain
    eligible. Invalid geometry keeps its existing measurement rejection path;
    mapped rock is independent of this building-only setting.
    """
    if not math.isfinite(minimum_area_m2) or minimum_area_m2 < 0:
        raise ValueError('Minimum LiDAR footprint area must be finite and nonnegative')
    admitted, rejected = [], {}
    for feature in features:
        geometry = geometries[feature['id']]
        if (minimum_area_m2 > 0
                and (feature.get('properties') or {}).get('lidar_surface_kind') != 'rock'
                and geometry.is_valid and geometry.area < minimum_area_m2):
            rejected[feature['id']] = FOOTPRINT_SKIP_REASON
        else:
            admitted.append(feature)
    return admitted, rejected
