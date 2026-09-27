"""Validated water polygons and rectangle intersections, without Blender.

Water holes are land. Clipping rings separately and discarding a hole at the
frame floods that land; closing a clipped concave shell can also join separate
pieces. Instead retain directed source edges inside the frame and add only
the frame intervals inside the complete polygon. Stitching those edges gives
closed components, with boundary-crossing islands incorporated as notches.
"""

from __future__ import annotations

import math

from ..data.geojson import geometry_polygons
from .planar import point_in_polygon, point_in_ring, ring_bounds, signed_area


# Topology uses double precision, before the mesh builder's float32 cleaning.
_TOL = 1.0e-8


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _intersects(a, b, c, d):
    """Inclusive segment intersection; touching rings are ambiguous as solids."""
    return (_cross(a, b, c) * _cross(a, b, d) <= 0.0
            and _cross(c, d, a) * _cross(c, d, b) <= 0.0)


def valid_water_polygon(rings):
    """Reject intersections, orphan/nested holes, and non-simple boundaries.

    An x sweep bounds comparisons to edges with overlapping bounding boxes;
    coast tiles can contain tens of thousands of vertices and many islands.
    Adjacent edges may share their endpoint, but may not double back.
    """
    if not rings or any(len(ring) < 3 for ring in rings):
        return False
    edges = []
    for ri, ring in enumerate(rings):
        for i, a in enumerate(ring):
            b = ring[(i + 1) % len(ring)]
            edges.append((min(a[0], b[0]), max(a[0], b[0]),
                          min(a[1], b[1]), max(a[1], b[1]), ri, i, a, b))
    active = []
    for edge in sorted(edges):
        low_x, _, low_y, high_y, ri, i, a, b = edge
        active = [other for other in active if other[1] >= low_x]
        for other in active:
            if other[3] < low_y or other[2] > high_y:
                continue
            _, _, _, _, rj, j, c, d = other
            if ri == rj and (i - j) % len(rings[ri]) in (1, len(rings[ri]) - 1):
                shared = a if a == c or a == d else b
                first = b if shared == a else a
                second = d if shared == c else c
                if _cross(shared, first, second) == 0.0 and (
                    (first[0] - shared[0]) * (second[0] - shared[0])
                    + (first[1] - shared[1]) * (second[1] - shared[1]) > 0.0
                ):
                    return False
                continue
            if _intersects(a, b, c, d):
                return False
        active.append(edge)
    extents = [ring_bounds(ring) for ring in rings]

    def contains(point, index):
        x, y = point
        left, bottom, right, top = extents[index]
        return left <= x <= right and bottom <= y <= top and point_in_ring(point, rings[index])

    for i, hole in enumerate(rings[1:], 1):
        if not point_in_ring(hole[0], rings[0]):
            return False
        for j in range(1, i):
            if contains(hole[0], j) or contains(rings[j][0], i):
                return False
    return True


def _clip_segment(a, b, bounds):
    low, high = 0.0, 1.0
    for axis in (0, 1):
        delta = b[axis] - a[axis]
        minimum, maximum = bounds[axis], bounds[axis + 2]
        if delta == 0.0:
            if not minimum <= a[axis] <= maximum:
                return None
            continue
        enter, leave = sorted(((minimum - a[axis]) / delta,
                               (maximum - a[axis]) / delta))
        low, high = max(low, enter), min(high, leave)
        if low >= high:
            return None

    def at(t):
        p = [a[k] + t * (b[k] - a[k]) for k in (0, 1)]
        for k in (0, 1):
            for limit in (bounds[k], bounds[k + 2]):
                if abs(p[k] - limit) <= _TOL:
                    p[k] = limit
        return tuple(p)

    return at(low), at(high)


def clip_water_polygon(rings, bounds):
    """Intersect a validated polygon with a rectangle, retaining every hole.

    Returns None for an ambiguous boundary graph, [] for an empty intersection,
    otherwise a list of polygons. No inferred closure across missing data.
    """
    min_x, min_y, max_x, max_y = bounds
    frame = [(min_x, min_y), (max_x, min_y), (max_x, max_y), (min_x, max_y)]
    sides = [[frame[i], frame[(i + 1) % 4]] for i in range(4)]
    edges = []

    def on_side(p, i):
        axis = 1 if i % 2 == 0 else 0
        return p[axis] == frame[i][axis]

    for ring in rings:
        for i, a in enumerate(ring):
            clipped = _clip_segment(a, ring[(i + 1) % len(ring)], bounds)
            if clipped is None:
                continue
            a, b = clipped
            on_frame = False
            for side in range(4):
                for p in (a, b):
                    if on_side(p, side):
                        sides[side].append(p)
                if on_side(a, side) and on_side(b, side):
                    on_frame = True
            if not on_frame and math.dist(a, b) > _TOL:
                edges.append((a, b))

    for side, points in enumerate(sides):
        axis = 0 if side % 2 == 0 else 1
        points = sorted(set(points), key=lambda p: p[axis], reverse=side >= 2)
        # A probe just inside the frame handles coincident source/frame edges.
        inward = ((0, 1), (-1, 0), (0, -1), (1, 0))[side]
        for a, b in zip(points, points[1:]):
            if math.dist(a, b) <= _TOL:
                continue
            mid = tuple((a[k] + b[k]) * 0.5 + inward[k] * _TOL for k in (0, 1))
            if point_in_polygon(mid, rings):
                edges.append((a, b))

    # Canonicalize numerical intersection roundoff, without moving the frame.
    nodes, buckets = [], {}

    def node(p):
        key = tuple(math.floor(v / _TOL) for v in p)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for index in buckets.get((key[0] + dx, key[1] + dy), ()):
                    if math.dist(p, nodes[index]) <= _TOL:
                        return index
        index = len(nodes)
        nodes.append(p)
        buckets.setdefault(key, []).append(index)
        return index

    outgoing, incoming = {}, {}
    for a, b in edges:
        start, end = node(a), node(b)
        if start == end:
            continue
        if start in outgoing or end in incoming:
            return None
        outgoing[start], incoming[end] = end, start
    if outgoing.keys() != incoming.keys():
        return None
    loops = []
    while outgoing:
        start = next(iter(outgoing))
        current, loop = start, []
        while True:
            loop.append(nodes[current])
            current = outgoing.pop(current)
            if current == start:
                break
        if len(loop) < 3 or abs(signed_area(loop)) <= _TOL * _TOL:
            return None
        loops.append(loop)
    polygons = [[ring] for ring in loops if signed_area(ring) > 0.0]
    for hole in (ring for ring in loops if signed_area(ring) < 0.0):
        owners = [polygon for polygon in polygons if point_in_ring(hole[0], polygon[0])]
        if len(owners) != 1:
            return None
        owners[0].append(hole)
    return polygons


def projected_water_polygons(geometry, transform):
    """Project/validate each source Polygon atomically, then clip it as an area.

    A malformed shell OR hole rejects its polygon. MultiPolygon siblings are
    independent. In particular, never skip a bad coordinate or implicitly close
    an incomplete coastline: either action can invent a water-spanning chord.
    """
    frame = transform.model_bounds
    bounds = (frame.min_x_mm, frame.min_y_mm, frame.max_x_mm, frame.max_y_mm)
    result, rejected = [], 0
    for source in geometry_polygons(geometry):
        rings = []
        try:
            if not source:
                raise ValueError("missing shell")
            for source_ring in source:
                if len(source_ring) < 4 or source_ring[0][:2] != source_ring[-1][:2]:
                    raise ValueError("incomplete ring")
                ring = []
                for coordinate in source_ring:
                    if len(coordinate) < 2 or not all(
                        isinstance(v, (float, int)) and math.isfinite(v) for v in coordinate[:2]
                    ):
                        raise ValueError("invalid coordinate")
                    x, y, _ = transform.geographic_to_model(*coordinate[:2], 0.0)
                    if not math.isfinite(x) or not math.isfinite(y):
                        raise ValueError("invalid projection")
                    p = (x, y)
                    if not ring or p != ring[-1]:
                        ring.append(p)
                if len(ring) > 1 and ring[-1] == ring[0]:
                    ring.pop()
                area = signed_area(ring)
                if len(ring) < 3 or abs(area) <= _TOL * _TOL:
                    raise ValueError("degenerate ring")
                if (area > 0) != (len(rings) == 0):
                    ring.reverse()
                rings.append(ring)
            extent = ring_bounds(rings[0])
            if extent[2] < bounds[0] or extent[0] > bounds[2] or extent[3] < bounds[1] or extent[1] > bounds[3]:
                continue
            if not valid_water_polygon(rings):
                raise ValueError("invalid polygon topology")
            polygons = clip_water_polygon(rings, bounds)
            if polygons is None:
                raise ValueError("ambiguous clipped boundary")
            result.extend(polygons)
        except (ValueError, TypeError, IndexError, OverflowError):
            rejected += 1
    return result, rejected
