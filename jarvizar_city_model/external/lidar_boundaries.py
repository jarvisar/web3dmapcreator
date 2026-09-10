"""Sub-cell tier outlines from supported roof returns, outside Blender only.

The coarse roof grid still establishes which masses exist. Only a narrow band
around an accepted tier is reconstructed, using observed high/low roof returns.
No points are fetched and unsupported portions keep their existing outline.
"""
import math

import numpy as np
from shapely import contains_xy, delaunay_triangles, force_2d, get_coordinates, get_parts
from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPoint, Polygon
from shapely.ops import unary_union


MAX_BOUNDARY_SAMPLES = 4096


def _fit_ring(ring, cell):
    """Local quadratic contour fit, with resolved architectural corners pinned.

    Equal arc-length samples avoid weighting dense survey edges more strongly.
    A quadratic fit preserves straight lines and follows broad curvature without
    the shrinking bias of repeated neighbour averaging. Sampling-scale jaggies
    are filtered; long adjoining edges meeting at a sharp corner are protected.
    """
    coarse = np.asarray(LineString(ring.coords).simplify(cell * .4).coords)[:-1, :2]
    anchors = []
    for i, point in enumerate(coarse):
        before, after = point-coarse[i-1], coarse[(i+1) % len(coarse)]-point
        a, b = np.linalg.norm(before), np.linalg.norm(after)
        if min(a, b) >= cell * 2 and np.dot(before, after)/(a*b) < math.cos(math.radians(35)):
            anchors.append(point)
    count = max(12, int(math.ceil(ring.length / (cell * .2))))
    if count > MAX_BOUNDARY_SAMPLES:
        return list(ring.coords)
    distances = np.arange(count) * ring.length / count
    xy = get_coordinates(ring.interpolate(distances))[:, :2]
    axis = np.arange(-5, 6, dtype=float)
    weights = np.linalg.pinv(np.column_stack((np.ones(11), axis, axis**2)))[0]
    fitted = sum(weight * np.roll(xy, shift, axis=0)
                 for shift, weight in zip(range(-5, 6), weights))
    if anchors:
        protected = np.min(np.linalg.norm(xy[:, None, :] - np.asarray(anchors), axis=2), axis=1) <= cell
        fitted[protected] = xy[protected]
    # Include the closing edge in simplification; no vertex is fixed merely
    # because GEOS chose it as the arbitrary first point of the ring.
    fitted = np.vstack((fitted, fitted[0]))
    return list(LineString(fitted).simplify(cell * .1).coords)


def _remove_unprintable_noise(geometry, original, min_width):
    parts = list(geometry.geoms) if geometry.geom_type == 'MultiPolygon' else [geometry]
    old_parts = list(original.geoms) if original.geom_type == 'MultiPolygon' else [original]
    protected = unary_union([Polygon(h) for p in old_parts for h in p.interiors])
    cleaned = []
    for part in parts:
        if part.geom_type != 'Polygon' or part.area < min_width**2:
            continue
        holes = [h.coords for h in part.interiors
                 if Polygon(h).area >= min_width**2 or Polygon(h).intersects(protected)]
        cleaned.append(Polygon(part.exterior, holes))
    return unary_union(cleaned)


def measured_tier_boundary(region, samples, threshold, cell, min_width):
    """Refine within a sub-cell error envelope, or keep the accepted grid mass.

    Samples have already passed roof-cell support checks. Equal-weight XY bins
    bound density; conflicting high/low observations within a bin are omitted.
    Only short observed triangles are used, never extrapolated across a gap.
    """
    if (region.is_empty or not region.is_valid or len(samples) < 12
            or region.geom_type not in ('Polygon', 'MultiPolygon')
            or not math.isfinite(cell) or cell <= 0
            or not math.isfinite(min_width) or min_width <= 0):
        return region
    initial_parts = list(region.geoms) if region.geom_type == 'MultiPolygon' else [region]
    if all(len(p.simplify(cell * 1e-6).exterior.coords) <= 5 for p in initial_parts):
        return region  # Resolved rectangular walls need no contour reconstruction.
    try:
        band = region.boundary.buffer(cell * 1.5)
        local = samples[contains_xy(band, samples[:, 0], samples[:, 1])]
        if not 12 <= len(local) <= MAX_BOUNDARY_SAMPLES * 32:
            return region
        origin = np.array(region.bounds[:2])
        spacing = max(cell / 4, min_width / 6)
        keys = np.floor((local[:, :2] - origin) / spacing).astype(np.int64)
        order = np.lexsort((local[:, 2], local[:, 1], local[:, 0], keys[:, 1], keys[:, 0]))
        keys, local = keys[order], local[order]
        breaks = np.flatnonzero(np.any(keys[1:] != keys[:-1], axis=1)) + 1
        observations = []
        for group in np.split(local, breaks):
            high = group[:, 2] >= threshold
            if high.all() or not high.any():
                observations.append([*np.mean(group[:, :2], axis=0), float(high[0])])
        if not 12 <= len(observations) <= MAX_BOUNDARY_SAMPLES:
            return region
        observations = np.asarray(observations)
        if min(np.sum(observations[:, 2] == 0), np.sum(observations[:, 2] == 1)) < 6:
            return region
        # Z carries the binary membership through GEOS triangulation; heights
        # of the final roof remain the independently measured architectural Z.
        triangles = get_parts(delaunay_triangles(MultiPoint(observations)))
        vertices = get_coordinates(triangles, include_z=True).reshape(-1, 4, 3)[:, :3]
        lengths = np.linalg.norm(vertices[:, :, :2] - np.roll(vertices[:, :, :2], 1, axis=1), axis=2)
        valid = lengths.max(axis=1) <= cell * 1.5
        triangles, vertices = triangles[valid], vertices[valid]
        triangles = force_2d(triangles)
        if len(triangles) < 8:
            return region
        roof = []
        for xyz in vertices:
            high = xyz[:, 2] > .5
            if high.all():
                roof.append(Polygon(xyz[:, :2]))
            elif high.any():
                ring = []
                for i in range(3):
                    j = (i + 1) % 3
                    if high[i]:
                        ring.append(xyz[i, :2])
                    if high[i] != high[j]:
                        ring.append((xyz[i, :2] + xyz[j, :2]) * .5)
                roof.append(Polygon(ring))
        if not roof:
            return region
        observed = unary_union(triangles)
        candidate = region.difference(observed).union(unary_union(roof))
        candidate = _remove_unprintable_noise(candidate, region, min_width)
        candidate_parts = list(candidate.geoms) if candidate.geom_type == 'MultiPolygon' else [candidate]
        if any(p.geom_type != 'Polygon' for p in candidate_parts):
            return region
        fitted_parts = []
        for part in candidate_parts:
            fitted = Polygon(_fit_ring(part.exterior, cell), [_fit_ring(h, cell) for h in part.interiors])
            fitted_parts.append(fitted if fitted.is_valid else part)
        fitted = unary_union(fitted_parts)
        # Never replace an unobserved boundary by the fitted continuation.
        candidate = region.difference(observed).union(fitted.intersection(observed))
        candidate = _remove_unprintable_noise(candidate, region, min_width)
        if candidate.is_empty or candidate.geom_type not in ('Polygon', 'MultiPolygon'):
            return region
        # A scan gap or thin projection can disagree locally while the rest of
        # a long curved wall is well observed. Retain that portion of the old
        # mass, rather than discarding every supported correction on the tier.
        limit = cell * .8
        unsupported = region.boundary.difference(candidate.boundary.buffer(limit)).union(
            candidate.boundary.difference(region.boundary.buffer(limit)))
        if not unsupported.is_empty:
            preserve = unsupported.buffer(cell * 1.5)
            candidate = candidate.difference(preserve).union(region.intersection(preserve))
        old_parts = list(region.geoms) if region.geom_type == 'MultiPolygon' else [region]
        new_parts = list(candidate.geoms) if candidate.geom_type == 'MultiPolygon' else [candidate]
        if (candidate.geom_type not in ('Polygon', 'MultiPolygon') or not candidate.is_valid
                or len(old_parts) != len(new_parts)
                or sorted(len(p.interiors) for p in old_parts) != sorted(len(p.interiors) for p in new_parts)
                or abs(candidate.area - region.area) > region.area * .05
                or candidate.symmetric_difference(region).area > region.area * .15
                or candidate.boundary.length > region.boundary.length * 1.02
                or candidate.boundary.hausdorff_distance(region.boundary) > cell * .8):
            return region
        unmatched = list(new_parts)
        for old in old_parts:
            new = max(unmatched, key=lambda p: p.intersection(old).area)
            if (new.intersection(old).area < old.area * .85
                    or abs(new.area-old.area) > old.area * .05
                    or len(new.interiors) != len(old.interiors)):
                return region
            unmatched.remove(new)
            for old_hole in old.interiors:
                hole = Polygon(old_hole)
                match = max((Polygon(h) for h in new.interiors), key=lambda h: h.intersection(hole).area)
                if abs(match.area-hole.area) > hole.area*.05:
                    return region
        return candidate
    except (GEOSException, ValueError, ArithmeticError):
        return region
