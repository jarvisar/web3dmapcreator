// City of Helsinki laser data, 2021 (about 62 points per m², buildings
// classified) and 2017: LAZ per 500 m map sheet, about 90 MB each. Its server
// ignores Range, so a sheet is downloaded whole, once, and read from the
// cache after that. The city's sheet grid WFS is the index. Finland's national
// survey needs an API key, and Flai mirrors its sparse 0.5 point data.

import { geoPolygons, pagedFeatures, ringBox, Surveys, type Provider } from './common';

const SHEETS = 'https://kartta.hel.fi/ws/geoserver/avoindata/wfs';
const FILES = 'https://ptp.hel.fi/DataHandlers/Lidar_kaikki/Default.ashx';
// Each year with its returns per m², from sheet headers (46-83 in 2021, 30-40
// in 2017). Whole files give no density before they're downloaded, and
// without one neither was ever offered over Flai's 0.6.
const YEARS: [number, number][] = [
  [2021, 60],
  [2017, 32],
];
// The grid runs out to sea and into Espoo and Vantaa, and a sheet a year
// doesn't have answers 200 with 65 bytes of text.
const MISSING_BYTES = 1000;

export const helsinki: Provider = {
  id: 'helsinki',
  name: 'City of Helsinki',
  areas: [[24.78, 60.1, 25.27, 60.3]],
  async discover(fetcher, bbox) {
    // WFS 2.0 in EPSG:4326 takes its box as lat, lon.
    const box = [bbox.south, bbox.west, bbox.north, bbox.east].join(',');
    const rows = await pagedFeatures(
      fetcher,
      (offset, count) =>
        `${SHEETS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=avoindata:Karttalehtijako_05x05_km&outputFormat=application/json&srsName=EPSG:4326&bbox=${box},urn:ogc:def:crs:EPSG::4326&count=${count}&startIndex=${offset}`,
    );
    const sheets = rows.flatMap((row) => {
      const sheet = String(row.properties.tunnus ?? '');
      const outline = geoPolygons(row.geometry);
      return /^\d{6}[a-d]$/.test(sheet) && outline.length ? YEARS.map(([year, density]) => ({ url: `${FILES}?q=${sheet}&y=${year}`, year, density, outline })) : [];
    });
    // A failed HEAD keeps the sheet: the file itself says if it's there.
    const sizes = await Promise.all(sheets.map(({ url }) => fetcher.size(url).catch(() => undefined)));
    const surveys = new Surveys();
    sheets.forEach(({ url, year, density, outline }, i) => {
      const size = sizes[i];
      if (size !== undefined && size < MISSING_BYTES) return;
      surveys.add(
        String(year),
        () => ({
          provider: 'City of Helsinki',
          id: String(year),
          name: `Helsinki laser data ${year}`,
          url: `${FILES}#${year}`,
          format: 'LAZ',
          verticalUnits: 'm',
          acquisitionStart: `${year}-01-01`,
          acquisitionEnd: `${year}-12-31`,
          densityM2: density,
          license: 'CC BY 4.0',
          attribution: 'City of Helsinki, Kaupunkimittauspalvelut',
          sourcePage: 'https://hri.fi/data/en_GB/dataset/helsingin-laserkeilausaineistot',
          authoritative: true,
          projectYearHint: year,
        }),
        // The files have no CRS records: ETRS-GK25 (EPSG:3879), N2000 heights.
        { url, bbox: ringBox(outline.flat()), horizontalCrs: 'EPSG:3879', whole: true, size },
        outline,
      );
    });
    return surveys.list();
  },
};
