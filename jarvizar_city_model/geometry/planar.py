"""Blender-free planar geometry used by every feature generator.

These helpers operate on plain ``(x, y)`` tuples.  Callers use them in two
different units: the shared local ENU frame in metres (road buffering, tree
scatter) and the final miniature frame in millimetres (ring cleaning and
rectangle clipping).  Every tolerance is therefore an explicit argument with a
millimetre-scale default rather than a hidden module constant.
"""

from __future__ import annotations

import math
from typing import Callable, Dict, Iterable, List, Sequence, Tuple


Point = Tuple[float, float]

# Blender mesh coordinates are float32.  At a ~200 mm footprint, differences
# below a few microns collapse to identical vertices and create zero-length
# boundary edges.  This tolerance is still far below FDM-resolvable detail.
EPSILON = 1.0e-4


def signed_area(points: Sequence[Point]) -> float:
    """Return the shoelace signed area; positive is counter-clockwise."""
    count = len(points)
    if count < 3:
        return 0.0
    return 0.5 * sum(
        points[index][0] * points[(index + 1) % count][1]
        - points[(index + 1) % count][0] * points[index][1]
        for index in range(count)
    )


def clean_ring(points: Iterable[Point], epsilon: float = EPSILON) -> List[Point]:
    """Drop duplicate/near-duplicate vertices and reject degenerate rings."""
    clean: List[Point] = []
    for x, y in points:
        point = (float(x), float(y))
        if (
            not clean
            or abs(point[0] - clean[-1][0]) > epsilon
            or abs(point[1] - clean[-1][1]) > epsilon
        ):
            clean.append(point)
    if (
        len(clean) > 1
        and abs(clean[0][0] - clean[-1][0]) <= epsilon
        and abs(clean[0][1] - clean[-1][1]) <= epsilon
    ):
        clean.pop()
    if len(clean) < 3 or abs(signed_area(clean)) <= epsilon:
        return []
    return clean


def oriented_ring(
    points: Iterable[Point], counter_clockwise: bool, epsilon: float = EPSILON
) -> List[Point]:
    """Return a cleaned ring wound in the requested direction."""
    ring = clean_ring(points, epsilon)
    if not ring:
        return []
    if (signed_area(ring) > 0.0) != counter_clockwise:
        ring.reverse()
    return ring


def clip_ring_to_rectangle(
    points: Sequence[Point],
    min_x: float,
    min_y: float,
    max_x: float,
    max_y: float,
    epsilon: float = EPSILON,
) -> List[Point]:
    """Clip one ring to an axis-aligned rectangle using Sutherland-Hodgman."""

    def clip_edge(vertices, inside, intersection):
        if not vertices:
            return []
        output = []
        previous = vertices[-1]
        previous_inside = inside(previous)
        for current in vertices:
            current_inside = inside(current)
            if current_inside:
                if not previous_inside:
                    output.append(intersection(previous, current))
                output.append(current)
            elif previous_inside:
                output.append(intersection(previous, current))
            previous = current
            previous_inside = current_inside
        return output

    def vertical(a, b, x):
        delta = b[0] - a[0]
        factor = 0.0 if abs(delta) <= epsilon else (x - a[0]) / delta
        return x, a[1] + factor * (b[1] - a[1])

    def horizontal(a, b, y):
        delta = b[1] - a[1]
        factor = 0.0 if abs(delta) <= epsilon else (y - a[1]) / delta
        return a[0] + factor * (b[0] - a[0]), y

    result = list(points)
    result = clip_edge(
        result, lambda p: p[0] >= min_x, lambda a, b: vertical(a, b, min_x)
    )
    result = clip_edge(
        result, lambda p: p[0] <= max_x, lambda a, b: vertical(a, b, max_x)
    )
    result = clip_edge(
        result, lambda p: p[1] >= min_y, lambda a, b: horizontal(a, b, min_y)
    )
    result = clip_edge(
        result, lambda p: p[1] <= max_y, lambda a, b: horizontal(a, b, max_y)
    )
    return clean_ring(result, epsilon)


def ring_bounds(points: Sequence[Point]) -> Tuple[float, float, float, float]:
    """Return ``(min_x, min_y, max_x, max_y)`` for a non-empty ring."""
    if not points:
        raise ValueError("ring must not be empty")
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_ring(point: Point, ring: Sequence[Point]) -> bool:
    """Crossing-number point-in-polygon test for a single closed ring."""
    if len(ring) < 3:
        return False
    x, y = point
    inside = False
    count = len(ring)
    previous = ring[-1]
    for index in range(count):
        current = ring[index]
        if (current[1] > y) != (previous[1] > y):
            span = previous[1] - current[1]
            if span != 0.0:
                crossing = current[0] + (y - current[1]) / span * (
                    previous[0] - current[0]
                )
                if x < crossing:
                    inside = not inside
        previous = current
    return inside


def point_in_polygon(point: Point, rings: Sequence[Sequence[Point]]) -> bool:
    """Return whether a point is inside an outer ring and outside every hole."""
    if not rings:
        return False
    if not point_in_ring(point, rings[0]):
        return False
    return not any(point_in_ring(point, hole) for hole in rings[1:])


def densify_ring(points: Sequence[Point], maximum_spacing: float) -> List[Point]:
    """Insert vertices so no ring edge is longer than *maximum_spacing*.

    Terrain draping samples elevation per vertex.  A large park or water
    polygon must therefore be subdivided along its edges before it can follow
    the ground, otherwise a long edge cuts straight through a hillside.
    """
    if len(points) < 3 or maximum_spacing <= 0.0:
        return list(points)
    result: List[Point] = []
    count = len(points)
    for index in range(count):
        a = points[index]
        b = points[(index + 1) % count]
        result.append(a)
        distance = math.dist(a, b)
        steps = int(distance / maximum_spacing)
        for step in range(1, steps + 1):
            factor = step / (steps + 1)
            result.append(
                (a[0] + (b[0] - a[0]) * factor, a[1] + (b[1] - a[1]) * factor)
            )
    return result


def interior_grid_points(
    rings: Sequence[Sequence[Point]],
    spacing: float,
    limit: int = 1200,
) -> List[Point]:
    """Return grid points strictly inside a polygon, excluding its holes.

    Solving a water surface from a polygon's *outline* reads the banks rather
    than the water: ring vertices sit on the shore, which is both higher and
    far more variable than the surface being solved for.

    Sample count is bounded twice, and neither bound may skew *where* the
    samples fall.  The candidate grid is coarsened first so a huge polygon does
    not run millions of containment tests, and any surplus is then strided
    rather than truncated -- keeping the first N points would confine them to
    the bottom few rows and bias a solved level toward one bank.
    """
    if not rings or spacing <= 0.0 or len(rings[0]) < 3 or limit < 1:
        return []
    min_x, min_y, max_x, max_y = ring_bounds(rings[0])
    if max_x <= min_x or max_y <= min_y:
        return []

    columns = max(1, int((max_x - min_x) / spacing))
    rows = max(1, int((max_y - min_y) / spacing))
    candidate_cap = limit * 3
    if columns * rows > candidate_cap:
        thinning = math.sqrt((columns * rows) / float(candidate_cap))
        columns = max(1, int(columns / thinning))
        rows = max(1, int(rows / thinning))

    samples: List[Point] = []
    for row in range(rows):
        y = min_y + (max_y - min_y) * (row + 0.5) / rows
        for column in range(columns):
            x = min_x + (max_x - min_x) * (column + 0.5) / columns
            if point_in_polygon((x, y), rings):
                samples.append((x, y))
    if len(samples) > limit:
        stride = len(samples) / float(limit)
        samples = [samples[int(index * stride)] for index in range(limit)]
    return samples


def effective_width(ring: Sequence[Point]) -> float:
    """Return a ring's narrow dimension: twice its area over its perimeter.

    For a long thin sliver this converges on its actual width, which plain area
    does not.  A 2 m x 60 m wall fragment and a small house can have the same
    area while only one of them is printable.
    """
    count = len(ring)
    if count < 3:
        return 0.0
    perimeter = sum(
        math.dist(ring[index], ring[(index + 1) % count]) for index in range(count)
    )
    if perimeter <= 0.0:
        return 0.0
    return 2.0 * abs(signed_area(ring)) / perimeter


def point_in_triangle(point, a, b, c) -> bool:
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1, d2, d3 = side(point, a, b), side(point, b, c), side(point, c, a)
    has_negative = d1 < 0.0 or d2 < 0.0 or d3 < 0.0
    has_positive = d1 > 0.0 or d2 > 0.0 or d3 > 0.0
    return not (has_negative and has_positive)


def ear_clip(points: Sequence[Sequence[float]]) -> List[Tuple[int, int, int]]:
    """Triangulate one simple ring, using every vertex exactly as given.

    Blender's own triangulator optimises the outline: across a run of nearly
    collinear vertices it spans them, and sometimes overlaps itself doing so.
    For a draped surface that is not an optimisation but a loss -- those
    vertices are precisely where the slab samples the terrain -- and an
    overlapping cap cannot be closed at all.

    Ear clipping keeps every vertex and produces non-overlapping triangles by
    construction.  A collinear vertex yields a triangle with no area in plan
    but real extent in Z, which is exactly what a slab following a hillside
    along a straight edge should be.
    """
    count = len(points)
    if count < 3:
        return []
    order = list(range(count))
    if signed_area([(p[0], p[1]) for p in points]) < 0.0:
        order.reverse()

    triangles: List[Tuple[int, int, int]] = []
    guard = count * count + 16
    while len(order) > 3 and guard > 0:
        guard -= 1
        for position in range(len(order)):
            previous = order[position - 1]
            current = order[position]
            following = order[(position + 1) % len(order)]
            a, b, c = points[previous], points[current], points[following]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if cross < 0.0:
                continue
            blocked = False
            for other in order:
                if other in (previous, current, following):
                    continue
                if point_in_triangle(points[other], a, b, c):
                    blocked = True
                    break
            if blocked:
                continue
            triangles.append((previous, current, following))
            del order[position]
            break
        else:
            return []
    if len(order) != 3:
        return []
    triangles.append(tuple(order))
    return triangles


def shell_volume(
    vertices: Sequence[Sequence[float]],
    faces: Sequence[Sequence[int]],
) -> float:
    """Return the signed volume a closed, consistently wound shell encloses.

    Positive means the faces are wound outward.  The divergence sum is only
    translation invariant for a consistently oriented closed surface, so this
    is meaningful after :func:`orient_faces_outward` and meaningless before it.
    """
    total = 0.0
    for face in faces:
        if len(face) < 3:
            continue
        ax, ay, az = vertices[face[0]]
        for offset in range(1, len(face) - 1):
            bx, by, bz = vertices[face[offset]]
            cx, cy, cz = vertices[face[offset + 1]]
            total += (
                ax * (by * cz - bz * cy)
                - ay * (bx * cz - bz * cx)
                + az * (bx * cy - by * cx)
            )
    return total / 6.0


def faces_are_consistent(faces: Sequence[Sequence[int]]) -> bool:
    """Whether every directed edge of *faces* is traversed exactly once.

    That is the definition of a consistently wound closed surface, and it is
    strictly stronger than "every edge is shared by two faces": two faces can
    share an edge and both traverse it the same way, which leaves the pair
    back to back with no inside between them.
    """
    directed: Dict[Tuple[int, int], int] = {}
    for face in faces:
        count = len(face)
        for offset in range(count):
            key = (face[offset], face[(offset + 1) % count])
            if key in directed:
                return False
            directed[key] = 1
    return all((b, a) in directed for a, b in directed)


def orient_faces_outward(
    vertices: Sequence[Sequence[float]],
    faces: Sequence[Sequence[int]],
) -> List[Tuple[int, ...]]:
    """Re-wind *faces* so the shell they close is consistently outward facing.

    A prism's caps are wound one triangle at a time from the sign of their own
    area, and the walls follow whichever direction the cap triangle handed
    them.  That is exact until a cap triangle has no area to speak of: a ring
    that touches itself, or one pinched into a zero-width corridor by the
    rectangle clip, triangulates into slivers whose sign is float noise.  The
    slivers carry no volume, but the full-size wall quads raised on their
    edges inherit the noise and come out facing inward, which is what a slicer
    reports as a hole and what Blender's overlay paints red.

    Orientation is therefore decided by propagation rather than per face:
    neighbours across a shared edge must traverse it in opposite directions,
    which fixes each face against its neighbours no matter how small it is.
    Each edge-connected component is then flipped as a whole if it came out
    enclosing a negative volume.  Faces are returned unchanged if the shell is
    not edge-manifold or not orientable, leaving the caller's own checks to
    decide what to do with it.
    """
    faces = [tuple(face) for face in faces]
    if not faces:
        return faces

    neighbours: Dict[Tuple[int, int], List[int]] = {}
    for index, face in enumerate(faces):
        count = len(face)
        for offset in range(count):
            a, b = face[offset], face[(offset + 1) % count]
            key = (a, b) if a < b else (b, a)
            shared = neighbours.get(key)
            if shared is None:
                neighbours[key] = [index]
            elif len(shared) >= 2:
                return faces  # Not edge-manifold; nothing to propagate along.
            else:
                shared.append(index)
    if any(len(shared) != 2 for shared in neighbours.values()):
        return faces

    def runs_forward(face: Sequence[int], a: int, b: int) -> bool:
        """Whether *face*, as given, traverses the edge from a to b."""
        count = len(face)
        for offset in range(count):
            if face[offset] == a and face[(offset + 1) % count] == b:
                return True
        return False

    flipped: List[bool] = [False] * len(faces)
    seen = [False] * len(faces)
    for seed in range(len(faces)):
        if seen[seed]:
            continue
        seen[seed] = True
        component = [seed]
        queue = [seed]
        while queue:
            current = queue.pop()
            face = faces[current]
            count = len(face)
            for offset in range(count):
                a, b = face[offset], face[(offset + 1) % count]
                key = (a, b) if a < b else (b, a)
                pair = neighbours[key]
                other = pair[0] if pair[1] == current else pair[1]
                if other == current:
                    continue  # A face folded onto its own edge; leave it be.
                # Once wound, this face runs a->b unless it is flipped, and the
                # neighbour has to run the edge the other way round.  So the
                # neighbour ends up flipped exactly when the direction it
                # already has disagrees with what this face's state demands.
                wants_flip = runs_forward(faces[other], a, b) != flipped[current]
                if seen[other]:
                    if flipped[other] != wants_flip:
                        return faces  # Not orientable.
                    continue
                seen[other] = True
                flipped[other] = wants_flip
                component.append(other)
                queue.append(other)

        oriented = [
            tuple(reversed(faces[index])) if flipped[index] else faces[index]
            for index in component
        ]
        if shell_volume(vertices, oriented) < 0.0:
            for index in component:
                flipped[index] = not flipped[index]

    return [
        tuple(reversed(face)) if flip else face
        for face, flip in zip(faces, flipped)
    ]


def refine_triangles(
    points: Sequence[Sequence[float]],
    triangles: Sequence[Tuple[int, int, int]],
    spacing: float,
    sample: Callable[[float, float], Sequence[float]],
) -> Tuple[List[Sequence[float]], List[Tuple[int, int, int]]]:
    """Split every triangle edge longer than *spacing* at its midpoint.

    A prism's caps are triangulated from its outline alone, so across a large
    park the top and bottom are sheets strung between outline vertices.  On a
    hillside they leave the ground by whatever the hill curves in between: a
    wedge that shows as a green step on the slope, or hangs unsupported over
    a hollow.  Refining the triangulation gives the caps interior vertices
    that can be draped exactly like the outline ones.

    Edges are split on their own length rather than per triangle, so the two
    triangles either side of an edge always agree about it and no T-junction
    is created; an outline edge only ever splits into outline edges, so the
    walls a solid raises on single-use edges are unaffected.  *sample* returns
    the payload beyond ``x, y`` (the bottom and top heights) for each new
    vertex.  The returned point list starts with *points* unchanged.
    """
    points = list(points)
    result: List[Tuple[int, int, int]] = []
    if spacing <= 0.0 or not triangles:
        return points, list(triangles)
    spacing_squared = spacing * spacing
    midpoints: Dict[Tuple[int, int], int] = {}

    def split(i: int, j: int) -> int:
        key = (i, j) if i < j else (j, i)
        index = midpoints.get(key)
        if index is None:
            x = (points[i][0] + points[j][0]) * 0.5
            y = (points[i][1] + points[j][1]) * 0.5
            index = len(points)
            points.append((x, y, *sample(x, y)))
            midpoints[key] = index
        return index

    def is_long(i: int, j: int) -> bool:
        dx = points[i][0] - points[j][0]
        dy = points[i][1] - points[j][1]
        return dx * dx + dy * dy > spacing_squared

    work = [tuple(triangle) for triangle in triangles]
    while work:
        a, b, c = work.pop()
        count = int(is_long(a, b)) + int(is_long(b, c)) + int(is_long(c, a))
        if count == 0:
            result.append((a, b, c))
        elif count == 3:
            ab, bc, ca = split(a, b), split(b, c), split(c, a)
            work.extend(((a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)))
        elif count == 1:
            while not is_long(a, b):
                a, b, c = b, c, a
            m = split(a, b)
            work.extend(((a, m, c), (m, b, c)))
        else:
            while is_long(c, a):
                a, b, c = b, c, a
            ab, bc = split(a, b), split(b, c)
            work.extend(((a, ab, c), (ab, b, bc), (ab, bc, c)))
    return points, result


def _unit_normal(a: Point, b: Point) -> Point | None:
    """Return the unit left-hand normal of the directed edge ``a -> b``."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length = math.hypot(dx, dy)
    if length <= 1.0e-12:
        return None
    return (-dy / length, dx / length)


def _arc_points(
    center: Point,
    start_normal: Point,
    end_normal: Point,
    radius: float,
    segments: int,
) -> List[Point]:
    """Return interior arc points sweeping the short way between two normals."""
    start_angle = math.atan2(start_normal[1], start_normal[0])
    end_angle = math.atan2(end_normal[1], end_normal[0])
    delta = end_angle - start_angle
    while delta > math.pi:
        delta -= 2.0 * math.pi
    while delta < -math.pi:
        delta += 2.0 * math.pi
    steps = max(1, int(segments))
    result = []
    for step in range(1, steps):
        angle = start_angle + delta * (step / steps)
        result.append(
            (center[0] + math.cos(angle) * radius, center[1] + math.sin(angle) * radius)
        )
    return result


def _semicircle_points(
    center: Point, start_normal: Point, radius: float, segments: int
) -> List[Point]:
    """Return the interior points of a clockwise half-turn end cap.

    The ribbon is assembled left side first, then the reversed right side, so
    both caps must sweep clockwise.  Choosing the shorter arc instead would
    fold the start cap back through the middle of the road.
    """
    start_angle = math.atan2(start_normal[1], start_normal[0])
    steps = max(2, int(segments))
    result = []
    for step in range(1, steps):
        angle = start_angle - math.pi * (step / steps)
        result.append(
            (center[0] + math.cos(angle) * radius, center[1] + math.sin(angle) * radius)
        )
    return result


def _offset_side(
    points: Sequence[Point],
    radius: float,
    arc_segments: int,
    miter_limit: float,
) -> List[Point]:
    """Offset a polyline to its left by *radius*, rounding outer corners."""
    normals: List[Point] = []
    kept: List[Point] = []
    for index in range(len(points) - 1):
        normal = _unit_normal(points[index], points[index + 1])
        if normal is None:
            continue
        normals.append(normal)
        kept.append(points[index])
    if not normals:
        return []
    kept.append(points[-1])

    result: List[Point] = [
        (kept[0][0] + normals[0][0] * radius, kept[0][1] + normals[0][1] * radius)
    ]
    for index in range(1, len(kept) - 1):
        vertex = kept[index]
        previous_normal = normals[index - 1]
        next_normal = normals[index]
        cross = (
            previous_normal[0] * next_normal[1] - previous_normal[1] * next_normal[0]
        )
        entry = (
            vertex[0] + previous_normal[0] * radius,
            vertex[1] + previous_normal[1] * radius,
        )
        exit_point = (
            vertex[0] + next_normal[0] * radius,
            vertex[1] + next_normal[1] * radius,
        )
        if cross < -1.0e-12:
            # The polyline turns right, so this left side is the outer corner.
            result.append(entry)
            result.extend(
                _arc_points(vertex, previous_normal, next_normal, radius, arc_segments)
            )
            result.append(exit_point)
            continue

        # Inner corner: a miter point is the only join that does not fold back
        # over the ribbon.  Fall back to both offsets on a near reversal.
        bisector_x = previous_normal[0] + next_normal[0]
        bisector_y = previous_normal[1] + next_normal[1]
        length = math.hypot(bisector_x, bisector_y)
        if length <= 1.0e-9:
            result.append(entry)
            result.append(exit_point)
            continue
        bisector = (bisector_x / length, bisector_y / length)
        cosine = bisector[0] * previous_normal[0] + bisector[1] * previous_normal[1]
        if cosine <= 1.0e-6 or (1.0 / cosine) > miter_limit:
            result.append(entry)
            result.append(exit_point)
            continue
        miter = radius / cosine
        result.append(
            (vertex[0] + bisector[0] * miter, vertex[1] + bisector[1] * miter)
        )

    result.append(
        (
            kept[-1][0] + normals[-1][0] * radius,
            kept[-1][1] + normals[-1][1] * radius,
        )
    )
    return result


def buffer_polyline(
    points: Sequence[Point],
    half_width: float,
    arc_segments: int = 4,
    round_caps: bool = True,
    miter_limit: float = 2.5,
    epsilon: float = EPSILON,
) -> List[Point]:
    """Return a closed ring approximating the polyline buffered by *half_width*.

    Round joins and caps are used so that consecutive Overture segments sharing
    a connector visually fuse instead of leaving a notch at every direction
    change.  The result is a counter-clockwise ring, or ``[]`` when the input
    degenerates.
    """
    if len(points) < 2 or half_width <= 0.0:
        return []

    forward = list(points)
    backward = list(reversed(points))
    left = _offset_side(forward, half_width, arc_segments, miter_limit)
    right = _offset_side(backward, half_width, arc_segments, miter_limit)
    if not left or not right:
        return []

    end_normal = _unit_normal(forward[-2], forward[-1])
    start_normal = _unit_normal(backward[-2], backward[-1])

    ring: List[Point] = list(left)
    if round_caps and end_normal is not None:
        ring.extend(
            _semicircle_points(forward[-1], end_normal, half_width, arc_segments)
        )
    ring.extend(right)
    if round_caps and start_normal is not None:
        ring.extend(
            _semicircle_points(forward[0], start_normal, half_width, arc_segments)
        )
    return oriented_ring(ring, counter_clockwise=True, epsilon=epsilon)


def _is_globally_separated(
    points: Sequence[Point], lengths: Sequence[float], half_width: float
) -> bool:
    """Return whether the polyline ever doubles back close to an earlier part.

    A corner test only sees adjacent segments.  A hairpin, a cul-de-sac loop,
    or a centerline that closes on itself brings two *distant* parts of the
    path within a ribbon width of each other, and the two sides of the buffer
    then cross even though every individual corner is gentle.

    Vertices are bucketed into a grid of the search radius, so each one is only
    compared against its immediate neighbourhood rather than the whole line.
    """
    radius = 2.0 * half_width
    if radius <= 0.0:
        return True

    # Distance along the path for each vertex, used to tell a genuine
    # self-approach apart from two vertices that are merely consecutive.
    travelled = [0.0]
    for length in lengths:
        travelled.append(travelled[-1] + length)
    separation = 4.0 * half_width

    buckets: dict = {}
    for index, (x, y) in enumerate(points):
        key = (int(math.floor(x / radius)), int(math.floor(y / radius)))
        buckets.setdefault(key, []).append(index)

    for index, point in enumerate(points):
        key_x = int(math.floor(point[0] / radius))
        key_y = int(math.floor(point[1] / radius))
        for offset_x in (-1, 0, 1):
            for offset_y in (-1, 0, 1):
                for other in buckets.get((key_x + offset_x, key_y + offset_y), ()):
                    if other <= index:
                        continue
                    if abs(travelled[other] - travelled[index]) <= separation:
                        continue
                    if math.dist(point, points[other]) < radius:
                        return False
    return True


def offset_is_safe(points: Sequence[Point], half_width: float) -> bool:
    """Return whether buffering this polyline yields a simple (non-folded) ring.

    At a corner, the inner side of a ribbon cuts back along both adjacent
    segments by ``half_width * tan(turn / 2)``.  When that exceeds the length
    available on either side, the inner boundary folds back through the ribbon
    and the resulting ring self-intersects, which tessellates into overlapping
    triangles and an unprintable, non-manifold cap.

    This is an O(n) test, unlike a general segment-intersection sweep, so it is
    cheap enough to run on every centerline before choosing a strategy.
    """
    if len(points) < 3 or half_width <= 0.0:
        return True
    lengths = [
        math.dist(points[index], points[index + 1]) for index in range(len(points) - 1)
    ]
    if not _is_globally_separated(points, lengths, half_width):
        return False
    for index in range(1, len(points) - 1):
        previous = points[index - 1]
        vertex = points[index]
        following = points[index + 1]
        first = (vertex[0] - previous[0], vertex[1] - previous[1])
        second = (following[0] - vertex[0], following[1] - vertex[1])
        length_a = lengths[index - 1]
        length_b = lengths[index]
        if length_a <= 1.0e-12 or length_b <= 1.0e-12:
            return False
        cosine = (first[0] * second[0] + first[1] * second[1]) / (length_a * length_b)
        cosine = max(-1.0, min(1.0, cosine))
        turn = math.acos(cosine)
        if turn >= math.pi - 1.0e-9:
            return False
        setback = half_width * math.tan(turn * 0.5)
        if setback > min(length_a, length_b) * 0.5:
            return False
    return True


def buffer_polyline_convex_pieces(
    points: Sequence[Point],
    half_width: float,
    arc_segments: int = 4,
    epsilon: float = EPSILON,
) -> List[List[Point]]:
    """Return overlapping convex rings whose union is the buffered polyline.

    This is the fallback for centerlines whose corners are too tight to offset
    into one simple ring.  A rectangle per span plus a disc per vertex can
    never self-intersect individually, so each piece is a valid closed solid
    even though the pieces overlap each other.  Overlapping closed solids are
    printable and can be boolean-unioned later; a folded ring is neither.
    """
    if len(points) < 2 or half_width <= 0.0:
        return []

    pieces: List[List[Point]] = []
    for index in range(len(points) - 1):
        a = points[index]
        b = points[index + 1]
        normal = _unit_normal(a, b)
        if normal is None:
            continue
        offset = (normal[0] * half_width, normal[1] * half_width)
        ring = oriented_ring(
            [
                (a[0] + offset[0], a[1] + offset[1]),
                (b[0] + offset[0], b[1] + offset[1]),
                (b[0] - offset[0], b[1] - offset[1]),
                (a[0] - offset[0], a[1] - offset[1]),
            ],
            counter_clockwise=True,
            epsilon=epsilon,
        )
        if ring:
            pieces.append(ring)

    sides = max(6, int(arc_segments) * 2)
    for point in points:
        ring = oriented_ring(
            [
                (
                    point[0] + math.cos(2.0 * math.pi * step / sides) * half_width,
                    point[1] + math.sin(2.0 * math.pi * step / sides) * half_width,
                )
                for step in range(sides)
            ],
            counter_clockwise=True,
            epsilon=epsilon,
        )
        if ring:
            pieces.append(ring)
    return pieces


def parametric_ribbon(
    points: Sequence[Point],
    half_width: float,
    miter_limit: float = 2.5,
    epsilon: float = EPSILON,
) -> Tuple[List[Point], List[float]]:
    """Return a ribbon ring plus each vertex's normalized centerline position.

    Unlike :func:`buffer_polyline`, every ring vertex keeps a known position
    along the centerline.  Bridge decks need that correspondence because their
    height varies along the span rather than with the ground beneath them.
    """
    from ..data.linework import cumulative_positions, dedupe_points

    clean = dedupe_points(points)
    if len(clean) < 2 or half_width <= 0.0:
        return [], []

    positions = cumulative_positions(clean)
    normals = []
    for index in range(len(clean) - 1):
        normal = _unit_normal(clean[index], clean[index + 1])
        normals.append(normal if normal is not None else (0.0, 1.0))

    def side(sign: float) -> List[Point]:
        offsets: List[Point] = []
        for index, vertex in enumerate(clean):
            if index == 0:
                normal = normals[0]
            elif index == len(clean) - 1:
                normal = normals[-1]
            else:
                previous_normal = normals[index - 1]
                next_normal = normals[index]
                bisector_x = previous_normal[0] + next_normal[0]
                bisector_y = previous_normal[1] + next_normal[1]
                length = math.hypot(bisector_x, bisector_y)
                if length <= 1.0e-9:
                    normal = next_normal
                else:
                    bisector = (bisector_x / length, bisector_y / length)
                    cosine = (
                        bisector[0] * previous_normal[0]
                        + bisector[1] * previous_normal[1]
                    )
                    scale = 1.0 / cosine if cosine > 1.0e-6 else miter_limit
                    scale = min(scale, miter_limit)
                    normal = (bisector[0] * scale, bisector[1] * scale)
            offsets.append(
                (
                    vertex[0] + normal[0] * half_width * sign,
                    vertex[1] + normal[1] * half_width * sign,
                )
            )
        return offsets

    left = side(1.0)
    right = side(-1.0)
    ring = left + list(reversed(right))
    parameters = list(positions) + list(reversed(positions))

    # Keep ring and parameter lists index-aligned through cleaning.  The
    # tolerance must be the one that matters in the frame these coordinates are
    # expressed in, because vertices closer than that collapse in float32 and
    # would leave degenerate triangles in the deck cap.
    merged = []
    for point, parameter in zip(ring, parameters):
        if merged and math.dist(point, merged[-1][0]) <= epsilon:
            continue
        merged.append((point, parameter))
    if len(merged) > 1 and math.dist(merged[0][0], merged[-1][0]) <= epsilon:
        merged.pop()
    if len(merged) < 3:
        return [], []
    cleaned_ring = [item[0] for item in merged]
    if signed_area(cleaned_ring) < 0.0:
        merged.reverse()
    return [item[0] for item in merged], [item[1] for item in merged]
