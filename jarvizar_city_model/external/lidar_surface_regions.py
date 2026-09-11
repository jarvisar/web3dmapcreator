"""Infer connected roof surfaces before making elevation contours.

Input observations are equal-weight, supported cell centroids in metres.  The
grid is only a spatial index: its cells never become height bands. Local robust
planes distinguish a slope from an actual jump. Explicit incompatible edges
remain barriers during agglomeration, so one erroneous connection cannot join
an otherwise well-observed tower wall to its podium.

Only numpy is required. These native calculations run in the external worker,
not in Blender. No footprint, city, or survey-specific rules are used here.
"""
import math

import numpy as np


def _neighbors(samples, cell):
    """Bounded neighborhoods and local adjacency, independent of input order."""
    xy = samples[:, :2]
    radius = cell * 2.75
    buckets = {}
    origin = xy.min(axis=0)
    keys = np.floor((xy - origin) / radius).astype(np.int64)
    for i, key in enumerate(keys):
        buckets.setdefault(tuple(key), []).append(i)
    neighbors = np.full((len(samples), 25), -1, dtype=np.int64)
    edges = []
    for i, (x, y) in enumerate(keys):
        indices = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                   for j in buckets.get((x + dx, y + dy), ())]
        indices = np.asarray(indices, dtype=np.int64)
        distances = np.sum((xy[indices] - xy[i]) ** 2, axis=1)
        order = np.lexsort((indices, distances))
        order = order[distances[order] <= radius * radius][:25]
        neighbors[i, :len(order)] = indices[order]
        # Supported centroids can sit near opposite ends of adjacent cells,
        # especially at a clipped footprint or a partially sampled roof band.
        # Using only nominal centre spacing or a diagonal-grid radius would
        # orphan a valid boundary strip. The surface barriers below decide
        # compatibility; this radius only establishes candidate neighbors.
        adjacent = indices[(indices > i) & (distances <= (cell * 2.05) ** 2)]
        edges.extend((i, int(j)) for j in adjacent)
    return (neighbors, np.asarray(edges, dtype=np.int64).reshape((-1, 2)),
            (buckets, radius, origin))


def _local_planes(samples, neighbors, tolerance):
    """Batched deterministic RANSAC with the observed centre on each hypothesis.

    Anchoring hypotheses prevents a majority podium from erasing a small roof
    near its boundary. Unsupported isolated centres are handled by the later
    spatial support filter, rather than being mistaken for a sloping roof.
    """
    pairs = np.array([(a, b) for a in range(1, 25) for b in range(a + 1, 25)])
    chosen = np.random.default_rng(1701).choice(len(pairs), 64, replace=False)
    pairs = pairs[chosen]
    planes = np.zeros((len(samples), 3), dtype=float)
    support = np.zeros(len(samples), dtype=np.int64)
    noise = np.zeros(len(samples), dtype=float)
    for start in range(0, len(samples), 384):
        stop = min(start + 384, len(samples))
        indices = neighbors[start:stop]
        valid = indices >= 0
        observations = samples[np.maximum(indices, 0)] - samples[start:stop, None, :]
        a, b = observations[:, pairs[:, 0]], observations[:, pairs[:, 1]]
        determinant = a[:, :, 0] * b[:, :, 1] - a[:, :, 1] * b[:, :, 0]
        usable = ((np.abs(determinant) > 1e-6) & valid[:, pairs[:, 0]]
                  & valid[:, pairs[:, 1]])
        determinant = np.where(usable, determinant, 1.)
        slope_x = (a[:, :, 2] * b[:, :, 1] - a[:, :, 1] * b[:, :, 2]) / determinant
        slope_y = (a[:, :, 0] * b[:, :, 2] - a[:, :, 2] * b[:, :, 0]) / determinant
        usable &= slope_x * slope_x + slope_y * slope_y <= 9.
        # A horizontal candidate also works in sparse/one-dimensional support.
        slope_x = np.column_stack((np.zeros(stop - start), slope_x))
        slope_y = np.column_stack((np.zeros(stop - start), slope_y))
        usable = np.column_stack((np.ones(stop - start, dtype=bool), usable))
        residual = np.abs(slope_x[:, :, None] * observations[:, None, :, 0]
                          + slope_y[:, :, None] * observations[:, None, :, 1]
                          - observations[:, None, :, 2])
        inliers = (residual <= tolerance) & valid[:, None, :]
        score = inliers.sum(axis=2) - np.sum(np.minimum(residual, tolerance)
                                           * valid[:, None, :], axis=2) / (tolerance * 100.)
        score[~usable] = -1
        winner = score.argmax(axis=1)
        mask = inliers[np.arange(stop - start), winner]
        design = np.concatenate((observations[:, :, :2], np.ones((*valid.shape, 1))), axis=2)
        coef = np.zeros((stop - start, 3))
        for _ in range(2):
            weighted = design * mask[:, :, None]
            normal = np.einsum('nki,nkj->nij', weighted, design)
            rhs = np.einsum('nki,nk->ni', weighted, observations[:, :, 2])
            normal += np.eye(3)[None, :, :] * 1e-9
            coef = np.linalg.solve(normal, rhs[..., None])[..., 0]
            errors = np.abs(np.einsum('nki,ni->nk', design, coef) - observations[:, :, 2])
            mask = (errors <= tolerance) & valid
        counts = mask.sum(axis=1)
        # Do not invent an extrapolating plane from isolated points.
        reliable = (counts >= 4) & (np.linalg.norm(coef[:, :2], axis=1) <= 3)
        coef[~reliable] = 0
        coef[:, 2] += samples[start:stop, 2]
        planes[start:stop] = coef
        support[start:stop] = counts
        noise[start:stop] = np.sum(errors * mask, axis=1) / np.maximum(counts, 1)
    return planes, support, noise


def _partition(count, edges, gaps, threshold):
    """Constrained region merging: a weak edge cannot cross a measured wall."""
    parent = np.arange(count)
    size = np.ones(count, dtype=np.int64)
    forbidden = [set() for _ in range(count)]

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return int(i)

    for a, b in edges[gaps > threshold]:
        forbidden[a].add(int(b))
        forbidden[b].add(int(a))
    for edge in np.argsort(gaps, kind='stable'):
        if gaps[edge] > threshold:
            break
        a, b = (root(i) for i in edges[edge])
        if a == b or b in forbidden[a]:
            continue
        if size[a] < size[b] or (size[a] == size[b] and a > b):
            a, b = b, a
        parent[b] = a
        size[a] += size[b]
        for other in forbidden[b]:
            forbidden[other].discard(b)
            forbidden[other].add(a)
            forbidden[a].add(other)
        forbidden[b].clear()
    return np.array([root(i) for i in range(count)])


def _edge_gaps(samples, planes, edges):
    a, b = edges.T
    half_delta = (samples[b, :2] - samples[a, :2]) * .5
    from_a = planes[a, 2] + np.sum(planes[a, :2] * half_delta, axis=1)
    from_b = planes[b, 2] - np.sum(planes[b, :2] * half_delta, axis=1)
    return np.abs(from_a - from_b)


def _remove_islands(labels, samples, planes, edges, cell, min_width, spatial):
    """Assign unresolved micro-regions to an adjacent, supported surface.

    Four independent cells are the minimum evidence for a separate rooftop
    object. The printable width can raise that floor; broad towers remain
    valid irrespective of their height or the size of the surrounding podium.
    """
    minimum = max(4, int(math.ceil((min_width / cell) ** 2)))
    regions, counts = np.unique(labels, return_counts=True)
    sizes = dict(zip(regions.tolist(), counts.tolist()))
    neighbors = {}
    for a, b in edges:
        ra, rb = int(labels[a]), int(labels[b])
        if ra != rb:
            neighbors.setdefault(ra, []).append((int(a), int(b)))
            neighbors.setdefault(rb, []).append((int(b), int(a)))
    removed, gap_islands = 0, 0
    # Resolve the best-supported small pieces first. A neighboring singleton
    # may then inherit that resolved ownership instead of staying isolated.
    for region in sorted(sizes, key=lambda r: (-sizes[r], r)):
        if sizes[region] >= minimum:
            continue
        candidates = {}
        for a, b in neighbors.get(region, ()):
            target = int(labels[b])
            if target == region or sizes.get(target, 0) < minimum:
                continue
            delta = samples[a, :2] - samples[b, :2]
            predicted = np.dot(planes[b, :2], delta) + planes[b, 2]
            candidates.setdefault(target, []).append((abs(samples[a, 2] - predicted), b))
        crossed_gap = not candidates
        if crossed_gap:
            # Missing returns can isolate a clipped sliver from the adjacency
            # graph. It is still too little evidence for a separate roof; use
            # nearby supported surfaces, bounded to four acquisition cells.
            # This only applies below the independent-cell support minimum.
            for a in np.flatnonzero(labels == region):
                buckets, pitch, origin = spatial
                x, y = np.floor((samples[a, :2] - origin) / pitch).astype(np.int64)
                reach = int(math.ceil(4 * cell / pitch))
                local = np.asarray([j for dx in range(-reach, reach + 1)
                                    for dy in range(-reach, reach + 1)
                                    for j in buckets.get((x + dx, y + dy), ())], dtype=np.int64)
                distances = np.sum((samples[local, :2] - samples[a, :2]) ** 2, axis=1)
                for b in local[distances <= (4 * cell) ** 2]:
                    target = int(labels[b])
                    if target == region or sizes.get(target, 0) < minimum:
                        continue
                    delta = samples[a, :2] - samples[b, :2]
                    predicted = np.dot(planes[b, :2], delta) + planes[b, 2]
                    candidates.setdefault(target, []).append((abs(samples[a, 2] - predicted), int(b)))
        if not candidates:
            continue
        target = min(candidates, key=lambda r: (np.median([e for e, _ in candidates[r]]),
                                                -len(candidates[r]), r))
        mask = labels == region
        support_indices = sorted(set(b for _, b in candidates[target]))
        for a in np.flatnonzero(mask):
            delta = samples[a, :2] - samples[support_indices, :2]
            predictions = (np.sum(planes[support_indices, :2] * delta, axis=1)
                           + planes[support_indices, 2])
            samples[a, 2] = float(np.median(predictions))
            planes[a, :2] = np.median(planes[support_indices, :2], axis=0)
            planes[a, 2] = samples[a, 2]
        labels[mask] = target
        sizes[target] += sizes[region]
        sizes[region] = 0
        removed += 1
        gap_islands += int(crossed_gap)
    return removed, gap_islands


def _denoise_plane_outliers(labels, samples, edges, tolerance, reliable_local):
    """Correct sparse facade/noise returns within a dominant measured plane.

    The consensus must explain at least three quarters of the region. Only
    residual islands with fewer than four independent support cells change;
    a coherent rooftop feature is retained even if it is a tiny percentage of
    a large building. Curved roofs and balanced multi-plane roofs cannot pass
    this dominant-plane test merely because they are connected.
    """
    adjacency = [[] for _ in range(len(samples))]
    for a, b in edges:
        adjacency[a].append(int(b))
        adjacency[b].append(int(a))
    corrected = 0
    for label in np.unique(labels):
        indices = np.flatnonzero(labels == label)
        if len(indices) < 8:
            continue
        points = samples[indices]
        center = points[:, :2].mean(axis=0)
        design = np.column_stack((points[:, :2] - center, np.ones(len(points))))
        keep = np.ones(len(indices), dtype=bool)
        for _ in range(5):
            coef, _, rank, _ = np.linalg.lstsq(design[keep], points[keep, 2], rcond=None)
            if rank < 3 or np.linalg.norm(coef[:2]) > 3:
                break
            errors = np.abs(design @ coef - points[:, 2])
            mask = errors <= max(tolerance, 3 * float(np.median(errors)))
            if np.array_equal(mask, keep):
                break
            if mask.sum() < max(6, len(indices) * .75):
                break
            keep = mask
        else:
            coef, _, rank, _ = np.linalg.lstsq(design[keep], points[keep, 2], rcond=None)
        if rank < 3 or np.linalg.norm(coef[:2]) > 3:
            continue
        predicted = design @ coef
        outliers = np.abs(predicted - points[:, 2]) > tolerance
        if np.count_nonzero(~outliers) < max(6, len(indices) * .75):
            continue
        unresolved = set(indices[outliers].tolist())
        replacements = []
        while unresolved:
            seed = min(unresolved)
            unresolved.remove(seed)
            component, pending = [seed], [seed]
            while pending:
                a = pending.pop()
                for b in adjacency[a]:
                    if b in unresolved:
                        unresolved.remove(b)
                        component.append(b)
                        pending.append(b)
            if len(component) < 4:
                # A ridge corner may be assigned to either adjacent region;
                # its own well-supported local slope is valid geometry, not
                # an outlier merely because that region's main plane differs.
                replacements.extend(i for i in component if not reliable_local[i])
        if replacements:
            local = np.searchsorted(indices, replacements)
            samples[replacements, 2] = predicted[local]
            corrected += len(replacements)
    return corrected


def _merge_planes(labels, samples, edges, tolerance):
    """Merge fragmented planar regions when one plane explains their union.

    Local estimates near a noisy roof edge may disagree despite belonging to
    one broad roof. The full equal-cell evidence is a stronger test. A real
    height jump cannot pass the maximum-residual bound, even when the smaller
    roof occupies less than five percent of its large neighbor.
    """
    groups = {int(label): np.flatnonzero(labels == label) for label in np.unique(labels)}
    parent = {label: label for label in groups}

    def root(label):
        while parent[label] != label:
            label = parent[label]
        return label

    def fitted(indices):
        points = samples[indices]
        center = points[:, :2].mean(axis=0)
        design = np.column_stack((points[:, :2] - center, np.ones(len(points))))
        coef, _, rank, _ = np.linalg.lstsq(design, points[:, 2], rcond=None)
        residual = np.abs(design @ coef - points[:, 2])
        return rank == 3 and np.quantile(residual, .95) <= tolerance and residual.max() <= tolerance * 2

    planar = {label: fitted(indices) for label, indices in groups.items()}
    pairs = sorted(set(tuple(sorted((int(labels[a]), int(labels[b])))) for a, b in edges
                       if labels[a] != labels[b]))
    merges = 0
    for a, b in pairs:
        a, b = root(a), root(b)
        if a == b or not planar[a] or not planar[b]:
            continue
        combined = np.concatenate((groups[a], groups[b]))
        if not fitted(combined):
            continue
        if len(groups[a]) < len(groups[b]):
            a, b = b, a
        parent[b] = a
        groups[a] = combined
        del groups[b]
        merges += 1
    if merges:
        labels[:] = [root(int(label)) for label in labels]
    return merges


def _fit_regions(labels, samples, tolerance, local_gradients):
    planar = 0
    for label in np.unique(labels):
        mask = labels == label
        points = samples[mask]
        center = points[:, :2].mean(axis=0)
        design = np.column_stack((points[:, :2] - center, np.ones(len(points))))
        coef, _, rank, _ = np.linalg.lstsq(design, points[:, 2], rcond=None)
        # A low residual alone does not establish a slope: two close parallel
        # terraces can also fit a tilted plane. Preserve independently measured
        # local gradients and solve their offset before considering that global
        # regression. Equal-height noisy roofs therefore remain horizontal,
        # while a genuine shallow slope retains its measured normal.
        gradient = np.median(local_gradients[mask], axis=0)
        detrended = points[:, 2] - design[:, :2] @ gradient
        offset = float(np.mean(np.quantile(detrended, [.05, .95])))
        consensus = np.array([gradient[0], gradient[1], offset])
        consensus_residual = np.abs(design @ consensus - points[:, 2])
        if (np.quantile(consensus_residual, .95) <= tolerance
                and consensus_residual.max() <= tolerance * 2):
            coef = consensus
        elif np.ptp(design[:, :2] @ (coef[:2] - gradient)) > tolerance:
            # Do not erase the remaining nonplanar evidence with a slope that
            # the local surface observations do not corroborate.
            continue
        residual = np.abs(design @ coef - points[:, 2])
        if rank == 3 and np.quantile(residual, .95) <= tolerance and residual.max() <= tolerance * 2:
            samples[mask, 2] = design @ coef
            planar += 1
    return planar


def segment_surfaces(samples, cell, min_width):
    """Return ``(labels, denoised_xyz, diagnostics)`` in the original row order.

    ``cell`` and ``min_width`` are metres. Measurement uncertainty and spatial
    support decide whether adjacent planes describe the same surface; there
    is no elevation quantization or minimum-height-step input. Labels are compact
    and numbered by first spatial occurrence, independent of input row order.
    Continuous curves can occupy one region; a genuine ridge can separate two
    planar regions without becoming a stack of horizontal terraces.
    """
    samples = np.asarray(samples, dtype=float)
    if samples.ndim != 2 or samples.shape[1] != 3 or not np.all(np.isfinite(samples)):
        raise ValueError('surface samples must be finite Nx3 coordinates')
    if not np.isfinite(cell) or cell <= 0 or not np.isfinite(min_width) or min_width < 0:
        raise ValueError('surface support dimensions must be finite and positive')
    if not len(samples):
        return np.empty(0, dtype=np.int64), samples.copy(), {'surface_regions': 0}
    order = np.lexsort((samples[:, 2], samples[:, 1], samples[:, 0]))
    observed = samples[order].copy()
    neighbors, edges, spatial = _neighbors(observed, cell)
    # This is a metre-space measurement residual, not a height band or the
    # user's requested detail step. A fit must explain local survey samples.
    fit_tolerance = .30
    planes, support, noise = _local_planes(observed, neighbors, fit_tolerance)
    estimated_noise = float(np.median(noise[support >= 4])) if np.any(support >= 4) else 0.
    jump_tolerance = max(.5, min(.8, estimated_noise * 6))
    if len(edges):
        gaps = _edge_gaps(observed, planes, edges)
        labels = _partition(len(observed), edges, gaps, jump_tolerance)
    else:
        labels, gaps = np.arange(len(observed)), np.empty(0)
    # Re-estimate boundary planes using their actual surface ownership. A
    # hypothesis useful for deciding which side of a wall owns a point must
    # not later extrapolate across that wall when suppressing a tiny island.
    if len(np.unique(labels)) > 1:
        regional_neighbors = neighbors.copy()
        compatible = labels[np.maximum(neighbors, 0)] == labels[:, None]
        regional_neighbors[~compatible] = -1
        planes, _, _ = _local_planes(observed, regional_neighbors, fit_tolerance)
        # Mixed hypotheses at a wall can initially create a false barrier
        # elsewhere on the same surface. Reconsider it only after both sides
        # have independent fits, and only if the entire boundary now agrees.
        # Internal edges are fixed, so this pass can merge but never fragment
        # an existing coherent region or open a path around a retained wall.
        if len(edges):
            refined_gaps = _edge_gaps(observed, planes, edges)
            refined_gaps[labels[edges[:, 0]] == labels[edges[:, 1]]] = 0
            labels = _partition(len(observed), edges, refined_gaps, jump_tolerance)
    denoised = observed.copy()
    denoised[:, 2] = planes[:, 2]
    removed, gap_islands = _remove_islands(labels, denoised, planes, edges, cell, min_width, spatial)
    reliable_local = support >= np.maximum(6, np.count_nonzero(neighbors >= 0, axis=1) * .5)
    plane_outliers = _denoise_plane_outliers(labels, denoised, edges, fit_tolerance, reliable_local)
    # A region with one coherent plane should become exactly that plane. Local
    # denoising otherwise retains continuous curvature for adaptive meshing.
    planar_regions = _fit_regions(labels, denoised, fit_tolerance, planes[:, :2])
    merged = _merge_planes(labels, denoised, edges, fit_tolerance)
    if merged:
        planar_regions = _fit_regions(labels, denoised, fit_tolerance, planes[:, :2])
    ids = {}
    compact = np.array([ids.setdefault(int(label), len(ids)) for label in labels], dtype=np.int64)
    original_labels = np.empty(len(observed), dtype=np.int64)
    original_samples = np.empty_like(denoised)
    original_labels[order], original_samples[order] = compact, denoised
    diagnostics = {'surface_regions': len(ids), 'surface_planar_regions': planar_regions,
                   'surface_removed_islands': removed, 'surface_noise_m': estimated_noise,
                   'surface_gap_islands': gap_islands,
                   'surface_plane_outlier_samples': plane_outliers,
                   'surface_merged_planar_regions': merged,
                   'surface_jump_tolerance_m': jump_tolerance,
                   'surface_barrier_edges': int(np.count_nonzero(gaps > jump_tolerance)),
                   'surface_denoise_p95_m': float(np.quantile(np.abs(denoised[:, 2] - observed[:, 2]), .95)),
                   'surface_denoise_max_m': float(np.max(np.abs(denoised[:, 2] - observed[:, 2])))}
    return original_labels, original_samples, diagnostics
