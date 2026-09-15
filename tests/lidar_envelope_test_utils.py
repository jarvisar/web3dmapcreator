"""Metric cross-sections of the actual sloping roof faces for geometry tests."""
import numpy as np
from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union


def height_at(record, x, y):
    """The cap height at a point, from the plane of the face above it."""
    heights = []
    for surface in record['roof_surfaces']:
        if shape(surface['geometry']).buffer(1e-8).covers(Point(x, y)):
            xyz = np.asarray(surface['geometry']['coordinates'][0][:-1])
            design = np.column_stack((xyz[:, :2]-[x, y], np.ones(len(xyz))))
            heights.append(float(np.linalg.lstsq(design, xyz[:, 2], rcond=None)[0][2]))
    if not heights:
        raise AssertionError(f'No envelope above {(x, y)}')
    return max(heights)


def cap_area(record):
    """Total face area: the cap tiles its footprint exactly."""
    return sum(shape(s['geometry']).area for s in record['roof_surfaces'])


def height_contour(record, elevation):
    polygons = []
    for surface in record['roof_surfaces']:
        ring = surface['geometry']['coordinates'][0][:-1]
        clipped = []
        for a, b in zip(ring, [*ring[1:], ring[0]]):
            if a[2] >= elevation:
                clipped.append(a[:2])
            if (a[2] >= elevation) != (b[2] >= elevation):
                t = (elevation-a[2])/(b[2]-a[2])
                clipped.append([a[i]+(b[i]-a[i])*t for i in (0, 1)])
        if len(clipped) >= 3:
            polygon = Polygon(clipped)
            if polygon.area > 1e-10:
                polygons.append(polygon)
    return unary_union(polygons)
