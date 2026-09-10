"""OpenTopography public catalog and published tile-index discovery."""
from html import unescape
from urllib.parse import quote, urlencode
from zipfile import BadZipFile

from shapely.geometry import box, shape
from shapely.ops import unary_union

try:
    from .lidar_candidates import candidate, asset_format, https_url
    from .lidar_metadata import normalized_metadata
    from .lidar_indexes import zip_index
except ImportError:
    from lidar_candidates import candidate, asset_format, https_url
    from lidar_metadata import normalized_metadata
    from lidar_indexes import zip_index

CATALOG_URL = 'https://portal.opentopography.org/API/otCatalog'
BULK_URL = 'https://opentopography.s3.sdsc.edu/pc-bulk/'


def discover_opentopography(fetch, bbox, failures, progress):
    west, south, east, north = bbox
    url = CATALOG_URL + '?' + urlencode(dict(productFormat='PointCloud', minx=west, miny=south,
        maxx=east, maxy=north, detail='true', outputFormat='json', include_federated='false'))
    document = fetch.json(url, fresh=True)
    datasets = document['Datasets']
    if not isinstance(datasets, list):
        raise ValueError('Invalid OpenTopography catalog')
    if len(datasets) > 100:
        failures.append({'source': 'OpenTopography', 'reason': 'Catalog limit reached; listing is incomplete', 'buildings': 0})
    for item in datasets[:100]:
        name = 'dataset'
        try:
            dataset = item['Dataset']
            name = dataset['name']
            geojson = dataset['spatialCoverage']['geo']['geojson']
            coverage = unary_union([shape(f['geometry']) for f in geojson['features']])
            if not coverage.intersects(box(*bbox)):
                continue
            short = dataset['alternateName']
            if not short or '/' in short or '\\' in short or short in ('.', '..'):
                raise ValueError('Invalid OpenTopography dataset identifier')
            index_url = BULK_URL + quote(short, safe='') + '/' + quote(short, safe='') + '_TileIndex.zip'
            interval = dataset.get('temporalCoverage', '').split('/')
            meta = normalized_metadata({'acquisition_start': interval[0].strip(),
                'acquisition_end': interval[-1].strip()}) if len(interval) == 2 else {}
            progress(f'Locating OpenTopography tiles: {name}')
            groups = {}
            for row, geometry in zip_index(fetch, index_url, bbox):
                row = {k.lower(): v for k, v in row.items()}
                tile_url = str(row.get('url', ''))
                if tile_url.startswith('http://'):
                    tile_url = 'https://' + tile_url[7:]
                https_url(tile_url)
                format = asset_format(tile_url)
                if not format:
                    continue
                groups.setdefault(format, []).append(({'url': tile_url, 'bbox': list(geometry.bounds),
                    'size_bytes': row.get('size_bytes'), 'updated': dataset.get('dateModified', '')}, geometry))
            if not groups:
                raise ValueError('No supported intersecting point-cloud tiles in published index')
            for format, values in groups.items():
                yield candidate('OpenTopography', dataset['identifier']['value'], unescape(name),
                    index_url + '#' + format, format, unary_union([g for _, g in values]),
                    tiles=[t for t, _ in values], survey_metadata=meta,
                    source_page=dataset.get('url', url), license=dataset.get('license', 'unknown; see source page'),
                    attribution=unescape(dataset.get('citation', '')), vertical_datum='unknown')
        except (ValueError, OSError, RuntimeError, KeyError, TypeError, AttributeError, BadZipFile) as exc:
            failures.append({'source': 'OpenTopography ' + name,
                             'reason': f'Catalog dataset found; tile discovery unavailable: {exc}', 'buildings': 0})
