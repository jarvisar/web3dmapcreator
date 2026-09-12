"""Join one measured height surface into a solid; no Blender dependencies.

Only faces of this single building's continuous roof are joined. Adjacent
buildings and unrelated solids must remain separate, as with MeshBuilder.
"""
import math
import struct
from collections import Counter, defaultdict

from .planar import ear_clip, faces_are_consistent, signed_area


def _float32(value):
    return struct.unpack('f', struct.pack('f', value))[0]


def envelope_solid(polygons, bottom, outlines):
    """Return indexed roof, underside and exterior walls, or None on conflict.

    Polygons are simple planar XYZ rings already clipped to the output frame.
    Match Blender's XY precision before constructing adjacency. A cap's shared
    edges have no internal walls; clipping-induced edge splits are conformed
    before closure, winding, area, and exterior-boundary checks.
    """
    if not math.isfinite(bottom):
        return None
    vertices, lookup, triangles = [], {}, []
    for polygon in polygons:
        ids = []
        for x, y, z in polygon:
            if not all(map(math.isfinite, (x, y, z))):
                return None
            xy = (_float32(x), _float32(y))
            if xy in lookup:
                index = lookup[xy]
                if abs(vertices[index][2]-z) > .002:
                    return None
            else:
                index = lookup[xy] = len(vertices)
                vertices.append((*xy, z))
            if not ids or ids[-1] != index:
                ids.append(index)
        if len(ids) > 1 and ids[-1] == ids[0]:
            ids.pop()
        if len(set(ids)) < 3:
            continue
        local = [vertices[i] for i in ids]
        for triangle in ear_clip(local):
            indices = tuple(ids[i] for i in triangle)
            a, b, c = (vertices[i] for i in indices)
            cross = (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
            if cross > 0:
                triangles.append(indices)
    if not triangles or any(v[2] <= bottom for v in vertices):
        return None

    def boundaries(faces):
        uses = Counter(tuple(sorted((face[i], face[(i+1)%3]))) for face in faces for i in range(3))
        if max(uses.values(), default=0) > 2:
            return None
        return [(j, a, b) for j, face in enumerate(faces)
                for a, b in zip(face, (*face[1:], face[0])) if uses[tuple(sorted((a, b)))] == 1]

    boundary = boundaries(triangles)
    if boundary is None:
        return None
    span = max(max(v[axis] for v in vertices)-min(v[axis] for v in vertices) for axis in (0, 1))
    pitch = max(span/64, .001)
    buckets = defaultdict(list)
    for index in sorted({i for _, a, b in boundary for i in (a, b)}):
        x, y, _ = vertices[index]
        buckets[(math.floor(x/pitch), math.floor(y/pitch))].append(index)
    # Float32 clipping intersections can land a few microns from an edge.
    epsilon = max(1e-6, max(abs(v[a]) for v in vertices for a in (0, 1))*2e-7)
    splits = {}
    for face, a, b in boundary:
        ax, ay, az = vertices[a]; bx, by, bz = vertices[b]
        length2 = (bx-ax)**2+(by-ay)**2
        if length2 <= epsilon**2:
            continue
        candidates = [i for x in range(math.floor((min(ax, bx)-epsilon)/pitch), math.floor((max(ax, bx)+epsilon)/pitch)+1)
                        for y in range(math.floor((min(ay, by)-epsilon)/pitch), math.floor((max(ay, by)+epsilon)/pitch)+1)
                        for i in buckets.get((x, y), ()) if i not in (a, b)]
        chain = []
        # A vertex within rounding distance of this edge's own endpoint is that
        # endpoint, not a T-junction. Splitting there would fan the face around
        # a degenerate sliver and leave three faces on one edge.
        margin = epsilon/math.sqrt(length2)
        for index in candidates:
            x, y, z = vertices[index]
            t = ((x-ax)*(bx-ax)+(y-ay)*(by-ay))/length2
            if (margin < t < 1-margin and math.hypot(x-(ax+t*(bx-ax)), y-(ay+t*(by-ay))) <= epsilon
                    and abs(z-(az+t*(bz-az))) < .002):
                chain.append((t, index))
        if chain:
            splits[(a, b)] = [i for _, i in sorted(chain)]
    if splits:
        conformed = []
        for triangle in triangles:
            ring = []
            for a, b in zip(triangle, (*triangle[1:], triangle[0])):
                ring.extend([a, *splits.get((a, b), ())])
            if len(ring) == 3:
                conformed.append(triangle)
                continue
            center = tuple(sum(vertices[i][axis] for i in triangle)/3 for axis in range(3))
            middle = len(vertices); vertices.append(center)
            conformed.extend((a, b, middle) for a, b in zip(ring, (*ring[1:], ring[0])))
        triangles = conformed
        boundary = boundaries(triangles)
        if boundary is None:
            return None

    # Open cap edges must lie on an actual outline/courtyard or output crop,
    # never on a missing interior triangle that would create an internal wall.
    outline_edges = [(a, b) for rings in outlines for ring in rings
                     for a, b in zip(ring, (*ring[1:], ring[0]))]
    def on_outline(point):
        x, y = point
        for a, b in outline_edges:
            length2 = (b[0]-a[0])**2+(b[1]-a[1])**2
            if not length2:
                continue
            t = max(0., min(1., ((x-a[0])*(b[0]-a[0])+(y-a[1])*(b[1]-a[1]))/length2))
            if math.hypot(x-a[0]-t*(b[0]-a[0]), y-a[1]-t*(b[1]-a[1])) <= epsilon*3:
                return True
        return False
    if any(not on_outline(((vertices[a][0]+vertices[b][0])/2,
                           (vertices[a][1]+vertices[b][1])/2)) for _, a, b in boundary):
        return None
    # Point-touching loops are a pinched vertex, not a printable closed shell.
    if (any(n != 1 for n in Counter(a for _, a, _ in boundary).values()) or
            any(n != 1 for n in Counter(b for _, _, b in boundary).values())):
        return None
    expected = sum(abs(signed_area(rings[0]))-sum(abs(signed_area(r)) for r in rings[1:]) for rings in outlines)
    area = sum(abs(signed_area([vertices[i][:2] for i in triangle])) for triangle in triangles)
    if abs(area-expected) > max(1e-5, expected*1e-5):
        return None
    count = len(vertices)
    solid = vertices + [(x, y, bottom) for x, y, _ in vertices]
    faces = list(triangles) + [tuple(i+count for i in reversed(t)) for t in triangles]
    faces += [(b, a, a+count, b+count) for _, a, b in boundary]
    return (solid, faces) if faces_are_consistent(faces) else None
