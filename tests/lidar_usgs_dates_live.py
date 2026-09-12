"""Metadata-only live discovery and first-acquisition check for cached buildings.

Run in external Python: tests/lidar_usgs_dates_live.py --cache <cache root>
    --output <diagnostic directory> [--providers usgs|default]
No point downloads, measurements, or writes to the user's map cache.
"""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from pyproj import CRS, Transformer
from shapely.geometry import box, shape
from shapely.ops import transform
from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.external.lidar_acquisition import discover_sources, source_audit
from jarvizar_city_model.external.lidar_ept import Fetcher
from jarvizar_city_model.external.lidar_ranking import AcquisitionPlan, selection_thresholds


class MetadataOnlyFetcher(Fetcher):
    def get(self, url, *args, **kwargs):
        path = url.split('?')[0].lower()
        assert '/ept-data/' not in path and '/ept-hierarchy/' not in path, url
        assert not path.endswith(('.laz', '.las', '.zip')), url
        return super().get(url, *args, **kwargs)

    def download(self, *args, **kwargs):
        raise AssertionError('This check must never acquire point files')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--providers', choices=('usgs', 'default'), default='default')
    args = parser.parse_args()
    bbox = (-122.44417, 37.76678, -122.37834, 37.81745)
    bundle = CacheBundle(Path(args.cache), Bounds(*bbox))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    # Match the worker's local projection and 75 m ground-context halo.
    crs = CRS.from_proj4(f'+proj=aeqd +lat_0={(bbox[1]+bbox[3])/2} +lon_0={(bbox[0]+bbox[2])/2} +datum=WGS84 +units=m')
    forward = Transformer.from_crs(4326, crs, always_xy=True).transform
    inverse = Transformer.from_crs(crs, 4326, always_xy=True).transform
    query = transform(inverse, transform(forward, box(*bbox)).buffer(75)).bounds
    fetch = MetadataOnlyFetcher(output/'metadata', max_bytes=128*1024**2)
    sources, failures = discover_sources(fetch, query, progress=lambda msg: print(msg, flush=True),
                                        discovery={'providers': ['usgs']} if args.providers == 'usgs' else None)
    # First verify the order, then run the real scheduler on cached footprints.
    assert sources and sources[0]['name'] == 'CA_SanFrancisco_1_B23', source_audit(sources)
    buildings = json.loads(bundle.data_path('building').read_text(encoding='utf-8'))['features']
    geometries = {f['id']: shape(f['geometry']) for f in buildings}
    buildings = [f for f in buildings if geometries[f['id']].intersects(box(*bbox))]
    plan = AcquisitionPlan(sources, buildings, geometries, selection_thresholds())
    first, selected, reason = plan.next(set(), source_format='STREAM')
    assert first['name'] == 'CA_SanFrancisco_1_B23', first['name']
    assert first['survey_metadata']['acquisition_start'] == '2023-04-20'
    report = dict(bbox=bbox, query=query, first=first['name'], selected_buildings=len(selected),
                  reason=reason, requests=fetch.requests, metadata_bytes=fetch.bytes,
                  point_downloads=0, sources=source_audit(sources), failures=failures)
    (output/'ranking.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('USGS_DATES_LIVE_OK', first['name'], len(selected), 'buildings; no point downloads', flush=True)


if __name__ == '__main__':
    main()
