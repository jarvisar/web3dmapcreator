// AHN5 (2023 and 2024) and AHN6 (from 2025), the Netherlands' national
// survey, as 1 km COPC on Het Waterschapshuis' bucket. Flai's mirror stops
// at AHN4 (2020-2022). AHN5 is 23-27 returns per m² in the cities, AHN4 had
// up to 35 in Amsterdam, so with Most detail AHN4 can still win there.
//
// The bucket only answers CORS for basisdata.nl, so files go through the
// proxy. Which sheets exist, and their year, comes from the Ellipsis Drive
// WFS the AHN dataroom links, which does answer cross-origin: AHN6 by 1 km
// sheet, AHN5 by 5 x 6.25 km map sheet with the 1 km tiles under it on the
// grid. A missing tile answers 403, so each one is checked with a HEAD.

import type { GeoBounds, Polygon } from '../../types';
import { HttpError } from '../../data/http';
import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { geoPolygons, gridSquares, overlaps, ringBox, squarePolygon, Surveys, type Feature, type Provider } from './common';

const BUCKET = 'https://fsn1.your-objectstorage.com/hwh-ahn/';
const WFS = 'https://api.ellipsis-drive.com/v3/ogc/wfs/';
const AHN6_LAYER = '0820faae-5240-499b-8486-cf406433cf71?service=WFS&version=2.0.0&request=GetFeature&typeNames=layerId_6aec07f5-f7eb-4f51-b6f7-aee45e5767bd';
const AHN5_LAYER = '65945b69-81df-4270-97f0-f029033154c1?service=WFS&version=2.0.0&request=GetFeature&typeNames=layerId_01170035-93d3-4a38-b04c-8e7be7a7ca78';
const KM = 1000;

async function sheets(fetcher: Fetcher, layer: string, bbox: GeoBounds): Promise<Feature[]> {
  // The service's numberMatched is always 999999999, so it can't be paged.
  // An area the app models fits in one answer.
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east},urn:ogc:def:crs:EPSG::4326`;
  const answer = (await fetcher.json(`${WFS}${layer}&outputFormat=application/json&count=1000&bbox=${box}`)) as { features?: Feature[] };
  if (!Array.isArray(answer.features)) throw new Error('Catalog returned no features');
  return answer.features;
}

/** Whether a tile is on the bucket. Missing ones answer 403 (listing is off), never 404. */
async function exists(fetcher: Fetcher, url: string): Promise<boolean> {
  try {
    return (await fetcher.size(url)) > 0;
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return false;
    throw error;
  }
}

export const ahn: Provider = {
  id: 'ahn',
  name: 'AHN (Het Waterschapshuis)',
  areas: [[3.2, 50.7, 7.3, 53.7]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(28992));
    const found: { url: string; edition: string; year: number; square: Polygon }[] = [];

    for (const feature of await sheets(fetcher, AHN6_LAYER, bbox)) {
      const name = /AHN6_(\d{4})_C_(\d{6})_(\d{6})\.LAZ$/i.exec(String(feature.properties.Puntenwolk ?? ''));
      if (!name) continue;
      const [, year, x, y] = name;
      const square = squarePolygon(toLonLat, Number(x), Number(y), KM);
      found.push({ url: `${BUCKET}AHN6/01_LAZ/AHN6_${year}_C_${x}_${y}.COPC.LAZ`, edition: 'AHN6', year: Number(year), square });
    }

    // AHN5's 1 km tiles take the year of the map sheet holding the middle of
    // the part of them in the area. Sheets are 6.25 km tall, so a tile can sit
    // across two, and its own centre on the edge between them.
    const ahn5 = (await sheets(fetcher, AHN5_LAYER, bbox)).flatMap((feature) => {
      const year = /\/(\d{4})_C_[^/]+\.LAZ$/i.exec(String(feature.properties.Puntenwolk ?? ''))?.[1];
      const shape = geoPolygons(feature.geometry);
      return year && shape.length ? [{ year: Number(year), shape, box: ringBox(shape.flat()) }] : [];
    });
    if (ahn5.length) {
      for (const { x, y } of gridSquares(28992, bbox, KM)) {
        const [w, s, e, n] = ringBox(squarePolygon(toLonLat, x, y, KM));
        const [lon, lat] = [(Math.max(w, bbox.west) + Math.min(e, bbox.east)) / 2, (Math.max(s, bbox.south) + Math.min(n, bbox.north)) / 2];
        const sheet = ahn5.find(({ shape }) => shape.some((polygon) => inside(polygon[0], lon, lat))) ?? ahn5.find(({ box }) => overlaps(box, { west: w, south: s, east: e, north: n }));
        if (!sheet) continue;
        const name = `${String(x).padStart(6, '0')}_${String(y).padStart(6, '0')}`;
        found.push({ url: `${BUCKET}AHN5_KM/01_LAZ/AHN5_C_${name}.COPC.LAZ`, edition: 'AHN5', year: sheet.year, square: squarePolygon(toLonLat, x, y, KM) });
      }
    }

    const surveys = new Surveys();
    const wanted = found.filter((tile) => overlaps(ringBox(tile.square), bbox));
    const present = await Promise.all(wanted.map((tile) => exists(fetcher, tile.url)));
    wanted.forEach(({ url, edition, year, square }, i) => {
      if (!present[i]) return;
      surveys.add(
        `${edition}-${year}`,
        () => ({
          provider: 'AHN',
          id: `${edition}-${year}`,
          name: `${edition} ${year}`,
          url: `${BUCKET}${edition}#${year}`,
          format: 'COPC',
          verticalUnits: 'm',
          // 26 is "kunstwerken": bridges, viaducts, locks.
          classification: { '1': 'unclassified', '2': 'ground', '6': 'building', '9': 'water', '26': 'bridge' },
          acquisitionStart: `${year}-01-01`,
          acquisitionEnd: `${year}-12-31`,
          license: 'CC BY 4.0',
          attribution: 'AHN, Het Waterschapshuis',
          sourcePage: 'https://www.ahn.nl/dataroom',
          authoritative: true,
          projectYearHint: year,
        }),
        { url, bbox: ringBox(square), horizontalCrs: 'EPSG:28992' },
        [square],
      );
    });
    return surveys.list();
  },
};

function inside(ring: [number, number][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
