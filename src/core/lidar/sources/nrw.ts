// Geobasis NRW 3D-Messdaten: plain LAZ tiles of 1 km in ETRS89 / UTM 32,
// about 50-130 MB each. The state keeps one current version of every tile.
// The index is the zipped tile metadata (110 KB, every tile with its date)
// rather than the 3.3 MB file listing next to it. Tile files are named after
// the tile.

import { unzipSync } from 'fflate';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { gridSquares, ringBox, squarePolygon, type Provider, type Tile } from './common';
import type { Polygon } from '../../types';

const BASE = 'https://www.opengeodata.nrw.de/produkte/geobasis/hm/3dm_l_las/3dm_l_las/';
const META = `${BASE}3dm_meta.zip`;

interface NrwTile {
  date: string;
  /** Minimum points per m² the tile was captured at. */
  density: number;
}

/** Tile name to its metadata, from the semicolon-separated table in 3dm_meta.zip. */
export function nrwTiles(csv: string): Map<string, NrwTile> {
  const lines = csv.split(/\r?\n/);
  const head = lines.findIndex((line) => line.startsWith('Kachelname;'));
  if (head < 0) throw new Error('NRW tile metadata has no table');
  const columns = lines[head].split(';');
  const name = columns.indexOf('Kachelname');
  const date = columns.indexOf('Aktualitaet');
  const density = columns.indexOf('Aufloesung');
  if (date < 0) throw new Error('NRW tile metadata changed: no Aktualitaet column');
  const out = new Map<string, NrwTile>();
  for (const line of lines.slice(head + 1)) {
    const cells = line.split(';');
    if (cells.length <= date || !/^\d{4}-\d{2}-\d{2}$/.test(cells[date])) continue;
    out.set(cells[name], { date: cells[date], density: Number(cells[density]) || 0 });
  }
  if (!out.size) throw new Error('NRW tile metadata lists no tiles');
  return out;
}

// Parsed once per thread: 36,000 rows.
let parsed: { size: number; tiles: Map<string, NrwTile> } | null = null;

export const nrw: Provider = {
  id: 'nrw',
  name: 'Geobasis NRW',
  areas: [[5.8, 50.3, 9.5, 52.6]],
  async discover(fetcher, bbox) {
    const zip = new Uint8Array(await fetcher.catalog(META, undefined, [0x50, 0x4b, 0x03, 0x04]));
    if (parsed?.size !== zip.length) {
      const files = unzipSync(zip, { filter: (file) => file.name.endsWith('.csv') });
      const csv = Object.values(files)[0];
      if (!csv) throw new Error('NRW tile metadata archive has no table');
      parsed = { size: zip.length, tiles: nrwTiles(new TextDecoder('utf-8').decode(csv)) };
    }
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25832));
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    const dates: string[] = [];
    let density = Infinity;
    for (const { x, y } of gridSquares(25832, bbox, 1000)) {
      const name = `3dm_32_${x / 1000}_${y / 1000}_1_nw`;
      const tile = parsed.tiles.get(name);
      if (!tile) continue;
      const square = squarePolygon(toLonLat, x, y, 1000);
      tiles.push({ url: `${BASE}${name}.laz`, bbox: ringBox(square), horizontalCrs: 'EPSG:25832' });
      coverage.push(square);
      dates.push(tile.date);
      if (tile.density > 0) density = Math.min(density, tile.density);
    }
    if (!tiles.length) return [];
    dates.sort();
    return [
      {
        provider: 'Geobasis NRW',
        id: '3dm',
        name: 'Geobasis NRW 3D-Messdaten',
        // Dated, so a tile flown again isn't answered from old checkpoints.
        url: `${BASE}#3dm-${dates[0]}-${dates.at(-1)}`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        // Class 20 is every last return above the ground: roofs and trees alike.
        classification: { '1': 'unclassified', '2': 'ground', '20': 'unclassified' },
        acquisitionStart: dates[0],
        acquisitionEnd: dates.at(-1),
        densityM2: Number.isFinite(density) ? density : undefined,
        license: 'Datenlizenz Deutschland - Zero - Version 2.0',
        attribution: 'Land NRW, Datenlizenz Deutschland - Zero - Version 2.0',
        sourcePage: 'https://www.opengeodata.nrw.de/produkte/geobasis/hm/3dm_l_las/',
        authoritative: true,
        projectYearHint: Number(dates.at(-1)!.slice(0, 4)),
      },
    ];
  },
};
