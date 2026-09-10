"""IGN LiDAR HD: official metadata WFS, classified COPC, measured tile dates."""
from pyproj import Geod

try:
    from .lidar_services import features, grouped, tile
    from .lidar_metadata import positive
except ImportError:
    from lidar_services import features, grouped, tile
    from lidar_metadata import positive

ENDPOINT = 'https://data.geopf.fr/wfs'
LAYER = 'IGNF_LIDAR-HD_METADONNEE:metadata'
SOURCE_PAGE = 'https://geoservices.ign.fr/lidarhd'


def discover_france(fetch, bbox, failures, progress):
    records = []
    for row, geom in features(fetch, ENDPOINT, bbox, layer=LAYER):
        url = row.get('url_npl')
        if not url:
            continue
        # IGN publishes a separate range-enabled endpoint for the same asset.
        # The ordinary download endpoint can reject Range or require a full file.
        if url.startswith('https://data.geopf.fr/telechargement/download/') and '.copc.' in url:
            url = url.replace('https://data.geopf.fr/telechargement/', 'https://data.geopf.fr/chunk/telechargement/', 1)
        project = row.get('code_mission') or url.rsplit('/', 2)[-2]
        processing = row.get('procede_classement', '')
        classification = {'mapping': {'1': 'unclassified', '2': 'ground', '6': 'building', '67': 'unclassified'},
                          'basis': 'IGN LiDAR HD classification; ' + processing}
        # IGN 67 is an unconfirmed building: evaluate single returns through the
        # shared roof fitter, without granting confirmed building-class confidence.
        area = abs(Geod(ellps='WGS84').geometry_area_perimeter(geom)[0])
        count = positive(row.get('nombre_points'))
        meta = dict(acquisition_start=str(row.get('date_debut_acquisition') or '')[:10],
                    acquisition_end=str(row.get('date_fin_acquisition') or '')[:10],
                    point_density_m2=count / area if count and area else None,
                    ground_class=True, building_class=True,
                    classification_quality=1.0 if 'MANUEL' in processing else .5,
                    classification_basis='IGN LiDAR HD processing level')
        records.append((project, 'IGN LiDAR HD ' + project, tile(url, geom,
            original_asset_url=row['url_npl'],
            updated=row.get('date_edition'), survey_metadata=meta,
            classification=classification, vertical_datum=row.get('systeme_altimetrique'),
            # File CRS is authoritative; this only fills absent headers for the
            # explicitly named projection, never all French territories.
            horizontal_crs={'LAMB93': 'EPSG:2154'}.get(row.get('systeme_planimetrique')),
            provider_metadata={k: v for k, v in row.items() if k not in ('metadata', 'url_mnt', 'url_mns', 'url_mnh')}), geom))
    yield from grouped('IGN France', records, source_page=SOURCE_PAGE,
        vertical_units='m', vertical_units_basis='IGN LiDAR HD product specification',
        license='Licence Ouverte 2.0', attribution='IGN - LiDAR HD')
