"""Error-bounded edge collapse for a triangulated height raster.

A raster cap costs one face per cell and draws every wall as a staircase of
cells. Collapsing edges by quadric error (Garland & Heckbert) merges a flat
roof into a few faces and a run of stairs into one straight facet, so a curved
tower comes out faceted but coherent, like a decimated survey model.

The error of a collapse is measured against the faces as they are now, not
the original ones (Lindstrom & Turk's memoryless variant). With accumulated
quadrics a straight facet remembers every stair it replaced and its cost grows
with the cube of the stairs it spans, so walls stop merging at a few metres
however loose the threshold; measured locally, extending a straight facet
costs nothing and a real feature still costs its full height.

The cap has to stay a height field so its outline walls can be built: a
collapse never flips a face in plan or leaves one thinner than `MIN_GAP`
(a sliver that thin is float32 noise once printed, and folds when a corner
is later snapped to the outline), never puts two vertices within `MIN_GAP`
of each other in plan (Blender welds by float32 XY), and never moves a
vertex on the mesh rim. Plain Python inside the loop: the per-edge work is
a handful of floats and numpy's per-call overhead dominates it. No Blender
or GIS dependencies.
"""
import heapq
import math

import numpy as np

MIN_GAP = .01


def _plane(p, q, r):
    """Unit normal and offset of a triangle's plane, or None if degenerate."""
    ux, uy, uz = q[0]-p[0], q[1]-p[1], q[2]-p[2]
    vx, vy, vz = r[0]-p[0], r[1]-p[1], r[2]-p[2]
    nx, ny, nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
    length = math.sqrt(nx*nx+ny*ny+nz*nz)
    if not length:
        return None
    nx, ny, nz = nx/length, ny/length, nz/length
    return nx, ny, nz, -(nx*p[0]+ny*p[1]+nz*p[2])


def _quadric(planes):
    """Sum of the plane quadrics, as the 10 unique entries of the 4x4 matrix."""
    q = [0.]*10
    for a, b, c, d in planes:
        q[0] += a*a; q[1] += a*b; q[2] += a*c; q[3] += a*d
        q[4] += b*b; q[5] += b*c; q[6] += b*d
        q[7] += c*c; q[8] += c*d; q[9] += d*d
    return q


def _error(q, x, y, z):
    return (q[0]*x*x+q[4]*y*y+q[7]*z*z+2*(q[1]*x*y+q[2]*x*z+q[5]*y*z+q[3]*x+q[6]*y+q[8]*z)+q[9])


def _optimum(q):
    """The point minimising the quadric, or None when the planes do not fix one."""
    a, b, c, d, e, f, g, h, i = q[0], q[1], q[2], q[4], q[5], q[7], q[3], q[6], q[8]
    det = a*(d*f-e*e)-b*(b*f-c*e)+c*(b*e-c*d)
    trace = (a+d+f)/3
    if trace <= 0 or det <= 1e-6*trace*trace*trace:
        return None
    x = -(g*(d*f-e*e)-b*(h*f-e*i)+c*(h*e-d*i))/det
    y = -(a*(h*f-e*i)-g*(b*f-c*e)+c*(b*i-h*c))/det
    z = -(a*(d*i-e*h)-b*(b*i-c*h)+g*(b*e-c*d))/det
    return x, y, z


def collapse(vertices, faces, threshold, budget, deviation=math.inf):
    """Return (vertices, faces) with every edge under `threshold` collapsed.

    Beyond the threshold, the cheapest edges keep collapsing while the face
    count exceeds `budget`. A merged vertex never sits further than
    `deviation` from any face it replaces: the quadric sum is small for a
    corner of a small plant room whose top has already merged into one face,
    so without this bound such a feature is lowered step by step until it
    is gone. `vertices` is an Nx3 array in metres, `faces` an Mx3 array of
    counter-clockwise triangles in plan.
    """
    V = [tuple(map(float, v)) for v in np.asarray(vertices, dtype=float)]
    F = [list(map(int, f)) for f in np.asarray(faces, dtype=np.int64)]
    alive = [True]*len(F)
    vf = [set() for _ in V]
    for index, face in enumerate(F):
        for v in face:
            vf[v].add(index)
    pairs = np.sort(np.concatenate([np.asarray(faces)[:, k] for k in ((0, 1), (1, 2), (2, 0))]), axis=1)
    unique, counts = np.unique(pairs, axis=0, return_counts=True)
    pinned = set(map(int, unique[counts == 1].ravel()))
    version = [0]*len(V)
    heap = []

    def neighbours(v):
        return {u for index in vf[v] for u in F[index]}-{v}

    def push(a, b):
        if a > b:
            a, b = b, a
        pin_a, pin_b = a in pinned, b in pinned
        if pin_a and pin_b:
            return
        planes = [p for p in (_plane(*(V[v] for v in F[index])) for index in vf[a] | vf[b]) if p]
        q = _quadric(planes)
        pa, pb = V[a], V[b]
        if pin_a:
            candidates = [pa]
        elif pin_b:
            candidates = [pb]
        else:
            mid = ((pa[0]+pb[0])/2, (pa[1]+pb[1])/2, (pa[2]+pb[2])/2)
            candidates = [pa, pb, mid]
            best = _optimum(q)
            if best is not None and math.dist(best, mid) <= 2*math.dist(pa, pb)+1.:
                candidates.append(best)
        for cost, position in sorted((max(_error(q, *c), 0.), c) for c in candidates):
            if all(abs(nx*position[0]+ny*position[1]+nz*position[2]+d) <= deviation
                   for nx, ny, nz, d in planes):
                heapq.heappush(heap, (cost, (pa[0]-pb[0])**2+(pa[1]-pb[1])**2+(pa[2]-pb[2])**2,
                                      a, b, version[a], version[b], position))
                return

    for a, b in unique:
        push(int(a), int(b))
    count = len(F)

    def folds(index, a, b, position):
        p, q, r = (position if v in (a, b) else V[v] for v in F[index])
        cross = (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0])
        # Twice the plan area over the longest edge is the least altitude.
        longest = max((q[0]-p[0])**2+(q[1]-p[1])**2, (r[0]-q[0])**2+(r[1]-q[1])**2,
                      (p[0]-r[0])**2+(p[1]-r[1])**2)
        return cross <= MIN_GAP*math.sqrt(longest)

    while heap and (count > budget or heap[0][0] <= threshold):
        _cost, _length, a, b, seen_a, seen_b, position = heapq.heappop(heap)
        if version[a] != seen_a or version[b] != seen_b:
            continue
        shared = vf[a] & vf[b]
        # Link condition: the only common neighbours are the apexes of the
        # faces on this edge, so the collapse cannot pinch the cap.
        if (neighbours(a) & neighbours(b)) != {v for index in shared for v in F[index]}-{a, b}:
            continue
        if any(folds(index, a, b, position) for index in (vf[a] | vf[b])-shared):
            continue
        if any((V[u][0]-position[0])**2+(V[u][1]-position[1])**2 < MIN_GAP*MIN_GAP
               for u in (neighbours(a) | neighbours(b))-{a, b}):
            continue
        V[a] = position
        for index in shared:
            alive[index] = False
            count -= 1
            for v in F[index]:
                vf[v].discard(index)
        for index in list(vf[b]):
            F[index][F[index].index(b)] = a
            vf[a].add(index)
        vf[b] = set()
        version[a] += 1
        version[b] = -1
        if b in pinned:
            pinned.add(a)
        for u in neighbours(a):
            push(a, u)
    kept = np.array([f for f, ok in zip(F, alive) if ok], dtype=np.int64).reshape(-1, 3)
    used, inverse = np.unique(kept.ravel(), return_inverse=True)
    return np.array([V[i] for i in used], dtype=float).reshape(-1, 3), inverse.reshape(kept.shape)
