"""Pure, station-preserving mesh construction for simple bridge ribbons."""

from .deck_profile import interpolate_profile
from .planar import parametric_ribbon
from ..data.linework import cumulative_positions


def deck_strip_geometry(points, half_width, heights, thickness):
    """Return a closed ribbon with a cross-section at every profile station.

    Whole-outline tessellation can skip intermediate heights on either side,
    cutting diagonally through a crest. Pairing the two banks at each station
    constrains every top triangle to a single profile interval. The caller
    checks offset safety and retains its convex-piece fallback if cleaning
    collapses a station or a strip folds.
    """
    ring, parameters = parametric_ribbon(points, half_width)
    if not ring:
        return [], []
    stations = {}
    for index, parameter in enumerate(parameters):
        stations.setdefault(parameter, []).append(index)
    pairs = [stations[t] for t in sorted(stations)]
    if len(pairs) < 2 or any(len(pair) != 2 for pair in pairs):
        return [], []
    # The ring walks one bank forward and the other backward.
    pairs = [sorted(pair) for pair in pairs]
    positions = cumulative_positions(points)
    vertices = []
    for (x, y), t in zip(ring, parameters):
        top = interpolate_profile(positions, heights, t)
        vertices.extend(((x, y, top - thickness), (x, y, top)))
    faces = []
    for (a, b), (c, d) in zip(pairs, pairs[1:]):
        triangles = [(a, c, d), (a, d, b)]
        areas = []
        for i, j, k in triangles:
            p, q, r = ring[i], ring[j], ring[k]
            areas.append((q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0]))
        if areas[0] * areas[1] <= 0 or min(map(abs, areas)) <= 1e-12:
            return [], []
        for triangle, area in zip(triangles, areas):
            if area < 0:
                triangle = tuple(reversed(triangle))
            faces.append(tuple(2*i+1 for i in triangle))
            faces.append(tuple(2*i for i in reversed(triangle)))
    for a in range(len(ring)):
        b = (a + 1) % len(ring)
        faces.append((2*a, 2*b, 2*b+1, 2*a+1))
    return vertices, faces
