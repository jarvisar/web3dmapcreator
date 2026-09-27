"""Open LiDAR Data / Flai adapter using the published inventory and tile indexes.

Dataset paths, dates, density and CRS come from the live publisher inventory.
Never derive tile coordinates from names or crawl/download COPC point files.
"""
import re
import struct
from urllib.parse import quote, urlencode

from pyproj import CRS, Transformer
from shapely.geometry import box
from shapely.ops import unary_union

try:
    from .lidar_candidates import candidate
    from .lidar_metadata import normalized_metadata, positive, xml_root
    from .lidar_indexes import indexed_shapes, RemoteDbf, INDEX_LIMIT
    from .lidar_identity import original_asset_id
except ImportError:
    from lidar_candidates import candidate
    from lidar_metadata import normalized_metadata, positive, xml_root
    from lidar_indexes import indexed_shapes, RemoteDbf, INDEX_LIMIT
    from lidar_identity import original_asset_id

INVENTORY_URL = 'https://raw.githubusercontent.com/flai-ai/open-lidar-data/main/README.md'
BUCKET_URL = 'https://open-lidar-data.s3.eu-central-1.amazonaws.com/'


def inventory(text):
    # The publisher's seven-column table is its public inventory. Do not bake a
    # country/path list into the add-on; future inventory additions are discovered.
    for row in re.findall(r'\|\s*([^|]+)\|\s*(\d+)\s*\|\s*(data/[^|]+/copc)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|', text):
        name, epsg, path, start, end, density, license = [v.strip().replace('\\', '') for v in row]
        yield {'name': name + ' / ' + path.rsplit('/', 2)[-2], 'path': path,
               'horizontal_crs': f'EPSG:{epsg}', 'license': license,
               'survey_metadata': normalized_metadata({'acquisition_start': start,
                   'acquisition_end': end, 'point_density_m2': positive(density)})}


def discover_flai(fetch, bbox, failures, progress):
    text = fetch.get(INVENTORY_URL, fresh=True, limit=2 * 1024**2).decode('utf-8-sig')
    datasets = list(inventory(text))
    if not datasets:
        raise ValueError('Flai inventory schema changed or contains no datasets')
    roi = box(*bbox)
    for dataset in datasets:
        try:
            crs = CRS.from_user_input(dataset['horizontal_crs'])
            area = crs.area_of_use
            if area and not box(area.west, area.south, area.east, area.north).intersects(roi):
                continue
            prefix = dataset['path'].rsplit('/', 1)[0] + '/shp/'
            authority = ('ea' if dataset['path'].startswith('data/UK/DEFRA/') else
                         'pnoa' if dataset['path'].startswith('data/ES/CNIG/') else '')
            progress(f"Locating Flai COPC tiles: {dataset['name']}")
            listing = xml_root(fetch.get(BUCKET_URL + '?' + urlencode({
                'list-type': 2, 'prefix': prefix, 'max-keys': 100}), fresh=True, limit=1024**2))
            if listing.findtext('IsTruncated') == 'true':
                raise ValueError('Flai spatial index listing is incomplete')
            objects = {n.findtext('Key'): n.findtext('ETag') for n in listing.findall('Contents')}
            tiles, coverage = [], []
            for key in sorted(k for k in objects if k and k.endswith('.shp')):
                url = BUCKET_URL + quote(key, safe='/')
                index_crs = crs
                if key[:-4] + '.prj' in objects:
                    index_crs = CRS.from_wkt(fetch.get(url[:-4] + '.prj', limit=128 * 1024).decode('utf-8-sig'))
                header = fetch.range(url, 0, 100)
                bounds = struct.unpack_from('<4d', header, 36)
                extent = Transformer.from_crs(index_crs, 4326, always_xy=True).transform_bounds(*bounds, densify_pts=21)
                if not box(*extent).intersects(roi):
                    continue
                dbf = RemoteDbf(fetch, url[:-4] + '.dbf')
                for index, geometry in indexed_shapes(fetch.get(url, limit=INDEX_LIMIT), index_crs, bbox):
                    row = dbf.row(index)
                    name = row.get('fname')
                    if not isinstance(name, str) or '/' in name or '\\' in name or not name.lower().endswith('.copc.laz'):
                        raise ValueError('Flai tile index lacks a COPC filename')
                    tile_url = BUCKET_URL + quote(dataset['path'] + '/' + name, safe='/')
                    tiles.append({'url': tile_url, 'bbox': list(geometry.bounds),
                                  'original_asset_id': original_asset_id(authority, name),
                                  'horizontal_crs': f"EPSG:{int(row['epsg'])}" if positive(row.get('epsg')) else dataset['horizontal_crs'],
                                  'updated': objects[key], 'size_bytes': None})
                    coverage.append(geometry)
            if tiles:
                yield candidate('Flai', dataset['path'].rsplit('/', 1)[0], dataset['name'],
                    BUCKET_URL + quote(dataset['path'], safe='/') + '/', 'COPC',
                    unary_union(coverage), tiles=tiles,
                    horizontal_crs=dataset['horizontal_crs'], vertical_datum='unknown',
                    classification={'convention': 'asprs', 'basis': 'LAS standard; explicit VLR labels take precedence'},
                    survey_metadata=dataset['survey_metadata'], license=dataset['license'],
                    attribution='Open LiDAR Data / Flai; ' + dataset['license'], source_page=INVENTORY_URL)
        except (ValueError, OSError, RuntimeError, KeyError, TypeError, AttributeError, struct.error) as exc:
            failures.append({'source': 'Flai ' + dataset['name'], 'reason': str(exc), 'buildings': 0})
