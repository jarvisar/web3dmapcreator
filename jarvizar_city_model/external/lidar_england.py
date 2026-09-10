"""Environment Agency official spatial indexes and public survey tile API.

England only. The official minimum delivery unit is a 5 km ZIP, offered with
explicit consent. Only intersecting indexed LAZ members enter preparation.
"""
import json
from urllib.parse import quote

from shapely.geometry import box, mapping

try:
    from .lidar_services import features, grouped, tile
    from .lidar_identity import original_asset_id
except ImportError:
    from lidar_services import features, grouped, tile
    from lidar_identity import original_asset_id

INDEX = 'https://environment.data.gov.uk/spatialdata/survey-index-files/wfs'
NAMESPACE = 'dataset-9f0fa3fc-a860-4729-adc9-47fe53f658d0:'
SEARCH = 'https://environment.data.gov.uk/tiles/collections/survey/search'
PRODUCTS = {
    'lidar_point_cloud': ('LIDAR_Point_Cloud_Index_Catalogue', 'filename'),
    'national_lidar_programme_point_cloud': ('National_LIDAR_Programme_Index_Catalogue', 'pnt_fn'),
}


def discover_england(fetch, bbox, failures, progress):
    result = json.loads(fetch.get(SEARCH, body=mapping(box(*bbox)),
        content_type='application/geo+json', ttl=86400, timeout=20, attempts=1, limit=4 * 1024**2))
    if not isinstance(result.get('results'), list) or result.get('count') != len(result['results']):
        raise ValueError('Incomplete Environment Agency tile search')
    deliveries = [r for r in result['results'] if r['product']['id'] in PRODUCTS]
    records = []
    for product in sorted({r['product']['id'] for r in deliveries}):
        layer, filename_field = PRODUCTS[product]
        for row, geom in features(fetch, INDEX, bbox, layer=NAMESPACE + layer):
            filename = row.get(filename_field)
            if not filename or not filename.lower().endswith('.laz'):
                continue
            for delivery in deliveries:
                if delivery['product']['id'] != product or str(row.get('year')) != delivery['year']['id']:
                    continue
                # The public API uses OS lower-left 5 km grid references.
                ref = row.get('os_ref') or row.get('tilename') or ''
                grid = delivery['tile']['id']
                if len(ref) != 6 or len(grid) != 6 or ref[:2] != grid[:2]:
                    continue
                if not (int(grid[2:4]) <= int(ref[2:4]) < int(grid[2:4]) + 5
                        and int(grid[4:6]) <= int(ref[4:6]) < int(grid[4:6]) + 5):
                    continue
                archive = delivery['uri']
                project = row.get('polygon_id') or filename
                records.append((project, 'Environment Agency ' + project, tile(
                    archive + '#member=' + quote(filename, safe=''), geom, format='LAZ',
                    archive_url=archive, archive_member=filename,
                    original_asset_id=original_asset_id('ea', filename),
                    delivery_note='5 km ZIP delivery tile; only selected LAZ members are prepared',
                    horizontal_crs='EPSG:27700', vertical_datum='Ordnance Datum Newlyn',
                    vertical_units='m', survey_metadata={
                        'acquisition_start': str(row.get('sd_flown') or '')[:10],
                        'acquisition_end': str(row.get('ed_flown') or '')[:10],
                        'point_spacing_m': row.get('pt_spacing'),
                        'ground_class': True if product.startswith('national_') or row.get('classified') == 'YES' else None},
                    classification={'convention': 'asprs', 'basis': 'EA ground/surface-object classification'},
                    provider_metadata=row), geom))
    if records:
        progress('England LAZ available: official minimum download is a 5 km ZIP; consent is required')
    yield from grouped('Environment Agency England', records,
        source_page='https://environment.data.gov.uk/survey', vertical_units='m',
        delivery_note='Minimum delivery: 5 km ZIP archive; selected LAZ members only are prepared',
        vertical_units_basis='Environment Agency survey specification',
        license='Open Government Licence v3.0', attribution='Environment Agency copyright and database right')
