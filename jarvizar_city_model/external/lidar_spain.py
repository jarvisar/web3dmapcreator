"""Official PNOA second-coverage tiles published by Castilla-La Mancha.

This is regional coverage, not an adapter for CNIG's interactive national store.
The ArcGIS index supplies actual delivery URLs and surveyed coverage polygons.
"""
import re

try:
    from .lidar_services import features, grouped, tile
    from .lidar_identity import original_asset_id
except ImportError:
    from lidar_services import features, grouped, tile
    from lidar_identity import original_asset_id

ENDPOINT = 'https://geoservicios.castillalamancha.es/arcgis/rest/services/Vector/Rejilla_Descargas_Laz2Cober/MapServer/0/query'


def discover_spain_clm(fetch, bbox, failures, progress):
    records = []
    for row, geom in features(fetch, ENDPOINT, bbox, arcgis=True):
        name = row.get('FICHERO', '')
        # PNOA's documented identifier encodes capture year, lot and grid cell.
        # Only interpret that schema; unknown editions remain separate tiles.
        match = re.fullmatch(r'PNOA_(\d{4})_(.+)_\d+-\d+_ORT-CLA-RGB\.laz', name, re.I)
        project = '_'.join(match.groups()) if match else name
        records.append((project, 'PNOA Castilla-La Mancha ' + project,
            tile(row['URL'], geom, horizontal_crs='EPSG:25830',
                 original_asset_id=original_asset_id('pnoa', name),
                 vertical_datum='Orthometric heights, PNOA EGM08-REDNAP',
                 classification={'mapping': {'1': 'unclassified', '2': 'ground', '6': 'building'},
                                 'basis': 'PNOA classified point-cloud specification'},
                 survey_metadata={'acquisition_year': match[1] if match else None,
                                  'ground_class': True, 'building_class': True},
                 provider_metadata=row), geom))
    yield from grouped('PNOA / Castilla-La Mancha', records,
        source_page=ENDPOINT.rsplit('/0/query', 1)[0],
        vertical_units='m', vertical_units_basis='PNOA orthometric point-cloud specification',
        license='IGN/CNIG geographic information reuse terms',
        attribution='PNOA IGN/CNIG and Junta de Comunidades de Castilla-La Mancha')
