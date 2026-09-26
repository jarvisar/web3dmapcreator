"""Printability of adjoining source parts, without changing their meshes."""

import math
from collections import defaultdict

from ..data.geojson import feature_id, feature_properties
from .buildings import resolve_vertical_profile
from .planar import EPSILON, effective_width, polygon_area, ring_bounds, signed_area


def _edges(rings):
    for index, ring in enumerate(rings):
        # Solid is on the left, including around courtyard boundaries.
        points = list(ring)
        if (signed_area(points) > 0) != (index == 0):
            points.reverse()
        yield from zip(points, points[1:] + points[:1])


def _shared_wall(first, second):
    """Length of opposing collinear edges; point contacts do not support."""
    total = 0.0
    for a, b in first:
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length <= EPSILON:
            continue
        ux, uy = dx / length, dy / length
        for c, d in second:
            if dx * (d[0] - c[0]) + dy * (d[1] - c[1]) >= 0:
                continue
            if any(abs(ux * (p[1] - a[1]) - uy * (p[0] - a[0])) > EPSILON
                   for p in (c, d)):
                continue
            start, end = sorted(ux * (p[0] - a[0]) + uy * (p[1] - a[1]) for p in (c, d))
            total += max(0.0, min(length, end) - max(0.0, start))
    return total


def adjoining_part_widths(masses, minimum_width=0.08, maximum_slenderness=30.0):
    """Return filter widths for (polygon rings, bottom mm, top mm) masses.

    Adjacent partitions with a common base and modest height steps form one
    mass for width filtering. Its area/perimeter excludes internal walls but
    includes holes. Actual footprints, roofs and independent shells stay intact.
    Only shared walls count: gaps, point contacts and overlapping duplicate
    outlines cannot inflate support. An elevated facade cannot borrow support
    from a ground-founded sibling. A thin section extending far above its
    neighbor still has to pass the original slenderness rule on that extension.
    """
    widths = [effective_width(rings[0]) for rings, _, _ in masses]
    edges = [list(_edges(rings)) for rings, _, _ in masses]
    boxes = [ring_bounds(rings[0]) for rings, _, _ in masses]
    groups = list(range(len(masses)))
    contacts = []

    def root(i):
        while groups[i] != i:
            groups[i] = groups[groups[i]]
            i = groups[i]
        return i

    for i, (_, bottom, top) in enumerate(masses):
        for j in range(i):
            _, other_bottom, other_top = masses[j]
            if abs(bottom - other_bottom) > EPSILON:
                continue
            a, b = boxes[i], boxes[j]
            if (a[0] > b[2] + EPSILON or b[0] > a[2] + EPSILON
                    or a[1] > b[3] + EPSILON or b[1] > a[3] + EPSILON):
                continue
            contact = _shared_wall(edges[i], edges[j])
            if contact <= max(EPSILON, minimum_width):
                continue
            contacts.append((i, j, contact))
            taller_width = widths[i if top >= other_top else j]
            step = abs(top - other_top)
            # Tiny seams may retain a small roof step, never a long thin tip.
            if taller_width < minimum_width and step > minimum_width + EPSILON:
                continue
            if maximum_slenderness > 0 and step > taller_width * maximum_slenderness + EPSILON:
                continue
            groups[root(i)] = root(j)

    members = defaultdict(list)
    for i in range(len(masses)):
        members[root(i)].append(i)
    internal = defaultdict(float)
    for i, j, length in contacts:
        if root(i) == root(j):
            internal[root(i)] += 2 * length
    result = list(widths)
    for group, indices in members.items():
        if len(indices) < 2:
            continue
        area = sum(polygon_area(rings) for rings, _, _ in (masses[i] for i in indices))
        perimeter = sum(math.dist(a, b) for i in indices for a, b in edges[i]) - internal[group]
        if area <= 0 or perimeter <= EPSILON:
            continue
        width = 2 * area / perimeter
        for i in indices:
            result[i] = max(widths[i], width)
    return result


def source_part_widths(parts, project, vertical, floor_height, default_height,
                       minimum_width, maximum_slenderness):
    """Map selected (source ID, polygon index) to a sibling-aware filter width."""
    groups = defaultdict(list)
    for part in parts:
        props = feature_properties(part)
        parent = str(props.get('building_id') or '')
        profile = resolve_vertical_profile(props, floor_height, default_height)
        if not parent or profile.thickness_m <= 0 or props.get('is_underground') is True:
            continue
        for index, rings in enumerate(project(part.get('geometry') or {})):
            groups[parent].append(((feature_id(part), index),
                (rings, vertical(profile.bottom_m), vertical(profile.top_m))))
    result = {}
    for members in groups.values():
        widths = adjoining_part_widths([mass for _, mass in members], minimum_width, maximum_slenderness)
        result.update((key, width) for (key, _), width in zip(members, widths))
    return result
