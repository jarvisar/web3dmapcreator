"""Shared measurement validation at disk boundaries; standard library only.

Safe to import in Blender and in the external worker. Invalid records must
never turn a missing upper roof into an apparently valid podium-only model.
"""
import math

MAX_ROOF_FACETS = 1024


def finite_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def validate_geometry(geometry, dimensions=2, floor=None):
    if not isinstance(geometry, dict):
        raise ValueError('Invalid LiDAR geometry')
    kind = geometry.get('type')
    coordinates = geometry.get('coordinates')
    if kind not in ('Polygon', 'MultiPolygon') or (dimensions == 3 and kind != 'Polygon'):
        raise ValueError('Invalid LiDAR polygon type')
    if not isinstance(coordinates, (list, tuple)) or not coordinates:
        raise ValueError('Empty LiDAR polygon')
    polygons = [coordinates] if kind == 'Polygon' else coordinates
    vertices = 0
    for rings in polygons:
        if not isinstance(rings, (list, tuple)) or not rings:
            raise ValueError('Empty LiDAR polygon rings')
        for ring in rings:
            if not isinstance(ring, (list, tuple)) or len(ring) < 4 or ring[0] != ring[-1]:
                raise ValueError('Open or empty LiDAR ring')
            vertices += len(ring)
            for point in ring:
                if not isinstance(point, (list, tuple)) or len(point) != dimensions or not all(map(finite_number, point)):
                    raise ValueError('Invalid LiDAR vertex')
                if not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
                    raise ValueError('Invalid LiDAR coordinates')
                if floor is not None and point[2] < floor-1e-6:
                    raise ValueError('LiDAR roof below its base')
            # Translate first: tiny geographic polygons lose precision in a
            # shoelace sum of unshifted longitude/latitude products.
            x, y = ring[0][:2]
            area = sum((a[0]-x)*(b[1]-y)-(b[0]-x)*(a[1]-y) for a,b in zip(ring, ring[1:]))
            if area == 0:
                raise ValueError('Degenerate LiDAR ring')
    if dimensions == 3 and vertices > 4096:
        raise ValueError('Oversized LiDAR roof')


def validate_records(buildings):
    if not isinstance(buildings, dict):
        raise ValueError('Invalid buildings dictionary')
    for identifier, record in buildings.items():
        if not isinstance(identifier, str) or not isinstance(record, dict):
            raise ValueError('Invalid LiDAR building record')
        height = record.get('height_m')
        if not finite_number(height) or height <= 0:
            raise ValueError('Invalid LiDAR height')
        part_heights = record.get('part_heights', {})
        if not isinstance(part_heights, dict) or any(not isinstance(key, str) or not key
                or not finite_number(value) or value <= 0 for key,value in part_heights.items()):
            raise ValueError('Invalid LiDAR part heights')
        if 'infill_geometry' in record:
            validate_geometry(record['infill_geometry'])
        if ('infill_geometry' in record or part_heights) and record.get('method') != 'source_parts':
            raise ValueError('Invalid LiDAR source assembly')
        if record.get('method') == 'source_parts' and not part_heights and 'infill_geometry' not in record:
            raise ValueError('Empty LiDAR source assembly')
        tiers = record.get('tiers')
        if not isinstance(tiers, list) or len(tiers) > 23:
            raise ValueError('Invalid LiDAR tiers')
        previous = height
        for tier in tiers:
            if not isinstance(tier, dict):
                raise ValueError('Invalid LiDAR tier record')
            bottom, top = tier.get('bottom_m'), tier.get('top_m')
            if not finite_number(bottom) or not finite_number(top):
                raise ValueError('Invalid LiDAR interval')
            if abs(bottom-previous) > 1e-6 or top <= bottom:
                raise ValueError('Disconnected LiDAR tiers')
            validate_geometry(tier.get('geometry'))
            previous = top
        surfaces = record.get('roof_surfaces', [])
        limit = MAX_ROOF_FACETS if record.get('method') == 'faceted_roof' else 8
        if not isinstance(surfaces, list) or len(surfaces) > limit or (surfaces and tiers):
            raise ValueError('Invalid LiDAR roof surfaces')
        for surface in surfaces:
            if not isinstance(surface, dict) or not finite_number(surface.get('bottom_m')) or abs(surface['bottom_m']-height) > 1e-6:
                raise ValueError('Disconnected LiDAR roof')
            validate_geometry(surface.get('geometry'), dimensions=3, floor=height)
        for key in ('coverage', 'explained_fraction', 'roof_support_density_m2', 'part_boundaries_used'):
            if key in record and (not finite_number(record[key]) or record[key] < 0):
                raise ValueError('Invalid LiDAR quality statistic')
        year = record.get('capture_year')
        if 'classified_roof_fraction' in record and (not finite_number(record['classified_roof_fraction'])
                or not 0 <= record['classified_roof_fraction'] <= 1):
            raise ValueError('Invalid LiDAR classification statistic')
        if year is not None and (not finite_number(year) or int(year) != year):
            raise ValueError('Invalid LiDAR capture year')
        for key in ('source', 'source_url', 'source_format', 'method', 'date_basis'):
            if key in record and not isinstance(record[key], str):
                raise ValueError('Invalid LiDAR source metadata')
