"""Build only validated mapped-rock envelopes; a failed cap adds no geometry."""
from ..blender.mesh_utils import projected_polygon_rings
from .lidar_buildings import measured_builder
from .planar import densify_ring


def generate_rock_surfaces(records, transform, heightfield, collection, material,
                           height_scale=1.1, embed=.15, spacing=1.5, minimum_width=.08,
                           ground_support=None):
    counts = {'lidar_rock_surfaces': 0, 'lidar_rock_geometry_fallbacks': 0}
    covered = set()
    vertical = lambda z: transform.vertical_meters_to_model_mm(z)*height_scale
    for identifier, record in records.items():
        if record.get('surface_kind') != 'rock':
            continue
        feature = {'id': identifier, 'geometry': record['surface_geometry'], 'properties': {}}
        outlines = projected_polygon_rings(feature['geometry'], transform)
        if not outlines:
            continue
        x, y = transform.forward(*record['ground_anchor'][:2])[:2]
        base = heightfield.height_mm(x, y)-vertical(record['ground_anchor'][2])
        samples = [xy for rings in outlines for ring in rings for xy in densify_ring(ring, spacing)]
        top = heightfield.maximum_over(samples)
        try:
            built = measured_builder(feature, record, transform, heightfield, (base, top), vertical,
                                      embed, spacing, minimum_width, 0, 0, 0, 0)
        except (ValueError, TypeError, KeyError, IndexError):
            built = None
        if built is None:
            counts['lidar_rock_geometry_fallbacks'] += 1
            continue
        builder, metadata = built
        builder.name = 'ROCK_LIDAR_'+identifier.replace('rock:', '')[:12]
        obj = builder.build(collection, material)
        obj['feature_type'] = 'rock'
        obj['height_source'] = 'lidar:rock_envelope'
        obj['lidar_source'] = record.get('source', '')
        obj['lidar_coverage'] = record['coverage']
        for key, value in metadata.items():
            obj[key] = value
        if ground_support is not None:
            for rings in outlines:
                ground_support.footprint(rings, 'building')
        # A mapped rock mass already represents wholly contained source masses.
        # Only commit suppression after its complete replacement cap succeeds.
        covered.update(record.get('covered_buildings', ()))
        counts['lidar_rock_surfaces'] += 1
    return counts, covered
