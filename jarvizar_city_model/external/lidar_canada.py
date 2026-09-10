"""NRCan CanElevation public ArcGIS tile index; point files stay in COPC."""
import re
from urllib.parse import unquote, urlparse

try:
    from .lidar_services import features, grouped, tile
    from .lidar_metadata import date_interval
except ImportError:
    from lidar_services import features, grouped, tile
    from lidar_metadata import date_interval

ENDPOINT = 'https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/lidar_point_cloud_canelevation_en/MapServer/1/query'
SOURCE_PAGE = 'https://open.canada.ca/data/en/dataset/7069387e-9986-4297-9f55-0288e9676947'


def collection_end(url):
    # Federal Airborne LiDAR Data Acquisition Guideline, section 6.3.5:
    # ProjectCollectionDate is explicitly the acquisition END, not publication.
    # Require the documented surrounding CRS/grid schema; no generic year hints.
    name = unquote(urlparse(url).path).rsplit('/', 1)[-1]
    match = re.fullmatch(r'[A-Z]{2}_.+_(\d{8})_NAD83CSRS_UTMZ?\d{1,2}_\d+(?:km|m)_E\d+_N\d+_.+\.copc\.laz', name)
    interval = date_interval(match[1]) if match else None
    return interval[1] if interval else None


def discover_canada(fetch, bbox, failures, progress):
    records = []
    for row, geom in features(fetch, ENDPOINT, bbox, arcgis=True):
        project, url = row['project'], row['url']
        # Index lacks start dates and density. Its standardized tile identifier
        # may report collection end; do not promote it into a full interval.
        records.append((row['provider'] + '/' + project, 'CanElevation ' + project,
            tile(url, geom, vertical_datum='CGVD2013',
                 survey_metadata={'acquisition_end': collection_end(url)},
                 classification={'convention': 'asprs', 'basis': 'CanElevation LAS classification specification'},
                 provider_metadata=row), geom))
    yield from grouped('NRCan Canada', records, source_page=SOURCE_PAGE,
        vertical_units='m', vertical_units_basis='CanElevation product specification',
        license='Open Government Licence - Canada', attribution='NRCan and the tile source organization')
