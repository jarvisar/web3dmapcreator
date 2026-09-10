"""Remove sampling-grid stairs without rounding architectural corners.

This is a reconstruction of the boundary supported by raster cells, not an
increase in survey resolution. Only alternating short orthogonal steps can be
replaced; long edges and genuine convex/concave corners remain fixed. Call it
in the sampling frame before source-part snapping and physical width filtering.
"""
import math

from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPolygon, Polygon


def _ring_without_stairs(ring, cell_m):
    # Union/buffer can leave collinear grid vertices. They are not corners.
    points = list(Polygon(ring).simplify(0).exterior.coords)[:-1]
    count = len(points)
    if count < 8:
        return points
    edges = [(points[(i+1) % count][0]-p[0],
              points[(i+1) % count][1]-p[1]) for i, p in enumerate(points)]
    epsilon = cell_m * 1e-6
    # Mapped outlines and clipped diagonal source boundaries are authoritative;
    # this helper only knows how to recognize orthogonal raster staircases.
    if any(abs(dx) > epsilon and abs(dy) > epsilon for dx, dy in edges):
        return points
    lengths = [math.hypot(dx, dy) for dx, dy in edges]
    turns = []
    for i, (dx, dy) in enumerate(edges):
        previous = edges[i-1]
        cross = previous[0]*dy-previous[1]*dx
        turns.append(1 if cross > 0 else -1)
    # Raster stairs alternate left/right turns. Repeated turns indicate a
    # meaningful corner. Anchor both ends of long wall/setback runs as well.
    anchors = [i for i in range(count)
               if turns[i] == turns[i-1]
               or turns[i] == turns[(i+1) % count]
               or lengths[i-1] > cell_m*2.5
               or lengths[i] > cell_m*2.5]
    if not anchors:
        return points
    result = []
    for j, start in enumerate(anchors):
        end = anchors[(j+1) % len(anchors)]
        if end <= start:
            end += count
        chain = [points[i % count] for i in range(start, end+1)]
        if len(chain) >= 5:
            # Fit edge midpoints, which lie between the inward/outward stair
            # corners. Simplifying the original corners alone biases the whole
            # diagonal toward whichever stair phase contains the endpoints.
            # The midpoint fit removes that directional/area bias while the
            # fixed endpoints retain the adjacent architectural corners.
            middle = [((a[0]+b[0])*.5, (a[1]+b[1])*.5)
                      for a, b in zip(chain, chain[1:])]
            origin = chain[0]
            # Normalize to cell units so equal-distance tie choices are stable
            # across model scales and large projected-coordinate offsets.
            normalized = [(round((x-origin[0])/cell_m, 8),
                           round((y-origin[1])/cell_m, 8)) for x, y in middle]
            fitted = LineString(normalized).simplify(.35).coords
            middle = [(origin[0]+x*cell_m, origin[1]+y*cell_m) for x, y in fitted]
            chain = [chain[0], *middle, chain[-1]]
        result.extend(chain[:-1])
    return result


def regularize_grid_contours(geometry, cell_m):
    """Return bounded straight/curved tier outlines, preserving safe fallback.

    The sampling frame must have orthogonal cell edges. Each polygon is adopted
    independently only if it stays valid, retains its holes, changes area by at
    most 5%, and moves its boundary by at most 0.8 cells. Source-footprint and
    previous-tier intersection and minimum-width opening must still follow.
    """
    if (geometry.is_empty or not geometry.is_valid
            or not math.isfinite(cell_m) or cell_m <= 0):
        return geometry
    if geometry.geom_type == 'Polygon':
        original_parts = [geometry]
    elif geometry.geom_type == 'MultiPolygon':
        original_parts = list(geometry.geoms)
    else:
        return geometry
    parts = []
    for original in original_parts:
        try:
            outer = _ring_without_stairs(original.exterior.coords, cell_m)
            holes = [_ring_without_stairs(ring.coords, cell_m)
                     for ring in original.interiors]
            candidate = Polygon(outer, holes)
            if (not candidate.is_valid or candidate.is_empty
                    or abs(candidate.area-original.area) > original.area*.05
                    or candidate.symmetric_difference(original).area > original.area*.08
                    or original.boundary.hausdorff_distance(candidate.boundary) > cell_m*.8):
                parts.append(original)
                continue
            # Courtyard topology and area are separate from outer mass area;
            # a small hole must not disappear inside an acceptable total error.
            if any(abs(Polygon(new).area-Polygon(old).area) > Polygon(old).area*.05
                   for old, new in zip(original.interiors, candidate.interiors)):
                parts.append(original)
                continue
            parts.append(candidate)
        except (ValueError, ArithmeticError, GEOSException):
            parts.append(original)
    result = parts[0] if geometry.geom_type == 'Polygon' else MultiPolygon(parts)
    # Independently fitted components may approach one another. Never repair
    # those collisions with a union, which could merge distinct towers.
    return result if result.is_valid else geometry
