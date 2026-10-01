// Rhineland-Palatinate (LVermGeo RLP): plain LAZ tiles of 1 km in UTM 32,
// 80-320 MB each, the current state of every tile. The index is the ATOM link
// list (5.8 MB, each tile with its box and size). Only two classes: 2 is the
// last-pulse ground and 20 the first-pulse objects, roofs and trees alike.

import { overlaps, type Box, type Provider, type Tile } from './common';
import type { Polygon } from '../../types';

const BASE = 'https://geobasis-rlp.de/data/las/current/las/';
const LINKS = `${BASE}atomfeed-links/atomfeed-links.xml`;

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

let parsed: { length: number; tiles: RlpTile[] } | null = null;

export const rlp: Provider = {
  id: 'rlp',
  name: 'LVermGeo Rhineland-Palatinate',
  areas: [[6.0, 48.9, 8.6, 51.0]],
  async discover(fetcher, bbox) {
    const xml = await fetcher.text(LINKS);
    if (parsed?.length !== xml.length) parsed = { length: xml.length, tiles: rlpTiles(xml) };
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const tile of parsed.tiles) {
      if (!overlaps(tile.box, bbox)) continue;
      const [w, s, e, n] = tile.box;
      tiles.push({ url: tile.url, bbox: tile.box, horizontalCrs: 'EPSG:25832', size: tile.size || undefined });
      // The tile's square in UTM, near enough in lon/lat at 1 km.
      coverage.push([[[w, s], [e, s], [e, n], [w, n]]]);
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
