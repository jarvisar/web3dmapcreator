"""Shared measurement validation at disk boundaries; standard library only.

Safe to import in Blender and in the external worker. Invalid records must
never turn a missing upper roof into an apparently valid podium-only model.
"""
import math

ALGORITHM_VERSION = 26
MAX_ROOF_FACETS = 1024
# A roof envelope costs about one face per print-scale cell, so a downtown
# outline needs several times the earlier budget to keep its plan resolution
# instead of having its whole surface coarsened into blocks. That is affordable
# because an envelope publishes one shared vertex table rather than repeating
# every corner in every face: see `envelope_mesh`. The budget is set for a 1 m
# grid and grows with a finer one (a larger print on a dense survey), up to the
# hard limit the reader accepts.
ENVELOPE_FACETS_AT_1M = 16384
MAX_ENVELOPE_FACETS = 65536
MAX_ENVELOPE_VERTICES = MAX_ENVELOPE_FACETS*3


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


def envelope_mesh(rings):
    """Pack cap faces into one shared vertex table and integer faces.

    A roof envelope is one continuous surface whose faces meet at shared
    corners, so writing each face as an independent polygon repeats every
    corner about six times and repeats the GeoJSON wrapper once per face.
    Measured on downtown buildings that is about 238 bytes a face against 42
    here, and the same saving applies to what the reader has to hold in
    memory. Vertices keep their exact published values, so this is only a
    change of encoding: no coordinate moves.
    """
    vertices, lookup, faces = [], {}, []
    for ring in rings:
        indices = []
        # Rings arrive closed, GeoJSON style; a shared table needs each corner
        # once and the closure is implied by the face.
        for vertex in (ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring):
            key = (vertex[0], vertex[1], vertex[2])
            if key not in lookup:
                lookup[key] = len(vertices)
                vertices.append([key[0], key[1], key[2]])
            if not indices or indices[-1] != lookup[key]:
                indices.append(lookup[key])
        if len(indices) > 1 and indices[0] == indices[-1]:
            indices.pop()
        # A sliver clipped beside an outline can round onto one of its own
        # corners; the ring then touches itself, and splitting it there leaves
        # two simple faces covering the same ground.
        pending, simple = [indices], []
        while pending:
            face = pending.pop()
            seen = {}
            for position, index in enumerate(face):
                if index in seen:
                    start = seen[index]
                    pending += [face[start:position], face[position:]+face[:start]]
                    break
                seen[index] = position
            else:
                ring = [vertices[index] for index in face]
                if len(face) >= 3 and sum((a[0]-ring[0][0])*(b[1]-ring[0][1])-(b[0]-ring[0][0])*(a[1]-ring[0][1])
                                          for a, b in zip(ring, ring[1:])):
                    simple.append(face)
        faces += simple
    return {'vertices': vertices, 'faces': faces}


def envelope_rings(mesh):
    """The closed rings of a packed cap, in publication order."""
    vertices = mesh['vertices']
    return [[vertices[index] for index in face]+[vertices[face[0]]] for face in mesh['faces']]


def roof_faces(record):
    """The record's cap faces as closed rings, whichever encoding it uses."""
    if 'roof_mesh' in record:
        return envelope_rings(record['roof_mesh'])
    return [ring for surface in record.get('roof_surfaces') or ()
            for ring in surface['geometry']['coordinates']]


def has_roof_surface(record):
    """Does this record carry measured roof geometry of any kind?"""
    return bool(record.get('roof_surfaces') or record.get('roof_mesh'))


def validate_envelope_mesh(mesh, floor):
    """A packed cap: finite geographic vertices and simple, closed faces."""
    if not isinstance(mesh, dict):
        raise ValueError('Invalid LiDAR envelope mesh')
    vertices, faces = mesh.get('vertices'), mesh.get('faces')
    if (not isinstance(vertices, list) or not isinstance(faces, list)
            or not faces or len(faces) > MAX_ENVELOPE_FACETS
            or not vertices or len(vertices) > MAX_ENVELOPE_VERTICES):
        raise ValueError('Invalid LiDAR envelope mesh size')
    for vertex in vertices:
        if not isinstance(vertex, (list, tuple)) or len(vertex) != 3 or not all(map(finite_number, vertex)):
            raise ValueError('Invalid LiDAR envelope vertex')
        if not (-180 <= vertex[0] <= 180 and -90 <= vertex[1] <= 90):
            raise ValueError('Invalid LiDAR envelope coordinates')
        if vertex[2] < floor-1e-6:
            raise ValueError('LiDAR envelope below its base')
    count = len(vertices)
    for face in faces:
        if not isinstance(face, (list, tuple)) or len(face) < 3 or len(face) > 4096:
            raise ValueError('Invalid LiDAR envelope face')
        if any(not isinstance(index, int) or isinstance(index, bool)
               or not 0 <= index < count for index in face):
            raise ValueError('Invalid LiDAR envelope face index')
        if len(set(face)) != len(face):
            raise ValueError('Degenerate LiDAR envelope face')
        first = vertices[face[0]]
        ring = [vertices[index] for index in face]
        area = sum((a[0]-first[0])*(b[1]-first[1])-(b[0]-first[0])*(a[1]-first[1])
                   for a, b in zip(ring, ring[1:]+ring[:1]))
        if area == 0:
            raise ValueError('Degenerate LiDAR envelope ring')


def validate_records(buildings):
    if not isinstance(buildings, dict):
        raise ValueError('Invalid buildings dictionary')
    for identifier, record in buildings.items():
        if not isinstance(identifier, str) or not isinstance(record, dict):
            raise ValueError('Invalid LiDAR building record')
        height = record.get('height_m')
        if not finite_number(height) or height <= 0:
            raise ValueError('Invalid LiDAR height')
        if record.get('method') == 'height_only' and any(record.get(key) for key in
                ('tiers', 'roof_surfaces', 'roof_mesh', 'infill_geometry', 'part_heights', 'surface_kind')):
            raise ValueError('Height-only measurements cannot contain reconstructed geometry')
        if 'source_heights' in record:
            heights = record['source_heights']
            if (record.get('method') != 'height_only' or not isinstance(heights, dict) or not heights
                    or any(not isinstance(k,str) or not k or not finite_number(v) or v<=0 for k,v in heights.items())
                    or max(heights.values()) != height):
                raise ValueError('Invalid source mass heights')
        if 'surface_kind' in record:
            if record['surface_kind'] != 'rock' or record.get('surface_reconstruction') != 'roof_envelope':
                raise ValueError('Invalid LiDAR surface kind')
            validate_geometry(record.get('surface_geometry'))
            if 'ground_anchor' not in record:
                raise ValueError('Missing LiDAR ground anchor')
            covered = record.get('covered_buildings', [])
            if not isinstance(covered, list) or any(not isinstance(k, str) or not k or k.startswith('rock:') for k in covered):
                raise ValueError('Invalid rock-covered building identifiers')
        if 'ground_anchor' in record:
            anchor = record.get('ground_anchor')
            if (not isinstance(anchor, (list, tuple)) or len(anchor) != 3 or not all(map(finite_number, anchor))
                    or not -180 <= anchor[0] <= 180 or not -90 <= anchor[1] <= 90 or anchor[2] < 0):
                raise ValueError('Invalid LiDAR ground anchor')
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
        if record.get('surface_reconstruction') == 'roof_envelope':
            # An envelope publishes one packed mesh instead of thousands of
            # independent faces; the legacy polygon list stays for every other
            # reconstruction, including a record written before that change.
            if record.get('method') != 'faceted_roof' or (not surfaces and 'roof_mesh' not in record):
                raise ValueError('Invalid LiDAR upper surface')
            limit = MAX_ENVELOPE_FACETS
            if 'roof_mesh' in record:
                if surfaces:
                    raise ValueError('Duplicate LiDAR upper surface')
                validate_envelope_mesh(record['roof_mesh'], height)
        elif 'roof_mesh' in record:
            raise ValueError('Unexpected LiDAR envelope mesh')
        if not isinstance(surfaces, list) or len(surfaces) > limit or (surfaces and tiers):
            raise ValueError('Invalid LiDAR roof surfaces')
        if tiers and 'roof_mesh' in record:
            raise ValueError('Invalid LiDAR roof surfaces')
        for surface in surfaces:
            if not isinstance(surface, dict) or not finite_number(surface.get('bottom_m')) or abs(surface['bottom_m']-height) > 1e-6:
                raise ValueError('Disconnected LiDAR roof')
            validate_geometry(surface.get('geometry'), dimensions=3, floor=height)
            if record.get('surface_reconstruction') == 'roof_envelope' and len(surface['geometry']['coordinates']) != 1:
                raise ValueError('Envelope faces must be simple polygons')
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
