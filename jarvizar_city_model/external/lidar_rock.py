"""Upper surfaces for explicitly mapped bare rock, using one survey at a time.

Rock is a terrain surface, so its class-2 returns are valid surface evidence.
Vegetation never supplies its coverage or raises its envelope. These domains
come from polygons, never point landmarks or an attraction's general boundary.
"""
import hashlib

import numpy as np
from shapely import contains_xy, STRtree
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

try:
    from .lidar_envelope import DEFAULT_SURFACE_SCALE, fit_roof_envelope, envelope_parameters
    from .lidar_ground import ground_anchor
    from .lidar_measurements import occupied_area
except ImportError:
    from lidar_envelope import DEFAULT_SURFACE_SCALE, fit_roof_envelope, envelope_parameters
    from lidar_ground import ground_anchor
    from lidar_measurements import occupied_area


def rock_features(features):
    """Merge intersecting mapped rock polygons without growing their outlines."""
    polygons, originals = [], []
    for feature in features:
        props = feature.get('properties') or {}
        if props.get('class') != 'bare_rock':
            continue
        raw = feature.get('geometry') or {}
        if raw.get('type') not in ('Polygon', 'MultiPolygon'):
            continue
        geometry = shape(raw)
        if geometry.geom_type not in ('Polygon', 'MultiPolygon') or geometry.is_empty or not geometry.is_valid:
            continue
        polygons.append(geometry)
        originals.append(feature)
    tree = STRtree(polygons)
    pending = set(range(len(polygons)))
    results = []
    while pending:
        group, todo = [], [min(pending)]
        while todo:
            i = todo.pop()
            if i not in pending:
                continue
            pending.remove(i)
            group.append(i)
            todo.extend(int(j) for j in tree.query(polygons[i], predicate='intersects') if int(j) in pending)
        members = sorted(str(originals[i].get('id') or polygons[i].wkb_hex) for i in group)
        identifier = 'rock:' + hashlib.sha256('\n'.join(members).encode()).hexdigest()[:24]
        results.append({'type': 'Feature', 'id': identifier,
            'properties': {'lidar_surface_kind': 'rock', 'source_land_ids': members},
            'geometry': mapping(unary_union([polygons[i] for i in sorted(group)]))})
    return sorted(results, key=lambda f: f['id'])


def measure_rock_surface(footprint, index, scale=DEFAULT_SURFACE_SCALE):
    """Validate coverage and use surrounding ground to align a measured relief.

    An irregular hillside cannot be represented by one fitted ground plane.
    A low, spatially balanced ground cell supplies an explicit alignment anchor
    instead; all surface heights retain their measured differences from it.
    """
    if footprint.is_empty or not footprint.is_valid or footprint.area < 4:
        return None, 'invalid_or_small_footprint'
    if footprint.area > 40000 * envelope_parameters(scale)[0]**2:
        return None, 'footprint_cell_budget'
    neighborhood = footprint.buffer(25)
    points = index.query(neighborhood.bounds)
    inside = contains_xy(footprint, points[:, 0], points[:, 1])
    anchor = ground_anchor(footprint, index)
    if anchor is None:
        return None, 'insufficient_ground'
    usable = points[inside & (np.isin(points[:, 3], (2, 6)) |
                              ((points[:, 3] == 1) & (points[:, 4] == 1)))][:, :3]
    if len(usable) < 20:
        return None, 'insufficient_roof_points'
    pitch = 1.5
    domains = [footprint] if footprint.geom_type == 'Polygon' else list(footprint.geoms)
    coverage, bands = [], []
    for domain in domains:
        groups = {}
        local = usable[contains_xy(domain, usable[:, 0], usable[:, 1])]
        for row in local:
            groups.setdefault(tuple(np.floor(row[:2]/pitch).astype(int)), []).append(row)
        supported = {key: np.array(rows) for key, rows in sorted(groups.items()) if len(rows) >= 3}
        coverage.append(occupied_area(supported, domain, pitch)/domain.area)
        bands.extend(supported.values())
    if not coverage or min(coverage) < .85 or len(bands) < 4:
        return None, 'footprint_roof_mismatch'
    observations = np.concatenate(bands)
    # A tiny below-surface offset gives the closed solid a positive base without
    # changing any measured height: its offset is also retained at the anchor.
    datum = float(min(anchor[2], observations[:, 2].min()-.05))
    observations = observations.copy()
    observations[:, 2] -= datum
    if np.quantile(observations[:, 2], .99)-np.quantile(observations[:, 2], .01) < .05/scale[1]:
        return None, 'no_printable_rock_relief'
    samples = np.array([np.median(rows, axis=0) for rows in bands])
    samples[:, 2] -= datum
    result, reason = fit_roof_envelope(footprint, samples, pitch, scale,
                                       boundary_samples=observations)
    if not result:
        return None, reason
    result.update(surface_kind='rock', ground_m=datum,
                  ground_reference='surrounding_ground_anchor',
                  ground_anchor=[float(anchor[0]), float(anchor[1]), float(anchor[2]-datum)],
                  coverage=float(min(coverage)), explained_fraction=float(min(coverage)),
                  roof_support_density_m2=len(observations)/footprint.area,
                  roof_points=len(observations), cell_m=pitch)
    return result, 'faceted_roof'
