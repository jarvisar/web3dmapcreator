// Rhineland-Palatinate (LVermGeo RLP): plain LAZ tiles of 1 km in UTM 32,
// 80-320 MB each, the current state of every tile. The index is the ATOM link
// list (5.8 MB, each tile with its box and size). Only two classes: 2 is the
// last-pulse ground and 20 the first-pulse objects, roofs and trees alike.

import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { gridSquares, ringBox, squarePolygon, type Box, type Provider, type Tile } from './common';
import type { Polygon } from '../../types';

const BASE = 'https://geobasis-rlp.de/data/las/current/las/';
const LINKS = `${BASE}atomfeed-links/atomfeed-links.xml`;
const KM = 1000;

interface RlpTile {
  url: string;
  /** West, south, east, north. */
  box: Box;
  size: number;
}

/** Tiles from the ATOM link list. Its boxes are min lat, min lon, max lat, max lon. */
export function rlpTiles(xml: string): RlpTile[] {
  const out: RlpTile[] = [];
  for (const match of xml.matchAll(/<link\b[^>]*>/g)) {
    const tag = match[0];
    const url = /href="([^"]+\.laz)"/.exec(tag)?.[1];
    const box = /bbox="([^"]+)"/.exec(tag)?.[1].split(',').map(Number);
    if (!url || !url.startsWith(BASE) || !box || box.length !== 4 || !box.every(Number.isFinite)) continue;
    const [s, w, n, e] = box;
    out.push({ url, box: [w, s, e, n], size: Number(/size="(\d+)"/.exec(tag)?.[1]) || 0 });
  }
  if (!out.length) throw new Error('The Rhineland-Palatinate link list has no tiles');
  return out;
}

// By south-west corner in km. The feed's boxes are lon/lat boxes around the
// turned squares, up to about 40 m past them, and listed a 146 MB tile for an
// area that ended 5 m short of it.
let parsed: { length: number; tiles: Map<string, RlpTile> } | null = null;

export const rlp: Provider = {
  id: 'rlp',
  name: 'LVermGeo Rhineland-Palatinate',
  areas: [[6.0, 48.9, 8.6, 51.0]],
  async discover(fetcher, bbox) {
    const xml = await fetcher.text(LINKS);
    if (parsed?.length !== xml.length) {
      const named = rlpTiles(xml).flatMap((t) => {
        const corner = /_32_(\d+)_(\d+)_1_rp\.laz$/.exec(t.url);
        return corner ? [[`${corner[1]}_${corner[2]}`, t] as const] : [];
      });
      parsed = { length: xml.length, tiles: new Map(named) };
    }
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25832));
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const { x, y } of gridSquares(25832, bbox, KM)) {
      const tile = parsed.tiles.get(`${x / KM}_${y / KM}`);
      if (!tile) continue;
      const square = squarePolygon(toLonLat, x, y, KM);
      tiles.push({ url: tile.url, bbox: ringBox(square), horizontalCrs: 'EPSG:25832', size: tile.size || undefined });
      coverage.push(square);
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'LVermGeo RLP',
        id: 'las-current',
        name: 'Rhineland-Palatinate Laserscan',
        url: `${BASE}#current`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        classification: { '2': 'ground', '20': 'unclassified' },
        license: 'Datenlizenz Deutschland - Namensnennung - Version 2.0',
        attribution: '©GeoBasis-DE / LVermGeoRP, dl-de/by-2-0',
        sourcePage: 'https://lvermgeo.rlp.de/produkte/geotopografie/laserscandaten',
        authoritative: true,
        projectYearHint: null,
      },
    ];
  },
};
