"""Select LAZ delivery tiles from individual building footprints and ground halos."""
from shapely import STRtree
from shapely.geometry import box
from shapely.ops import transform

# Measurements consume footprint.buffer(25). Keep the existing 30 m acquisition
# margin (5 m guard) while excluding empty space between unrelated footprints.
SUPPORT_HALO_M = 30.0


def building_tile_plan(source, features, geometries, to_geographic, selection):
    tiles = source['tiles']
    bounds = [box(*tile['bbox']) for tile in tiles]
    tree = STRtree(bounds)
    selected = {}
    limit = selection.buffer(75)
    for feature in features:
        identifier = feature['id']
        footprint = geometries[identifier]
        support = transform(to_geographic, footprint.buffer(SUPPORT_HALO_M).intersection(limit))
        geographic = transform(to_geographic, footprint)
        for i in sorted(tree.query(support, predicate='intersects')):
            tile = tiles[i]
            entry = selected.setdefault(tile['url'], {'tile': tile, 'footprints': [], 'ground_halos': []})
            key = 'footprints' if bounds[i].intersects(geographic) else 'ground_halos'
            entry[key].append(identifier)
    return selected


def batch_source(source, features, tile_plan):
    """The reader and prefetcher share this exact allowlist, including split jobs."""
    if source['format'] != 'LAZ':
        return source
    identifiers = {feature['id'] for feature in features}
    return {**source, 'tiles': [entry['tile'] for entry in tile_plan.values()
            if identifiers.intersection(entry['footprints'] + entry['ground_halos'])]}


def tile_audit(tile_plan, features, reasons):
    identifiers = {feature['id'] for feature in features}
    result = []
    for url, entry in sorted(tile_plan.items()):
        footprints = sorted(identifiers.intersection(entry['footprints']))
        halos = sorted(identifiers.intersection(entry['ground_halos']))
        if footprints or halos:
            result.append({'url': url, 'footprints': footprints, 'ground_halos': halos,
                           'reasons': sorted({reasons[k] for k in footprints + halos}),
                           'size_bytes': entry['tile'].get('size_bytes')})
    return result
