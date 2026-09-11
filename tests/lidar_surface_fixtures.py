"""Generate reproducible measurement inputs for blender_lidar_surfaces.py.

Run with the optional LiDAR Python environment, for example:
  python tests/lidar_surface_fixtures.py --output scratchpad/lidar-surfaces.json

The default comparison uses unchanged Terraces against Detailed Surfaces. To
compare an earlier Detailed Surfaces implementation, supply --baseline-dir with
lidar_measurements.py and lidar_facets.py (the *_baseline.py names also work).
Reference dependencies are loaded from that directory when supplied, with the
checkout as a fallback for a two-module snapshot. No city caches, network, or
Blender are required.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import numpy as np
from shapely import contains_xy
from shapely.affinity import rotate
from shapely.geometry import Point, box, mapping

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from jarvizar_city_model.external import lidar_measurements as current


SETTINGS = {'min_width_m': .1/.07, 'min_step_m': .05/(.07*1.1), 'ground_m': 0}
POINT_SPACING = .45


def baseline_modules(directory):
    """Load optional reference code under isolated, non-package module names."""
    sys.path.insert(0, str(ROOT / 'jarvizar_city_model' / 'external'))
    sys.path.insert(0, str(directory.resolve()))
    hashes = {}
    for stem, module_name in (('lidar_facets', 'lidar_facets'),
                              ('lidar_measurements', 'lidar_measurements_reference')):
        path = directory / (stem + '_baseline.py')
        if not path.is_file():
            path = directory / (stem + '.py')
        if not path.is_file():
            raise FileNotFoundError(f'Missing reference module: {stem} in {directory}')
        hashes[stem] = hashlib.sha256(path.read_bytes()).hexdigest()
        spec = importlib.util.spec_from_file_location(module_name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
    return module, hashes


def definitions():
    footprint = box(0, 0, 60, 60)
    tower, crown = rotate(box(15, 18, 45, 42), 29), rotate(box(24, 24, 36, 36), 29)

    def diagonal(x, y):
        return np.where(contains_xy(crown, x, y), 80,
                        np.where(contains_xy(tower, x, y), 50, 20))

    yield {'name': 'diagonal_nested_towers', 'footprint': footprint, 'roof': diagonal,
           'probe_xy': [(5, 5), (15, 15), (20, 30), (30, 30), (40, 30), (55, 55)],
           'tolerance_m': .05}

    def circular(x, y):
        radius = np.hypot(x-30, y-30)
        return np.where(radius < 10, 80, np.where(radius < 23, 50, 20))

    yield {'name': 'curved_nested_towers', 'footprint': footprint, 'roof': circular,
           'probe_xy': [(5, 5), (12, 30), (30, 12), (30, 30), (48, 30), (30, 48)],
           'tolerance_m': .05}

    irregular = Point(30, 30).buffer(23, quad_segs=96).difference(box(30, 30, 60, 60))

    def irregular_roof(x, y):
        return np.where(contains_xy(irregular, x, y), 50, 20)

    yield {'name': 'irregular_arc_setback', 'footprint': footprint, 'roof': irregular_roof,
           'probe_xy': [(5, 5), (30, 15), (20, 30), (25, 25), (40, 40), (35, 35), (33, 27)],
           'tolerance_m': .05}

    def steep_crown(x, y):
        return 20 + 2.3*x

    yield {'name': 'steep_continuous_crown', 'footprint': box(0, 0, 24, 24),
           'roof': steep_crown,
           'probe_xy': [(x, y) for x in (3, 8, 12, 18, 22) for y in (4, 12, 20)],
           'tolerance_m': 1.3}

    def kinked_roof(x, y):
        return 20 + 2.3*np.maximum(0, x-6)

    yield {'name': 'steep_kink_retained_boundary', 'footprint': box(0, 0, 24, 24),
           'roof': kinked_roof,
           'probe_xy': [(x, y) for x in (3, 8, 12, 18, 22) for y in (4, 12, 20)],
           'tolerance_m': 2.0, 'compare_probe_error': True,
           'note': 'The former fitter retained a terrace at this flat-to-steep boundary. '
                   'Surface reconstruction can now recover its supported continuous fold.'}

    def curved_roof(x, y):
        return 15 + 7*(1-((x-12)/12)**2)

    yield {'name': 'curved_roof_courtyard',
           'footprint': box(0, 0, 24, 24).difference(box(8, 8, 16, 16)),
           'roof': curved_roof,
           'probe_xy': [(x, y) for x in (3, 6, 12, 18, 21) for y in (3, 21)]
                       + [(3, 12), (21, 12)],
           'void_probes': [(10, 10), (12, 12), (14, 14)], 'tolerance_m': 1.3}

    footprint = box(0, 0, 48, 36)
    probes = [(x, y) for x in (3, 9, 18, 30, 43) for y in (4, 14, 29)]
    noise = lambda x, y: np.sin(x*1.7)*np.cos(y*2.1)
    roofs = {
        'noisy_flat_roof': lambda x, y: 22 + .12*noise(x, y),
        'broad_subprint_roof_ripple': lambda x,y:20+.4*np.sin(x/3)*np.cos(y/4),
        'subprint_offset_flat_roof': lambda x,y:20+np.where(x>24,.9,0)+.05*noise(x,y),
        'noisy_sloped_roof': lambda x, y: 15 + .42*x + .12*noise(x, y),
        'noisy_barrel_roof': lambda x, y: 15 + 10*np.sqrt(np.maximum(0, 1-((x-24)/26)**2)) + .1*noise(x, y),
        'noisy_gabled_roof': lambda x, y: 15 + .55*np.minimum(x, 48-x) + .1*noise(x, y),
        'flat_roof_with_plant': lambda x, y: 20 + np.where((x>17)&(x<30)&(y>11)&(y<24), 4, 0) + .1*noise(x, y),
        'sloped_roof_with_plant': lambda x,y:20+.3*x+np.where((x>17)&(x<30)&(y>11)&(y<24),8,0)+.1*noise(x,y),
        'three_level_setbacks': lambda x, y: np.where((x>14)&(x<34)&(y>10)&(y<26), 95,
            np.where((x>7)&(x<41)&(y>5)&(y<31), 55, 18)) + .08*np.sin(x*1.7),
    }
    for name, roof in roofs.items():
        interior_probes = ([(x, y) for x in (3, 9, 18, 24, 32, 43) for y in (4, 14, 29)]
                           if name in ('flat_roof_with_plant','sloped_roof_with_plant') else probes)
        yield {'name': name, 'footprint': footprint, 'roof': roof,
               'probe_xy': interior_probes, 'tolerance_m': .8}


def make_cloud(footprint, roof):
    left, bottom, right, top = footprint.bounds
    xx, yy = np.meshgrid(np.arange(left+.25, right, POINT_SPACING),
                         np.arange(bottom+.25, top, POINT_SPACING), indexing='ij')
    x, y = xx.ravel(), yy.ravel()
    inside = contains_xy(footprint, x, y)
    x, y = x[inside], y[inside]
    return np.column_stack((x, y, roof(x, y), np.full(len(x), 6), np.ones(len(x))))


def generate(reference=None):
    cases = []
    for definition in definitions():
        footprint, roof = definition['footprint'], definition['roof']
        cloud = make_cloud(footprint, roof)
        previous = reference or current
        before_mode = 'FACETED' if reference else 'TERRACES'
        before, before_reason = previous.measure_building(
            footprint, previous.PointIndex(cloud), roof_mode=before_mode, **SETTINGS)
        after, after_reason = current.measure_building(
            footprint, current.PointIndex(cloud), roof_mode='FACETED', **SETTINGS)
        if before is None or after is None:
            raise AssertionError((definition['name'], before_reason, after_reason))
        if after_reason != 'faceted_roof':
            raise AssertionError((definition['name'], 'Detailed Surfaces did not fit', after_reason))
        probes = [{'xy': xy, 'height_m': float(roof(*xy)),
                   'tolerance_m': definition['tolerance_m']} for xy in definition['probe_xy']]
        cases.append({'name': definition['name'], 'footprint': mapping(footprint),
                      'before': before, 'after': after, 'probes': probes,
                      'void_probes': definition.get('void_probes', []),
                      'point_count': len(cloud), 'before_mode': before_mode,
                      'before_reason': before_reason, 'after_reason': after_reason,
                      'compare_probe_error': definition.get('compare_probe_error', False),
                      'note': definition.get('note', '')})
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--baseline-dir', type=Path)
    args = parser.parse_args()
    reference, hashes = baseline_modules(args.baseline_dir) if args.baseline_dir else (None, {})
    cases = generate(reference)
    result = {'cases': cases, 'measurement_settings': SETTINGS,
              'mm_per_metre': .07, 'building_height_multiplier': 1.1,
              'point_spacing_m': POINT_SPACING, 'reference_module_sha256': hashes}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print('LIDAR_SURFACE_FIXTURES_OK', json.dumps([
        {'name': case['name'], 'points': case['point_count'],
         'before': case['before_reason'], 'after': case['after_reason'],
         'before_facets': len(case['before'].get('roof_surfaces', [])),
         'after_facets': len(case['after'].get('roof_surfaces', []))} for case in cases]))


if __name__ == '__main__':
    main()
