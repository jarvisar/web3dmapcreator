"""Optional installed Bambu Studio import/save/reopen contract.

First run blender_export_plates.py. Uses an isolated data directory, with no
slicing, network access, printer connection, or user preference changes.
"""
import argparse
from collections import Counter
import ctypes
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvizar_city_model.data.export_3mf import MODEL, NS, SETTINGS
from jarvizar_city_model.data.export_plates import PROJECT
from jarvizar_city_model.data.export_sections import plate_origin


def metadata(element, key):
    value = element.find(f"metadata[@key='{key}']")
    return value.get('value') if value is not None else None


def transform(point, text):
    if not text:
        return point
    m = [float(v) for v in text.split()]
    return tuple(sum(m[i + j * 3] * point[j] for j in range(3)) + m[9 + i] for i in range(3))


def paint_id(code, default):
    if not code:
        return default
    if code[-1] != 'C':
        return int(code, 16) // 4
    return 3 + 15 * code[1:-1].count('F') + int(code[0], 16)


def inspect(path):
    with zipfile.ZipFile(path) as archive:
        roots = {name: ET.fromstring(archive.read(name)) for name in archive.namelist() if name.endswith('.model')}
        config = ET.fromstring(archive.read(SETTINGS))
        project = json.loads(archive.read(PROJECT))
    palette = project['filament_colour']
    count = len(config.findall('plate'))
    result = {}
    root = roots[MODEL]
    for index, plate in enumerate(config.findall('plate')):
        assert metadata(plate, 'plater_id') == str(index + 1)
        assert len(plate.findall('model_instance')) == 1
        instance = plate.find('model_instance')
        assert metadata(instance, 'instance_id') == '0'
        object_id = metadata(instance, 'object_id')
        assembly = root.find(f"m:resources/m:object[@id='{object_id}']", NS)
        item = root.find(f"m:build/m:item[@objectid='{object_id}']", NS)
        obj_settings = config.find(f"object[@id='{object_id}']")
        name = metadata(obj_settings, 'name')
        assert name == metadata(plate, 'plater_name')
        origin = plate_origin(index, count)
        parts = {}
        for component in assembly.findall('m:components/m:component', NS):
            part_id = component.get('objectid')
            model_path = component.get('{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}path', MODEL).lstrip('/')
            mesh = roots[model_path].find(f"m:resources/m:object[@id='{part_id}']/m:mesh", NS)
            part_settings = obj_settings.find(f"part[@id='{part_id}']")
            part_name = metadata(part_settings, 'name')
            default = int(metadata(part_settings, 'extruder') or metadata(obj_settings, 'extruder'))
            points = [tuple(float(v.get(a)) for a in ('x', 'y', 'z')) for v in mesh.find('m:vertices', NS)]
            points = [transform(transform(p, component.get('transform')), item.get('transform')) for p in points]
            points = [(x - origin[0], y - origin[1], z) for x, y, z in points]
            assert all(-1e-4 <= x <= 256.0001 and -1e-4 <= y <= 256.0001 and z >= -1e-4 for x, y, z in points)
            triangles = []
            for triangle in mesh.find('m:triangles', NS):
                color = palette[paint_id(triangle.get('paint_color'), default) - 1]
                triangles.append((tuple(points[int(triangle.get(v))] for v in ('v1', 'v2', 'v3')), color))
            parts[part_name] = triangles
        result[name] = parts
    return result, palette


def compare(before, after):
    assert before[1] == after[1], (before[1], after[1])
    assert list(before[0]) == list(after[0])
    for name, parts in before[0].items():
        assert parts.keys() == after[0][name].keys()
        for part_name, triangles in parts.items():
            other = after[0][name][part_name]
            assert len(triangles) == len(other), (name, part_name)
            # Bambu can reorder faces, but must preserve geometry and colors.
            def key(face):
                points, color = face
                center = tuple(round(sum(p[i] for p in points) / 3, 3) for i in range(3))
                return center, color
            assert Counter(map(key, triangles)) == Counter(map(key, other)), (name, part_name, 'faces/colors')
            a = sorted(p for points, color in triangles for p in points)
            b = sorted(p for points, color in other for p in points)
            # Compare bounds independently: re-centering uses float32 internally.
            for axis in range(3):
                assert abs(min(p[axis] for p in a) - min(p[axis] for p in b)) < 1e-4
                assert abs(max(p[axis] for p in a) - max(p[axis] for p in b)) < 1e-4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bambu', type=Path, required=True)
    parser.add_argument('--folder', type=Path, default=Path(__file__).resolve().parents[1] / 'scratchpad/multi-plate')
    args = parser.parse_args()
    folder = args.folder.resolve()
    if sys.platform == 'win32':
        # Report subprocess failures instead of leaving a Windows crash dialog.
        ctypes.windll.kernel32.SetErrorMode(0x8003)
    def reopen(source, name):
        destination = folder / (name + '.3mf')
        with (folder / (name + '.log')).open('w') as log:
            subprocess.run([str(args.bambu.resolve()), '--datadir', str(folder / 'bambu-profile'),
                            '--arrange', '0', '--orient', '0', '--export-3mf', destination.name,
                            '--outputdir', str(folder), str(source)], cwd=folder,
                           stdout=log, stderr=subprocess.STDOUT, timeout=60, check=True,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return destination
    for name in ('six-NONE', 'six-METRIC', 'concave', 'fits'):
        source = folder / (name + '.3mf')
        expected = inspect(source)
        saved = reopen(source, name + '-saved')
        compare(expected, inspect(saved))
        reopened = reopen(saved, name + '-reopened')
        compare(expected, inspect(reopened))
        print('BAMBU_PLATES_ROUNDTRIP', name, len(expected[0]), len(expected[1]), flush=True)
    print('BAMBU_EXPORT_PLATES_OK')


if __name__ == '__main__':
    main()
