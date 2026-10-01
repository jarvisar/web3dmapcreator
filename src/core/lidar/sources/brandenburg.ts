// Brandenburg (LGB): one ZIP per 1 km tile holding a deflated LAZ (deflate
// gains nothing on LAZ, so a tile is about its LAZ size, 50-150 MB). The WFS
// of capture dates is the index: each sheet number names its ZIP. GPS times
// in the files are week times, so these dates are the only ones there are.
// The WFS has failed to answer now and then, and then the file listing
// (4.4 MB, every sheet) stands in for it, without dates.

import { projectYear } from '../selection';
import type { GeoBounds, Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { dateOnly, geoPolygons, gridSquares, pagedFeatures, ringBox, squarePolygon, type Feature, type Provider, type Tile } from './common';

const WFS = 'https://isk.geobasis-bb.de/ows/aktualitaeten_wfs';
const FILES = 'https://data.geobasis-bb.de/geobasis/daten/als/laz/';

/** Sheets under the area from the file listing, as rows like the WFS's but without dates. */
async function listedSheets(fetcher: Fetcher, bbox: GeoBounds): Promise<Feature[]> {
  const html = new TextDecoder().decode(await fetcher.catalog(FILES, undefined, [0x3c]));
  const sheets = new Set([...html.matchAll(/als_(\d{5}-\d{4})\.zip/g)].map((m) => m[1]));
  if (!sheets.size) throw new Error('The Brandenburg file listing has no sheets');
  const { toLonLat } = lonLatTransforms(crsFromEpsg(25833));
  const rows: Feature[] = [];
  for (const { x, y } of gridSquares(25833, bbox, 1000)) {
    const sheet = `33${x / 1000}-${y / 1000}`;
    if (!sheets.has(sheet)) continue;
    const [ring] = squarePolygon(toLonLat, x, y, 1000);
    rows.push({ properties: { sheetnr: sheet }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
  }
  return rows;
}

export const brandenburg: Provider = {
  id: 'brandenburg',
  name: 'LGB Brandenburg',
  areas: [[11.26, 51.36, 14.77, 53.56]],
  async discover(fetcher, bbox) {
    // WFS 2.0 in EPSG:4326 takes its box as lat, lon.
    const box = [bbox.south, bbox.west, bbox.north, bbox.east].join(',');
    let rows: Feature[];
    try {
      rows = await pagedFeatures(
        fetcher,
        (offset, count) =>
          `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=app:als_single&BBOX=${box},urn:ogc:def:crs:EPSG::4326&OUTPUTFORMAT=application/geo%2Bjson&COUNT=${count}&STARTINDEX=${offset}`,
      );
    } catch {
      rows = await listedSheets(fetcher, bbox);
    }
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    const dates: string[] = [];
    for (const row of rows) {
      const sheet = String(row.properties.sheetnr ?? '');
      if (!/^\d{5}-\d{4}$/.test(sheet)) continue;
      const outline = geoPolygons(row.geometry);
      if (!outline.length) continue;
      tiles.push({ url: `${FILES}als_${sheet}.zip`, bbox: ringBox(outline.flat()), horizontalCrs: 'EPSG:25833' });
      coverage.push(...outline);
      const date = dateOnly(row.properties.creationdate);
      if (date) dates.push(date);
    }
    if (!tiles.length) return [];
    dates.sort();
    return [
      {
        provider: 'LGB Brandenburg',
        id: 'als',
        name: 'Brandenburg ALS',
        // Dated, so a sheet flown again isn't answered from old checkpoints.
        url: `${FILES}#als-${dates[0] ?? ''}-${dates.at(-1) ?? ''}`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        // No building class: 20 is everything above the ground, 0 and 1 the rest.
        classification: { '0': 'unclassified', '1': 'unclassified', '2': 'ground', '20': 'unclassified' },
        acquisitionStart: dates[0],
        acquisitionEnd: dates.at(-1),
        license: 'Datenlizenz Deutschland - Namensnennung - Version 2.0',
        attribution: 'GeoBasis-DE/LGB, dl-de/by-2-0',
        sourcePage: 'https://geobroker.geobasis-bb.de/',
        authoritative: true,
        projectYearHint: projectYear(dates.at(-1)),
      },
    ];
  },
};
