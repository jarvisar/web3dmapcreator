"""Put supported planar roof folds on their shared plane intersection.

Cell ownership is sufficient to separate surfaces, but its boundary is not a
roof ridge. This module moves only a locally corroborated interface between
two planes. Their combined outline and holes remain exactly unchanged; actual
height steps and unsupported interfaces keep their measured partition.
"""
import math

import numpy as np
from shapely import STRtree, contains_xy
from shapely.errors import GEOSException
from shapely.geometry import Polygon
from shapely.ops import unary_union

try:
    from .lidar_planes import half_plane
except ImportError:
    from lidar_planes import half_plane


def _fit_plane(samples, tolerance):
    """Robust local-origin plane for standalone callers."""
    if len(samples) < 3:
        return None
    center = np.mean(samples[:, :2], axis=0)
    design = np.column_stack((samples[:, :2] - center, np.ones(len(samples))))
    keep = np.ones(len(samples), dtype=bool)
    for _ in range(4):
        coef, _, rank, _ = np.linalg.lstsq(design[keep], samples[keep, 2], rcond=None)
        if rank < 3:
            return None
        residual = np.abs(design @ coef - samples[:, 2])
        keep = residual <= max(tolerance, 3 * float(np.median(residual)))
        if keep.sum() < max(3, len(samples) * .75):
            return None
    if (np.linalg.norm(coef[:2]) > 3 or np.quantile(residual, .95) > tolerance
            or residual.max() > max(1.25, tolerance * 4)):
        return None
    level = float(np.median(samples[:, 2]))
    if np.quantile(np.abs(samples[:, 2] - level), .95) <= tolerance:
        coef = np.array([0., 0., level])
    return center, coef, float(np.quantile(residual, .95))


def _global_plane(fit):
    center, coef, _error = fit
    return np.array([coef[0], coef[1], coef[2] - np.dot(coef[:2], center)])


def _line_samples(line, cell):
    count = min(96, max(8, int(math.ceil(line.length / max(cell*.5, 1e-6)))))
    return np.array([line.interpolate((i + .5)/count, normalized=True).coords[0][:2]
                     for i in range(count)])


def _lines(geometry):
    if geometry.geom_type in ('LineString', 'LinearRing'):
        return [geometry] if not geometry.is_empty else []
    return [line for child in getattr(geometry, 'geoms', ()) for line in _lines(child)]


def _polygons(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry] if not geometry.is_empty else []
    return [polygon for child in getattr(geometry, 'geoms', ()) for polygon in _polygons(child)]


def _polygonal(geometry):
    if geometry.geom_type in ('Polygon', 'MultiPolygon'):
        return geometry
    pieces = _polygons(geometry)
    return unary_union(pieces) if pieces else Polygon()


def _sides_agree(samples_a, samples_b, difference, tolerance):
    a = samples_a[:, :2] @ difference[:2] + difference[2]
    b = samples_b[:, :2] @ difference[:2] + difference[2]
    # Choose ownership from measurements, so valleys and flat-to-slope folds
    # work equally well as convex ridges. Ambiguous observations right on the
    # crease do not assign its side; confident opposite-side points veto it.
    med_a, med_b = float(np.median(a)), float(np.median(b))
    if med_a * med_b >= 0 or min(abs(med_a), abs(med_b)) <= tolerance:
        return None
    sign = 1. if med_a > 0 else -1.
    if np.any(a * sign < -tolerance) or np.any(b * sign > tolerance):
        return None
    return sign


def _observations_agree(observations, shared, combined, plane_a, plane_b,
                        difference, sign, cell, tolerance):
    if observations is None or not len(observations):
        return None
    nearby = shared.buffer(cell * 2).intersection(combined)
    local = observations[contains_xy(nearby, observations[:, 0], observations[:, 1])]
    if len(local) < 6:
        return None
    if len(local) > 4096:
        order = np.lexsort((local[:, 2], local[:, 1], local[:, 0]))
        local = local[order[np.linspace(0, len(order)-1, 4096, dtype=int)]]
    first = local[:, :2] @ plane_a[:2] + plane_a[2]
    second = local[:, :2] @ plane_b[:2] + plane_b[2]
    residual_a, residual_b = np.abs(first-local[:, 2]), np.abs(second-local[:, 2])
    unique_a = (residual_a <= tolerance) & (residual_b > residual_a + tolerance)
    unique_b = (residual_b <= tolerance) & (residual_a > residual_b + tolerance)
    if unique_a.sum() < 3 or unique_b.sum() < 3:
        return None
    side = (local[:, :2] @ difference[:2] + difference[2]) * sign
    if np.any(unique_a & (side < 0)) or np.any(unique_b & (side > 0)):
        return False
    return True


def reconcile_planar_junctions(patches, cell, tolerance, observations=None, fits=None):
    """Return ``(region, samples)`` patches with supported analytic interfaces.

    Optional ``fits`` contains the final fitter's ``(center, coefficients,
    error)`` tuples, or ``None`` for nonplanar patches. Passing those guarantees
    the exact same planes define both the repaired boundary and emitted roof.
    ``observations`` may contain the existing raw, supported XYZ returns; they
    can disambiguate a true fold from two sloping roofs separated by a wall.
    Sample ownership, the outer footprint, and courtyards are never rewritten.
    """
    # Valid clipping may retain line/point contacts beside roof polygons.
    # GeometryCollection.boundary is undefined; those nonareal remnants never
    # describe an emitted roof and must not enter junction topology.
    result = [(_polygonal(region), samples) for region, samples in patches]
    if len(result) < 2:
        return result
    if not math.isfinite(cell) or cell <= 0 or not math.isfinite(tolerance) or tolerance <= 0:
        raise ValueError('Invalid roof junction support dimensions')
    if fits is None:
        fits = [_fit_plane(samples, tolerance) for _region, samples in result]
    if len(fits) != len(result):
        raise ValueError('Roof junction fits do not match patches')
    planes = [_global_plane(fit) if fit is not None else None for fit in fits]
    if observations is not None:
        observations = np.asarray(observations, dtype=float)
    regions = [region for region, _samples in result]
    tree = STRtree(regions)
    pairs = sorted((i, int(j)) for i, region in enumerate(regions)
                   if planes[i] is not None for j in tree.query(region, predicate='intersects')
                   if j > i and planes[j] is not None)
    for i, j in pairs:
        region_a, samples_a = result[i]
        region_b, samples_b = result[j]
        plane_a, plane_b = planes[i], planes[j]
        difference = plane_a - plane_b
        gradient = float(np.linalg.norm(difference[:2]))
        if gradient < .06:
            continue  # Parallel levels are walls, not folds.
        try:
            # Disconnected footprint components may also touch at isolated
            # points. Only shared line segments describe a roof interface.
            shared = unary_union(_lines(region_a.boundary.intersection(region_b.boundary)))
            if shared.is_empty or shared.length < cell * 2:
                continue
            probes = _line_samples(shared, cell)
            gaps = probes @ difference[:2] + difference[2]
            if np.max(np.abs(gaps)) / gradient > cell * .8:
                continue
            sign = _sides_agree(samples_a, samples_b, difference, tolerance)
            if sign is None:
                continue
            combined = region_a.union(region_b)
            evidence = _observations_agree(observations, shared, combined, plane_a, plane_b,
                                          difference, sign, cell, tolerance)
            if evidence is False:
                continue
            if evidence is None and abs(float(np.median(gaps))) > tolerance:
                # Without near-interface observations, a consistent offset can
                # equally describe a real vertical wall. Keep that ambiguity.
                continue
            cutter = half_plane(combined.bounds, difference * sign)
            if cutter.is_empty:
                continue
            first = _polygonal(combined.intersection(cutter))
            second = _polygonal(combined.difference(first))
            if (first.is_empty or second.is_empty or not first.is_valid or not second.is_valid
                    or first.area < region_a.area*.8 or second.area < region_b.area*.8):
                continue
            seam = unary_union(_lines(first.boundary.intersection(second.boundary)))
            if seam.is_empty or shared.hausdorff_distance(seam) > cell * .8:
                continue
            moved = first.symmetric_difference(region_a).area
            if moved > min(region_a.area, region_b.area)*.15:
                continue
            if abs(first.area + second.area - combined.area) > max(1e-7, combined.area*1e-9):
                continue
            result[i], result[j] = (first, samples_a), (second, samples_b)
        except (GEOSException, np.linalg.LinAlgError):
            # A junction trial is optional and atomic. Uncertain topology does
            # not discard an otherwise supported complete reconstruction.
            continue
    return result
