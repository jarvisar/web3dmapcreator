"""Outlines and solid of a ``cutout`` frame for the export crop (no bpy).

The crop keeps what lies inside the frame's through opening. Every shape here
is convex, so the crop cuts along planes; curves are polygons whose edges stay
within ``CHORD_TOLERANCE_MM`` of the true curve.
"""

import math


SHAPES = ("RECTANGLE", "ROUNDED", "CIRCLE", "HEXAGON")
RIM_MM = 6.0
THICKNESS_MM = 2.0
CHORD_TOLERANCE_MM = 0.1
_MIN_SEGMENTS = 32
_MAX_SEGMENTS = 192


def circle_segments(radius, tolerance=CHORD_TOLERANCE_MM):
    """Segments of a full circle, a multiple of four, within *tolerance* of it."""
    if radius <= tolerance:
        return _MIN_SEGMENTS
    count = math.ceil(math.pi / math.acos(1 - tolerance / radius))
    count = min(_MAX_SEGMENTS, max(_MIN_SEGMENTS, count))
    return count + (-count) % 4


def _arc(cx, cy, radius, start, segments):
    """A quarter arc from angle *start* (radians), both ends included."""
    return [(cx + radius * math.cos(start + math.pi / 2 * i / segments),
             cy + radius * math.sin(start + math.pi / 2 * i / segments))
            for i in range(segments + 1)]


def opening_ring(shape, width, height, corner_radius=0.0):
    """Counter-clockwise opening outline centred on the origin, inside *width* x *height*.

    Circles and hexagons are regular and as large as fits; the hexagon has
    flat north and south sides. A rounded rectangle's corner radius is capped
    at half its shorter side.
    """
    if not all(math.isfinite(v) and v > 0 for v in (width, height)):
        raise ValueError("The cutout opening needs a positive width and height")
    w, h = width / 2, height / 2
    if shape == "RECTANGLE" or (shape == "ROUNDED" and corner_radius <= 0):
        return [(-w, -h), (w, -h), (w, h), (-w, h)]
    if shape == "ROUNDED":
        r = min(corner_radius, w, h)
        segments = max(2, circle_segments(r) // 4)
        ring = []
        for cx, cy, start in ((w - r, -h + r, -math.pi / 2), (w - r, h - r, 0.0),
                              (-w + r, h - r, math.pi / 2), (-w + r, -h + r, math.pi)):
            for point in _arc(cx, cy, r, start, segments):
                # Arcs of a side fully rounded away meet at one point.
                if not ring or math.dist(point, ring[-1]) > 1e-9 * max(w, h):
                    ring.append(point)
        if math.dist(ring[0], ring[-1]) <= 1e-9 * max(w, h):
            ring.pop()
        return ring
    if shape == "CIRCLE":
        radius = min(w, h)
        segments = circle_segments(radius)
        return [(radius * math.cos(math.tau * i / segments), radius * math.sin(math.tau * i / segments))
                for i in range(segments)]
    if shape == "HEXAGON":
        radius = min(w, height / math.sqrt(3))
        return [(radius * math.cos(math.pi / 3 * i), radius * math.sin(math.pi / 3 * i)) for i in range(6)]
    raise ValueError(f"Unknown cutout shape: {shape!r}")


def offset_ring(ring, distance):
    """A convex counter-clockwise ring moved outward by *distance*, corners mitred."""
    result = []
    count = len(ring)
    for i, (x, y) in enumerate(ring):
        (ax, ay), (bx, by) = ring[i - 1], ring[(i + 1) % count]
        normals = []
        for dx, dy in ((x - ax, y - ay), (bx - x, by - y)):
            length = math.hypot(dx, dy)
            normals.append((dy / length, -dx / length))
        (n1x, n1y), (n2x, n2y) = normals
        scale = distance / (1 + n1x * n2x + n1y * n2y)
        result.append((x + (n1x + n2x) * scale, y + (n1y + n2y) * scale))
    return result


def frame_geometry(ring, rim=RIM_MM, thickness=THICKNESS_MM):
    """Closed, outward-wound flat ring around *ring*: (vertices, quad faces), Z from 0 to *thickness*."""
    if len(ring) < 3 or rim <= 0 or thickness <= 0:
        raise ValueError("A cutout frame needs an opening, a rim and a thickness")
    outer = offset_ring(ring, rim)
    n = len(ring)
    # Inner bottom, outer bottom, inner top, outer top.
    vertices = ([(x, y, 0.0) for x, y in ring] + [(x, y, 0.0) for x, y in outer]
                + [(x, y, thickness) for x, y in ring] + [(x, y, thickness) for x, y in outer])
    faces = []
    for i in range(n):
        j = (i + 1) % n
        ib, ob, it, ot = i, n + i, 2 * n + i, 3 * n + i
        jb, pb, jt, pt = j, n + j, 2 * n + j, 3 * n + j
        faces.append((ot, pt, jt, it))   # top
        faces.append((ob, ib, jb, pb))   # bottom
        faces.append((ob, pb, pt, ot))   # outer wall
        faces.append((jb, ib, it, jt))   # inner wall, facing the opening
    return vertices, faces
