"""Scalar roof measurements without reconstructing any roof geometry."""
import numpy as np


def supported_height(cells, cell_m, classified_fraction):
    """Highest supported roof patch, rather than a whole-footprint percentile.

    A tower may cover less than ten percent of its podium. Equal-area cells
    and connected support retain that tower without letting isolated returns
    or a tiny chimney establish the height of the whole assembly.
    """
    pending, patches = set(cells), []
    while pending:
        seed = pending.pop()
        group, stack = [seed], [seed]
        while stack:
            x, y = stack.pop()
            for other in ((x-1, y), (x+1, y), (x, y-1), (x, y+1)):
                if other in pending and abs(cells[other]-cells[(x, y)]) < 3:
                    pending.remove(other)
                    stack.append(other)
                    group.append(other)
        if len(group) >= max(4, int(np.ceil(36 / cell_m**2))):
            patches.append([cells[key] for key in group])
    explained = sum(map(len, patches)) / max(1, len(cells))
    if not patches or explained < .85:
        return None
    # Unclassified roofs can have slopes and several connected levels. Require
    # the same local coherence used by supported scalar source-part heights,
    # rather than requiring the entire roof to be flat.
    edges = [abs(z-cells[other]) for (x,y),z in cells.items()
             for other in ((x+1,y),(x,y+1)) if other in cells]
    coherent = float(np.mean(np.array(edges) < 3)) if edges else 0.
    if classified_fraction < .7 and coherent < .8:
        return None
    # A tiny high patch must not raise a huge convention hall. Retain smaller
    # towers when they have at least two percent of the supported roof area.
    major = [patch for patch in patches if len(patch) >= len(cells)*.02]
    if not major:
        return None
    top = max(float(np.quantile(patch, .95)) for patch in major)
    return top, min(explained, coherent)


def source_heights(feature, parts, footprint, cell_samples, cell_m, classified, stats, prefer_lidar):
    """Check existing main masses against returns within their own footprints.

    Reuse the validated roof cells. Do not fit parts, infer new outlines, or
    assign the tallest source height to whichever roof the scan found tallest.
    Overlaps and mapped roof details are excluded from a mass's sampling area.
    """
    from shapely import contains_xy
    from shapely.ops import unary_union
    try:
        from .lidar_source import height_decision, strong_measurement
    except ImportError:
        from lidar_source import height_decision, strong_measurement
    corrections = {}
    for target, geometry in [(feature, footprint)] + list(parts):
        props = target.get('properties') or {}
        if (props.get('is_underground') or props.get('min_height') or props.get('min_floor')
                or (target is not feature and (geometry.area < footprint.area*.05
                    or props.get('roof_shape') not in (None, '', 'flat')))):
            continue
        others = [g for p,g in parts if p is not target]
        # A half-cell margin prevents neighboring tall roofs from supplying a
        # low mass's height. An occluded/ambiguous mass retains its source height.
        exposed = geometry.intersection(footprint)
        if others:
            exposed = exposed.difference(unary_union(others).buffer(cell_m*.5))
        if exposed.area < max(36., geometry.area*.25):
            continue
        selected = {key:z for key,x,y,z in cell_samples if contains_xy(exposed,x,y)}
        if len(selected)*cell_m**2 < exposed.area*.85:
            continue
        scalar = supported_height(selected, cell_m, classified)
        if scalar is None:
            continue
        observed, explained = scalar
        decision = height_decision(props, observed, strong_measurement({**stats,'explained_fraction':explained}))
        if decision in ('source_height_conflict','weak_height_correction') and not prefer_lidar:
            continue
        identifier = str(target.get('id') or props.get('id') or '')
        if identifier:
            corrections[identifier] = observed
    return corrections
