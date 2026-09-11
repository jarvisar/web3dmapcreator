"""A robust upper-surface raster over LiDAR returns, clipped to mapped footprints.

Coverage and ground checks run upstream. A near-vertical facade projects its
whole height into a handful of plan cells, so the height there is decided by
which return happened to land where, not by the shape of the building. Isotropic
morphology cannot repair that: on a steep ramp an opening or closing by any flat
element is the identity, so dilation, erosion and relaxation passes leave
cross-slope detail exactly as they found it. A rank filter is unaffected by
slope, so one moving median over a print-scale window removes those ribs while
leaving ramps, steps and roof edges where the returns put them.

The result is a height raster triangulated on its own grid and clipped to the
footprint, so the cap covers the outline exactly and has no long slivers.
Native dependencies stay in the preparation worker.
"""
import math

import numpy as np
from shapely import contains_xy
from shapely.errors import GEOSException
from shapely.geometry import Polygon
from shapely.ops import unary_union

try:
    from .lidar_facets import UnsupportedFit, pieces
    from .lidar_records import MAX_ENVELOPE_FACETS
except ImportError:
    from lidar_facets import UnsupportedFit, pieces
    from lidar_records import MAX_ENVELOPE_FACETS

CROSS = ((-1, 0), (1, 0), (0, -1), (0, 1))
# The upper order statistic taken in each cell before the rank filter.
UPPER_QUANTILE = .9


def envelope_parameters(scale):
    """Raster pitch, rank window, mesh tolerance and secondary admission band.

    Every value is a printed length converted back to ground distance, so a
    coarser or finer output scale moves them together and no length is tied to
    any particular survey, city or building. The mesh tolerance is well under
    one printed layer, so simplifying to it cannot move a printed surface.
    """
    if len(scale) != 2 or not all(math.isfinite(s) and s > 0 for s in scale):
        raise ValueError('Invalid LiDAR reconstruction scale')
    pitch = min(3., max(.8, .07/scale[0]))
    return pitch, pitch*2, max(.05, .015/scale[1]), max(3., .28/scale[0])


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

    def upper(self, samples, values=None, quantile=1.):
        """An upper order statistic of the returns in each cell.

        The plain maximum is the outer skin but it is the noisiest possible
        estimator: it takes the extreme of however many returns happened to
        land in the cell. A high quantile keeps the skin on a wall, where the
        returns run the whole height of the cell, while costing only
        measurement noise on a surface, where they do not.
        """
        grid = np.full((self.nx, self.ny), -np.inf)
        if not len(samples):
            return grid
        values = samples[:, 2] if values is None else values
        ix, iy = self.cells(samples)
        if quantile >= 1.:
            np.maximum.at(grid, (ix, iy), values)
            return grid
        keys = ix*self.ny+iy
        order = np.lexsort((values, keys))
        ordered = keys[order]
        starts = np.flatnonzero(np.concatenate(([True], ordered[1:] != ordered[:-1])))
        counts = np.diff(np.concatenate((starts, [len(ordered)])))
        picked = starts+np.floor(quantile*(counts-1)).astype(np.int64)
        grid.reshape(-1)[ordered[starts]] = values[order][picked]
        return grid

    def corners(self):
        x = np.arange(self.nx)*self.pitch+self.x0
        y = np.arange(self.ny)*self.pitch+self.y0
        return np.meshgrid(x, y, indexing='ij')


def _fill(heights, observed):
    """Carry the surrounding surface across unobserved cells.

    The median has already rejected outliers, so propagation here cannot
    spread a bad return; it only continues a scan shadow or a courtyard edge.
    """
    if observed.all():
        return heights
    if not observed.any():
        raise UnsupportedFit('no observed upper surface cells')
    filled = np.where(observed, heights, float(np.median(heights[observed])))
    for _ in range(2*max(heights.shape)):
        relaxed = sum(np.roll(filled, offset, axis=(0, 1)) for offset in CROSS)/4.
        updated = np.where(observed, filled, relaxed)
        if np.max(np.abs(updated-filled)) < 1e-3:
            return updated
        filled = updated
    return filled


def _rank(grid, pitch, window):
    """Moving median of the cell values; unobserved cells never vote.

    Counting them would drag a roof edge across a courtyard or across the gap
    between two separate components of the same outline.
    """
    data = np.where(np.isfinite(grid), grid, np.nan)
    with np.errstate(invalid='ignore'):
        heights = np.nanmedian(_stack(data, _disc(window, pitch)), axis=0)
    observed = np.isfinite(heights)
    return _fill(np.where(observed, heights, 0.), observed), observed


def _component_surface(polygon, samples, pitch, window):
    """Upper returns, rank filtered, over one connected footprint component."""
    raster = _Raster(polygon.bounds, pitch, window)
    inside = samples[contains_xy(polygon.buffer(pitch), samples[:, 0], samples[:, 1])]
    if len(inside) < 4:
        raise UnsupportedFit('insufficient upper surface support')
    heights, observed = _rank(raster.upper(inside, quantile=UPPER_QUANTILE), pitch, window)
    return heights, raster, int(observed.sum())


def _clip_to(polygon, shape, corners):
    """Emit the parts of one grid triangle that lie inside the component.

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
        if part.geom_type != 'Polygon' or part.area <= 1e-7 or part.interiors:
            continue
        ring = []
        for x, y in part.exterior.coords:
            a = ((y2-y3)*(x-x3)+(x3-x2)*(y-y3))/det
            b = ((y3-y1)*(x-x3)+(x1-x3)*(y-y3))/det
            ring.append([float(x), float(y), float(a*z1+b*z2+(1-a-b)*z3)])
        rings.append(ring)
    return rings


def _levels(heights, tolerance, limit=6):
    """Largest square block per cell whose corners still describe the raster.

    A genuinely planar roof collapses to a handful of faces; measured relief
    keeps its own cells. Only the face count changes: every block corner is a
    raster node, so the surface itself is never moved by this step.
    """
    nx, ny = heights.shape
    fits = {0: np.ones((nx-1, ny-1), dtype=bool)}
    top = 0
    for level in range(1, limit+1):
        span = 1 << level
        bx, by = (nx-1)//span, (ny-1)//span
        if bx < 1 or by < 1:
            break
        child = fits[level-1]
        ok = (child[0::2, 0::2][:bx, :by] & child[1::2, 0::2][:bx, :by]
              & child[0::2, 1::2][:bx, :by] & child[1::2, 1::2][:bx, :by])
        i0, j0 = np.arange(bx)*span, np.arange(by)*span
        corners = [heights[np.ix_(i0+a*span, j0+b*span)] for a in (0, 1) for b in (0, 1)]
        error = np.zeros((bx, by))
        for a in range(span+1):
            u = a/span
            for b in range(span+1):
                v = b/span
                predicted = (corners[0]*(1-u)*(1-v) + corners[1]*(1-u)*v
                             + corners[2]*u*(1-v) + corners[3]*u*v)
                error = np.maximum(error, np.abs(heights[np.ix_(i0+a, j0+b)]-predicted))
        fits[level] = ok & (error <= tolerance)
        top = level
    level_of = np.zeros((nx-1, ny-1), dtype=np.int8)
    claimed = np.zeros((nx-1, ny-1), dtype=bool)
    for level in range(top, 0, -1):
        span = 1 << level
        bx, by = (nx-1)//span, (ny-1)//span
        free = ~np.add.reduceat(np.add.reduceat(claimed[:bx*span, :by*span].astype(np.int32),
                                                np.arange(0, bx*span, span), axis=0),
                                np.arange(0, by*span, span), axis=1).astype(bool)
        take = fits[level][:bx, :by] & free
        if not take.any():
            continue
        spread = np.repeat(np.repeat(take, span, axis=0), span, axis=1)
        region = np.zeros_like(claimed)
        region[:bx*span, :by*span] = spread
        level_of[region] = level
        claimed |= region
    # A block may sit beside one that is at most twice as fine; otherwise its
    # edge would meet more than one vertex and open a crack in the cap.
    while True:
        padded = np.pad(level_of, 1, mode='edge')
        neighbours = np.minimum.reduce([padded[:-2, 1:-1], padded[2:, 1:-1],
                                        padded[1:-1, :-2], padded[1:-1, 2:]])
        need = level_of > neighbours+1
        if not need.any():
            break
        for level in range(top, 0, -1):
            mask = need & (level_of == level)
            if not mask.any():
                continue
            span = 1 << level
            ii, jj = np.nonzero(mask)
            flag = np.zeros(((nx-1+span-1)//span, (ny-1+span-1)//span), dtype=bool)
            flag[ii//span, jj//span] = True
            spread = np.repeat(np.repeat(flag, span, axis=0), span, axis=1)[:nx-1, :ny-1]
            level_of = np.where((level_of == level) & spread, level-1, level_of)
    blocks = {}
    for i in range(nx-1):
        for j in range(ny-1):
            span = 1 << int(level_of[i, j])
            blocks[(i//span*span, j//span*span, span)] = None
    return sorted(blocks), level_of


def _coplanar(ring, tolerance=.015):
    """Is one block flat enough to publish as a single face?

    The reader fits a plane through each published face and rejects anything
    that misses it by more than two centimetres, so this bound stays under it.
    """
    origin = ring[0]
    far = max(ring, key=lambda v: (v[0]-origin[0])**2+(v[1]-origin[1])**2)
    side = max(ring, key=lambda v: abs((far[0]-origin[0])*(v[1]-origin[1])
                                       - (far[1]-origin[1])*(v[0]-origin[0])))
    dx, dy, dz = far[0]-origin[0], far[1]-origin[1], far[2]-origin[2]
    ex, ey, ez = side[0]-origin[0], side[1]-origin[1], side[2]-origin[2]
    det = dx*ey-dy*ex
    if not det:
        return False
    a, b = (dz*ey-dy*ez)/det, (dx*ez-dz*ex)/det
    return all(abs(origin[2]+a*(x-origin[0])+b*(y-origin[1])-z) <= tolerance
               for x, y, z in ring)


def _surfaces(polygon, heights, raster, tolerance):
    """Triangulate the raster on a crack-free block grid and clip it."""
    pitch = raster.pitch
    blocks, level_of = _levels(heights, tolerance)
    rings, area = [], 0.

    def node(i, j):
        return (raster.x0+i*pitch, raster.y0+j*pitch, float(heights[i, j]))

    for i, j, span in blocks:
        x, y = raster.x0+i*pitch, raster.y0+j*pitch
        side = span*pitch
        cell = Polygon([(x, y), (x+side, y), (x+side, y+side), (x, y+side)])
        if not polygon.intersects(cell):
            continue
        half = span//2
        outline = []
        for (ai, aj), (bi, bj), (ni, nj) in (
                ((i, j), (i+span, j), (i+half, j-1)),
                ((i+span, j), (i+span, j+span), (i+span, j+half)),
                ((i+span, j+span), (i, j+span), (i+half, j+span)),
                ((i, j+span), (i, j), (i-1, j+half))):
            outline.append((ai, aj))
            if span > 1 and (0 <= ni < level_of.shape[0] and 0 <= nj < level_of.shape[1]
                             and level_of[ni, nj] < int(np.log2(span))):
                outline.append(((ai+bi)//2, (aj+bj)//2))
        # A block that needs no clipping and whose corners really are coplanar
        # can stay one face. The Blender side fits each face's plane to carry
        # heights across the output crop, so anything less flat than that fit
        # allows still has to leave as triangles.
        if polygon.covers(cell):
            ring = [node(*v) for v in outline]
            if _coplanar(ring):
                rings.append([list(v) for v in ring]+[list(ring[0])])
                area += side*side
                continue
        if span == 1:
            fans = [(node(i, j), node(i+1, j), node(i+1, j+1)),
                    (node(i, j), node(i+1, j+1), node(i, j+1))]
        else:
            centre = node(i+half, j+half)
            fans = [(centre, node(*a), node(*b))
                    for a, b in zip(outline, outline[1:]+outline[:1])]
        for points in fans:
            triangle = [np.asarray(p) for p in points]
            normal = np.cross(triangle[1]-triangle[0], triangle[2]-triangle[0])
            if abs(normal[2]) < 1e-12:
                continue
            for ring in _clip_to(polygon, Polygon([p[:2] for p in triangle]), points):
                rings.append(ring)
                area += abs(sum((a[0]-ring[0][0])*(b[1]-ring[0][1])
                                - (b[0]-ring[0][0])*(a[1]-ring[0][1])
                                for a, b in zip(ring, ring[1:])))/2
    return rings, area


def _envelope(components, footprint, observed, secondary, pitch, window,
              mesh_tolerance, tolerance):
    """One whole-outline attempt, or None when it exceeds the record budget."""
    surfaces, area, cells, admitted, residuals = [], 0., 0, 0, []
    for polygon in components:
        usable = observed
        if len(secondary):
            established, raster, _ = _component_surface(polygon, observed, pitch, window)
            ix, iy = raster.cells(secondary)
            keep = secondary[:, 2] <= established[ix, iy]+tolerance
            admitted += int(keep.sum())
            usable = np.concatenate((observed, secondary[keep]))
        heights, raster, count = _component_surface(polygon, usable, pitch, window)
        cells += count
        # Comparing an upper envelope to individual returns measures the
        # building, not the reconstruction: under one facade cell the returns
        # run the whole height of the wall. Report instead how far the rank
        # filter moved the surface off the raw upper envelope.
        raw = raster.upper(usable[contains_xy(polygon.buffer(pitch), usable[:, 0], usable[:, 1])])
        seen = np.isfinite(raw)
        if seen.any():
            residuals.append(np.abs(heights[seen]-raw[seen]))
        rings, piece = _surfaces(polygon, heights, raster, mesh_tolerance)
        surfaces.extend(rings)
        area += piece
        if len(surfaces) > MAX_ENVELOPE_FACETS:
            return None
    return surfaces, area, cells, admitted, residuals


def fit_roof_envelope(footprint, samples, cell, scale=(.07, .077), boundary_samples=(),
                      secondary_samples=()):
    """Return a complete continuous envelope, or an explicit fallback reason.

    `samples` are the per-cell upper observations proven by the coverage tests;
    `boundary_samples` are the individual returns behind them, which carry the
    facade. `secondary_samples` are returns the survey filed under a vegetation
    class; they are admitted only where the structural envelope already reaches
    that level, so a canopy can never lift a roof while a facade misfiled as
    vegetation is still used.
    """
    pitch, window, mesh_tolerance, tolerance = envelope_parameters(scale)
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
    try:
        components = pieces(footprint)
        base = pitch
        for attempt in range(4):
            # A large outline may not fit the record budget at the print-scale
            # pitch. Coarsen the whole surface and measure again rather than
            # thinning it unevenly or guessing the face count in advance.
            result = _envelope(components, footprint, observed, secondary, pitch,
                               max(window, pitch*2), mesh_tolerance, tolerance)
            if result is not None:
                break
            pitch *= 1.5
            if attempt == 3 or pitch > base*4:
                raise UnsupportedFit('upper surface facet budget')
        surfaces, area, cells, admitted, residuals = result
        window = max(window, pitch*2)
        if not surfaces or abs(area-footprint.area) > max(.00001, footprint.area*1e-5):
            raise UnsupportedFit('incomplete clipped upper surface')
        # Publication rounds heights to the millimetre-scale precision this
        # model can use. Round before choosing the base, so no vertex can end
        # up under the base the record declares.
        for ring in surfaces:
            for vertex in ring:
                vertex[2] = round(vertex[2], 4)
        elevations = np.array([vertex[2] for ring in surfaces for vertex in ring])
        low = float(elevations.min())
        if low <= 0 or not np.isfinite(elevations).all():
            raise UnsupportedFit('invalid upper surface heights')
        residual = float(np.quantile(np.concatenate(residuals), .95)) if residuals else 0.
        return {'height_m': low, 'tiers': [],
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
                    'surface_retained_samples': int(len(samples)),
                    'envelope_fit_error_basis': 'mesh_versus_height_raster',
                    'envelope_residual_basis': 'rank_filter_versus_raw_upper_envelope',
                    'envelope_fit_max_m': 0.,
                    'envelope_smoothing_p95_m': residual,
                    'envelope_budget_limited': bool(pitch > envelope_parameters(scale)[0]+1e-9)}}, None
    except (UnsupportedFit, np.linalg.LinAlgError, GEOSException) as exc:
        return None, str(exc)
