"""Low-poly tree solids and canopy clearance, independent of Blender."""

from __future__ import annotations

import math


def tree_solid_geometry(canopy_radius_mm, height_mm, sides=6, embed_mm=0.0):
    """Return one closed three-tier crown with a broad terrain-facing base.

    Each outward flare rises at least as far as it extends horizontally, so
    there are no flat canopy undersides or disconnected/intersecting cones.
    Very squat custom dimensions soften the tiers instead of adding height.
    """
    sides = max(3, int(sides))
    radius, height = canopy_radius_mm, height_mm
    profile = [
        [radius, 0.0],
        [0.58 * radius, 0.36 * height],
        [0.78 * radius, 0.45 * height],
        [0.33 * radius, 0.69 * height],
        [0.49 * radius, 0.77 * height],
    ]
    # Enforce a 45-degree maximum outward slope, including unusual user sizes.
    for lower, upper in zip(reversed(profile[:-1]), reversed(profile[1:])):
        lower[0] = max(lower[0], upper[0] - (upper[1] - lower[1]))
    if embed_mm > 0:
        profile.insert(0, [radius, -embed_mm])
    vertices = [(math.cos(math.tau * i / sides) * r,
                 math.sin(math.tau * i / sides) * r, z)
                for r, z in profile for i in range(sides)]
    faces = [tuple(reversed(range(sides)))]
    for ring in range(len(profile) - 1):
        bottom, top = ring * sides, (ring + 1) * sides
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((bottom + i, bottom + j, top + j, top + i))
    apex = len(vertices)
    vertices.append((0.0, 0.0, height))
    top = (len(profile) - 1) * sides
    faces.extend((top + i, top + (i + 1) % sides, apex) for i in range(sides))
    return vertices, faces


class TreeClearance:
    """Accept trees only when their finished crowns have room, across sources.

    Circumradii keep differently rotated low-poly crowns apart. A spatial hash
    bounds each lookup to nearby cells instead of comparing every tree pair.
    """

    def __init__(self, maximum_radius, gap):
        self.gap = max(0.0, gap)
        self.cell_size = max(2 * maximum_radius + self.gap, 1.0e-6)
        self.cells = {}

    def accept(self, x, y, radius):
        column, row = math.floor(x / self.cell_size), math.floor(y / self.cell_size)
        for cx in range(column - 1, column + 2):
            for cy in range(row - 1, row + 2):
                for px, py, pr in self.cells.get((cx, cy), ()):
                    if (x - px)**2 + (y - py)**2 < (radius + pr + self.gap)**2:
                        return False
        self.cells.setdefault((column, row), []).append((x, y, radius))
        return True


def tree_base_width(points):
    """Minimum caliper width of a remaining base's convex hull, in print mm."""
    from .footprint_cut import _hull
    ring = _hull(points)
    if len(ring) < 3:
        return 0.0
    width = math.inf
    for a, b in zip(ring, ring[1:] + ring[:1]):
        dx, dy = b[0]-a[0], b[1]-a[1]
        values = [(dx*(p[1]-a[1])-dy*(p[0]-a[0])) / math.hypot(dx, dy) for p in ring]
        width = min(width, max(values)-min(values))
    return width


def merge_convex_footprints(rings):
    """Coalesce overlapping cutters only when their exact union stays convex.

    Buffered cap triangles often describe just one straight road. Consolidating
    those triangles avoids expensive coplanar self-intersections in 3D without
    filling concave corners or spanning gaps between independent roads.
    """
    from .footprint_cut import FootprintIndex, _bounds, _hull, _overlap, area_xy
    result = []
    for ring in rings:
        index = 0
        while index < len(result):
            other = result[index]
            if _overlap(_bounds(ring), _bounds(other)):
                hull = _hull([tuple(p[:2]) for p in ring + other])
                mask = FootprintIndex(clearance=0)
                mask.add(ring)
                union_area = area_xy(ring) + sum(area_xy(p) for p in mask.difference(other))
                if abs(area_xy(hull)-union_area) <= 1e-9:
                    ring = hull
                    result.pop(index)
                    index = 0
                    continue
            index += 1
        result.append(ring)
    return result
