"""Fit a few supported roof planes and intersect them with clean footprints.

The convex envelope supports shed, gable, hip and broad sloping crowns. It
does not triangulate the cloud. Ambiguous/concave roofs retain the fallback.
"""
import numpy as np
from shapely.geometry import Polygon, box, mapping
from shapely.ops import unary_union


def polygon_pieces(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry] if not geometry.is_empty else []
    return [p for g in getattr(geometry, 'geoms', ()) for p in polygon_pieces(g)]


def half_plane(bounds, coef):
    """A bounded half plane ax+by+c >= 0, intersected exactly along edges."""
    ring = list(box(*bounds).exterior.coords)[:-1]
    output = []
    for p, q in zip(ring, ring[1:]+ring[:1]):
        fp, fq = np.dot(coef[:2], p)+coef[2], np.dot(coef[:2], q)+coef[2]
        if fp >= 0:
            output.append(p)
        if (fp >= 0) != (fq >= 0):
            t = fp/(fp-fq)
            output.append((p[0]+t*(q[0]-p[0]), p[1]+t*(q[1]-p[1])))
    return Polygon(output) if len(output) >= 3 else Polygon()


def fit_roof_planes(footprint, samples, min_width, min_rise, tolerance=0.45):
    """Return eave height and supported planar polygons, or None.

    Samples are equal-weight roof cell XYZ observations, already separated
    from facades/noise. Robust fits need broad spatial inliers; the final
    envelope must explain >=90% of samples and cover the entire outline.
    """
    if len(samples) < 12:
        return None
    center = np.mean(samples[:, :2], axis=0)
    design = np.column_stack((samples[:, :2]-center, np.ones(len(samples))))
    heights = samples[:, 2]
    remaining = np.ones(len(samples), dtype=bool)
    rng = np.random.default_rng(0)
    planes = []
    minimum = max(6, int(len(samples)*0.1))
    for _ in range(4):
        indices = np.flatnonzero(remaining)
        if len(indices) < minimum:
            break
        best, best_count = None, 0
        # Deterministic RANSAC; cost depends on roof cells, not raw returns.
        for attempt in range(160):
            chosen = indices if attempt == 0 else rng.choice(indices, 3, replace=False)
            coef, _, rank, _ = np.linalg.lstsq(design[chosen], heights[chosen], rcond=None)
            if rank != 3 or np.linalg.norm(coef[:2]) > 3:
                continue
            keep = remaining & (np.abs(design @ coef-heights) <= tolerance)
            count = int(keep.sum())
            if count > best_count:
                best, best_count = keep, count
        if best_count < minimum:
            break
        coef = np.linalg.lstsq(design[best], heights[best], rcond=None)[0]
        for _ in range(2):
            best = remaining & (np.abs(design @ coef-heights) <= tolerance)
            if best.sum() < minimum:
                break
            coef = np.linalg.lstsq(design[best], heights[best], rcond=None)[0]
        if best.sum() < minimum or np.linalg.norm(coef[:2]) > 3:
            break
        planes.append(coef)
        remaining[best] = False
        if remaining.sum() <= len(samples)*0.08:
            break
    if not planes:
        return None
    predictions = np.array([design @ coef for coef in planes])
    envelope = predictions.min(axis=0)
    if np.mean(np.abs(envelope-heights) <= tolerance*1.5) < 0.9:
        return None
    # Reject extrapolated planes and tiny facets, even if algebraic residuals
    # happen to fit. Plane ownership must agree with the measured samples.
    owner = predictions.argmin(axis=0)
    surfaces, extrema = [], []
    global_planes = [np.array([c[0], c[1], c[2]-np.dot(c[:2], center)]) for c in planes]
    for i, coef in enumerate(global_planes):
        region = footprint
        for j, other in enumerate(global_planes):
            if i != j:
                region = region.intersection(half_plane(footprint.bounds, other-coef))
        for polygon in polygon_pieces(region):
            if polygon.area < min_width**2 or polygon.buffer(-min_width*0.35).is_empty:
                return None
            from shapely import contains_xy
            mask = contains_xy(polygon.buffer(0.1), samples[:, 0], samples[:, 1])
            if (mask & (owner == i)).sum() < minimum:
                return None
            # Prevent an apparently supported plane extending far beyond its
            # observations on a narrow scan strip.
            from shapely.geometry import MultiPoint
            hull = MultiPoint(samples[mask & (owner == i), :2]).convex_hull
            if hull.area < polygon.area*0.45:
                return None
            rings = []
            for ring in (polygon.exterior, *polygon.interiors):
                xyz = [[float(x), float(y), float(coef[0]*x+coef[1]*y+coef[2])] for x,y in ring.coords]
                extrema.extend(v[2] for v in xyz)
                rings.append(xyz)
            surfaces.append({'geometry': {'type': 'Polygon', 'coordinates': rings}})
    if not surfaces or len(surfaces) > 8 or max(extrema)-min(extrema) < min_rise:
        return None
    if min(extrema) <= 2 or min(extrema) < heights.min()-min_width*3:
        return None
    # At least one real slope; a noisy flat plane is never roof detail.
    if max(np.linalg.norm(c[:2]) for c in planes) < 0.06:
        return None
    bottom = min(extrema)
    for surface in surfaces:
        surface['bottom_m'] = float(bottom)
    return {'height_m': float(bottom), 'roof_surfaces': surfaces,
            'roof_fit_p90_m': float(np.quantile(np.abs(envelope-heights), .9))}
