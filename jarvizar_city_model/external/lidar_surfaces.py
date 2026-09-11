"""Surface-first, footprint-constrained roof reconstruction (external Python).

The sampling grid establishes evidence, never roof elevations. Roof regions
come from compatible local surfaces; their polygons partition the footprint.
Planes remove measurement noise and an adaptive mesh represents continuous
nonplanar roofs. Every patch is supported down to the building base.
"""
import math

import numpy as np
from shapely import contains_xy, voronoi_polygons, STRtree, points as make_points
from shapely.errors import GEOSException
from shapely.geometry import MultiPoint, Polygon
from shapely.ops import unary_union

try:
    from . import lidar_facets as facets
    from .lidar_boundaries import measured_tier_boundary
    from .lidar_surface_regions import segment_surfaces
    from .lidar_surface_junctions import reconcile_planar_junctions
    from .lidar_surface_partition import clean_partition
except ImportError:
    import lidar_facets as facets
    from lidar_boundaries import measured_tier_boundary
    from lidar_surface_regions import segment_surfaces
    from lidar_surface_junctions import reconcile_planar_junctions
    from lidar_surface_partition import clean_partition


def surface_parameters(scale):
    """Physical approximation error and feature size, independent of terraces.

    A quarter of a 0.1 mm fine printed feature is the surface error budget;
    measurement precision remains a floor even at very large output scales.
    A feature also needs several independently supported survey cells.
    """
    xy, z = scale
    if not all(math.isfinite(s) and s > 0 for s in scale):
        raise ValueError('Invalid LiDAR reconstruction scale')
    return max(1.0, .1 / xy), max(.4, .05 / z), max(.2, .025 / z)


def _plane(samples, tolerance, rise=None):
    """Robust equal-cell regression; don't pin survey extrema into a mesh."""
    center = np.mean(samples[:, :2], axis=0)
    level = float(np.median(samples[:, 2]))
    flat_residual = np.abs(samples[:, 2]-level)
    flat_span = float(np.quantile(samples[:, 2], .95)-np.quantile(samples[:, 2], .05))
    if ((np.quantile(flat_residual, .95) <= tolerance or (rise is not None and flat_span <= rise))
            and flat_residual.max() <= max(tolerance * 3, rise or 0)):
        return center, np.array([0., 0., level]), float(np.quantile(flat_residual, .95))
    design = np.column_stack((samples[:, :2] - center, np.ones(len(samples))))
    keep = np.ones(len(samples), dtype=bool)
    for _ in range(4):
        coef, _, rank, _ = np.linalg.lstsq(design[keep], samples[keep, 2], rcond=None)
        if rank < 3:
            return None
        residual = np.abs(design @ coef - samples[:, 2])
        keep = residual <= max(tolerance, 3 * float(np.median(residual)))
        if keep.sum() < max(3, len(samples) * .75):
            return None
    if (np.linalg.norm(coef[:2]) > 3 or np.quantile(residual, .95) > tolerance
            or np.max(residual) > max(1.25, tolerance * 4)):
        return None
    # Statistically flat roofs are horizontal, rather than imperceptibly tilted
    # planes whose different extrapolated edges create tiny roof discontinuities.
    if np.quantile(np.abs(samples[:, 2] - level), .95) <= tolerance:
        coef = np.array([0., 0., level])
    return center, coef, float(np.quantile(residual, .95))


def _planar_surfaces(region, center, coef):
    surfaces = []
    for polygon in facets.pieces(region):
        # Clean polygons need just one cap. Near-coincident out-and-back edges
        # can remain GEOS-valid after partitioning but collapse in Blender's
        # float mesh coordinates. Resolve those and hole channels externally;
        # the established facet filter discards only microscopic slivers.
        fragile = polygon.minimum_clearance < .005
        pieces = facets.roof_triangles(polygon) if polygon.interiors or fragile else [polygon]
        for piece in pieces:
            if not facets.printable_facet(piece):
                continue
            rings = []
            for ring in (piece.exterior, *piece.interiors):
                rings.append([[float(x), float(y), float(np.dot(np.array([x, y])-center,
                              coef[:2])+coef[2])] for x, y in ring.coords])
            surfaces.append({'geometry': {'type': 'Polygon', 'coordinates': rings}})
    return surfaces


def _regularize_regions(raw, samples, labels, cell, width, rise, tolerance):
    """Filter unresolvable strips and join statistically compatible planes.

    Cell count alone admits long one-cell facade strips and parapet noise.
    Require a two-dimensional printable core for an independent roof feature.
    Adjacent planes that differ by less than one printed roof increment share
    a fit; a real wall or a ridge with different normals remains separate.
    """
    raw = {i: unary_union(facets.pieces(g)) for i, g in raw.items()}
    labels = labels.copy()
    observed_heights = samples[:, 2].copy()
    excluded = np.zeros(len(samples), dtype=bool)
    dominant = max(raw, key=lambda i: raw[i].area)
    removed, merged = 0, 0
    for label in sorted(raw, key=lambda i: (raw[i].area, i)):
        if label == dominant:
            continue
        region = raw[label]
        core = region.buffer(-width * .5)
        if not core.is_empty and core.area >= (cell * .5) ** 2:
            continue
        adjacent = [(region.boundary.intersection(g.boundary).length, i)
                    for i, g in raw.items() if i != label and g.intersects(region)]
        adjacent = [(length, i) for length, i in adjacent if length > 1e-7]
        if not adjacent:
            continue
        _, target = max(adjacent, key=lambda item: (item[0], raw[item[1]].area, -item[1]))
        raw[target] = raw[target].union(raw.pop(label))
        mask = labels == label
        excluded[mask] = True
        labels[mask] = target
        removed += 1

    ids = sorted(raw)
    tree = STRtree([raw[i] for i in ids])
    pairs = sorted((i, ids[int(j)]) for k, i in enumerate(ids)
                   for j in tree.query(raw[i], predicate='intersects') if j > k)
    parent = {i: i for i in ids}
    def root(i):
        while parent[i] != i:
            i = parent[i]
        return i
    fits = {i: _plane(samples[(labels == i) & ~excluded], tolerance, rise) for i in ids}
    for a, b in pairs:
        a, b = root(a), root(b)
        if a == b or fits[a] is None or fits[b] is None:
            continue
        ca, pa, _ = fits[a]
        cb, pb, _ = fits[b]
        if np.linalg.norm(pa[:2]-pb[:2]) > .06:
            continue
        shared = raw[a].boundary.intersection(raw[b].boundary)
        if shared.geom_type == 'GeometryCollection':
            shared = unary_union([g for g in shared.geoms
                                  if g.geom_type in ('LineString', 'MultiLineString')])
        if shared.is_empty or shared.length <= cell * .5:
            continue
        xy = np.array([shared.interpolate((j+.5)/12, normalized=True).coords[0][:2]
                       for j in range(12)])
        delta = (xy-ca) @ pa[:2]+pa[2] - ((xy-cb) @ pb[:2]+pb[2])
        if np.max(np.abs(delta)) > rise:
            continue
        mask_a = (labels == a) & ~excluded
        mask_b = (labels == b) & ~excluded
        selected = mask_a | mask_b
        # Spatially separated height offsets must not become a regression
        # slope: two horizontal roofs justify one horizontal approximation.
        # Retain the independently supported gradients and fit only the level.
        # Test against pre-merge evidence so repeated merges cannot accumulate
        # an arbitrarily large height change through several small increments.
        gradient = (pa[:2] * mask_a.sum() + pb[:2] * mask_b.sum()) / selected.sum()
        center = samples[selected, :2].mean(axis=0)
        trend = (samples[selected, :2] - center) @ gradient
        offsets = observed_heights[selected] - trend
        level = float(np.median(offsets))
        residual = np.abs(offsets - level)
        span = float(np.quantile(offsets, .95) - np.quantile(offsets, .05))
        if span > rise or residual.max() > max(rise, tolerance * 3):
            continue
        coef = np.r_[gradient, level]
        fit = center, coef, float(np.quantile(residual, .95))
        raw[a] = raw[a].union(raw.pop(b))
        samples[selected, 2] = trend + level
        labels[labels == b] = a
        parent[b] = a
        fits[a] = fit
        merged += 1
    adjusted = np.abs(samples[:, 2] - observed_heights)
    return raw, labels, excluded, {'surface_filtered_strips': removed,
                                  'surface_filtered_samples': int(excluded.sum()),
                                  'surface_merged_subprint_regions': merged,
                                  'surface_merge_p95_m': float(np.quantile(adjusted, .95)),
                                  'surface_merge_max_m': float(adjusted.max())}


def _patches(footprint, samples, labels, cell, width, rise, tolerance, observations, parts):
    """One partition with shared boundaries; sample ownership never moves.

    Voronoi cells are an intermediate ownership map, not emitted roof geometry.
    Supported raw observations refine real discontinuities below that sampling
    scale. Assigning the complement last keeps the exterior and courtyards exact.
    """
    ids, counts = np.unique(labels, return_counts=True)
    if len(ids) == 1:
        return [(footprint, samples)], 0, {}
    # Nearly identical grid coordinates can differ by a few summation ulps.
    # Normalize at sub-micron precision before GEOS constructs shared edges.
    origin = samples[:, :2].min(axis=0)
    xy = np.round((samples[:, :2]-origin), 7) + origin
    cells = list(voronoi_polygons(MultiPoint(xy),
                 extend_to=footprint.envelope, ordered=True).geoms)
    raw = {label: unary_union([cells[i] for i in np.flatnonzero(labels == label)])
           .intersection(footprint) for label in ids}
    raw, labels, excluded, diagnostics = _regularize_regions(
        raw, samples, labels, cell, max(width, cell * 2), rise, tolerance)
    ids, counts = np.unique(labels[~excluded], return_counts=True)
    # The broadest surface receives the remaining footprint, including the
    # narrow registration fringe. No invented roofs outside the source outline.
    dominant = int(ids[np.argmax(counts)])
    ordering = sorted((int(i) for i in ids if i != dominant),
                      key=lambda i: (-float(np.median(samples[labels == i, 2])), i))
    remaining, patches, refined = footprint, [], 0
    assigned_raw = []
    assigned_labels = []
    sample_tree = STRtree(make_points(samples[:, :2]))
    observation_tree = STRtree(make_points(observations[:, :2])) if len(observations) else None
    edge_strip = footprint.boundary.buffer(cell * .5)
    for label in ordering:
        region = raw[label]
        included_labels = {label}
        if assigned_raw and any(p.interiors for p in facets.pieces(region)):
            higher = unary_union(assigned_raw)
            filled = []
            for piece in facets.pieces(region):
                holes = []
                for ring in piece.interiors:
                    hole = Polygon(ring)
                    if hole.intersection(higher).area >= hole.area * .75:
                        included_labels.update(i for i in assigned_labels
                                               if raw[i].intersection(hole).area > 1e-8)
                    else:
                        holes.append(ring.coords)
                filled.append(Polygon(piece.exterior, holes))
            region = unary_union(filled)
        if len(observations):
            # A label is selected by local XY support AND elevation agreement;
            # proximity alone pushes high roofs into neighboring lower roofs.
            near = region.boundary.buffer(cell * 2)
            local = observations[observation_tree.query(near, predicate='contains')]
            if len(local):
                query = make_points(local[:, :2])
                a, b = sample_tree.query(query, predicate='dwithin', distance=cell * 2)
                score = (np.sum((local[a, :2]-samples[b, :2])**2, axis=1) / cell**2
                         + ((local[a, 2]-samples[b, 2]) / max(.5, cell))**2)
                order = np.lexsort((b, score, a))
                first = order[np.r_[True, np.diff(a[order]) != 0]]
                chosen = local[a[first]].copy()
                chosen[:, 2] = np.isin(labels[b[first]], sorted(included_labels)).astype(float)
                candidate = measured_tier_boundary(region, chosen, .5, cell, width)
                if not candidate.equals(region):
                    region = candidate
                    refined += 1
        # Favor authoritative mapped section boundaries only when the measured
        # region corroborates them; source heights never enter this fit.
        matches = [p.intersection(footprint) for p in parts if p.is_valid and not p.is_empty
                   and p.intersection(region).area / max(p.union(region).area, 1e-12) >= .85]
        if matches:
            region = max(matches, key=lambda p: p.intersection(region).area / p.union(region).area)
        if assigned_raw and any(p.interiors for p in facets.pieces(region)):
            # A hole occupied by an already fitted upper roof must share that
            # roof's new boundary. Keeping its old hole contour leaves deep
            # podium-height slivers between two independently refined tiers.
            higher = unary_union(assigned_raw)
            filled = []
            for piece in facets.pieces(region):
                holes = [h.coords for h in piece.interiors
                         if Polygon(h).intersection(higher).area < Polygon(h).area * .75]
                filled.append(Polygon(piece.exterior, holes))
            region = unary_union(filled)
        region = region.simplify(cell * .15, preserve_topology=True)
        # Contour fitting must not peel a sliver off the authoritative exterior
        # or a courtyard wall. Such a sliver would receive another region's
        # plane extrapolated across an entire roof (especially at a gable eave).
        region = region.difference(edge_strip).union(raw[label].intersection(edge_strip))
        region = region.intersection(remaining)
        if region.is_empty or region.area < raw[label].area * .75:
            raise facets.UnsupportedFit('unresolved surface boundary')
        patches.append((region, samples[(labels == label) & ~excluded]))
        remaining = remaining.difference(region)
        assigned_raw.append(raw[label])
        assigned_labels.append(label)
    patches.append((remaining, samples[(labels == dominant) & ~excluded]))
    return patches, refined, diagnostics


def fit_surface_roof(footprint, samples, cell, scale=(.07, .077),
                     boundary_samples=(), part_footprints=()):
    """Return a complete surface envelope, or an explicit conservative fallback.

    This entry point is independent of terrace fitting. A failure never publishes
    only the successfully fitted low portions of a complex building.
    """
    width, rise, tolerance = surface_parameters(scale)
    if len(samples) < 6:
        return None, 'insufficient surface support'
    samples = samples[np.lexsort((samples[:, 2], samples[:, 1], samples[:, 0]))]
    try:
        # Clipping can retain isolated line/point contacts alongside the roof.
        # GeometryCollection has no boundary; only its areal pieces define the
        # envelope. Leave ordinary footprints unchanged, including ring order.
        if footprint.geom_type not in ('Polygon', 'MultiPolygon'):
            footprint = unary_union(facets.pieces(footprint))
        if footprint.is_empty or footprint.area <= 0:
            raise facets.UnsupportedFit('empty surface footprint')
        labels, clean, diagnostics = segment_surfaces(samples, cell, width)
        if len(np.unique(labels)) > facets.MAX_FACETS:
            raise facets.UnsupportedFit('roof region budget')
        patches, refined, partition_diagnostics = _patches(footprint, clean, labels, cell, width,
            rise, tolerance, np.asarray(boundary_samples), part_footprints)
        diagnostics.update(partition_diagnostics)
        patches, spatial_diagnostics = clean_partition(patches, cell, width)
        diagnostics.update(spatial_diagnostics)
        diagnostics['surface_retained_samples'] = sum(len(support) for _region, support in patches)
        fits = [_plane(support, tolerance, rise) for _region, support in patches]
        reconciled = reconcile_planar_junctions(patches, cell, tolerance,
                                               observations=boundary_samples, fits=fits)
        diagnostics['surface_reconciled_patches'] = sum(
            not a[0].equals(b[0]) for a, b in zip(patches, reconciled))
        patches = reconciled
        surfaces, errors, planar_count, regularized = [], [], 0, []
        for (region, support), fit in zip(patches, fits):
            if fit is not None:
                center, coef, error = fit
                fitted = _planar_surfaces(region, center, coef)
                planar_count += 1
            else:
                fitted, error = [], 0.
                try:
                    for piece in facets.pieces(region):
                        if piece.area <= 1e-8:
                            continue
                        # Keep logical sample ownership across regularized contours,
                        # while assigning disconnected patches only nearby evidence.
                        nearby = support[contains_xy(piece.buffer(cell * 2), support[:, 0], support[:, 1])]
                        part, residual = facets.patch_facets(piece, nearby, cell, tolerance,
                            facets.MAX_FACETS-len(surfaces)-len(fitted), surface_owned=True)
                        fitted.extend(part)
                        error = max(error, residual)
                except facets.UnsupportedFit as exc:
                    # A noisy, undersampled patch may not justify a curved roof.
                    # Prefer a supported plane at fine-feature print resolution
                    # over hundreds of interpolated spikes or a whole-building
                    # terrace fallback. Meaningful curvature exceeding this
                    # explicit error bound still requires the continuous fit.
                    fit = _plane(support, max(tolerance, .1 / scale[1]))
                    if fit is None:
                        raise
                    center, coef, error = fit
                    fitted = _planar_surfaces(region, center, coef)
                    regularized.append({'reason': str(exc), 'p95_m': error,
                                        'area_m2': float(region.area)})
                    planar_count += 1
            if not fitted:
                raise facets.UnsupportedFit('empty fitted surface')
            surfaces.extend(fitted)
            errors.append(error)
            if len(surfaces) > facets.MAX_FACETS:
                raise facets.UnsupportedFit('roof facet budget')
        if any(sum(len(ring) for ring in s['geometry']['coordinates']) > 4096 for s in surfaces):
            raise facets.UnsupportedFit('roof polygon vertex budget')
        polygons = [Polygon(s['geometry']['coordinates'][0],
                            s['geometry']['coordinates'][1:]) for s in surfaces]
        area = sum(p.area for p in polygons)
        if abs(area-footprint.area) > max(.002, footprint.area*.001):
            raise facets.UnsupportedFit('incomplete surface envelope')
        heights = [v[2] for s in surfaces for ring in s['geometry']['coordinates'] for v in ring]
        low, high = min(heights), max(heights)
        if low <= 2 or high > float(np.max(clean[:, 2])) + max(2, cell * 3):
            raise facets.UnsupportedFit('unsupported surface extrapolation')
        for surface in surfaces:
            surface['bottom_m'] = float(low)
        return {'height_m': float(low), 'tiers': [], 'roof_surfaces': surfaces,
                'method': 'faceted_roof', 'surface_reconstruction': 'coherent_regions',
                'roof_fit_p95_m': max(errors), 'roof_patch_count': len(patches),
                'planar_patch_count': planar_count, 'faceted_patch_count': len(patches)-planar_count,
                'measured_tier_boundaries': refined, 'surface_diagnostics': diagnostics,
                'regularized_surface_patches': regularized}, None
    except (facets.UnsupportedFit, np.linalg.LinAlgError, GEOSException) as exc:
        return None, str(exc)
