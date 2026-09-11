"""Fit a shared vector boundary network for measured architectural surfaces.

Roof planes and their evidence are unchanged. Each internal interface is fitted
once, then polygonized with the exact footprint/courtyards. This avoids cracks,
overlapping repairs and tiny complementary strips from separately simplified
roof polygons. Displacement is bounded by survey support and output scale.
"""
import math

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge, polygonize, unary_union
from shapely.errors import GEOSException

try:
    from .lidar_facets import pieces
except ImportError:
    from lidar_facets import pieces


def _lines(g):
    if g.geom_type in ('LineString', 'LinearRing'):
        return [g] if not g.is_empty else []
    return [p for child in getattr(g, 'geoms', ()) for p in _lines(child)]


def _sample(line, spacing):
    count = min(2048, max(12, int(math.ceil(line.length / spacing))))
    return np.array([line.interpolate(i/count, normalized=True).coords[0][:2]
                     for i in range(count + 1)])


def _admissible(candidate, original, tolerance):
    return (candidate.is_simple and candidate.length <= original.length * 1.001
            and candidate.hausdorff_distance(original) <= tolerance)


def _closed_primitive(line, tolerance):
    """Use a circle or rectangle only when the *whole* boundary supports it.

    Resolved recesses cannot pass the two-sided contour distance bound. No
    building-axis snapping is imposed on arbitrary or diagonal architecture.
    """
    xy = _sample(line, max(tolerance*.5, .1))[:-1]
    center = xy.mean(axis=0)
    uv = xy-center
    design = np.column_stack((2*uv, np.ones(len(uv))))
    coef, _, rank, _ = np.linalg.lstsq(design, np.sum(uv*uv, axis=1), rcond=None)
    candidates = []
    if rank == 3:
        origin = coef[:2]+center
        radius = float(np.median(np.linalg.norm(xy-origin, axis=1)))
        residual = np.abs(np.linalg.norm(xy-origin, axis=1)-radius)
        if radius > tolerance*3 and residual.max() <= tolerance:
            # Chord error is finer than the contour uncertainty; the polygon
            # is a geometry approximation of a fitted circle, not height bins.
            count = max(16, min(256, int(math.ceil(math.pi/math.acos(
                max(-1., 1-min(tolerance*.15, radius*.1)/radius))))))
            angles = np.arange(count+1)*2*math.pi/count
            ring = origin + radius*np.column_stack((np.cos(angles), np.sin(angles)))
            ring[-1] = ring[0]
            candidates.append(LineString(ring))
    rectangle = Polygon(line).minimum_rotated_rectangle
    coords = np.array(rectangle.exterior.coords)
    delta = coords[1]-coords[0]
    angle = math.atan2(delta[1], delta[0])
    rectangles = []
    for offset in np.linspace(-math.radians(4), math.radians(4), 17):
        theta = angle+offset
        rotation = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
        projected = uv @ rotation
        bounds = []
        for axis in range(2):
            v = projected[:, axis]
            bounds.append((np.median(v[v <= v.min()+tolerance]),
                           np.median(v[v >= v.max()-tolerance])))
        (x0,x1),(y0,y1) = bounds
        ring = np.array([(x0,y0),(x1,y0),(x1,y1),(x0,y1),(x0,y0)]) @ rotation.T + center
        candidate = LineString(ring)
        if _admissible(candidate, line, tolerance):
            rectangles.append((candidate.hausdorff_distance(line), candidate))
    if rectangles:
        candidates.append(min(rectangles, key=lambda item:item[0])[1])
    valid = [g for g in candidates if _admissible(g, line, tolerance)]
    return min(valid, key=lambda g:len(g.coords)) if valid else None


def fit_chain(line, tolerance):
    """Bounded line/curve approximation; junction endpoints stay fixed."""
    closed = line.is_ring
    if closed:
        primitive = _closed_primitive(line, tolerance)
        if primitive is not None:
            return primitive
        # Canonical start prevents arbitrary GEOS ring order changing corners.
        line = LineString(Polygon(line).normalize().exterior.coords)
    coarse = line.simplify(tolerance*.8, preserve_topology=True)
    if len(coarse.coords) <= 2:
        return coarse if _admissible(coarse, line, tolerance) else line
    # Refit long segments using equal arc-length support. RDP alone picks
    # noisy extreme vertices; intersecting independently measured lines gives
    # intentional corners without forcing a right angle.
    vertices = np.asarray(coarse.coords)[:, :2]
    distances = np.array([line.project(Point(p)) for p in vertices])
    if closed:
        distances[-1] = line.length
    fitted = []
    for i in range(len(vertices)-1):
        start, stop = distances[i:i+2]
        count = max(3, min(256, int(math.ceil((stop-start)/max(.1,tolerance*.4)))))
        xy = np.array([line.interpolate(t).coords[0][:2] for t in np.linspace(start,stop,count)])
        origin = xy.mean(axis=0)
        _, _, vectors = np.linalg.svd(xy-origin, full_matrices=False)
        direction = vectors[0]
        fitted.append((origin,direction))
    result = vertices.copy()
    indices = range(len(vertices)-1) if closed else range(1,len(vertices)-1)
    for i in indices:
        a,u = fitted[i-1]
        b,v = fitted[i]
        matrix = np.column_stack((u,-v))
        if abs(np.linalg.det(matrix)) < .15:
            continue
        point = a+u*np.linalg.solve(matrix,b-a)[0]
        if np.linalg.norm(point-vertices[i]) <= tolerance:
            result[i] = point
    if closed:
        result[-1] = result[0]
    candidate = LineString(result)
    if _admissible(candidate,line,tolerance):
        return candidate
    return coarse if _admissible(coarse,line,tolerance) else line


def regularize_outlines(patches, footprint, cell, scale, fits=None):
    """Refit common interfaces, preserving region identity and supported cores."""
    if len(patches) < 2:
        return patches, {}
    tolerance = max(.3, min(cell*.8, .1/scale[0]))
    try:
        # Node at the exact exterior so fixed endpoints continue to meet it.
        internal = unary_union([g.boundary.difference(footprint.boundary)
                                for g,_ in patches])
        lines = _lines(internal)
        if not lines:
            return patches, {}
        chains = _lines(linemerge(lines))
        region_tree = STRtree([g for g,_s in patches])
        def eligible(line):
            if fits is None:
                return True
            middle = line.interpolate(.5, normalized=True)
            owners = [int(i) for i in region_tree.query(middle.buffer(1e-6),predicate='intersects')
                      if patches[int(i)][0].boundary.distance(middle) < 1e-6]
            if len(owners) != 2:
                return False
            a,b = owners
            if fits[a] is None or fits[b] is None:
                # Local nonplanar boundary heights will be inferred during
                # tessellation. Do not displace a possibly continuous join.
                return False
            ca,pa,_=fits[a];cb,pb,_=fits[b]
            xy=_sample(line,max(cell, line.length/24))
            gap=(xy-ca)@pa[:2]+pa[2]-((xy-cb)@pb[:2]+pb[2])
            return np.linalg.norm(pa[:2]-pb[:2]) < .06 or np.max(np.abs(gap)) > cell
        fitted = [fit_chain(line,tolerance) if line.length > tolerance*2 and eligible(line)
                  else line for line in chains]
        if all(a.equals(b) for a,b in zip(chains,fitted)):
            return patches, {}
        faces = list(polygonize(unary_union([footprint.boundary,*fitted])))
        assigned = [[] for _ in patches]
        for face in faces:
            if not footprint.covers(face.representative_point()):
                continue
            candidates=region_tree.query(face,predicate='intersects')
            if not len(candidates):
                return patches, {'surface_outline_rejected': True}
            owner=max(map(int,candidates),key=lambda i:(face.intersection(patches[i][0]).area,-i))
            assigned[owner].extend(pieces(face.intersection(footprint)))
        result = []
        for (original,support),polygons in zip(patches,assigned):
            candidate = unary_union(polygons)
            if (candidate.is_empty or not candidate.is_valid
                    or candidate.symmetric_difference(original).difference(
                        original.boundary.buffer(tolerance*1.05)).area > 1e-6
                    or candidate.intersection(original).area < original.area*.7):
                return patches, {'surface_outline_rejected': True}
            result.append((candidate,support))
        if unary_union([g for g,_ in result]).symmetric_difference(footprint).area > 1e-6:
            return patches, {'surface_outline_rejected': True}
        return result, {'surface_outline_chains':len(chains),
                        'surface_outline_fitted':sum(not a.equals(b) for a,b in zip(chains,fitted)),
                        'surface_outline_vertices_before':sum(len(g.coords) for g in chains),
                        'surface_outline_vertices_after':sum(len(g.coords) for g in fitted),
                        'surface_outline_tolerance_m':tolerance}
    except (GEOSException, ValueError, np.linalg.LinAlgError):
        return patches, {'surface_outline_rejected': True}
