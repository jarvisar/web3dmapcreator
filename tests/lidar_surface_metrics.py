"""Measure internal roof steps independently of cap triangulation.

Shared edges are compared within 10 microns in survey metres. Derived base
fill strips below the fitter's 5 mm numerical sliver scale are excluded.
This measures reconstructed interfaces, not whether every step is architecture.
"""
import numpy as np
from shapely import STRtree
from shapely.geometry import shape
from shapely.ops import unary_union


def analyze(record, footprint):
    if not record:
        return {}
    patches = []
    remaining = footprint
    for surface in record.get('roof_surfaces', []):
        polygon = shape(surface['geometry'])
        ring = np.asarray(polygon.exterior.coords)
        center = ring[:, :2].mean(axis=0)
        coef = np.linalg.lstsq(np.column_stack((ring[:, :2]-center, np.ones(len(ring)))), ring[:, 2], rcond=None)[0]
        patches.append((polygon, (center, coef)))
    remaining = remaining.difference(unary_union([p for p, _ in patches])) if patches else remaining
    for tier in sorted(record.get('tiers', []), key=lambda r:r['top_m'], reverse=True):
        poly = shape(tier['geometry']).intersection(remaining)
        if not poly.is_empty:
            patches.append((poly, (np.zeros(2), np.array([0.,0.,tier['top_m']]))))
            remaining = remaining.difference(poly)
    def polygon_parts(geometry):
        if geometry.geom_type == 'Polygon':
            return [geometry]
        return [p for child in getattr(geometry, 'geoms', ()) for p in polygon_parts(child)]
    if not remaining.is_empty and remaining.area > 1e-6:
        for p in polygon_parts(remaining):
            # Facet clipping discards sub-5 mm survey slivers. Tiny numerical
            # complement strips are not separate printable roof regions; do
            # not score both sides of a microscopic base-fill crack as walls.
            if record.get('roof_surfaces') and 2*p.area/max(p.length,1e-12)<.005:
                continue
            patches.append((p,(np.zeros(2),np.array([0.,0.,record['height_m']]))))
    patches = [(p, fit) for geometry, fit in patches for p in polygon_parts(geometry) if p.area > 1e-7]
    polygons = [p for p,_ in patches]
    tree = STRtree(polygons)
    tiny_length, major_length, tiny_count, major_count = 0., 0., 0, 0
    subprint_length, printable_minor_length, minor_wall_area = 0., 0., 0.
    def z(i, xy):
        center, coef = patches[i][1]
        return float((xy-center)@coef[:2]+coef[2])
    def line_parts(geometry):
        if geometry.geom_type in ('LineString', 'LinearRing'):
            yield geometry
        else:
            for part in getattr(geometry, 'geoms', ()):
                yield from line_parts(part)
    for i, (polygon, _) in enumerate(patches):
        for j in tree.query(polygon.buffer(1e-5), predicate='intersects'):
            if j <= i:
                continue
            border = polygon.boundary.intersection(polygons[j].boundary.buffer(1e-5, cap_style=2))
            if border.length < 1e-4:
                continue
            has_minor, has_major = False, False
            for line in line_parts(border):
                points = np.asarray(line.coords)[:, :2]
                for a, b in zip(points, points[1:]):
                    length = float(np.linalg.norm(b-a))
                    if length < 1e-8:
                        continue
                    da, db = z(i, a)-z(j, a), z(i, b)-z(j, b)
                    cuts = [0., 1.]
                    if abs(db-da) > 1e-12:
                        for threshold in (0., .05, -.05, .05/.077, -.05/.077, 2., -2.):
                            t = (threshold-da)/(db-da)
                            if 0. < t < 1.:
                                cuts.append(t)
                    cuts = sorted(set(cuts))
                    for start, end in zip(cuts, cuts[1:]):
                        segment_length = length*(end-start)
                        # Linear plane differences integrate exactly after
                        # splitting at the sign and category boundaries.
                        jump = abs(da+(db-da)*(start+end)*.5)
                        if .05 < jump < 2.:
                            tiny_length += segment_length
                            has_minor = True
                            minor_wall_area += jump*segment_length
                            if jump < .05/.077:
                                subprint_length += segment_length
                            else:
                                printable_minor_length += segment_length
                        elif jump >= 2.:
                            major_length += segment_length
                            has_major = True
            tiny_count += int(has_minor)
            major_count += int(has_major)
    return {'minor_step_length_m': tiny_length, 'major_step_length_m': major_length,
            'sub_default_step_length_m': subprint_length,
            'printable_minor_step_length_m': printable_minor_length,
            'minor_wall_area_m2': minor_wall_area,
            'minor_step_edges': tiny_count, 'major_step_edges': major_count,
            'roof_area_m2': footprint.area}

