"""Optional real Bambu Studio import/save/reopen check.

Run blender_export_cutout.py first to generate the paired fixtures, then:
python tests/bambu_export_names.py --bambu "C:/Program Files/Bambu Studio/bambu-studio.exe"
Uses an isolated data directory and never slices or sends a print job.
"""
import argparse
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
import zipfile


def settings(path):
    with zipfile.ZipFile(path) as archive:
        return ET.fromstring(archive.read('Metadata/model_settings.config'))


def mesh_data(path):
    with zipfile.ZipFile(path) as archive:
        result = []
        for filename in sorted(archive.namelist()):
            if filename.endswith('.model'):
                root = ET.fromstring(archive.read(filename))
                ns = {'m': root.tag.split('}')[0][1:]}
                # Includes per-triangle paint data as saved by Bambu.
                result.extend(ET.tostring(mesh) for mesh in root.findall('.//m:mesh', ns))
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bambu', required=True, type=Path)
    parser.add_argument('--folder', type=Path, default=Path(__file__).resolve().parents[1]/'scratchpad/3mf-names')
    args = parser.parse_args()
    folder = args.folder.resolve()

    def reopen(source, output):
        with (folder/(output+'.log')).open('w') as log:
            subprocess.run([str(args.bambu.resolve()), '--datadir', str(folder/'bambu-profile'),
                            '--arrange', '0', '--orient', '0', '--export-3mf', output,
                            '--outputdir', str(folder), str(folder/source)],
                           cwd=folder, stdout=log, stderr=subprocess.STDOUT,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                           check=True, timeout=120)
        assert (folder/output).is_file(), output
        return settings(folder/output)

    expected = settings(folder/'semantic.3mf')
    baseline = reopen('baseline.3mf', 'baseline-roundtrip.3mf')
    named = reopen('semantic.3mf', 'roundtrip.3mf')
    again = reopen('semantic.3mf', 'reopened.3mf')
    def names(root):
        return [m.get('value') for m in root.findall('.//metadata[@key="name"]')]
    assert names(named) == names(expected), (names(named), names(expected))
    assert names(again) == names(expected)
    assert names(named)[0] == 'Map'
    assert mesh_data(folder/'baseline-roundtrip.3mf') == mesh_data(folder/'roundtrip.3mf')
    # Bambu's saved placement, extruders, repair stats, and part types must agree.
    for root in (baseline, named):
        for part in root.findall('object/part'):
            for key in ('uuid', 'part_guid'):
                part.attrib.pop(key, None)
        for parent in root.iter():
            for child in list(parent):
                if child.tag == 'metadata' and child.get('key') in {'name', 'source_file'}:
                    parent.remove(child)
    assert ET.tostring(baseline) == ET.tostring(named)
    print('BAMBU_EXPORT_NAMES_OK', names(again))


if __name__ == '__main__':
    main()
