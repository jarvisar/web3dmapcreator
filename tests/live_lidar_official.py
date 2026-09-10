"""Opt-in network regression; coordinates live only in tests, never providers.

Metadata only by default. --acquire reads the best streaming source; ordinary
tiles additionally require --use-offers. --prepare downloads real Overture
footprints and runs the normal worker, including its request-bound offer token.
Use tests/blender_lidar.py -- --bundle <printed path> for geometry verification.
"""
import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'jarvizar_city_model' / 'external')]

from jarvizar_city_model.external.lidar_acquisition import discover_sources, read_source, source_audit
from jarvizar_city_model.external.lidar_ept import Fetcher
from jarvizar_city_model.external.lidar_candidates import streamable
from jarvizar_city_model.external.lidar_downloads import prefetch_source

CASES = {
    'paris': ([2.349, 48.8495, 2.351, 48.851], ['ign_france']),
    'london': ([-.124, 51.507, -.122, 51.508], ['ea_england']),
    'cologne': ([6.9555, 50.9405, 6.9575, 50.9425], ['geobasis_nrw']),
    'munich': ([11.5735, 48.1365, 11.5755, 48.1385], ['bavaria']),
    'dresden': ([13.739, 51.050, 13.740, 51.051], ['flai']),
    'madrid': ([-3.705, 40.416, -3.704, 40.417], ['pnoa_clm']),
    'barcelona': ([2.173, 41.385, 2.174, 41.386], ['pnoa_clm']),
    'toledo': ([-4.0245, 39.8575, -4.0225, 39.8595], ['pnoa_clm']),
    'toronto': ([-79.391, 43.6495, -79.388, 43.651], ['nrcan']),
    'vancouver': ([-123.121, 49.282, -123.120, 49.283], ['nrcan']),
    'campbeltown': ([-5.607, 55.425, -5.606, 55.426], ['scotland']),
    # No direct Italian point-cloud adapter is claimed. These explicitly test
    # whether the preserved international catalogs provide a usable fallback.
    'trieste': ([13.769, 45.649, 13.770, 45.650], ['flai', 'opentopography']),
    'rome': ([12.495, 41.889, 12.496, 41.890], ['flai', 'opentopography']),
    'chicago': ([-87.635, 41.882, -87.6345, 41.8825], ['usgs']),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', choices=CASES, action='append', required=True)
    parser.add_argument('--cache', type=Path, default=ROOT / 'scratchpad' / 'official-live')
    parser.add_argument('--aggregators', action='store_true', help='Also query Flai and OpenTopography')
    parser.add_argument('--all-providers', action='store_true', help='Use normal add-on discovery defaults')
    parser.add_argument('--acquire', action='store_true', help='Read one selected dataset, within 1 GiB')
    parser.add_argument('--prepare', action='store_true', help='Run real footprint acquisition and shared LiDAR preparation')
    parser.add_argument('--use-offers', action='store_true', help='Explicitly authorize selected LAZ/ZIP test downloads')
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    errors = 0
    for name in args.case:
        bbox, providers = CASES[name]
        providers = None if args.all_providers else sorted(set(providers + (['flai', 'opentopography'] if args.aggregators else [])))
        started = time.monotonic()
        report = {'case': name, 'bbox': bbox}
        try:
            if args.prepare:
                from jarvizar_city_model.data.cache import Bounds, CacheBundle
                from jarvizar_city_model.data.overture import download_to_cache
                from jarvizar_city_model.data.lidar import request_signature
                from download_lidar import prepare
                bundle = CacheBundle(args.cache, Bounds(*bbox))
                if not bundle.is_complete():
                    download_to_cache(Path(sys.executable), bundle)
                request = request_signature(bundle, .07, .07, providers=providers)
                (args.cache / (name + '-request.json')).write_text(json.dumps(request, indent=2))
                report['summary'] = prepare(bundle.path, request, progress_path=args.cache / (name + '-progress.json'))
                if report['summary']['laz_offers'] and args.use_offers:
                    report['summary'] = prepare(bundle.path, request,
                        laz_approval=report['summary']['laz_offer_token'], download_workers=1,
                        progress_path=args.cache / (name + '-progress.json'))
                report['bundle'] = str(bundle.path.resolve())
                print('PREPARED', name, report['bundle'], report['summary']['buildings'], 'measurements', flush=True)
            else:
                fetch = Fetcher(args.cache / 'lidar_tiles', max_bytes=1024**3)
                fetch.progress = lambda message: print(name, message, flush=True)
                sources, failures = discover_sources(fetch, bbox, discovery={'providers': providers}, progress=fetch.progress)
                report.update(sources=source_audit(sources), failures=failures)
                print('DISCOVERED', name, len(sources), 'datasets', len(failures), 'diagnostics', flush=True)
                if args.acquire and sources:
                    source = sources[0]
                    if streamable(source) or args.use_offers:
                        with prefetch_source(fetch, source, [bbox], workers=1) as stream:
                            points, info = read_source(stream, source, bbox)
                        report.update(points=len(points), info=info, bytes=fetch.bytes, requests=fetch.requests)
                        print('ACQUIRED', name, len(points), 'points', flush=True)
                    else:
                        report['delivery'] = 'LAZ requires explicit --use-offers for this test'
        except Exception as exc:
            errors += 1
            report['error'] = str(exc)
            print('FAILED', name, repr(exc), flush=True)
        report['seconds'] = time.monotonic() - started
        (args.cache / (name + '-report.json')).write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
