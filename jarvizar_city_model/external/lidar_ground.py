"""A measured alignment anchor when surrounding terrain is not planar."""
import numpy as np
from shapely import contains_xy
from shapely.geometry import MultiPoint

# Share of the footprint the surrounding ground cells' hull must cover.
ANCHOR_COVERAGE = .9


def surrounding_ground(footprint, index, margin=25.):
    """Ground-class returns within `margin` of the footprint, outside it."""
    neighborhood = footprint.buffer(margin)
    points = index.query(neighborhood.bounds)
    if not len(points):
        return points
    return points[(points[:, 3] == 2) &
        contains_xy(neighborhood, points[:, 0], points[:, 1]) &
        ~contains_xy(footprint, points[:, 0], points[:, 1])]


def ground_anchor(footprint, index, margin=25.):
    """Return a low ground cell and retain its XY, without extrapolating a plane.

    Cell medians balance scan density; a lower decile avoids a single low
    outlier. Surrounding support must enclose nearly the entire footprint:
    ground on one side of a building, or on half of it, says nothing about
    the base of the rest on a hillside, but a stadium flush with a riverbank
    has no ground cells on the water side and was rejected for the two per
    cent of its footprint beyond the hull. The model aligns this exact
    location to its DEM, so a hillside's vertical variation is retained
    rather than interpreted as noise around an invented flat base.
    """
    samples = surrounding_ground(footprint, index, margin)
    if len(samples) < 20:
        return None
    groups = {}
    for row in samples:
        groups.setdefault(tuple(np.floor(row[:2]/4).astype(int)), []).append(row[:3])
    cells = np.array([np.median(rows, axis=0) for _, rows in sorted(groups.items()) if len(rows) >= 3])
    if len(cells) < 8:
        return None
    hull = MultiPoint(cells[:, :2]).convex_hull.buffer(2)
    if not hull.covers(footprint.representative_point()) or hull.intersection(footprint).area < footprint.area*ANCHOR_COVERAGE:
        return None
    return cells[np.argsort(cells[:, 2], kind='stable')[int((len(cells)-1)*.1)]].tolist()
