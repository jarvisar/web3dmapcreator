"""A robust upper-surface raster over LiDAR returns, collapsed and clipped to mapped footprints.

Coverage and ground checks run upstream. The upper surface is the
second-highest return in each print-scale cell, a moving median over a disc of cells, and a
light mean over observed cells away from walls; unobserved cells copy their
nearest observed neighbour. That raster, triangulated on its own grid, is a
faithful but wasteful surface: a face per cell, and every wall a staircase of
cells, because a step can only fall between nodes. Relief along a steep face
narrower than a nozzle once printed (piers, fins) is straightened first,
where no height level moves more than a small printed reach. An error-bounded edge
collapse (`lidar_simplify`) then merges a flat roof into a few faces and a run
of stairs into one straight facet, so a tower comes out as large flat walls, a
curved face as a coherent fan of facets and a flared base as a smooth slope,
while real steps, setbacks and rooftop plant above the tolerance survive. The
collapsed faces are clipped to the footprint, so the cap covers the outline
exactly. Nothing detects tiers, setbacks or architecture: the returns alone
say where the walls are. Native dependencies stay in the preparation worker.
"""
import math
import warnings

import numpy as np
import shapely
from shapely import contains_xy
from shapely.affinity import rotate
from shapely.errors import GEOSException
from shapely.geometry import Polygon
from shapely.ops import nearest_points, unary_union

try:
    from .lidar_facets import UnsupportedFit, pieces
    from .lidar_records import ENVELOPE_FACETS_AT_1M, MAX_ENVELOPE_FACETS
    from .lidar_simplify import MIN_GAP, collapse
except ImportError:
    from lidar_facets import UnsupportedFit, pieces
    from lidar_records import ENVELOPE_FACETS_AT_1M, MAX_ENVELOPE_FACETS
    from lidar_simplify import MIN_GAP, collapse

CROSS = ((-1, 0), (1, 0), (0, -1), (0, 1))
# Each cell's height before the rank filter: its second-highest return.
UPPER_RANK = 2
# The quantile of a scan shadow's cells that its pooled height takes.
UPPER_QUANTILE = .9
MIN_VOTES = 4
# Collapse error, in cells squared, under which an edge is always merged; see
# `_surfaces`. Calibrated on Chicago towers at a 0.5 m grid: 8 m² there gives
# 4–5 m facets on a curved face (the reference model has about 5 m) and keeps
# rooftop plant over about a metre tall.
COLLAPSE_TOLERANCE = 32.
# A collapsed vertex may leave the faces it replaces by this many cells, and a
# mass counts as slender up to three times that across; see `_spires`.
DEVIATION_CELLS = 2
SPIRE_SHARE = .8
# Printed lengths of `_fair`: relief along a steep face narrower than half the
# window (0.3 mm, under a nozzle's width) is straightened where no height level
# moves further than the reach.
FAIR_WINDOW_MM = .6
FAIR_REACH_MM = .14


def envelope_parameters(scale, density=None):
    """Raster pitch, rank window and secondary admission band.

    Every value is a printed length converted back to ground distance, so a
    coarser or finer output scale moves them together and no length is tied to
    any particular survey, city or building.

    The pitch follows the print scale (0.035 mm, half a printed layer) down
    to 0.8 m. With a known return `density` (per m²) it may go finer, to
    0.5 m, while a cell still averages about one return: the collapse makes
    faces cheap, so the grid keeps the detail the survey measured and a
    sparse survey is never gridded finer than it can support.

    The band (0.28 mm printed, never under 3 m) is a layer and a half: a
    vegetation return that far above the structural envelope is canopy, and a
    slender mass that far above its surroundings is a tower; see `_spires`.
    """
    if len(scale) != 2 or not all(math.isfinite(s) and s > 0 for s in scale):
        raise ValueError('Invalid LiDAR reconstruction scale')
    floor = .8
    if density is not None and math.isfinite(density) and density > 0:
        floor = min(floor, max(.5, 1/math.sqrt(density)))
    pitch = min(3., max(floor, .035/scale[0]))
    return pitch, pitch*2, max(3., .28/scale[0])


def facet_budget(pitch):
    """Faces one cap may use: the 1 m budget, grown with a finer grid."""
    return min(MAX_ENVELOPE_FACETS, int(ENVELOPE_FACETS_AT_1M/min(1., pitch)**2))


def _disc(radius, pitch):
    reach = int(round(radius/pitch))
    return [(dx, dy) for dx in range(-reach, reach+1) for dy in range(-reach, reach+1)
            if dx*dx+dy*dy <= reach*reach+1e-9]


def _stack(data, offsets):
    return np.stack([np.roll(data, offset, axis=(0, 1)) for offset in offsets])


class _Raster:
    """A padded cell grid covering one footprint component."""

    def __init__(self, bounds, pitch, reach):
        margin = int(math.ceil(reach/pitch))+2
        self.pitch = pitch
        self.x0 = bounds[0]-margin*pitch
        self.y0 = bounds[1]-margin*pitch
        self.nx = int(math.ceil((bounds[2]-self.x0)/pitch))+margin+1
        self.ny = int(math.ceil((bounds[3]-self.y0)/pitch))+margin+1

    def cells(self, xy):
        return (np.clip(np.round((xy[:, 0]-self.x0)/self.pitch).astype(np.int64), 0, self.nx-1),
                np.clip(np.round((xy[:, 1]-self.y0)/self.pitch).astype(np.int64), 0, self.ny-1))

    def upper(self, samples, rank=1):
        """The `rank`-th highest return in each cell, or its lowest if it holds fewer.

        Returns are not filtered before this. A cell beside a facade holds
        returns from the whole height of the wall, and its top is near the
        roof edge, so the roof reaches at most one cell past its true edge;
        the median and the collapse below deal with everything else. Dropping
        returns by any rule about their neighbours (a "shadow" test) removed
        sloping facades and stepped roofs along with the noise and kept a
        fifth of some towers' returns. The plain maximum is the outer skin
        but the noisiest estimator: one stray return sets it. The second
        highest ignores that return and, unlike a quantile, how many returns
        lie below it: a facade cell holds hundreds of the wall's, and its
        90th percentile sat a tenth of the way down the wall, which hung
        roof edges down it in teeth. The two agree up to eleven returns.
        """
        grid = np.full((self.nx, self.ny), -np.inf)
        if not len(samples):
            return grid
        values = samples[:, 2]
        ix, iy = self.cells(samples)
        if rank <= 1:
            np.maximum.at(grid, (ix, iy), values)
            return grid
        keys = ix*self.ny+iy
        order = np.lexsort((values, keys))
        ordered = keys[order]
        starts = np.flatnonzero(np.concatenate(([True], ordered[1:] != ordered[:-1])))
        counts = np.diff(np.concatenate((starts, [len(ordered)])))
        picked = starts+np.maximum(counts-rank, 0)
        grid.reshape(-1)[ordered[starts]] = values[order][picked]
        return grid

    def corners(self):
        x = np.arange(self.nx)*self.pitch+self.x0
        y = np.arange(self.ny)*self.pitch+self.y0
        return np.meshgrid(x, y, indexing='ij')


def _spires(heights, rise):
    """Cells of slender masses standing free: `rise` above most of a ring around them.

    The collapse lets a wall wander two cells at every merge. A broad mass
    never shows that; a tower a few cells across is folded into the towers
    beside it, and a castle comes out as one slanted blade. A tower, a
    steeple or a chimney clears nearly the whole ring. A bay or a fin
    attached to a larger mass clears half of it and a square corner three
    quarters, so walls and corners are never marked, and a cap without such
    a mass is collapsed exactly as before.
    """
    reach = 3*DEVIATION_CELLS
    ring = [(dx, dy) for dx in range(-reach-1, reach+2) for dy in range(-reach-1, reach+2)
            if (reach-.5)**2 <= dx*dx+dy*dy < (reach+.5)**2]
    span = reach+1
    nx, ny = heights.shape
    padded = np.pad(heights, span, mode='edge')
    below = np.zeros(heights.shape, dtype=np.int32)
    for dx, dy in ring:
        below += padded[span+dx:span+dx+nx, span+dy:span+dy+ny] < heights-rise
    return below >= SPIRE_SHARE*len(ring)


def _fair(heights, pitch, window, reach, spires):
    """Straighten relief along steep faces narrower than half `window`, within `reach`.

    Piers, fins and mullions a metre or two proud of a tower's face are far
    under a nozzle's width once printed, but the collapse keeps any relief
    over its deviation bound, and where it tapers up a curved face it leaves
    long slivers, creases down the whole facade (Chase Tower). Along a face
    the heights rise monotonically across it, so the median of the heights
    on a line along the face is the median of the face's position at every
    height: it straightens the face without mixing heights across it, and
    keeps steps and square corners exactly. Each steep cell takes the line
    whose heights vary least over the window, which is the one along its
    face, and only where the face is straight along it and goes on past
    both ends of it. A change is kept only where every height level moves
    by at most `reach` in plan, both ways, so a mass the median would erase
    (a plant room, a fin, a turret) stays whole. Cells within half a window
    of a spire are left alone: a turret's flank is a face curved too
    tightly for a straight line.
    """
    half = max(1, int(round(window/pitch/2)))
    offsets = _disc(reach, pitch)
    span = half+max(max(abs(dx), abs(dy)) for dx, dy in offsets)+1
    nx, ny = heights.shape
    padded = np.pad(heights, span, mode='edge')

    def shifted(data, dx, dy):
        return data[span+dx:span+dx+nx, span+dy:span+dy+ny]

    # Over four cells, so that noise on a gentle roof never reads as a face.
    slope = np.hypot(shifted(padded, 2, 0)-shifted(padded, -2, 0),
                     shifted(padded, 0, 2)-shifted(padded, 0, -2))/(4*pitch)
    # Half a cell of plan position, in height on this face.
    tolerance = slope*pitch/2
    # Within half the reach of a steep cell: at a pier's toe the face it
    # stands on has not started to rise yet, a metre further in.
    steep = np.pad(slope >= 1, span, mode='constant')
    steep = np.pad(np.logical_or.reduce([shifted(steep, dx, dy) for dx, dy in _disc(reach/2, pitch)]),
                   span, mode='constant')
    least = np.full(heights.shape, np.inf)
    straight, level = heights, np.zeros(heights.shape, dtype=bool)
    for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
        steps = half if not (dx and dy) else max(1, int(round(half/math.sqrt(2))))
        line = np.stack([shifted(padded, k*dx, k*dy) for k in range(-steps, steps+1)])
        spread = line.max(axis=0)-line.min(axis=0)
        middle = np.median(line, axis=0)
        along = spread < least
        least = np.where(along, spread, least)
        straight = np.where(along, middle, straight)
        # Most of the line lies on one straight face: the relief is narrow.
        # A face curved tighter than the window, or crossing the line at an
        # angle, drifts away from the median along it and is left alone.
        # The face goes on past both ends: a line through a convex corner
        # runs off the mass at both ends and would cut the corner off.
        face = 2*(np.abs(line-middle) <= tolerance).sum(axis=0) > len(line)
        face &= shifted(steep, steps*dx, steps*dy) & shifted(steep, -steps*dx, -steps*dy)
        level = np.where(along, face, level)
    moved = np.pad(straight, span, mode='edge')
    ok = (slope >= 1) & level & (straight != heights)
    ok &= np.minimum.reduce([shifted(moved, dx, dy) for dx, dy in offsets]) <= heights
    ok &= np.maximum.reduce([shifted(moved, dx, dy) for dx, dy in offsets]) >= heights
    ok &= np.minimum.reduce([shifted(padded, dx, dy) for dx, dy in offsets]) <= straight
    ok &= np.maximum.reduce([shifted(padded, dx, dy) for dx, dy in offsets]) >= straight
    if spires.any():
        near = np.pad(spires, half, mode='constant')
        wide = np.zeros(heights.shape, dtype=bool)
        for d in range(-half, half+1):
            wide |= near[half+d:half+d+nx, half:half+ny]
        near = np.pad(wide, half, mode='constant')
        wide = np.zeros(heights.shape, dtype=bool)
        for d in range(-half, half+1):
            wide |= near[half:half+nx, half+d:half+d+ny]
        ok &= ~wide
    return np.where(ok, straight, heights)


def _fill(heights, observed):
    """Copy the nearest observed height into each unobserved cell, unchanged.

    Inside a footprint the unobserved cells are scan shadows and the band
    beside a facade, where the median found no surface. Copying the nearest
    surface keeps a roof edge a step; relaxing across the band made it a
    ramp of uneven heights, which the cap showed as ribs down the facade.
    """
    if observed.all():
        return heights
    if not observed.any():
        raise UnsupportedFit('no observed upper surface cells')
    filled, known = np.where(observed, heights, 0.), observed.copy()
    while not known.all():
        for offset in CROSS:
            take = ~known & np.roll(known, offset, axis=(0, 1))
            filled[take] = np.roll(filled, offset, axis=(0, 1))[take]
            known |= take
    return filled


def _soften(heights, observed, steep):
    """Average each observed cell with its observed edge neighbours.

    A median of noisy returns on a curved or sloping roof settles into small
    plateaus, and a cap triangulated on the raster shows them as terraces. A
    cell beside a wall, where its neighbours differ by more than `steep`,
    keeps its value: averaging there smears a roof edge into a ramp of uneven
    heights, which the cap shows as ribs down the facade.
    """
    offsets = ((0, 0),)+CROSS
    weight = observed.astype(float)
    total = sum(np.roll(np.where(observed, heights, 0.), offset, axis=(0, 1)) for offset in offsets)
    count = sum(np.roll(weight, offset, axis=(0, 1)) for offset in offsets)
    near = _stack(np.where(observed, heights, np.nan), offsets)
    with np.errstate(invalid='ignore'), warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        relief = np.nanmax(near, axis=0)-np.nanmin(near, axis=0)
    wall = relief > steep
    return np.where(observed & ~wall, total/np.maximum(count, 1.), heights)


def _rank(grid, pitch, window):
    """Moving median of the cell values; unobserved cells never vote.

    Counting them would drag a roof edge across a courtyard or across the gap
    between two separate components of the same outline. A rank filter is
    unaffected by slope, so it removes the ribs a facade's returns leave
    across the grid while leaving ramps, steps and roof edges where the
    returns put them. Where fewer than `MIN_VOTES` cells of the disc are
    observed the cell is in a scan shadow, and its height is the upper
    quantile of the shadow's cells over twice the reach instead: the few
    returns there are a facade's, scattered down the wall, and each was
    otherwise the median of its own disc, which combed the rim with teeth.
    They still count; a shadow beside a tower can be a real low roof, and
    dropping them filled it from the tower.
    """
    data = np.where(np.isfinite(grid), grid, np.nan)
    near = _stack(data, _disc(window, pitch))
    with np.errstate(invalid='ignore'), warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        heights = np.nanmedian(near, axis=0)
        sparse = np.isfinite(near).sum(axis=0) < MIN_VOTES
        if sparse.any():
            pooled = _stack(np.where(sparse, data, np.nan), _disc(window*2, pitch))
            wide = np.nanquantile(pooled, UPPER_QUANTILE, axis=0)
            heights = np.where(sparse & np.isfinite(wide), wide, heights)
    observed = np.isfinite(heights)
    heights = _soften(np.where(observed, heights, 0.), observed, pitch*2)
    return _fill(heights, observed), observed


def _component_surface(polygon, samples, pitch, window, secondary=()):
    """Upper returns, rank filtered, over one connected footprint component.

    `secondary` returns (a vegetation class) join each cell's upper return
    but never lower it. A survey that files a facade as vegetation puts the
    whole wall's returns into the cells along an outline drawn a little
    outside it, and a lone roof return there must still set the cell. A cell
    the building classes left empty still takes them, so a flare filed as
    vegetation keeps its slope.
    """
    raster = _Raster(polygon.bounds, pitch, window)
    inside = samples[contains_xy(polygon.buffer(pitch), samples[:, 0], samples[:, 1])]
    if len(inside) < 4:
        raise UnsupportedFit('insufficient upper surface support')
    grid = raster.upper(inside, rank=UPPER_RANK)
    if len(secondary):
        extra = secondary[contains_xy(polygon.buffer(pitch), secondary[:, 0], secondary[:, 1])]
        if len(extra):
            both = raster.upper(np.concatenate((inside, extra)), rank=UPPER_RANK)
            grid = np.where(np.isfinite(grid), np.maximum(grid, both), both)
    gx, gy = raster.corners()
    within = contains_xy(polygon, gx, gy)
    # Returns outside the outline never vote: the roof reaches the outline at
    # the height of its last cell inside, and the band beyond, whose returns
    # run the whole height of the wall, cannot notch the rim.
    grid[~within] = -np.inf
    heights, observed = _rank(grid, pitch, window)
    # The outermost cell inside the outline holds a facade's returns wherever
    # the outline sits a little outside the wall, and its median dips there
    # every few metres, which combed the outline wall with teeth. A rim cell
    # more than two cells below a neighbour is such a dip, not roof: it
    # takes that neighbour's height, and the cells outside copy it again so
    # the cap is flat across the outline. Roof noise is far below that.
    interior = within.copy()
    for offset in CROSS:
        interior &= np.roll(within, offset, axis=(0, 1))
    rim = within & ~interior
    highest = _stack(heights, _disc(pitch, pitch)).max(axis=0)
    heights = np.where(rim & (highest-heights > 2*pitch), highest, heights)
    return _fill(heights, within), raster, observed


def _has_spires(polygon, samples, pitch, window, rise):
    heights, raster, _ = _component_surface(polygon, samples, pitch, window)
    return bool((_spires(heights, rise) & contains_xy(polygon, *raster.corners())).any())


def _clip_to(polygon, shape, corners):
    """Emit the parts of one cap triangle that lie inside the component.

    Heights come from barycentric weights, not from a plane equation. A cap
    triangle on a facade is nearly vertical, and solving such a plane for z
    divides by an almost-zero normal component, which moves a shared corner by
    millimetres and leaves the neighbouring face disagreeing about its height.
    """
    clipped = shape.intersection(polygon)
    if clipped.is_empty:
        return []
    (x1, y1, z1), (x2, y2, z2), (x3, y3, z3) = corners
    det = (y2-y3)*(x1-x3)+(x3-x2)*(y1-y3)
    if not det:
        return []
    parts = (clipped.geoms if clipped.geom_type in ('MultiPolygon', 'GeometryCollection')
             else [clipped])
    rings = []
    for part in parts:
        # Keep slivers however thin: an outline running close beside a grid
        # line clips into them, and dropping one leaves a hole in the cap.
        if part.geom_type != 'Polygon' or part.area <= 0:
            continue
        # A collapsed face can span a courtyard smaller than the mesh margin.
        # The join takes simple rings, so cut such a part around its holes.
        pieces_ = ([part] if not part.interiors
                   else [p for p in shapely.get_parts(shapely.constrained_delaunay_triangles(part))
                         if p.area > 0])
        for piece in pieces_:
            ring = []
            for x, y in piece.exterior.coords:
                a = ((y2-y3)*(x-x3)+(x3-x2)*(y-y3))/det
                b = ((y3-y1)*(x-x3)+(x1-x3)*(y-y3))/det
                ring.append([float(x), float(y), float(a*z1+b*z2+(1-a-b)*z3)])
            rings.append(ring)
    return rings


def _snap_to_boundary(vertices, polygon, gap):
    """Move vertices within `gap` of the component boundary onto it, in plan.

    An outline running a hair inside a grid line clips the faces along it
    into slivers thinner than float32 holds at print scale; the join drops
    them and finds a hole, and two clip points that should coincide round
    apart. Snapping the corners leaves every clipped piece at least `gap`
    wide. The collapse keeps vertices `MIN_GAP` apart and faces at least
    that wide, so with `gap` under a quarter of it snapped corners stay
    apart and no face folds. Heights are untouched.
    """
    boundary = polygon.boundary
    points = shapely.points(vertices[:, :2])
    near = np.flatnonzero(shapely.distance(points, boundary) <= gap)
    if len(near):
        vertices = vertices.copy()
        for k in near:
            nearest = nearest_points(boundary, points[k])[0]
            vertices[k, :2] = (nearest.x, nearest.y)
    return vertices


def _surfaces(polygon, heights, raster, threshold, budget, rise, fairing):
    """Straighten the raster's faces, triangulate it over the component, collapse it, and clip it.

    Returns the clipped rings, their area and the number of collapsed faces.
    """
    pitch = raster.pitch
    spires = _spires(heights, rise)
    heights = _fair(heights, pitch, *fairing, spires)
    gx, gy = raster.corners()
    mask = contains_xy(polygon.buffer(pitch*1.5), gx, gy)
    index = np.full(mask.shape, -1)
    index[mask] = np.arange(int(mask.sum()))
    cell = mask[:-1, :-1] & mask[1:, :-1] & mask[:-1, 1:] & mask[1:, 1:]
    i, j = np.nonzero(cell)
    if not len(i):
        raise UnsupportedFit('incomplete clipped upper surface')
    a, b, c, d = index[i, j], index[i+1, j], index[i+1, j+1], index[i, j+1]
    # Split each cell along the diagonal whose corners are closest in height.
    # A fixed diagonal folds every cell a diagonal wall cuts into a V-shaped
    # notch, and the collapse has to keep a row of notches as geometry.
    first = np.abs(heights[i+1, j]-heights[i, j+1]) < np.abs(heights[i, j]-heights[i+1, j+1])
    faces = np.concatenate((np.where(first[:, None], np.stack((a, b, d), 1), np.stack((a, b, c), 1)),
                            np.where(first[:, None], np.stack((b, c, d), 1), np.stack((a, c, d), 1))))
    # A merged vertex stays within two cells of every face it replaces: the
    # stairs of a wall are half a cell, and a plant room or a parapet taller
    # than two cells is never lowered away. Slender masses get half of that.
    vertices, faces = collapse(np.column_stack((gx[mask], gy[mask], heights[mask])), faces,
                               threshold, budget, deviation=DEVIATION_CELLS*pitch,
                               fine=index[mask & spires])
    vertices = _snap_to_boundary(vertices, polygon, MIN_GAP/4)
    rings, area = [], 0.
    for face in faces:
        corners = [tuple(vertices[k]) for k in face]
        triangle = Polygon([p[:2] for p in corners])
        if polygon.covers(triangle):
            rings.append([list(p) for p in corners]+[list(corners[0])])
            area += triangle.area
            continue
        for ring in _clip_to(polygon, triangle, corners):
            rings.append(ring)
            area += _ring_area(ring)
    return rings, area, len(faces)


def _ring_area(ring):
    return abs(sum((a[0]-ring[0][0])*(b[1]-ring[0][1]) - (b[0]-ring[0][0])*(a[1]-ring[0][1])
                   for a, b in zip(ring, ring[1:])))/2


def _envelope(components, observed, secondary, pitch, window, tolerance, budget, threshold, fairing):
    """The clipped cap faces of every component, and the fit diagnostics."""
    rings, faces, cells, admitted, residuals = [], 0, 0, 0, []
    total = sum(polygon.area for polygon in components)
    for polygon in components:
        usable, extra = observed, ()
        if len(secondary):
            established, raster, _ = _component_surface(polygon, observed, pitch, window)
            ix, iy = raster.cells(secondary)
            keep = secondary[:, 2] <= established[ix, iy]+tolerance
            admitted += int(keep.sum())
            extra = secondary[keep]
            usable = np.concatenate((observed, extra))
        heights, raster, seen_cells = _component_surface(polygon, observed, pitch, window, extra)
        cells += int(seen_cells.sum())
        # Comparing an upper envelope to individual returns measures the
        # building, not the reconstruction: under one facade cell the returns
        # run the whole height of the wall. Report instead how far the rank
        # filter moved the surface off the raw upper envelope.
        raw = raster.upper(usable[contains_xy(polygon.buffer(pitch), usable[:, 0], usable[:, 1])])
        seen = np.isfinite(raw)
        if seen.any():
            residuals.append(np.abs(heights[seen]-raw[seen]))
        share = max(1, int(budget*polygon.area/total))
        part, area, count = _surfaces(polygon, heights, raster, threshold, share, tolerance, fairing)
        if not part or abs(area-polygon.area) > max(.00001, polygon.area*1e-5):
            raise UnsupportedFit('incomplete clipped upper surface')
        if count > share:
            raise UnsupportedFit('upper surface facet budget')
        rings.extend(part)
        faces += count
    return rings, faces, cells, admitted, residuals


def _surface_density(footprint, returns):
    """Upper-surface returns per m²: the median 1 m cell, counting its top 0.5 m.

    A facade stacks many returns over a small plan area, so a plain count per
    footprint area says how much wall was scanned, not how densely the roof
    was sampled. The half-metre band also reads a noisy roof as sparse, which
    grids it coarser and averages the noise out.
    """
    inside = returns[contains_xy(footprint, returns[:, 0], returns[:, 1])]
    if len(inside) < 4:
        return None
    raster = _Raster(footprint.bounds, 1., 0.)
    top = raster.upper(inside)
    ix, iy = raster.cells(inside)
    near_top = inside[:, 2] >= top[ix, iy]-.5
    counts = np.bincount(ix[near_top]*raster.ny+iy[near_top], minlength=raster.nx*raster.ny)
    return float(np.median(counts[counts > 0]))


def _scatter_density(footprint, returns):
    """Returns per m² read from how many half-metre cells hold any: blind to height.

    A scatter of d returns per m² leaves exp(-d/4) of such cells empty. Cones
    and turrets spread the returns of a cell over many metres however densely
    they were scanned, so `_surface_density` reads a castle as a quarter as
    dense as the flat roofs beside it.
    """
    inside = returns[contains_xy(footprint, returns[:, 0], returns[:, 1])]
    raster = _Raster(footprint.bounds, .5, 0.)
    within = contains_xy(footprint, *raster.corners())
    if not len(inside) or not within.any():
        return None
    seen = np.isfinite(raster.upper(inside)) & within
    return -4*math.log(max(1-seen.sum()/within.sum(), 1e-3))


def _turn(points, angle, origin):
    """Rotate the XY columns of an Nx3 array about `origin`."""
    if not len(points):
        return points
    cosine, sine = math.cos(angle), math.sin(angle)
    x, y = points[:, 0]-origin[0], points[:, 1]-origin[1]
    turned = np.array(points, dtype=float)
    turned[:, 0] = origin[0]+x*cosine-y*sine
    turned[:, 1] = origin[1]+x*sine+y*cosine
    return turned


def fit_roof_envelope(footprint, samples, cell, scale=(.07, .077), boundary_samples=(),
                      secondary_samples=()):
    """Return a complete continuous envelope, or an explicit fallback reason.

    `samples` are the per-cell upper observations proven by the coverage tests;
    `boundary_samples` are the individual returns behind them, which carry the
    facade. `secondary_samples` are returns the survey filed under a vegetation
    class; they are admitted only where the structural envelope already reaches
    that level, so a canopy can never lift a roof while a facade misfiled as
    vegetation is still used, and they never lower a cell the building classes
    observed.
    """
    samples = np.asarray(samples, dtype=float)
    returns = np.asarray(boundary_samples, dtype=float)
    secondary = np.asarray(secondary_samples, dtype=float)
    for array in (samples, returns, secondary):
        if array.size and (array.ndim != 2 or array.shape[1] != 3 or not np.isfinite(array).all()):
            raise ValueError('Upper surface samples must be finite Nx3 coordinates')
    if not math.isfinite(cell) or cell <= 0:
        raise ValueError('Invalid upper surface sample spacing')
    if len(samples) < 4:
        return None, 'insufficient upper surface samples'
    observed = returns if len(returns) >= len(samples) else samples
    footprint = unary_union(pieces(footprint))
    density = _surface_density(footprint, observed)
    pitch, window, tolerance = envelope_parameters(scale, density)
    try:
        # Lay the raster along the building's long axis, so the walls of an
        # ordinary rectangular building fall on grid lines and need no
        # straightening at all. The grid is unchanged by a quarter turn, so an
        # outline already on it is not rotated.
        corners = list(footprint.minimum_rotated_rectangle.exterior.coords)
        start, end = max(zip(corners, corners[1:]), key=lambda edge: math.dist(*edge))
        angle = (math.atan2(end[1]-start[1], end[0]-start[0])+math.pi/4) % (math.pi/2)-math.pi/4
        angle = 0. if abs(angle) < 1e-9 else angle
        origin = footprint.centroid.coords[0]
        if angle:
            footprint = rotate(footprint, -angle, origin=origin, use_radians=True)
            observed, secondary = _turn(observed, -angle, origin), _turn(secondary, -angle, origin)
        components = pieces(footprint)
        # The band reading grids a steep roof coarser too, where nothing is
        # noisy, and slender free-standing masses are what a coarse grid
        # costs: a cap that shows any is gridded as finely as its cells are
        # filled. Every other cap keeps the pitch the band reading gave it.
        scatter = _scatter_density(footprint, observed) if pitch > envelope_parameters(scale, 1e9)[0] else None
        if scatter and envelope_parameters(scale, scatter)[0] < pitch and any(
                _has_spires(polygon, observed, pitch, window, tolerance) for polygon in components):
            density = scatter
            pitch, window, tolerance = envelope_parameters(scale, density)
        budget = facet_budget(pitch)
        # The stairs a wall makes on the grid are the pitch high in plan, so
        # the error that merges them scales with the pitch squared.
        surfaces, faces, cells, admitted, residuals = _envelope(
            components, observed, secondary, pitch, window, tolerance, budget,
            COLLAPSE_TOLERANCE*pitch*pitch, (FAIR_WINDOW_MM/scale[0], FAIR_REACH_MM/scale[0]))
        if len(surfaces) > MAX_ENVELOPE_FACETS:
            raise UnsupportedFit('upper surface facet budget')
        # Publication rounds heights to the millimetre-scale precision this
        # model can use. Round before choosing the base, so no vertex can end
        # up under the base the record declares.
        cosine, sine = math.cos(angle), math.sin(angle)
        for ring in surfaces:
            for vertex in ring:
                if angle:
                    x, y = vertex[0]-origin[0], vertex[1]-origin[1]
                    vertex[0], vertex[1] = origin[0]+x*cosine-y*sine, origin[1]+x*sine+y*cosine
                vertex[2] = round(vertex[2], 4)
        elevations = np.array([vertex[2] for ring in surfaces for vertex in ring])
        low = float(elevations.min())
        if low <= 0 or not np.isfinite(elevations).all():
            raise UnsupportedFit('invalid upper surface heights')
        residual = float(np.quantile(np.concatenate(residuals), .95)) if residuals else 0.
        record = {'height_m': low, 'tiers': [],
                  'roof_surfaces': [{'geometry': {'type': 'Polygon', 'coordinates': [ring]},
                                     'bottom_m': low} for ring in surfaces],
                  'method': 'faceted_roof', 'surface_reconstruction': 'roof_envelope',
                  'roof_fit_p95_m': residual,
                  'surface_diagnostics': {
                      'envelope_raw_returns': int(len(returns)),
                      'envelope_observations': int(len(observed)),
                      'envelope_secondary_returns': int(len(secondary)),
                      'envelope_secondary_admitted': admitted,
                      'envelope_cells': cells, 'envelope_pitch_m': pitch,
                      'envelope_window_m': window,
                      'envelope_components': len(components),
                      'envelope_return_density_m2': round(density or 0., 2),
                      'surface_retained_samples': int(len(samples)),
                      'envelope_collapsed_faces': faces,
                      'envelope_collapse_tolerance_m2': COLLAPSE_TOLERANCE*pitch*pitch,
                      'envelope_residual_basis': 'rank_filter_versus_raw_upper_envelope',
                      'envelope_smoothing_p95_m': residual}}
        return record, None
    except (UnsupportedFit, np.linalg.LinAlgError, GEOSException) as exc:
        return None, str(exc)
