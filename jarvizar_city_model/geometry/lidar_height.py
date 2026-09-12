"""Apply scalar LiDAR heights to already-built source masses."""


def correct_assemblies(groups, profiles, vertical, minimum_thickness):
    """Keep topology, XY, grounded undersides and source selection unchanged.

    Each source identity uses only its own measured height. The tallest
    successfully emitted roof excludes the print minimum lift. A low podium
    must never inherit the height measured on a neighboring tower.
    """
    corrected = 0
    for identifier, segments in groups.items():
        peak = max(segment['peak'] for segment in segments)
        if peak <= 0:
            continue
        record = profiles[identifier]
        height = record['height_m']
        measured = vertical(height)
        # This is a sanity correction, not a precision adjustment. Keep small
        # differences (including survey noise) byte-for-byte unchanged.
        if abs(measured-peak) <= max(vertical(3.), max(measured, peak)*.2):
            continue
        ratio = measured / peak
        objects = {}
        for segment in segments:
            builder, base = segment['builder'], segment['base']
            lift = max(0., segment['minimum'] - (base + segment['peak']*ratio - segment['terrain_top'])) if segment['minimum'] else 0.
            for index in segment['upper']:
                x, y, z = builder.vertices[index]
                z = base + (z-base-segment['lift'])*ratio + lift
                if segment['grounded']:
                    z = max(z, segment['floor'](x, y)+minimum_thickness)
                builder.vertices[index] = (x, y, z)
            obj = segment.get('object')
            if obj is not None:
                objects[obj.name] = (obj, builder)
                obj['height_source'] = 'lidar:height_only'
                obj['lidar_height_ratio'] = ratio
                obj['lidar_measured_height_m'] = height
                obj['minimum_height_lift_mm'] = lift
        for obj, builder in objects.values():
            # Unmerged meshes were emitted before the family's final top was
            # known. Merged builders are published after this correction.
            obj.data.vertices.foreach_set('co', [c for vertex in builder.vertices for c in vertex])
            obj.data.update()
            for key in ('height_m', 'mass_thickness_m', 'min_height_m', 'roof_height',
                        'roof_wall_top_m', 'roof_top_m'):
                if isinstance(obj.get(key), (int, float)):
                    obj[key] *= ratio
        corrected += 1
    return corrected
