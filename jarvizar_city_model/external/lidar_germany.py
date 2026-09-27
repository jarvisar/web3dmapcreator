"""Official German delivery indexes; each state remains an independent provider.

Grid coordinates are decoded only from filenames actually listed by the source,
using its documented kilometre-grid schema. No tile URL guessing or map scraping.
"""
import csv
import io
import re
import zipfile
from urllib.parse import urljoin

from pyproj import CRS, Transformer
from shapely.geometry import box
from shapely.ops import transform

try:
    from .lidar_services import metadata, grouped, tile, METADATA_TTL
    from .lidar_metadata import xml_root
except ImportError:
    from lidar_services import metadata, grouped, tile, METADATA_TTL
    from lidar_metadata import xml_root

NRW_INDEX = 'https://www.opengeodata.nrw.de/produkte/geobasis/hm/3dm_l_las/3dm_l_las/'
BAVARIA_INDEX = 'https://geoservices.bayern.de/services/poly2metalink/metalink/laser'
NRW_TILE = r'3dm_32_(?P<x>\d{3})_(?P<y>\d{4})_1_nw\.laz'


def grid_polygon(name, pattern, crs=25832):
    match = re.fullmatch(pattern, name)
    if not match:
        raise ValueError('Official tile grid filename schema changed')
    x, y = int(match['x']) * 1000, int(match['y']) * 1000
    return transform(Transformer.from_crs(crs, 4326, always_xy=True).transform,
                     box(x, y, x + 1000, y + 1000).segmentize(100))


def discover_nrw(fetch, bbox, failures, progress):
    # EPSG area-of-use pruning; not a country override or a city-specific test.
    a = CRS(25832).area_of_use
    if not box(a.west, a.south, a.east, a.north).intersects(box(*bbox)):
        return
    listing = xml_root(metadata(fetch, NRW_INDEX))
    selected = []
    local = box(*Transformer.from_crs(4326, 25832, always_xy=True).transform_bounds(*bbox, densify_pts=21))
    for node in listing.findall('.//file'):
        name = node.get('name', '')
        if not name.endswith('.laz'):
            continue
        match = re.fullmatch(NRW_TILE, name)
        if not match:
            raise ValueError('NRW official grid schema changed')
        x, y = int(match['x']) * 1000, int(match['y']) * 1000
        if not box(x, y, x + 1000, y + 1000).intersects(local):
            continue
        geom = grid_polygon(name, NRW_TILE)
        if geom.intersects(box(*bbox)):
            selected.append((name, node, geom))
    if not selected:
        return
    with zipfile.ZipFile(io.BytesIO(metadata(fetch, NRW_INDEX + '3dm_meta.zip'))) as archive:
        entry = archive.getinfo('3dm_nw.csv')
        if entry.file_size > 32 * 1024**2:
            raise ValueError('NRW metadata exceeds index budget')
        lines = archive.read(entry).decode('utf-8-sig').splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith('Kachelname;'))
    wanted = {name[:-4] for name, _, _ in selected}
    attrs = {r['Kachelname']: r for r in csv.DictReader(lines[start:], delimiter=';') if r['Kachelname'] in wanted}
    records = []
    for name, node, geom in selected:
        row = attrs.get(name[:-4], {})
        # Publication timestamp in the file inventory is only a cache revision.
        # Aktualitaet in the companion survey metadata is the acquisition date.
        date = row.get('Aktualitaet')
        meta = {'acquisition_start': date, 'acquisition_end': date,
                'ground_class': True, 'point_density_m2': row.get('Aufloesung')}
        records.append((date or name, 'Geobasis NRW ' + (date or name), tile(
            urljoin(NRW_INDEX, name), geom, size_bytes=int(node.get('size')),
            updated=node.get('timestamp'), survey_metadata=meta,
            horizontal_crs='EPSG:25832', vertical_datum=row.get('Koordinatenreferenzsystem_Hoehe'),
            # NRW class 20 contains last/only non-ground returns, including
            # roofs AND vegetation. Let the shared unclassified roof fitter
            # evaluate single returns; do not claim these are building labels.
            classification={'mapping': {'1': 'unclassified', '2': 'ground', '20': 'unclassified'},
                            'basis': 'Geobasis NRW 3D-Messdaten LAS class table'},
            provider_metadata=row), geom))
    yield from grouped('Geobasis NRW', records, source_page=NRW_INDEX,
        vertical_units='m', vertical_units_basis='Geobasis NRW 3D-Messdaten specification',
        license='Datenlizenz Deutschland - Zero - Version 2.0', attribution='Land NRW / Geobasis NRW')


def discover_bavaria(fetch, bbox, failures, progress):
    polygon = box(*bbox)
    body = 'SRID=4326;' + polygon.wkt
    data = fetch.get(BAVARIA_INDEX, body=body, content_type='text/plain',
                     ttl=METADATA_TTL, timeout=20, attempts=1, limit=4 * 1024**2)
    root = xml_root(data)
    if root.tag != 'metalink':
        raise ValueError('Bavarian spatial service did not return a Metalink index')
    records = []
    for node in root.findall('file'):
        name, url = node.get('name', ''), node.findtext('url')
        geom = grid_polygon(name, r'(?P<x>\d{3})_(?P<y>\d{4})\.laz')
        if not geom.intersects(polygon):
            continue
        # The index has no survey identifier/date. Keep unidentified tiles as
        # independent candidates rather than mixing possibly different epochs.
        records.append((name, 'Bavaria Laserpunkte ' + name, tile(url, geom,
            horizontal_crs='EPSG:25832', vertical_datum='unknown; use file header',
            classification={'mapping': {'1': 'unclassified', '2': 'ground', '6': 'building'},
                            'basis': 'Bavarian Laserdaten point-class specification'}), geom))
    yield from grouped('Bavaria LDBV', records,
        source_page='https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=laserdaten',
        vertical_units='m', vertical_units_basis='Bavarian Laserdaten product specification',
        license='CC BY 4.0', attribution='Bayerische Vermessungsverwaltung')
