"""Supported roof models and final consolidation at the actual output scale.

Local region growing protects discontinuities. This later pass compares the
final statistical models, retaining gradients, independent relief and bounded
changes from the original models even through repeated merges.
"""
import numpy as np
from shapely import STRtree, points as make_points
from shapely.geometry import MultiPoint
from shapely.ops import unary_union

try:
    from . import lidar_facets as facets
except ImportError:
    import lidar_facets as facets


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


def _unresolved_relief(support, fit, tolerance, cell):
    """A coherent residual feature cannot disappear inside a coarse plane."""
    center,coef,_error=fit
    residual=np.abs((support[:,:2]-center)@coef[:2]+coef[2]-support[:,2])
    points=support[residual>tolerance,:2]
    if len(points)<4:
        return False
    geometries=make_points(points)
    tree=STRtree(geometries)
    pending=set(range(len(points)))
    while pending:
        seed=min(pending);pending.remove(seed)
        group,stack=[seed],[seed]
        while stack:
            i=stack.pop()
            for j in tree.query(geometries[i],predicate='dwithin',distance=cell*2.05):
                j=int(j)
                if j in pending:
                    pending.remove(j);group.append(j);stack.append(j)
        if len(group)>=4 and not MultiPoint(points[group]).convex_hull.buffer(-cell*.5).is_empty:
            return True
    return False


def _surface_model(support,tolerance,rise,scale):
    fit=_plane(support,tolerance,rise)
    if fit is not None:
        return fit
    approximation=max(tolerance,.05/scale[1])
    fit=_plane(support,approximation)
    if fit is not None:
        center,coef,_error=fit
        residual=np.abs((support[:,:2]-center)@coef[:2]+coef[2]-support[:,2])
        if residual.max()<=approximation:
            return fit
    return None


def _consolidate_patches(patches, cell, tolerance, rise, scale):
    """Remove redundant interfaces using the final, supported surface models.

    Early region growing is deliberately sensitive to walls. Contour movement
    and removal of facade strips can subsequently reveal coplanar neighbors.
    Decide again on this final partition, including planes that are resolvable
    at print scale but too noisy for the initial strict regression. Never fit
    a ramp between parallel levels or accumulate drift through repeated merges.
    """
    error_budget = max(tolerance, .05/scale[1])
    feature_rise = max(rise, .1/scale[1])
    models = []
    output_models = []
    for region,support in patches:
        fit = _surface_model(support,tolerance,rise,scale)
        output_models.append(fit)
        if fit is None:
            fit = _plane(support,max(tolerance,.1/scale[1]))
            if fit is not None and _unresolved_relief(support,fit,feature_rise,cell):
                fit = None
        models.append(fit)
    original = [support.copy() for _region,support in patches]
    references=[None if fit is None else (support[:,:2]-fit[0])@fit[1][:2]+fit[1][2]
                for (_region,support),fit in zip(patches,models)]
    regions = [region for region,_support in patches]
    parent = list(range(len(patches)))
    def root(i):
        while parent[i] != i:
            i = parent[i]
        return i
    tree = STRtree(regions)
    pairs = []
    for i,region in enumerate(regions):
        for j in tree.query(region.buffer(1e-6),predicate='intersects'):
            j = int(j)
            if j > i:
                pairs.append((i,j))
    # Similar models merge first, independent of their polygon/start order.
    def gap(pair):
        a,b=pair
        if models[a] is None or models[b] is None:
            return float('inf')
        ca,pa,_=models[a];cb,pb,_=models[b]
        contact = regions[a].intersection(regions[b].buffer(1e-6))
        # The tree queried buffered A against B; polygonal buffer rounding can
        # make the reverse intersection empty at near-touching corners. There
        # is no coordinate to evaluate until an actual contact exists. The
        # merge loop still requires a supported shared edge, including after
        # either region has merged with another neighbor.
        if contact.is_empty:
            return float('inf')
        xy=np.asarray(contact.representative_point().coords)[0,:2]
        return abs((xy-ca)@pa[:2]+pa[2] - ((xy-cb)@pb[:2]+pb[2]))
    merges = 0
    for a,b in sorted(pairs,key=lambda pair:(gap(pair),pair)):
        a,b = root(a),root(b)
        if a == b or models[a] is None or models[b] is None:
            continue
        ca,pa,_=models[a];cb,pb,_=models[b]
        if np.linalg.norm(pa[:2]-pb[:2]) > .06:
            continue
        shared=regions[a].boundary.intersection(regions[b].buffer(1e-6))
        if shared.length < cell*.5:
            continue
        xy=np.array([shared.interpolate((j+.5)/12,normalized=True).coords[0][:2] for j in range(12)])
        differences=(xy-ca)@pa[:2]+pa[2] - ((xy-cb)@pb[:2]+pb[2])
        if np.max(np.abs(differences)) > feature_rise:
            continue
        observations=np.concatenate((original[a],original[b]))
        reference=np.concatenate((references[a],references[b]))
        gradient=(pa[:2]*len(original[a])+pb[:2]*len(original[b]))/len(observations)
        center=observations[:,:2].mean(axis=0)
        trend=(observations[:,:2]-center)@gradient
        offsets=reference-trend
        level=float(np.mean(np.quantile(offsets,[.05,.95])))
        predicted=trend+level
        residual=np.abs(observations[:,2]-predicted)
        # Check all pre-merge observations, including a small neighboring roof;
        # a percentage-only criterion could erase it on a much larger podium.
        if (np.max(np.abs(reference-predicted)) > error_budget
                or np.quantile(residual,.95) > max(error_budget,.1/scale[1])
                or np.max(residual-np.abs(observations[:,2]-reference)) > error_budget):
            continue
        regions[a]=unary_union(facets.pieces(regions[a].union(regions[b])))
        original[a]=observations
        references[a]=reference
        models[a]=(center,np.r_[gradient,level],float(np.quantile(residual,.95)))
        output_models[a]=models[a]
        parent[b]=a
        merges+=1
    kept=[i for i in range(len(patches)) if parent[i] == i]
    return ([(regions[i],original[i]) for i in kept], [output_models[i] for i in kept],
            {'surface_final_plane_merges':merges,
             'surface_plane_merge_error_m':error_budget})


