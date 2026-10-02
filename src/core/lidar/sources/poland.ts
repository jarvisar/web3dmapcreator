// GUGiK's LiDAR point clouds (Dane pomiarowe LIDAR) from 2024 on. Flai's
// COPC mirror has 2018-2023, which is far cheaper to read, so older years
// aren't listed here.
//
// Sheets come from GUGiK's WFS, one layer per year. It has CORS but only
// answers GML, and there's no DOMParser in a worker, so it's read with
// regular expressions. The file server has no CORS and ignores Range, so
// sheets go through the proxy and are downloaded whole (50-140 MB for 0.3 to
// 0.4 km²). At times it takes 85-110 s to answer anything at all, HEADs and
// 404s included.
//
// A survey is one order (nr_zglosz) of one year. Some orders flew the same
// sheets twice (Wrocław 2025 in March and August), so each repeat of a sheet
// goes in a survey of its own, newest first. The stated density is the
// order's minimum: sheets measured 1.4 to 2.6 times it.

import { proxyAvailable } from '../../data/corsProxy';
import type { Polygon, Ring } from '../../types';
import { overlaps, ringBox, type Candidate, type Provider } from './common';

const WFS = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/DanePomiaroweLidarEVRF2007/WFS/Skorowidze';
const FILES = 'https://opendata.geoportal.gov.pl/NumDaneWys/DanePomiaroweLAZ/';
const FIRST_YEAR = 2024;
const LAYER = 'SkorowidzDanychPomiarowychLIDAR';
const MAX_SHEETS = 1000;

export interface GugikSheet {
  sheet: string;
  year: number;
  /** When it was flown (akt_data). */
  date: string;
  order: string;
  /** Points per m² as stated, a minimum. */
  density: number;
  horizontalCrs?: string;
  /** False where the sheet is only partly covered. */
  filled: boolean;
  url: string;
  shape: Polygon[];
}

/** PL-1992 is EPSG:2180, PL-2000 zones 5-8 are 2176-2179. */
function crsOf(system: string): string | undefined {
  if (system === 'PL-1992') return 'EPSG:2180';
  const zone = /^PL-2000:S([5-8])$/.exec(system)?.[1];
  return zone ? `EPSG:${2171 + Number(zone)}` : undefined;
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Polygons of a GML block asked for in urn:ogc:def:crs:EPSG::4326, so lat, lon pairs. */
function gmlPolygons(block: string): Polygon[] {
  const ring = (list: string): Ring => {
    const numbers = list.trim().split(/\s+/).map(Number);
    const out: Ring = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) out.push([numbers[i + 1], numbers[i]]);
    const [first, last] = [out[0], out[out.length - 1]];
    if (out.length > 1 && first[0] === last[0] && first[1] === last[1]) out.pop();
    return out;
  };
  const polygons: Polygon[] = [];
  for (const polygon of block.matchAll(/<gml:Polygon\b[\s\S]*?<\/gml:Polygon>/g)) {
    const outer = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([^<]*)<\/gml:posList>/.exec(polygon[0]);
    if (!outer) continue;
    const valid = (r: Ring) => r.length >= 3 && r.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    const shell = ring(outer[1]);
    if (!valid(shell)) continue;
    const holes = [...polygon[0].matchAll(/<gml:interior>[\s\S]*?<gml:posList[^>]*>([^<]*)<\/gml:posList>/g)].map((m) => ring(m[1]));
    polygons.push([shell, ...holes.filter(valid)]);
  }
  return polygons;
}

/** The sheets in one GetFeature answer. */
export function gugikSheets(gml: string): GugikSheet[] {
  if (!/<wfs:FeatureCollection\b/.test(gml)) throw new Error('GUGiK WFS answered with something other than features');
  const out: GugikSheet[] = [];
  for (const block of gml.split(/<wfs:member>/).slice(1)) {
    const field = (name: string) => unescapeXml(new RegExp(`<gugik:${name}>([^<]*)</gugik:${name}>`).exec(block)?.[1]?.trim() ?? '');
    const url = field('url_do_pobrania');
    // Anything else wouldn't get through the proxy.
    if (!url.startsWith(FILES) || !/\.la[sz]$/i.test(url)) continue;
    const date = /<gugik:akt_data\b[^>]*>\s*<gml:timePosition>(\d{4}-\d{2}-\d{2})/.exec(block)?.[1] ?? '';
    const year = Number(field('akt_rok')) || Number(date.slice(0, 4));
    const shape = gmlPolygons(block);
    if (!year || !shape.length) continue;
    out.push({
      sheet: field('godlo'),
      year,
      date: date || `${year}-01-01`,
      order: field('nr_zglosz'),
      density: Number(/^([\d.]+)/.exec(field('char_przestrz'))?.[1]) || 0,
      horizontalCrs: crsOf(field('uklad_xy')),
      filled: field('czy_ark_wypelniony') !== 'NIE',
      url,
      shape,
    });
  }
  return out;
}

/**
 * Sheets as surveys: one per order, with a sheet flown again in the same
 * order put in a later survey than its newest flight. Two partial copies of
 * a sheet can share one, since they're usually its two halves.
 */
export function gugikSurveys(sheets: GugikSheet[]): Candidate[] {
  const orders = new Map<string, GugikSheet[]>();
  for (const sheet of sheets) {
    const key = `${sheet.year}\n${sheet.order}`;
    const list = orders.get(key);
    if (list) list.push(sheet);
    else orders.set(key, [sheet]);
  }
  const out: Candidate[] = [];
  const keys = [...orders.keys()].sort((a, b) => Number(b.slice(0, 4)) - Number(a.slice(0, 4)) || (a < b ? -1 : 1));
  for (const key of keys) {
    const layers: GugikSheet[][] = [];
    for (const sheet of [...orders.get(key)!].sort((a, b) => (a.date === b.date ? (a.url < b.url ? -1 : 1) : a.date < b.date ? 1 : -1))) {
      const fits = (layer: GugikSheet[]) => layer.every((s) => s.sheet !== sheet.sheet || (!s.filled && !sheet.filled));
      const layer = layers.find(fits);
      if (layer) layer.push(sheet);
      else layers.push([sheet]);
    }
    layers.forEach((layer, i) => {
      const { year, order } = layer[0];
      const dates = layer.map((s) => s.date).sort();
      const [first, last] = [dates[0], dates[dates.length - 1]];
      const densities = layer.map((s) => s.density).filter((d) => d > 0);
      const id = `${year}-${order || 'unknown'}${i ? `-${i + 1}` : ''}`;
      out.push({
        provider: 'GUGiK',
        id,
        name: `GUGiK ${year} (${first === last ? first : `${first} to ${last}`})`,
        // Dated, so a sheet flown again isn't answered from old checkpoints.
        url: `${FILES}#${id}-${first}-${last}`,
        format: 'LAZ',
        coverage: layer.flatMap((s) => s.shape),
        tiles: layer.map((s) => ({ url: s.url, bbox: ringBox(s.shape.flat()), horizontalCrs: s.horizontalCrs, whole: true })),
        verticalUnits: 'm',
        acquisitionStart: first,
        acquisitionEnd: last,
        densityM2: densities.length ? Math.min(...densities) : undefined,
        license: 'Free for any use (GUGiK open data)',
        attribution: 'Główny Urząd Geodezji i Kartografii',
        sourcePage: 'https://www.geoportal.gov.pl/pl/dane/dane-pomiarowe-lidar-lidar/',
        authoritative: true,
        projectYearHint: year,
      });
    });
  }
  return out;
}

export const poland: Provider = {
  id: 'poland',
  name: 'GUGiK',
  areas: [[14, 49, 24.2, 54.9]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    // A new year is a new layer.
    const capabilities = await fetcher.text(`${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities`);
    const all = [...capabilities.matchAll(new RegExp(`<Name>gugik:${LAYER}(\\d{4})</Name>`, 'g'))].map((m) => Number(m[1]));
    if (!all.length) throw new Error('GUGiK WFS lists no LiDAR layers');
    const years = all.filter((year) => year >= FIRST_YEAR);
    const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east},urn:ogc:def:crs:EPSG::4326`;
    const answers = await Promise.all(
      years.map((year) => fetcher.text(`${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=gugik:${LAYER}${year}&BBOX=${box}&COUNT=${MAX_SHEETS}&SRSNAME=urn:ogc:def:crs:EPSG::4326`)),
    );
    const sheets = answers.flatMap((gml) => {
      if (Number(/numberReturned="(\d+)"/.exec(gml)?.[1]) >= MAX_SHEETS) throw new Error('The area covers too many GUGiK sheets');
      return gugikSheets(gml);
    });
    return gugikSurveys(sheets.filter((s) => overlaps(ringBox(s.shape.flat()), bbox)));
  },
};
