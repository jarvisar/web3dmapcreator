"""Bounded, measured roof facets; native dependencies stay outside Blender.

Approximate supported cell samples with an adaptive triangulation. Significant
terrace jumps partition the roof first, so a tower never becomes a ramp down to
its podium. Existing footprint/ground/coverage checks run before this module;
any incomplete or over-budget fit retains the established terrace envelope.
"""
import math

import numpy as np
from shapely import STRtree, constrained_delaunay_triangles, points as make_points
from shapely.geometry import MultiPoint, shape
from shapely.errors import GEOSException
from shapely.ops import triangulate

try:
    from .lidar_records import MAX_ROOF_FACETS
except ImportError:
    from lidar_records import MAX_ROOF_FACETS

MAX_FACETS = MAX_ROOF_FACETS
MAX_PATCH_VERTICES = 120


def pieces(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry] if not geometry.is_empty else []
    return [p for child in getattr(geometry, 'geoms', ()) for p in pieces(child)]


class UnsupportedFit(ValueError):
    pass


def printable_facet(facet):
    """Discard millimetre-wide survey slivers below model triangulation precision."""
    ring = list(facet.exterior.coords)
    longest = max(math.dist(a,b) for a,b in zip(ring, ring[1:]))
    return longest > 0 and facet.area*2/longest >= .005


def roof_triangles(polygon):
    """Resolve valid point-touching holes without fragile tessellation channels."""
    try:
        return list(constrained_delaunay_triangles(polygon).geoms)
    except GEOSException:
        result = []
        # Noding against an ordinary Delaunay first splits touching boundaries
        # into small simple pieces. Clip every piece; never bridge a hole.
        for triangle in triangulate(polygon):
            for piece in pieces(triangle.intersection(polygon)):
                if piece.area > 1e-8:
                    result.extend(constrained_delaunay_triangles(piece).geoms)
        if abs(sum(t.area for t in result)-polygon.area) > max(1e-6, polygon.area*1e-6):
            raise UnsupportedFit('incomplete roof triangulation')
        return result


def patch_facets(region, samples, cell, tolerance, facet_budget):
    """Triangulate with measured boundary heights and bounded interior error."""
    from shapely import contains_xy
    samples = samples[contains_xy(region.buffer(1e-7), samples[:, 0], samples[:, 1])]
    if len(samples) < 6:
        raise UnsupportedFit('insufficient patch support')
    samples = samples[np.lexsort((samples[:, 1], samples[:, 0]))]
    center = np.mean(samples[:, :2], axis=0)

    def elevation(xy):
        distances = np.sum((samples[:, :2] - xy)**2, axis=1)
        order = np.argsort(distances, kind='stable')[:12]
        if distances[order[0]] > (cell*2)**2:
            raise UnsupportedFit('unobserved roof boundary')
        local = samples[order[distances[order] <= (cell*3)**2]]
        if len(local) < 3:
            raise UnsupportedFit('insufficient boundary support')
        design = np.column_stack((local[:, :2]-xy, np.ones(len(local))))
        coef, _, rank, _ = np.linalg.lstsq(design, local[:, 2], rcond=None)
        if (rank < 3 or np.linalg.norm(coef[:2]) > 3
                or np.quantile(np.abs(design @ coef-local[:, 2]), .9) > max(.6, tolerance*2)):
            # An ambiguous edge must not acquire an extrapolated roof slope.
            return float(np.median(local[:min(5, len(local)), 2]))
        return float(np.clip(coef[2], local[:, 2].min()-tolerance, local[:, 2].max()+tolerance))

    vertices = {}
    def add(xy, height=None):
        xy = tuple(map(float, xy))
        if xy not in vertices:
            if len(vertices) >= MAX_PATCH_VERTICES:
                raise UnsupportedFit('roof vertex budget')
            vertices[xy] = elevation(np.array(xy)) if height is None else float(height)

    def boundary(a, b, depth=0):
        add(a); add(b)
        if math.dist(a, b) <= cell*2 or depth >= 8:
            return
        middle = tuple((x+y)*.5 for x,y in zip(a,b))
        height = elevation(np.array(middle))
        # Quarter points detect a curved/corrugated edge whose midpoint alone
        # happens to lie on its endpoint chord.
        probes = [(middle, height)]
        for fraction in (.25, .75):
            xy = tuple(x+(y-x)*fraction for x,y in zip(a,b))
            probes.append((xy, elevation(np.array(xy))))
        if any(abs(z-(vertices[tuple(a)] + math.dist(a, xy)/math.dist(a,b)*
                      (vertices[tuple(b)]-vertices[tuple(a)]))) > tolerance for xy,z in probes):
            add(middle, height)
            boundary(a, middle, depth+1); boundary(middle, b, depth+1)

    # Triangulate the convex hull, then clip back to the exact outline. Pinning
    # every raster-edge/courtyard vertex wastes the detail budget on boundaries
    # that the clipping step already preserves exactly.
    for ring in (region.convex_hull.exterior,):
        xy = list(ring.coords)
        for a,b in zip(xy, xy[1:]):
            boundary(a[:2], b[:2])
    # Pin real extrema before refinement, including small supported roof crowns.
    for index in (int(np.argmin(samples[:, 2])), int(np.argmax(samples[:, 2]))):
        add(samples[index, :2], samples[index, 2])

    sample_points = make_points(samples[:, :2])
    for _ in range(24):
        ordered = sorted(vertices)
        triangles = [t for t in triangulate(MultiPoint(ordered)) if t.area > 1e-8]
        if not triangles:
            raise UnsupportedFit('degenerate roof triangulation')
        coordinates = np.array([list(t.exterior.coords)[:3] for t in triangles])
        design = np.concatenate((coordinates-center, np.ones((len(triangles), 3, 1))), axis=2)
        heights = np.array([[vertices[tuple(xy)] for xy in coords] for coords in coordinates])
        coefficients = np.linalg.solve(design, heights[..., None])[..., 0]
        point_ids, triangle_ids = STRtree(triangles).query(sample_points, predicate='intersects')
        predicted = np.full(len(samples), np.nan)
        predicted[point_ids] = np.sum((samples[point_ids, :2]-center)*coefficients[triangle_ids, :2], axis=1) + coefficients[triangle_ids, 2]
        if not np.all(np.isfinite(predicted)):
            raise UnsupportedFit('incomplete roof triangulation')
        error = np.abs(predicted-samples[:, 2])
        fit_error = float(np.quantile(error, .95))
        if fit_error <= tolerance and error.max() <= max(1.25, tolerance*3):
            break
        candidates = np.argsort(-error, kind='stable')
        before = len(vertices)
        for index in candidates:
            if error[index] <= tolerance or len(vertices)-before >= 8:
                break
            add(samples[index, :2], samples[index, 2])
        if len(vertices) == before:
            raise UnsupportedFit('unresolved roof residuals')
    else:
        raise UnsupportedFit('roof refinement budget')

    surfaces, area = [], 0.0
    for triangle, coef in zip(triangles, coefficients):
        for polygon in pieces(triangle.intersection(region)):
            if polygon.area <= 1e-8:
                continue
            # Clipped concave pieces/holes use constrained triangles; no roof
            # can bridge a courtyard or extend outside its supporting region.
            for facet in roof_triangles(polygon):
                if not printable_facet(facet):
                    continue
                ring = [[float(x), float(y), float(np.dot(np.array([x,y])-center, coef[:2])+coef[2])]
                        for x,y in facet.exterior.coords]
                surfaces.append({'geometry': {'type':'Polygon', 'coordinates':[ring]}})
                area += facet.area
                if len(surfaces) > facet_budget:
                    raise UnsupportedFit('roof facet budget')
    if abs(area-region.area) > max(.002, region.area*.001):
        raise UnsupportedFit('incomplete clipped roof')
    return surfaces, fit_error


def fit_faceted_roof(footprint, samples, cell, min_width, min_step, original):
    """Return a complete faceted replacement or a concise fallback reason."""
    if original.get('roof_surfaces'):
        return None, 'existing measured planes'
    if np.ptp(samples[:, 2]) < max(.5, min_step):
        return None, 'flat roof'
    # Keep mapped whole-building outlines and significant measured setbacks.
    # Minor terrace bands can become continuous slopes within each partition.
    step = max(2.0, min_step*4)
    boundaries = [shape(t['geometry']).intersection(footprint) for t in original['tiers']
                  if t['top_m']-t['bottom_m'] >= step]
    remaining, patches = footprint, []
    for boundary in reversed(boundaries):
        patches.extend(pieces(remaining.intersection(boundary)))
        remaining = remaining.difference(boundary)
    patches.extend(pieces(remaining))
    tolerance = max(.35, min_step*.5)
    def retained_surfaces(patch):
        result, remainder = [], patch
        levels = [(shape(t['geometry']), t['top_m']) for t in reversed(original['tiers'])]
        levels.append((footprint, original['height_m']))
        for geometry, height in levels:
            for polygon in pieces(remainder.intersection(geometry)):
                if polygon.area > 1e-8:
                    # Differences between nested terraces can leave touching
                    # holes and narrow channels. Resolve these in metric space
                    # instead of handing a fragile ring to Blender's tessellator.
                    for facet in roof_triangles(polygon):
                        if printable_facet(facet):
                            ring = [[float(x), float(y), float(height)] for x,y in facet.exterior.coords]
                            result.append({'geometry': {'type':'Polygon', 'coordinates':[ring]}})
                            if len(result) > MAX_FACETS:
                                raise UnsupportedFit('roof facet budget')
            remainder = remainder.difference(geometry)
        return result

    surfaces, errors, retained = [], [], []
    try:
        for patch in sorted(patches, key=lambda p: (-p.area, p.bounds)):
            fallback = retained_surfaces(patch)
            try:
                if patch.area < max(min_width**2, cell**2*2):
                    raise UnsupportedFit('small isolated roof patch')
                fitted, error = patch_facets(patch, samples, cell, tolerance, MAX_FACETS-len(surfaces))
                surfaces.extend(fitted); errors.append(error)
            except (UnsupportedFit, np.linalg.LinAlgError, GEOSException) as exc:
                surfaces.extend(fallback)
                retained.append(str(exc))
            if len(surfaces) > MAX_FACETS:
                raise UnsupportedFit('roof facet budget')
    except (UnsupportedFit, np.linalg.LinAlgError, GEOSException) as exc:
        return None, str(exc)
    if not errors:
        return None, retained[0] if retained else 'no supported roof facets'
    area = sum(shape(s['geometry']).area for s in surfaces)
    if abs(area-footprint.area) > max(.002, footprint.area*.001):
        return None, 'incomplete faceted envelope'
    elevations = [v[2] for s in surfaces for ring in s['geometry']['coordinates'] for v in ring]
    bottom, top = min(elevations), max(elevations)
    original_top = max([original['height_m']] + [t['top_m'] for t in original['tiers']])
    if bottom <= 2 or abs(top-original_top) > max(2, original_top*.05):
        return None, 'facets disagree with supported building height'
    for surface in surfaces:
        surface['bottom_m'] = float(bottom)
    return {'height_m':float(bottom), 'tiers':[], 'roof_surfaces':surfaces,
            'method':'faceted_roof', 'roof_fit_p95_m':max(errors),
            'roof_patch_count':len(patches), 'faceted_patch_count':len(errors),
            'retained_roof_patches':retained}, None
