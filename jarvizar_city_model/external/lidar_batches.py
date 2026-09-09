"""Bounded acquisition jobs owning whole buildings, never clipped roof pieces."""
from collections import defaultdict
import math

from shapely.geometry import box
from shapely.ops import unary_union


def building_batches(features, geometries, size=400.0):
    groups = defaultdict(list)
    for feature in features:
        polygon = geometries[feature['id']]
        center = polygon.centroid
        groups[(math.floor(center.x / size), math.floor(center.y / size))].append(feature)
    return [groups[key] for key in sorted(groups)]


def batch_bounds(features, geometries, selection, halo=75.0):
    # Include complete roofs and surrounding ground, but never escape the
    # selected map's established halo to chase an enormous regional feature.
    bounds = unary_union([geometries[f['id']] for f in features]).bounds
    return box(*bounds).buffer(30, join_style=2).intersection(selection.buffer(halo)).bounds


def split_batch(features, geometries):
    if len(features) < 2:
        return []
    centers = [geometries[f['id']].centroid for f in features]
    axis = 'x' if max(p.x for p in centers)-min(p.x for p in centers) >= max(p.y for p in centers)-min(p.y for p in centers) else 'y'
    ordered = sorted(features, key=lambda f: getattr(geometries[f['id']].centroid, axis))
    mid = len(ordered)//2
    return [ordered[:mid], ordered[mid:]]
