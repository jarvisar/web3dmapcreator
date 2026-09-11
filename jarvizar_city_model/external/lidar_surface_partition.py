"""Regularize architectural regions, never the triangles of a curved roof."""
import numpy as np
from shapely import contains_xy
from shapely.geometry import Polygon
from shapely.ops import unary_union

try:
    from .lidar_facets import pieces
except ImportError:
    from lidar_facets import pieces


def _polygonal(geometry):
    """Boolean operations may attach zero-area contacts to valid roof regions."""
    if geometry.geom_type in ('Polygon', 'MultiPolygon'):
        return geometry
    polygons = list(pieces(geometry))
    return unary_union(polygons) if polygons else Polygon()


def _local_height(support, gap, cell):
    """Compare roof elevations using evidence near this particular interface."""
    near = contains_xy(gap.buffer(cell*2), support[:, 0], support[:, 1])
    if np.count_nonzero(near) >= 3:
        selected = support[near]
    else:
        xy = np.asarray(gap.representative_point().coords)[0, :2]
        order = np.argsort(np.sum((support[:, :2]-xy)**2, axis=1), kind='stable')
        selected = support[order[:min(9, len(support))]]
    center = selected[:, :2].mean(axis=0)
    design = np.column_stack((selected[:, :2]-center, np.ones(len(selected))))
    coef, _residual, rank, _singular = np.linalg.lstsq(design, selected[:, 2], rcond=None)
    if rank == 3 and np.max(np.abs(design @ coef-selected[:, 2])) <= .5:
        # A sloped roof is evaluated at the common interface, so the height of
        # its remote ridge cannot incorrectly decide which local side is lower.
        xy = np.asarray(gap.representative_point().coords)[0, :2]
        predicted = float((xy-center) @ coef[:2]+coef[2])
        return float(np.clip(predicted, selected[:, 2].min(), selected[:, 2].max()))
    return float(np.median(selected[:, 2]))


def clean_partition(patches, cell, width):
    """Transfer unsupported narrow fingers to their surrounding roof.

    A region may have a broad supported core and still carry long, one-cell
    appendages from facade returns or contour clipping. A width opening removes
    those appendages while keeping straight corners. Each connected removed
    channel belongs to its lowest supported adjacent roof. This suppresses
    narrow raised structures without swapping fingers between roofs or adding
    artificial ridges. Broad roof cores, the footprint, and courtyards remain
    exact. Discarded samples must not tilt the receiving roof.
    """
    patches = [(_polygonal(g), support) for g, support in patches]
    if len(patches) < 2:
        return patches, {}
    radius = max(width * .5, cell)
    regions = [g for g, _s in patches]
    cleaned, scraps = [], []
    for i, region in enumerate(regions):
        opened = region.buffer(-radius, join_style=2).buffer(radius, join_style=2)
        opened = _polygonal(opened.intersection(region))
        # A wholly narrow mapped building or roof ring has no alternative
        # supported interior. Independent region acceptance handles that case.
        if opened.is_empty:
            cleaned.append(region)
            continue
        removed = [p for p in pieces(region.difference(opened)) if p.area > 1e-7]
        cleaned.append(_polygonal(region.difference(unary_union(removed))))
        scraps.extend((i, p) for p in removed)
    cores = cleaned.copy()
    count, area = 0, 0.
    for gap in pieces(unary_union([scrap for _source, scrap in scraps])):
        contact = gap.buffer(1e-7)
        candidates = [(i, region.boundary.intersection(contact).length)
                      for i, region in enumerate(regions) if region.intersects(contact)
                      and not cores[i].is_empty]
        if not candidates:
            continue
        target = min(candidates, key=lambda item: (
            _local_height(patches[item[0]][1], gap, cell), -item[1],
            -cores[item[0]].area, item[0]))[0]
        cleaned[target] = _polygonal(cleaned[target].union(gap))
    result = []
    for i, (region, support) in enumerate(patches):
        discarded = _polygonal(regions[i].difference(cleaned[i]))
        if discarded.area > 1e-7:
            count += len(list(pieces(discarded)))
            area += discarded.area
            keep = ~contains_xy(discarded, support[:, 0], support[:, 1])
            # Preserve enough observations to fit the retained broad core.
            if np.count_nonzero(keep) >= 3:
                support = support[keep]
        # Buffer intersections can leave coincident out-and-back segments a few
        # floating-point ulps apart. Collapse only sub-micron numerical seams.
        result.append((cleaned[i].simplify(1e-7, preserve_topology=True), support))
    return result, {'surface_removed_fingers': count,
                    'surface_removed_finger_area_m2': float(area)}
