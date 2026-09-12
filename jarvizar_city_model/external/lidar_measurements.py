"""Footprint-constrained roof evidence and reconstruction (no bpy).

Uses NumPy and Shapely only in the external environment. The output contains
clean planar surface polygons and ground-relative heights, never raw points.
"""
from __future__ import annotations

import math
from collections import Counter

import numpy as np
from shapely import contains_xy
from shapely.affinity import rotate
from shapely.geometry import MultiPoint, Polygon, box, mapping, shape
from shapely.ops import transform as map_geometry, unary_union
try:
    from .lidar_selection import construction_year, top_height
except ImportError:
    from lidar_selection import construction_year, top_height


class PointIndex:
    def __init__(self, points, cell=64.0):
        self.points, self.cell, self.buckets = points, cell, {}
        if not len(points):
            return
        keys = np.floor(points[:, :2] / cell).astype(np.int64)
        order = np.lexsort((keys[:, 1], keys[:, 0]))
        sorted_keys = keys[order]
        breaks = np.flatnonzero(np.any(sorted_keys[1:] != sorted_keys[:-1], axis=1)) + 1
        for group in np.split(order, breaks):
            self.buckets[tuple(keys[group[0]])] = group

    def query(self, bounds):
        x0, y0, x1, y1 = bounds
        selected = []
        for x in range(math.floor(x0 / self.cell), math.floor(x1 / self.cell) + 1):
            for y in range(math.floor(y0 / self.cell), math.floor(y1 / self.cell) + 1):
                indices = self.buckets.get((x, y))
                if indices is not None:
                    selected.append(indices)
        return self.points[np.concatenate(selected)] if selected else np.empty((0, self.points.shape[1]))


def occupied_area(keys, region, cell):
    """Area inside the tested region, not the full squares crossing its edge."""
    return sum(box(x*cell, y*cell, (x+1)*cell, (y+1)*cell).intersection(region).area
               for x,y in keys)


def observed_empty_area(footprint, points, ground):
    """Positive ground observations, not missing returns, indicate absence."""
    interior = footprint.buffer(-1.5)
    if interior.is_empty:
        return False
    inside = points[contains_xy(interior, points[:, 0], points[:, 1])]
    ground_cells, roof_cells = Counter(), set()
    for row in inside:
        key = tuple(np.floor(row[:2]/3).astype(int))
        if row[3] == 2 and abs(row[2]-ground) < 2:
            ground_cells[key] += 1
        elif row[3] in (1, 6) and row[2]-ground > 2:
            roof_cells.add(key)
    empty = [key for key,count in ground_cells.items() if count >= 3 and key not in roof_cells]
    return (len(empty) >= 4 and len(empty)*9 >= interior.area*.2
            and occupied_area(empty, interior, 3) >= interior.area*.2)


def polygons(geometry):
    if geometry.geom_type == "Polygon":
        return [geometry] if not geometry.is_empty else []
    if geometry.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [p for child in geometry.geoms for p in polygons(child)]
    return []


def ground_reference(footprint, index, margin=25.0):
    neighborhood = footprint.buffer(margin)
    samples = index.query(neighborhood.bounds)
    if not len(samples):
        return None
    mask = ((samples[:, 3] == 2) & contains_xy(neighborhood, samples[:, 0], samples[:, 1])
            & ~contains_xy(footprint, samples[:, 0], samples[:, 1]))
    ground = samples[mask]
    if len(ground) < 20:
        return None
    # Equal-weight 4 m ground cells prevent a dense scan strip from dominating.
    groups = {}
    for row in ground:
        groups.setdefault(tuple(np.floor(row[:2] / 4).astype(int)), []).append(row[:3])
    ground = np.array([np.median(rows, axis=0) for rows in groups.values()])
    if len(ground) < 8:
        return None
    center = np.array(footprint.centroid.coords[0])
    # Require surrounding ground: extrapolating a whole building from a tiny
    # patch on one side is unsafe on hills and beside elevated plazas.
    hull = MultiPoint(ground[:, :2]).convex_hull
    if not hull.buffer(2).covers(footprint.representative_point()):
        return None
    design = np.column_stack((ground[:, :2] - center, np.ones(len(ground))))
    keep = np.ones(len(ground), dtype=bool)
    for _ in range(3):
        if keep.sum() < 8:
            return None
        coef, _, rank, _ = np.linalg.lstsq(design[keep], ground[keep, 2], rcond=None)
        if rank < 3:
            return None
        residual = ground[:, 2] - design @ coef
        keep = np.abs(residual) < max(0.5, 3 * np.median(np.abs(residual[keep])))
    if np.sqrt(np.mean(residual[keep] ** 2)) > 1.0:
        return None
    outline = np.array([xy for p in polygons(footprint) for xy in p.exterior.coords])
    elevations = (outline - center) @ coef[:2] + coef[2]
    return float(elevations.min())


def measure_building(footprint, index, min_width_m, min_step_m, ground_m=None, roof_planes=True, part_footprints=(), neighboring_footprints=(), allow_complex_height=False, roof_mode='TERRACES', surface_scale=None):
    """Retry coverage failures at bounded grid offsets, without adding returns.

    Three fixed half-cell shifts reduce sensitivity to returns split across
    cell boundaries. Every fit still needs three returns per supported cell,
    85% coverage of every footprint component, and the full consistency and
    printability checks. Missing roofs are never interpolated. Preserve the
    initial fit exactly when it works; use the first complete retry otherwise.
    Retry only near misses (at least 80% supported area in every component).
    """
    if footprint.geom_type not in ('Polygon', 'MultiPolygon'):
        footprint = unary_union(polygons(footprint))
    if not footprint.is_valid or footprint.is_empty or footprint.area < 4:
        return None, 'invalid_or_small_footprint'
    anchor = None
    if ground_m is None:
        ground_m = ground_reference(footprint, index)
        if ground_m is None:
            try:
                from .lidar_ground import ground_anchor
            except ImportError:
                from lidar_ground import ground_anchor
            anchor = ground_anchor(footprint, index)
            if anchor is not None:
                ground_m = anchor[2]
    if ground_m is None:
        return None, 'insufficient_ground'
    if roof_planes and roof_mode == 'FACETED':
        sx, sz = surface_scale or (.07, .077)
        min_width_m, min_step_m = .1 / sx, max(.25, .05 / sz)
    options = dict(ground_m=ground_m, roof_planes=roof_planes, part_footprints=part_footprints,
                   neighboring_footprints=neighboring_footprints, allow_complex_height=allow_complex_height,
                   detailed_surfaces=roof_planes and roof_mode == 'FACETED', surface_scale=surface_scale)
    coverage = {}
    result, reason = _measure_building(footprint, index, min_width_m, min_step_m, coverage_out=coverage, **options)
    def aligned(record):
        if record and anchor is not None:
            record['ground_anchor'] = [anchor[0], anchor[1], 0.]
            record['ground_reference'] = 'surrounding_ground_anchor'
        return record
    if reason != 'footprint_roof_mismatch' or coverage.get('minimum_component', 0) < .8:
        return aligned(result), reason
    for offset in ((.5, 0), (0, .5), (.5, .5)):
        details = {}
        recovered, recovered_reason = _measure_building(footprint, index, min_width_m, min_step_m,
                                                       grid_offset=offset, coverage_out=details, **options)
        if recovered:
            recovered['coverage_grid_offset'] = list(offset)
            return aligned(recovered), recovered_reason
    return aligned(result), reason


def _measure_building(footprint, index, min_width_m, min_step_m, ground_m=None, roof_planes=True, part_footprints=(), neighboring_footprints=(), allow_complex_height=False, grid_offset=(0, 0), coverage_out=None, detailed_surfaces=False, boundary_refinement=True, surface_scale=None):
    """Measure the whole roof envelope; hidden undersides stay source-derived.

    Roof Envelope uses supported upper returns before the legacy terrace
    reconstruction below. Terraces alone filters islands by width/area and
    reduces unsupported continuous slopes to a conservative height fallback.
    """
    if not footprint.is_valid or footprint.is_empty or footprint.area < 4:
        return None, "invalid_or_small_footprint"
    ground = ground_reference(footprint, index) if ground_m is None else ground_m
    if ground is None:
        return None, "insufficient_ground"
    points = index.query(footprint.bounds)
    if len(points) < 20:
        return None, "insufficient_roof_points"
    inside = contains_xy(footprint, points[:, 0], points[:, 1])
    if observed_empty_area(footprint, points, ground):
        return None, 'observed_ground_in_footprint'
    # Class 6 and single-return unclassified points are usable only
    # when the subsequent coverage/flatness tests corroborate a broad surface.
    candidate = inside & ((points[:, 3] == 6) | ((points[:, 3] == 1) & (points[:, 4] == 1)))
    # Automated classifiers file a large share of articulated or glazed facade
    # returns under a vegetation class; in this survey that is most of the
    # facade of every tower. They never establish coverage, ground or height
    # here, and reconstruction admits them only where the structural envelope
    # already reaches that level, so a real canopy cannot raise a roof.
    secondary = points[inside & np.isin(points[:, 3], (3, 4, 5))
                       & (points[:, 2] - ground > 2.0)][:, :3].copy()
    secondary[:, 2] -= ground
    points = points[candidate]
    points = points[points[:, 2] - ground > 2.0]
    if len(points) < 20:
        return None, "insufficient_roof_points"
    rectangle = footprint.minimum_rotated_rectangle
    corners = list(rectangle.exterior.coords)
    edge = max(zip(corners, corners[1:]), key=lambda ab: math.dist(*ab))
    angle = math.atan2(edge[1][1] - edge[0][1], edge[1][0] - edge[0][0])
    cosine, sine = math.cos(angle), math.sin(angle)
    origin = footprint.centroid.coords[0]
    rotated = rotate(footprint, -angle, origin=origin, use_radians=True)
    xy = points[:, :2] - origin
    uv = np.column_stack((xy[:, 0] * cosine + xy[:, 1] * sine,
                          -xy[:, 0] * sine + xy[:, 1] * cosine)) + origin
    cell = 1.5 if detailed_surfaces else max(1.5, min_width_m / 3)
    x0, y0, x1, y1 = rotated.bounds
    x0 -= cell * grid_offset[0]
    y0 -= cell * grid_offset[1]
    nx, ny = math.ceil((x1 - x0) / cell), math.ceil((y1 - y0) / cell)
    if nx * ny > 40000:
        return None, "footprint_cell_budget"
    groups = {}
    for row, pos in zip(points, uv):
        key = (math.floor((pos[0] - x0) / cell), math.floor((pos[1] - y0) / cell))
        groups.setdefault(key, []).append(row)
    cells, samples, facet_samples, expected, supported_points = {}, {}, {}, 0, 0
    boundary_samples = []
    expected_by_piece, supported_by_piece = Counter(), Counter()
    supported_area_by_piece = Counter()
    pieces = polygons(rotated)
    for ix in range(nx):
        for iy in range(ny):
            tile = box(x0 + ix * cell, y0 + iy * cell, x0 + (ix + 1) * cell, y0 + (iy + 1) * cell)
            area = tile.intersection(rotated).area
            if area < cell * cell * 0.25:
                continue
            expected += 1
            component = 0 if len(pieces)==1 else max(range(len(pieces)), key=lambda i: tile.intersection(pieces[i]).area)
            expected_by_piece[component] += 1
            rows = np.asarray(groups.get((ix, iy), []))
            if len(rows) < 3:
                continue
            z = np.sort(rows[:, 2] - ground)
            # Multiple returns at the same XY can be a facade, a low podium,
            # and the actual roof. Class 6 is not an absolute priority: the
            # Cook County survey leaves Willis Tower's upper roofs in class 1
            # while classifying its low podium as 6. Select the highest dense
            # narrow band, then demand broad coherent support across cells.
            ends = np.searchsorted(z, z + max(0.8, cell * 0.4), side="right")
            support = ends - np.arange(len(z))
            # A tall facade can contribute thousands of returns through one
            # column. Requiring a roof band to contain 6% of the entire column
            # rejects a well-sampled upper roof simply because more wall data
            # was acquired. Detailed envelopes compare local band support;
            # legacy terraces retain their established acceptance policy.
            column_floor = 0 if detailed_surfaces else int(math.ceil(len(z)*.06))
            enough = support >= max(3, int(math.ceil(support.max() * 0.25)), column_floor)
            starts = np.flatnonzero(enough)
            if not len(starts):
                continue
            start = starts[-1]
            cells[(ix, iy)] = float(np.median(z[start:ends[start]]))
            if detailed_surfaces and boundary_refinement:
                # The coarse band proves coverage only. Let the upper-envelope
                # fitter see all usable returns in a supported cell: trimming
                # to that one band erased small caps and the lower parts of
                # steep/curved surfaces before reconstruction even began.
                selected = rows[:, :3].copy()
                selected[:, 2] -= ground
                boundary_samples.append(selected)
            supported_by_piece[component] += 1
            supported_area_by_piece[component] += (area if len(pieces)==1
                else tile.intersection(pieces[component]).area)
            supported_points += int(ends[start]-start)
            band = rows[np.argsort(rows[:,2], kind='stable')[start:ends[start]]]
            # The XYZ centroid stays exactly on a plane; independent medians
            # do not, particularly on oblique slopes and at cell boundaries.
            samples[(ix, iy)] = [float(np.mean(band[:,0])), float(np.mean(band[:,1])), float(np.mean(band[:,2])-ground)]
            # Include every tie at a supported band's endpoints and sum in a
            # stable XYZ order. A faceted triangulation must not move its sample
            # vertices when acquisition happens to reorder equal-height returns.
            facet_band = rows[(rows[:,2]-ground >= z[start]) & (rows[:,2]-ground <= z[ends[start]-1])]
            facet_band = facet_band[np.lexsort((facet_band[:,2], facet_band[:,1], facet_band[:,0]))]
            facet_samples[(ix, iy)] = [float(np.mean(facet_band[:,0])), float(np.mean(facet_band[:,1])), float(np.mean(facet_band[:,2])-ground)]
    coverage = len(cells) / max(expected, 1)
    area_coverage = False
    if coverage < 0.65 or len(cells) < 4:
        return None, "sparse_or_noisy_roof"
    if coverage < .85 or any(supported_by_piece[i] < count*.85 for i,count in expected_by_piece.items()):
        # A clipped boundary cell is not a full missing roof square. Retry the
        # same 85% check using actual supported footprint area, including every
        # polygon component. No extra points, interpolated cells or lower point
        # thresholds enter the measurement. Already accepted fits stay intact.
        coverage = sum(supported_area_by_piece.values()) / footprint.area
        if coverage_out is not None:
            coverage_out['minimum_component'] = min([coverage] + [
                supported_area_by_piece[i] / piece.area for i,piece in enumerate(pieces)])
        if coverage < .85 or any(supported_area_by_piece[i] < piece.area*.85
                                  for i,piece in enumerate(pieces)):
            return None, 'footprint_roof_mismatch'
        area_coverage = True
    # A broad classified roof beyond the outline can indicate an enlarged or
    # replaced building. Ignore modest registration error and mapped neighbors.
    ring = footprint.buffer(6).difference(footprint.buffer(2))
    if neighboring_footprints:
        ring = ring.difference(unary_union(neighboring_footprints).buffer(1))
    outside = index.query(ring.bounds) if not ring.is_empty else np.empty((0, index.points.shape[1]))
    if len(outside):
        outside = outside[(outside[:,3] == 6) & contains_xy(ring, outside[:,0], outside[:,1])]
        heights = np.sort(list(cells.values()))
        occupied = Counter()
        for row in outside:
            z = row[2]-ground
            pos = np.searchsorted(heights, z)
            if min(abs(z-heights[min(pos,len(heights)-1)]), abs(z-heights[max(0,pos-1)])) <= 2:
                occupied[tuple(np.floor(row[:2]/3).astype(int))] += 1
        area = sum(n >= 3 for n in occupied.values())*9
        if area >= max(36, footprint.area*.08) and area >= ring.area*.25:
            # Neighbor masks and the narrow test ring often clip most of a
            # square. Counting its full area exaggerated apparent extensions.
            area = occupied_area((key for key,n in occupied.items() if n >= 3), ring, 3)
            if area >= max(36, footprint.area*.08) and area >= ring.area*.25:
                return None, 'roof_extends_outside_footprint'

    # Detailed reconstruction starts at supported samples, before scalar roof
    # levels or terrace outlines can constrain the representation. Acquisition,
    # ground, per-component coverage and footprint contradiction guards above
    # are shared with Terraces mode.
    surface_fallback = None
    if detailed_surfaces:
        try:
            from .lidar_envelope import fit_roof_envelope
        except ImportError:
            from lidar_envelope import fit_roof_envelope
        fitted, surface_fallback = fit_roof_envelope(
            footprint, np.array([facet_samples[key] for key in sorted(facet_samples)]),
            cell, scale=surface_scale or (.07, .077),
            boundary_samples=np.concatenate(boundary_samples) if boundary_samples else np.empty((0, 3)),
            secondary_samples=secondary)
        if fitted:
            stats = {"ground_m": ground, "roof_points": len(points), "coverage": round(coverage, 4),
                     "cell_m": cell, "classified_fraction": float(np.mean(points[:, 3] == 6)),
                     'roof_support_density_m2': supported_points/footprint.area,
                     'explained_fraction': min(1.0, fitted['surface_diagnostics']
                         ['surface_retained_samples'] / max(expected, 1))}
            if area_coverage:
                stats['coverage_basis'] = 'footprint_area'
            return {**stats, **fitted}, 'faceted_roof'
        # Failure is explicit and transactional. The established terrace path
        # remains a conservative fallback; it is not an input to surface fitting.

    # Flood-fill *continuous* surfaces, then test each region's flatness.
    # A pitched roof remains connected across its small successive rises.
    pending, regions = set(cells), []
    continuous = []
    while pending:
        seed = min(pending)
        pending.remove(seed)
        group, stack = [seed], [seed]
        while stack:
            x, y = stack.pop()
            for other in ((x-1,y), (x+1,y), (x,y-1), (x,y+1)):
                if other in pending and abs(cells[other] - cells[(x,y)]) < min_step_m:
                    pending.remove(other)
                    group.append(other)
                    stack.append(other)
        elevations = np.array([cells[key] for key in group])
        continuous.append(group)
        area = len(group) * cell * cell
        if area < max(min_width_m ** 2, cell * cell * 4):
            continue
        if np.quantile(elevations, 0.9) - np.quantile(elevations, 0.1) > max(1.0, min_step_m * 0.4):
            # HVAC/parapet returns can connect to an otherwise broad flat
            # roof. Keep a dominant elevation consensus, provided it explains
            # most of this connected surface. A distributed slope has no such
            # majority and is handled separately by measured plane fitting.
            order = np.argsort(elevations)
            sorted_z = elevations[order]
            ends = np.searchsorted(sorted_z, sorted_z + max(1.0, min_step_m*.75), side='right')
            starts = np.arange(len(order))
            best = int(np.argmax(ends-starts))
            if ends[best]-best < len(group)*.6:
                continue
            group = [group[i] for i in order[best:ends[best]]]
            elevations = np.array([cells[key] for key in group])
            if len(group)*cell*cell < max(min_width_m**2, cell*cell*4):
                continue
        regions.append((float(np.median(elevations)), group))

    stats = {"ground_m": ground, "roof_points": len(points), "coverage": round(coverage, 4),
             "cell_m": cell, "classified_fraction": float(np.mean(points[:, 3] == 6)),
             'roof_support_density_m2': supported_points/footprint.area,
             'explained_fraction': sum(len(group) for _,group in regions)/max(expected,1)}
    if surface_fallback:
        stats['faceted_fallback'] = surface_fallback
    if area_coverage:
        stats['coverage_basis'] = 'footprint_area'
    if coverage_out is not None:
        coverage_out['samples'] = np.array([facet_samples[key] for key in sorted(facet_samples)])
    if roof_planes and max(map(len, continuous)) >= len(cells)*0.85:
        group = max(continuous, key=len)
        elevations = [cells[key] for key in group]
        if np.quantile(elevations, .9)-np.quantile(elevations, .1) >= min_step_m:
            try:
                from .lidar_planes import fit_roof_planes
            except ImportError:
                from lidar_planes import fit_roof_planes
            fitted = fit_roof_planes(footprint, np.array([samples[key] for key in group]), min_width_m, min_step_m)
            if fitted:
                stats['explained_fraction'] = len(group)/max(expected,1)
                return {**stats, **fitted, 'tiers': [], 'method': 'roof_planes'}, 'roof_planes'
    # A mapped architectural part or missing portion of a mapped assembly can
    # use a robust height without pretending its complex roof is a set of flat
    # terraces. Require dense, coherent returns with classified corroboration.
    # Never use this fallback to flatten an unresolved tower above a podium.
    if allow_complex_height:
        elevations = np.array(list(cells.values()))
        low, median, high, upper = np.quantile(elevations, [.1, .5, .9, .99])
        edges = [abs(height-cells[other]) for (x,y),height in cells.items()
                 for other in ((x+1,y), (x,y+1)) if other in cells]
        coherent = float(np.mean(np.array(edges) < max(3, cell))) if edges else 0
        if (coverage >= .9 and stats['classified_fraction'] >= .4
                and stats['roof_support_density_m2'] >= 1 and coherent >= .8
                and high-low <= max(12, median*.2) and upper-high <= max(5, median*.1)):
            stats['explained_fraction'] = coherent
            record = {**stats, 'height_m': float(high), 'tiers': [],
                      'method': 'supported_roof_height'}
            if regions:
                # A one-metre consensus joins coplanar patches without merging
                # separate shallow roof levels into a false dominant plateau.
                dominant = max(regions, key=lambda item: sum(len(g) for h,g in regions if abs(h-item[0]) < .5))
                support = [cells[key] for h,g in regions if abs(h-dominant[0]) < .5 for key in g]
                if len(support) >= expected*.2:
                    record['supported_base_m'] = float(np.median(support))
            return record, 'height_only'
    if not regions:
        # Unclassified sloping/noisy surfaces need stronger proof than this
        # first pass provides. Classed roofs can safely give one robust height.
        if stats["classified_fraction"] < 0.7:
            return None, "unclassified_nonplanar_roof"
        height = float(np.quantile(list(cells.values()), 0.9))
        return {**stats, "height_m": height, "tiers": [], "method": "roof_p90"}, "height_only"

    regions.sort(key=lambda item: item[0])
    # Merge separate coplanar roof patches into one elevation level.
    levels = []
    for height, group in regions:
        if levels and height - levels[-1][0] < min_step_m:
            old_height, old_group = levels[-1]
            levels[-1] = ((old_height * len(old_group) + height * len(group)) / (len(old_group) + len(group)), old_group + group)
        else:
            levels.append((height, group))
    if len(levels) > 24 or sum(len(group) for _, group in levels) < len(cells) * 0.5:
        if stats["classified_fraction"] < 0.7:
            return None, "complex_unclassified_roof"
        return {**stats, "height_m": float(np.quantile(list(cells.values()), 0.9)),
                "tiers": [], "method": "roof_p90"}, "height_only"
    base_height = levels[0][0]
    boundary_samples = np.concatenate(boundary_samples) if boundary_samples else np.empty((0, 3))
    tiers = []
    tier_sample_regions = []
    support = footprint
    lower = base_height
    for level_index in range(1, len(levels)):
        height = levels[level_index][0]
        # All supported higher returns contribute to the mass beneath them,
        # including non-flat roof edges omitted by plateau fitting. Using only
        # the accepted flat patches hollowed towers and erased narrow crowns.
        supported = [key for key,height in cells.items() if height >= levels[level_index][0] - min_step_m]
        region = unary_union([box(x0+x*cell,y0+y*cell,x0+(x+1)*cell,y0+(y+1)*cell) for x,y in supported])
        region = region.buffer(cell*.55, join_style=2).buffer(-cell*.55, join_style=2)
        region = unary_union([Polygon(p.exterior) for p in polygons(region)])
        sample_region = rotate(region, angle, origin=origin, use_radians=True)
        contour_regularized = False
        measured_boundary = False
        if detailed_surfaces:
            try:
                from .lidar_contours import regularize_grid_contours
            except ImportError:
                from lidar_contours import regularize_grid_contours
            candidate = regularize_grid_contours(region, cell)
            contour_regularized = not candidate.equals(region)
            region = candidate
        region = rotate(region, angle, origin=origin, use_radians=True)
        if (detailed_surfaces and boundary_refinement
                and height-lower >= max(2.0, min_step_m * 4)):
            try:
                from .lidar_boundaries import measured_tier_boundary
            except ImportError:
                from lidar_boundaries import measured_tier_boundary
            candidate = measured_tier_boundary(sample_region, boundary_samples,
                (lower + height) * .5, cell, min_width_m)
            if not candidate.equals(sample_region):
                region = candidate
                contour_regularized = True
                measured_boundary = True
                if coverage_out is not None:
                    coverage_out['boundary_refined'] = True
        measured_area = region.intersection(footprint).area
        # Prefer an existing part boundary only when its measured footprint
        # agrees with this plateau. Part heights never replace LiDAR heights.
        matches = [p.intersection(footprint) for p in part_footprints if p.is_valid
                   and not p.is_empty and p.area >= min_width_m**2
                   and p.intersection(region).area / p.union(region).area >= 0.8]
        if matches:
            candidate = max(matches, key=lambda p: p.intersection(region).area / p.union(region).area)
            if candidate.symmetric_difference(region).area <= region.area*0.2:
                region = candidate
                contour_regularized = False
                measured_boundary = False
                stats['part_boundaries_used'] = stats.get('part_boundaries_used', 0)+1
        # Morphological opening removes sub-nozzle strips. Its extent remains
        # bounded by measured cells and the authoritative footprint.
        radius = min_width_m / 2
        region = region.buffer(-radius, join_style=2).buffer(radius, join_style=2)
        # Reconstructed stair midpoints already use a bounded contour fit.
        # A second coarse simplification would move them back toward stair
        # corners. Source/unchanged outlines retain the established tolerance.
        region = region.simplify(cell * (0.1 if contour_regularized else 0.45),
                                 preserve_topology=True).intersection(support)
        keep = [p for p in polygons(region) if p.is_valid and p.area >= min_width_m ** 2
                and not p.buffer(-radius * 0.9).is_empty]
        if not keep:
            # Never quietly replace a tall building by its low podium when
            # an essential upper mass could not survive regularization.
            return None, 'unprintable_major_tier'
        region = unary_union(keep)
        if region.area < measured_area * .8:
            # Losing a supported section is a failed envelope, even when a
            # different section at the same height survives width filtering.
            return None, 'unprintable_major_tier'
        if tiers and region.equals(support):
            tiers[-1]['top_m'] = height
            lower = height
            continue
        if measured_boundary:
            stats['measured_tier_boundaries'] = stats.get('measured_tier_boundaries', 0) + 1
        tiers.append({"bottom_m": lower, "top_m": height, "geometry": mapping(region)})
        tier_sample_regions.append(sample_region)
        support, lower = region, height
    # A supported high roof that was too complex to reconstruct must not be
    # swallowed by a lower accepted plateau. Preserve source geometry here.
    higher = [key for key in cells if cells[key] > lower + min_step_m]
    if len(higher) >= max(4, len(cells)*.1) and len(higher)*cell*cell >= min_width_m**2:
        return None, 'unresolved_upper_roof'
    if coverage_out is not None:
        coverage_out['tier_sample_regions'] = tier_sample_regions
    return {**stats, "height_m": base_height, "tiers": tiers,
            "method": "flat_regions"}, "tiers" if tiers else "height_only"


def measure_source_parts(feature, parts, footprint, index, min_width_m, min_step_m, roof_planes=True, prefer_lidar=False):
    """Supplement an incomplete mapped assembly and retain its architecture.

    Only existing OSM part identities receive height corrections. Missing main
    mass is the exact footprint minus mapped parts, including real courtyards.
    Every component shares the same survey ground. No raw-point mesh is made.
    """
    try:
        from .lidar_source import height_decision, height_metres, estimated_height, strong_measurement, regional_top
    except ImportError:
        from lidar_source import height_decision, height_metres, estimated_height, strong_measurement, regional_top
    ground = ground_reference(footprint, index)
    if ground is None:
        return None, 'insufficient_ground'
    if observed_empty_area(footprint, index.query(footprint.bounds), ground):
        return None, 'observed_ground_in_footprint'
    remainder = footprint.difference(unary_union([geometry for _,geometry in parts]))
    needs_infill = remainder.area >= max(min_width_m**2, footprint.area*.15)
    infill, corrections, evidence, skipped = None, {}, [], {}
    if needs_infill:
        infill, reason = measure_building(remainder, index, min_width_m, min_step_m,
            ground_m=ground, neighboring_footprints=[footprint], allow_complex_height=True, roof_planes=roof_planes)
        if not infill:
            return None, reason
        # A complex main roof can still supply a strongly supported eave/base
        # level. Do not inflate the entire missing mass to its rooftop clutter.
        if 'supported_base_m' in infill:
            infill['height_m'] = infill['supported_base_m']
        evidence.append(infill)
    for part, geometry in parts:
        props = part.get('properties') or {}
        identifier = str(part.get('id') or props.get('id') or '')
        if geometry.area < min_width_m**2 or props.get('min_height') or props.get('min_floor'):
            skipped[identifier] = 'small_or_elevated_part'
            continue
        # The source retains this part's shape; only its scalar height is used.
        # Aggregate a few metres of roof to avoid fragmenting a shaped crown
        # into tiny noisy plateaus when fine terrace settings are requested.
        record, reason = measure_building(geometry.intersection(footprint), index,
            max(min_width_m, 6.0), max(min_step_m, 2.0),
            ground_m=ground, neighboring_footprints=[footprint], allow_complex_height=True, roof_planes=roof_planes)
        if record is None:
            skipped[identifier] = reason
            continue
        observed = top_height(record)
        # One height must describe this source part, not a narrow spill from a
        # neighboring higher roof. Check its interior before collapsing tiers.
        # Keep the full outline when an inset would consume most of the part.
        interior = geometry.intersection(footprint).buffer(-max(2.0, record['cell_m']))
        if interior.area >= geometry.area * .25:
            observed = regional_top(record, interior, footprint)
        decision = height_decision(props, observed, strong_measurement(record))
        if decision == 'source_height_conflict' and not prefer_lidar:
            return None, decision
        if decision == 'weak_height_correction' and not prefer_lidar:
            skipped[identifier] = decision
            continue
        # Keep good explicit architectural tops. Missing/floor-derived and
        # externally estimated heights can improve while roof shapes survive.
        if prefer_lidar or not height_metres(props) or estimated_height(props) or decision == 'corrected_estimated_height':
            corrections[identifier] = observed
            evidence.append(record)
    if not evidence:
        return None, 'no_source_part_improvement'
    result = dict(infill or max(evidence, key=top_height))
    result.update(method='source_parts', part_heights=corrections, parts_skipped=skipped)
    if infill:
        result['infill_geometry'] = mapping(remainder)
    else:
        result['height_m'] = max(corrections.values())
        result['tiers'] = []
        result.pop('roof_surfaces', None)
    observed_top = max([top_height(result)] + [height_metres(p.get('properties') or {}) for p,_ in parts])
    decision = height_decision(feature.get('properties') or {}, observed_top, all(strong_measurement(r) for r in evidence))
    if decision in ('source_height_conflict', 'weak_height_correction') and not prefer_lidar:
        return None, decision
    result['height_decision'] = 'lidar_preferred' if prefer_lidar else decision
    result['source_height_decision'] = decision
    return result, 'source_parts'


def _ring_area(ring):
    x, y = ring[0][:2]
    return abs(sum((a[0]-x)*(b[1]-y)-(b[0]-x)*(a[1]-y) for a, b in zip(ring, ring[1:])))


def measure_features(features, points, to_metric, to_geographic, min_width_m, min_step_m, roi, roof_planes=True, parts_by_parent=None, observations_out=None, neighbors_by_id=None, source_parts_by_parent=None, prefer_lidar=False, roof_mode='TERRACES', surface_scale=None, progress_callback=None):
    """One survey at a time; return measurements keyed by original feature ID."""
    index = PointIndex(points)
    results, counts, rejected = {}, Counter(), {}
    for position, feature in enumerate(features):
        identifier = str(feature.get("id") or feature.get("properties", {}).get("id") or "")
        if progress_callback:
            names = (feature.get('properties') or {}).get('names')
            name = (names.get('primary') if isinstance(names, dict) else None) or identifier
            progress_callback(position, len(features), str(name))
        footprint = map_geometry(to_metric, shape(feature["geometry"]))
        # Avoid lowering an entire building based on a clipped corner of its
        # roof. The halo permits buildings just outside the selected boundary.
        if not roi.covers(footprint.buffer(25)):
            counts["incomplete_footprint_or_ground_halo"] += 1
            rejected[identifier] = "incomplete_footprint_or_ground_halo"
            continue
        props = feature.get("properties") or {}
        if props.get("is_underground") or (props.get("min_height") or props.get("min_floor")):
            counts["elevated_or_underground"] += 1
            rejected[identifier] = "elevated_or_underground"
            continue
        local = index.query(footprint.buffer(25).bounds)
        local = local[contains_xy(footprint.buffer(25), local[:,0], local[:,1])]
        dated = {'capture_year':None, 'date_basis':'unknown'}
        reason, measured = None, None
        if local.shape[1] >= 7 and len(local) and np.any(local[:,5] > 0):
            known = local[local[:,5] > 0]
            years, numbers = np.unique(known[:,5], return_counts=True)
            significant = years[numbers >= max(20, len(local)*.1)]
            dated = {'capture_year':int(max(years)), 'date_basis':
                     'gps_declared' if np.all(known[:,6] == 1) else
                     'reported_acquisition' if np.all(known[:,6] == .75) else 'gps_inferred_ept'}
            # Do not reconstruct a roof from different annual capture epochs,
            # even if a provider has combined them under one project name.
            if len(known) < len(local)*.9 or len(significant) != 1:
                reason = 'mixed_capture_epochs'
            else:
                dated['capture_year'] = int(significant[0])
                local = local[local[:,5] == significant[0]]
        built = construction_year(props)
        predates = bool(built and dated['capture_year'] and dated['capture_year'] < built)
        if predates and not prefer_lidar:
            reason = 'predates_building'
        if reason is None and props.get('lidar_surface_kind') == 'rock':
            try:
                from .lidar_rock import measure_rock_surface
            except ImportError:
                from lidar_rock import measure_rock_surface
            measured, reason = measure_rock_surface(footprint, PointIndex(local), surface_scale or (.07, .077))
        elif reason is None:
            measured, reason = measure_building(footprint, PointIndex(local), min_width_m, min_step_m,
                roof_planes=roof_planes, roof_mode=roof_mode, surface_scale=surface_scale, part_footprints=(parts_by_parent or {}).get(identifier, ()),
                neighboring_footprints=(neighbors_by_id or {}).get(identifier, ()))
        source_parts = (source_parts_by_parent or {}).get(identifier, ())
        # Source-shaped roofs remain useful even when a whole-envelope fit is
        # too complex. Footprint/epoch contradictions never enter this fallback.
        if source_parts and props.get('has_parts') is True and reason in ('tiers', 'height_only', 'roof_planes', 'faceted_roof',
                'complex_unclassified_roof', 'unclassified_nonplanar_roof',
                'unresolved_upper_roof', 'unprintable_major_tier'):
            shaped = any((p.get('properties') or {}).get('roof_shape') not in (None, '', 'flat') for p,_ in source_parts)
            incomplete = unary_union([g for _,g in source_parts]).intersection(footprint).area < footprint.area*.85
            if (incomplete or shaped) and (not prefer_lidar or measured is None):
                supplement, supplement_reason = measure_source_parts(feature, source_parts, footprint,
                    PointIndex(local), min_width_m, min_step_m, roof_planes=roof_planes, prefer_lidar=prefer_lidar)
                if supplement or supplement_reason == 'source_height_conflict':
                    measured, reason = supplement, supplement_reason
        if measured:
            try:
                from .lidar_source import check_source
            except ImportError:
                from lidar_source import check_source
            decision = (measured.get('height_decision') if measured['method'] == 'source_parts'
                        else check_source(feature, source_parts, measured, footprint))
            if decision in ('source_height_conflict', 'weak_height_correction') and not prefer_lidar:
                measured, reason = None, decision
            else:
                measured.setdefault('source_height_decision', decision)
                measured['height_decision'] = 'lidar_preferred' if prefer_lidar else decision
                if predates:
                    measured['source_date_conflict'] = True
        if observations_out is not None:
            observations_out[identifier] = {**dated, 'reason':reason}
        counts[reason] += 1
        if measured:
            measured.update(dated)
            if 'ground_anchor' in measured:
                x, y, offset = measured['ground_anchor']
                measured['ground_anchor'] = [*to_geographic(x, y), offset]
            if measured.get('surface_kind') == 'rock':
                measured['surface_geometry'] = feature['geometry']
                measured['source_land_ids'] = props['source_land_ids']
                measured['covered_buildings'] = props.get('covered_buildings', [])
            if measured.get('infill_geometry'):
                measured['infill_geometry'] = mapping(map_geometry(to_geographic, shape(measured['infill_geometry'])))
            for tier in measured["tiers"]:
                tier["geometry"] = mapping(map_geometry(to_geographic, shape(tier["geometry"])))
            if measured.get('roof_surfaces'):
                # Shortening the published coordinates saves a fifth of the
                # cache, but the cap's shared vertices have to stay distinct:
                # on a facade two points a centimetre apart differ by metres in
                # height, so coarse rounding would merge them into one vertex
                # with two heights and the whole cap would be rejected. Nine
                # decimals is a fraction of a micron and cannot do that.
                retained = []
                for surface in measured['roof_surfaces']:
                    rings = [[[round(v, 9) for v in to_geographic(x, y)]+[round(z, 4)]
                              for x, y, z in ring] for ring in surface['geometry']['coordinates']]
                    if all(_ring_area(ring) > 0 for ring in rings):
                        surface['geometry']['coordinates'] = rings
                        retained.append(surface)
                measured['roof_surfaces'] = retained
                if measured.get('surface_reconstruction') == 'roof_envelope':
                    # A continuous cap publishes one shared vertex table: its
                    # faces meet at common corners, so an independent polygon
                    # per face repeats every corner about six times over, on
                    # disk and again in the reader's memory.
                    try:
                        from .lidar_records import envelope_mesh
                    except ImportError:
                        from lidar_records import envelope_mesh
                    measured['roof_mesh'] = envelope_mesh(
                        [ring for surface in retained
                         for ring in surface['geometry']['coordinates']])
                    measured.pop('roof_surfaces')
            results[identifier] = measured
        else:
            rejected[identifier] = reason
    if progress_callback:
        progress_callback(len(features), len(features), '')
    return results, dict(counts), rejected
