"""Planar footprint subtraction; no Blender or optional dependencies.

Convex cap fragments are cut by convex road footprints and remain convex.
Z is interpolated on every new edge, preserving the original draped surface.
Each surviving fragment can be extruded as its own closed shell, avoiding
T-junctions between separately clipped triangles.
"""

import math
from collections import defaultdict

from .planar import EPSILON


def area_xy(points):
    if len(points) < 3:
        return 0.0
    a = points[0]
    if len(points) == 3:
        b, c = points[1:]
        return ((b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])) * .5
    return sum((b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
               for b, c in zip(points[1:], points[2:])) * .5


def _hull(points):
    points = sorted(set(points))
    def half(items):
        result = []
        for p in items:
            while len(result) > 1:
                a, b = result[-2:]
                if (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0]) > 0:
                    break
                result.pop()
            result.append(p)
        return result
    return half(points)[:-1] + half(points[::-1])[:-1]


def _bounds(points):
    return (min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points))


def _overlap(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _split(poly, plane):
    """Split a convex XYZ polygon, interpolating Z at the clipping line."""
    nx, ny, d = plane
    inside, outside = [], []
    previous = poly[-1]
    before = nx*previous[0] + ny*previous[1] + d
    for point in poly:
        distance = nx*point[0] + ny*point[1] + d
        if (before < 0) != (distance < 0):
            t = before / (before-distance)
            hit = tuple(a + t*(b-a) for a, b in zip(previous, point))
            inside.append(hit)
            outside.append(hit)
        (inside if distance >= 0 else outside).append(point)
        previous, before = point, distance
    return inside, outside


def subtract_convex(poly, planes):
    """Return disjoint convex pieces of *poly* outside a convex cutter."""
    remaining = poly
    result = []
    for plane in planes:
        remaining, outside = _split(remaining, plane)
        if len(outside) >= 3 and area_xy(outside) > 1e-12:
            result.append(outside)
        if len(remaining) < 3 or area_xy(remaining) <= 1e-12:
            return [poly]  # No positive-area intersection: do not partition it.
    return result


class FootprintIndex:
    """Spatial index of the actual generated road cap triangles.

    Clearance is a square Minkowski buffer: at most clearance per XY axis,
    without unbounded miters on the road mesh's very slender triangles.
    """
    def __init__(self, clearance=0.005, cell_size=2.0):
        self.clearance = max(0.0, clearance)
        self.cell_size = cell_size
        self.cells = defaultdict(list)
        self.cutters = []

    def _cells(self, bounds):
        x0, y0, x1, y1 = [math.floor(v/self.cell_size) for v in bounds]
        for x in range(x0, x1+1):
            for y in range(y0, y1+1):
                yield x, y

    def add(self, points):
        if area_xy(points) <= 1e-12:
            return
        c = self.clearance
        ring = _hull([(p[0]+dx, p[1]+dy) for p in points
                      for dx, dy in ((-c, -c), (-c, c), (c, c), (c, -c))])
        planes = []
        for a, b in zip(ring, ring[1:]+ring[:1]):
            dx, dy = b[0]-a[0], b[1]-a[1]
            length = math.hypot(dx, dy)
            nx, ny = -dy/length, dx/length
            planes.append((nx, ny, -nx*a[0]-ny*a[1]))
        bounds = _bounds(ring)
        index = len(self.cutters)
        self.cutters.append((bounds, planes))
        for cell in self._cells(bounds):
            self.cells[cell].append(index)

    def overlaps(self, poly):
        """Whether a polygon has positive-area contact with any indexed footprint.

        Stop at the first hit; existence checks need no fragment subtraction.
        """
        bounds = _bounds(poly)
        candidates = set()
        for cell in self._cells(bounds):
            candidates.update(self.cells.get(cell, ()))
        for index in candidates:
            box, planes = self.cutters[index]
            if not _overlap(bounds, box):
                continue
            intersection = poly
            for plane in planes:
                intersection, _ = _split(intersection, plane)
                if len(intersection) < 3:
                    break
            if len(intersection) >= 3 and area_xy(intersection) > 1e-12:
                return True
        return False

    def difference(self, poly):
        bounds = _bounds(poly)
        candidates = set()
        for cell in self._cells(bounds):
            candidates.update(self.cells.get(cell, ()))
        pieces = [poly]
        piece_bounds = [bounds]
        for index in sorted(candidates):
            cut_bounds, planes = self.cutters[index]
            if not _overlap(bounds, cut_bounds):
                continue
            remaining = []
            remaining_bounds = []
            for piece, box in zip(pieces, piece_bounds):
                if _overlap(box, cut_bounds):
                    parts = subtract_convex(piece, planes)
                    remaining.extend(parts)
                    remaining_bounds.extend(box if p is piece else _bounds(p) for p in parts)
                else:
                    remaining.append(piece)
                    remaining_bounds.append(box)
            pieces = remaining
            piece_bounds = remaining_bounds
            if not pieces:
                break
        return pieces


def fragment_solid(poly, thickness):
    """Extrude one convex XYZ cap down, with outward winding and closed walls."""
    clean = []
    for p in poly:
        if not clean or math.dist(p[:2], clean[-1][:2]) > EPSILON:
            clean.append(p)
    if len(clean) > 1 and math.dist(clean[0][:2], clean[-1][:2]) <= EPSILON:
        clean.pop()
    if len(clean) < 3 or area_xy(clean) <= EPSILON*EPSILON:
        return [], []
    vertices = [(p[0], p[1], z) for p in clean for z in (p[2]-thickness, p[2])]
    faces = []
    for i in range(1, len(clean)-1):
        faces.extend(((1, 2*i+1, 2*i+3), (0, 2*i+2, 2*i)))
    for a in range(len(clean)):
        b = (a+1) % len(clean)
        faces.append((2*a, 2*b, 2*b+1, 2*a+1))
    return vertices, faces
