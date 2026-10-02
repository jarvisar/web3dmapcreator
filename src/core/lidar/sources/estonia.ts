// Maa- ja Ruumiamet's (the Estonian Land and Spatial Development Board)
// yearly LAZ on 1 km sheets in L-EST97. Towns are flown low ("madal", 25-30
// returns per m²) most years, the rest of the country normally ("tava", 3-6)
// and forests on their own ("mets", about 1). Flai's COPC mirror has every
// year and product up to 2023, so only later years are listed here. Each
// year and product is a survey.
//
// Nothing has CORS, so the sheet listings and files go through the proxy.
// The sheet number is (northing km - 6000) * 1000 + easting km, and its
// listing has every product and year on it. A file that doesn't exist
// answers 206 with a web page, so only names a listing shows are used.
//
// Class 5 here is first and intermediate returns of pulses with several,
// which is mostly trees, and 17 is the upper level at multi-level junctions.
// Flai's copies are read with the ASPRS meanings (high vegetation, and
// bridge in LiDAR only models), and so are these. Headers carry the
// processing date: Tartu's 2024 flight was in April, its header says May.

import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { gridSquares, ringBox, squarePolygon, Surveys, type Provider } from './common';

const BASE = 'https://geoportaal.maaruum.ee/index.php?lang_id=1&plugin_act=otsing&';
const FIRST_YEAR = 2024;
const KM = 1000;

export interface EstoniaFile {
  name: string;
  year: number;
  product: string;
}

/** The LAZ files a sheet's listing shows. */
export function estoniaFiles(html: string, sheet: number): EstoniaFile[] {
  const out: EstoniaFile[] = [];
  for (const match of html.matchAll(/>\s*((\d{6})_(\d{4})_([a-z]+)\.laz)\s*<\/a>/g)) {
    const [, name, number, year, product] = match;
    if (Number(number) === sheet) out.push({ name, year: Number(year), product });
  }
  return out;
}

export const sheetNumber = (x: number, y: number) => (Math.floor(y / KM) - 6000) * 1000 + Math.floor(x / KM);

export const estonia: Provider = {
  id: 'estonia',
  name: 'Maa- ja Ruumiamet',
  areas: [[21.7, 57.5, 28.3, 59.8]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(3301));
    const squares = gridSquares(3301, bbox, KM, 100);
    const listings = await Promise.all(
      squares.map(({ x, y }) => fetcher.text(`${BASE}page_id=614&kaardiruut=${sheetNumber(x, y)}&andmetyyp=lidar_laz_madal`)),
    );
    const surveys = new Surveys();
    squares.forEach(({ x, y }, i) => {
      const sheet = sheetNumber(x, y);
      const square = squarePolygon(toLonLat, x, y, KM);
      const files = estoniaFiles(listings[i], sheet).filter((f) => f.year >= FIRST_YEAR);
      for (const { name, year, product } of files) {
        const id = `${year}_${product}`;
        surveys.add(
          id,
          () => ({
            provider: 'Maa- ja Ruumiamet',
            id,
            name: `Estonia ${year} (${product})`,
            url: `${BASE}#${id}`,
            format: 'LAZ',
            verticalUnits: 'm',
            acquisitionStart: `${year}-01-01`,
            acquisitionEnd: `${year}-12-31`,
            license: 'Maa- ja Ruumiameti avaandmete litsents',
            attribution: `Kõrgusandmed ${year}, Maa- ja Ruumiamet`,
            sourcePage: 'https://geoportaal.maaruum.ee/eng/Maps-and-Data/Elevation-data/Download-elevation-data-p664.html',
            authoritative: true,
            projectYearHint: year,
          }),
          { url: `${BASE}kaardiruut=${sheet}&andmetyyp=lidar_laz_${product}&dl=1&f=${name}&page_id=614`, bbox: ringBox(square), horizontalCrs: 'EPSG:3301' },
          [square],
        );
      }
    });
    return surveys.list();
  },
};
