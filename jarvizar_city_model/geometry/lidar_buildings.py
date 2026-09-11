"""Emit measured building envelopes through the existing closed prism builder."""
from __future__ import annotations

from ..blender.mesh_utils import MeshBuilder, projected_polygon_rings
from ..data.geojson import feature_id
from .buildings import footprint_admits_minimum_height, resolve_vertical_profile
from .building_printability import source_part_widths
from .planar import clean_ring, densify_ring, effective_width, signed_area, EPSILON
from .planar import clip_ring_to_rectangle
from .lidar_envelope import envelope_solid
from .roofs import resolve_roof


def prefer_source_detail(features, parent, record, transform, vertical, floor_height,
                         default_height, minimum_width, maximum_slenderness,
                         exempt_width, generate_roofs, minimum_roof):
    """Keep existing printable crowns/tiers when this measurement omits them.

    LiDAR improves plain extrusions freely. A simpler roof envelope is not
    evidence that already mapped architectural sections should disappear.
    Inspect only source masses that pass the generator's size checks.
    """
    levels = []
    part_widths = source_part_widths([feature for feature in features if feature is not parent],
        lambda geometry: projected_polygon_rings(geometry, transform), vertical,
        floor_height, default_height, minimum_width, maximum_slenderness)
    parent_height = (parent.get('properties') or {}).get('height')
    if not isinstance(parent_height, (float,int)):
        parent_height = None
    for feature in features:
        props = feature.get('properties') or {}
        profile = resolve_vertical_profile(props, floor_height, default_height)
        if profile.thickness_m <= 0:
            continue
        for index, rings in enumerate(projected_polygon_rings(feature.get('geometry') or {}, transform)):
            width = effective_width(rings[0])
            filter_width = part_widths.get((feature_id(feature), index), width)
            if filter_width < minimum_width or (maximum_slenderness > 0 and filter_width < exempt_width
                    and vertical(profile.thickness_m) > filter_width*maximum_slenderness):
                continue
            roof = resolve_roof(props, profile, feature is not parent, parent_height,
                                width / max(transform.scale_x_mm_per_m, 1e-12))
            if generate_roofs and roof.is_shaped and len(rings)==1 and vertical(roof.height_m) >= minimum_roof:
                if not record.get('roof_surfaces'):
                    return True
            levels.append(vertical(profile.top_m))
    distinct = []
    for height in sorted(levels):
        if not distinct or height-distinct[-1] >= max(minimum_roof, .2):
            distinct.append(height)
    measured_sections = 1 + len(record['tiers']) + len(record.get('roof_surfaces', []))
    return len(distinct) >= 2 and len(levels) > measured_sections


def surface_height(surface, transform):
    """Fit the cached plane in the existing model XY frame, before clipping.

    LiDAR Z is a relative height, never passed to the geographical projection
    as an altitude (which would alter footprint XY on the ENU tangent plane).
    """
    vertices = [(*transform.forward(v[0], v[1])[:2], v[2])
                for ring in surface['geometry']['coordinates'] for v in ring[:-1]]
    p = vertices[0]
    q = max(vertices, key=lambda v: (v[0]-p[0])**2+(v[1]-p[1])**2)
    r = max(vertices, key=lambda v: abs((q[0]-p[0])*(v[1]-p[1])-(q[1]-p[1])*(v[0]-p[0])))
    dx, dy, dz = q[0]-p[0], q[1]-p[1], q[2]-p[2]
    ex, ey, ez = r[0]-p[0], r[1]-p[1], r[2]-p[2]
    det = dx*ey-dy*ex
    if abs(det) < EPSILON**2:
        raise ValueError('Degenerate measured roof plane')
    a, b = (dz*ey-dy*ez)/det, (dx*ez-dz*ex)/det
    def height(x,y):
        return p[2]+a*(x-p[0])+b*(y-p[1])
    if any(abs(height(x,y)-z) > 0.02 for x,y,z in vertices):
        raise ValueError('Nonplanar measured roof')
    return height


def measured_builder(feature, record, transform, heightfield, ground, vertical,
                     embed, spacing, minimum_width, maximum_slenderness,
                     exempt_width, minimum_height, minimum_footprint):
    """Build transactionally; failure leaves ordinary parent/part jobs intact.

    The envelope is one shared cap with exterior/courtyard walls, supported
    by the terrain-seated base. Legacy terraces retain independent solids.
    """
    outlines = projected_polygon_rings(record.get('infill_geometry') or feature.get("geometry") or {}, transform)
    if not outlines:
        return None
    terrain, terrain_top = ground
    base_height = record["height_m"]
    surfaces = record.get('roof_surfaces', [])
    total_height = max([base_height] + [t['top_m'] for t in record['tiers']]
                       + [v[2] for s in surfaces for ring in s['geometry']['coordinates'] for v in ring])
    projected_surfaces = [(surface, surface_height(surface, transform),
                           projected_polygon_rings(surface['geometry'], transform))
                          for surface in surfaces]
    # A tower cannot satisfy the minimum for its low, exposed podium. Raise
    # the base terrace and carry its tiers together so their steps survive.
    # A shaped roof instead uses its finished apex, as source roofs do; only
    # the portion actually inside the model crop contributes to that apex.
    finished_height = max([base_height] + [height(x, y)
        for _surface, height, polygons in projected_surfaces
        for rings in polygons for ring in rings for x, y in ring])
    lift = 0.0
    if minimum_height > 0 and any(
            footprint_admits_minimum_height(rings[0], minimum_footprint) for rings in outlines):
        lift = max(0.0, minimum_height - (terrain + vertical(finished_height) - terrain_top))
    builder = MeshBuilder("LIDAR_BUILDING")
    top = terrain + vertical(base_height) + lift
    for rings in outlines:
        width = effective_width(rings[0])
        if width < minimum_width or (maximum_slenderness > 0 and width < exempt_width
                                     and vertical(total_height) > width * maximum_slenderness):
            return None
        def floor(x, y):
            return min(heightfield.height_mm(x, y) - embed, top - 0.05)
        dense = [clean_ring(densify_ring(ring, spacing), EPSILON) for ring in rings]
        if not builder.add_prism([[(x, y, floor(x, y), top) for x, y in ring] for ring in dense],
                                 refine=(spacing, lambda x,y: (floor(x,y), top))):
            return None
    tier_count = 0
    for tier in record["tiers"]:
        if tier["geometry"].get("type") not in ("Polygon", "MultiPolygon"):
            return None
        rings_list = projected_polygon_rings(tier["geometry"], transform)
        # A tier outside the map crop is simply absent; everything retained is
        # still nested inside the cropped supporting outline.
        for rings in rings_list:
            bottom = terrain + vertical(tier["bottom_m"]) + lift - min(0.02, vertical(base_height) * 0.1)
            top_tier = terrain + vertical(tier["top_m"]) + lift
            if not builder.add_flat_prism(rings[0], bottom, top_tier, rings[1:]):
                return None
            tier_count += 1
    roof_count, roof_area = 0, 0.0
    joined = False
    if record.get('surface_reconstruction') == 'roof_envelope':
        # The measured TIN is one connected surface, not thousands of separate
        # extrusions. Clip in double precision before joining its shared edges.
        caps = []
        bounds = transform.model_bounds
        for surface, height, _polygons in projected_surfaces:
            for ring in surface['geometry']['coordinates']:
                xy = [transform.forward(v[0], v[1])[:2] for v in ring[:-1]]
                clipped = clip_ring_to_rectangle(xy, bounds.min_x_mm, bounds.min_y_mm,
                    bounds.max_x_mm, bounds.max_y_mm, epsilon=1e-10)
                if clipped:
                    caps.append([(x, y, terrain+vertical(height(x, y))+lift) for x, y in clipped])
        bottom = terrain+vertical(base_height)+lift-min(.02, vertical(base_height)*.1)
        solid = envelope_solid(caps, bottom, outlines)
        if solid is None:
            return None
        builder.add_raw(*solid)
        joined = True
        roof_count = len(caps)
    for surface, height, polygons in ([] if joined else projected_surfaces):
        bottom = terrain + vertical(surface['bottom_m']) + lift - min(0.02, vertical(base_height)*0.1)
        for rings in polygons:
            prism = []
            for ring in rings:
                vertices = []
                for x,y in ring:
                    z = terrain + vertical(height(x,y)) + lift
                    if z <= bottom:
                        return None
                    vertices.append((x,y,bottom,z))
                prism.append(vertices)
            if not builder.add_prism(prism):
                return None
            roof_area += abs(signed_area(rings[0])) - sum(abs(signed_area(r)) for r in rings[1:])
            roof_count += 1
    if surfaces and not joined:
        footprint_area = sum(abs(signed_area(rings[0]))-sum(abs(signed_area(r)) for r in rings[1:]) for rings in outlines)
        if abs(roof_area-footprint_area) > max(0.001, footprint_area*0.01):
            return None
    return builder, {"terrain_base_mm": terrain, "terrain_top_mm": terrain_top,
                     "minimum_height_lift_mm": lift, "lidar_tiers": tier_count,
                     'lidar_roof_planes': roof_count, 'lidar_joined_envelope': joined,
                     'height_m': total_height}
