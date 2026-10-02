// Coordinate systems of point clouds: what grid the XY are in, and what unit
// Z is in. Web Mercator (the USGS EPT mirror) is built in. Every other grid
// goes through a proj4-compatible projector installed with setProjector,
// with definitions below for the grids the streamed sources use, so no
// definition is fetched at run time. A header's own WKT is the fallback.

export type Transform = (x: number, y: number) => [number, number];

export interface Converter {
  forward(point: [number, number]): [number, number];
  inverse(point: [number, number]): [number, number];
}

export type Projector = (from: string, to: string) => Converter;

let projector: Projector | null = null;

export function setProjector(value: Projector | null): void {
  projector = value;
}

const R = 6378137;
const DEG = Math.PI / 180;

const webMercator = {
  toLonLat: ((x, y) => [(x / R) / DEG, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / DEG]) as Transform,
  fromLonLat: ((lon, lat) => [R * lon * DEG, R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2))]) as Transform,
};

const identity: Transform = (x, y) => [x, y];

const GRS80 = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

// proj4 definitions from epsg.io for grids seen in streamed surveys (IGN,
// NRCan, swisstopo, Flai's European mirrors, OpenTopography).
const DEFINITIONS: Record<number, string> = {
  2154: `+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 ${GRS80}`,
  2056: '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
  // Amersfoort to WGS 84 (4) as a position vector shift. epsg.io's string has
  // the Molodensky-Badekas rotations, which proj4 can't use: 170 m off.
  28992: '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,-0.398957388243134,0.343987817378283,-1.87740163998045,4.0725 +units=m +no_defs',
  27700: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
  2157: `+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 ${GRS80}`,
  3067: `+proj=utm +zone=35 ${GRS80}`,
  3006: `+proj=utm +zone=33 ${GRS80}`,
  2180: `+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 ${GRS80}`,
  31370: '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs',
  3812: `+proj=lcc +lat_0=50.797815 +lon_0=4.35921583333333 +lat_1=49.8333333333333 +lat_2=51.1666666666667 +x_0=649328 +y_0=665262 ${GRS80}`,
  3301: `+proj=lcc +lat_0=57.5175539305556 +lon_0=24 +lat_1=59.3333333333333 +lat_2=58 +x_0=500000 +y_0=6375000 ${GRS80}`,
  2169: '+proj=tmerc +lat_0=49.8333333333333 +lon_0=6.16666666666667 +k=1 +x_0=80000 +y_0=100000 +ellps=intl +towgs84=-189.681,18.3463,-42.7695,-0.33746,-3.09264,2.53861,0.4598 +units=m +no_defs',
  3794: `+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 ${GRS80}`,
  3035: `+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 ${GRS80}`,
  2193: `+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 ${GRS80}`,
  3765: `+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 ${GRS80}`,
  3059: `+proj=tmerc +lat_0=0 +lon_0=24 +k=0.9996 +x_0=500000 +y_0=-6000000 ${GRS80}`,
  4083: `+proj=utm +zone=28 ${GRS80}`,
  29902: '+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=1.000035 +x_0=200000 +y_0=250000 +ellps=mod_airy +towgs84=482.5,-130.6,564.6,-1.042,-0.214,-0.631,8.15 +units=m +no_defs',
  // ETRS89 / GK25FIN (Helsinki) and GK23FIN (Turku).
  3879: `+proj=tmerc +lat_0=0 +lon_0=25 +k=1 +x_0=25500000 +y_0=0 ${GRS80}`,
  3877: `+proj=tmerc +lat_0=0 +lon_0=23 +k=1 +x_0=23500000 +y_0=0 ${GRS80}`,
  // RDN2008 / UTM zone 32N (Genoa).
  7791: `+proj=utm +zone=32 ${GRS80}`,
  // SIRGAS-ROU98 / UTM zone 21S (Montevideo).
  5382: '+proj=utm +zone=21 +south +ellps=WGS84 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  // NAD83(2011) / Pennsylvania South, US feet (PASDA's copy of USGS's PA_17County_2024).
  6565: '+proj=lcc +lat_0=39.3333333333333 +lon_0=-77.75 +lat_1=40.9666666666667 +lat_2=39.9333333333333 +x_0=600000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs',
  // NAD83(2011) / Texas Central and South Central, US feet (TxGIO).
  6578: '+proj=lcc +lat_0=29.6666666666667 +lon_0=-100.333333333333 +lat_1=31.8833333333333 +lat_2=30.1166666666667 +x_0=699999.999898399 +y_0=3000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs',
  6588: '+proj=lcc +lat_0=27.8333333333333 +lon_0=-99 +lat_1=30.2833333333333 +lat_2=28.3833333333333 +x_0=600000 +y_0=3999999.9998984 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs',
  // NAD83(PA11) and NAD83(MA11) UTM: Hawaii, American Samoa, Guam and the Marianas (NOAA).
  6634: `+proj=utm +zone=4 ${GRS80}`,
  6635: `+proj=utm +zone=5 ${GRS80}`,
  6636: `+proj=utm +zone=2 +south ${GRS80}`,
  8693: `+proj=utm +zone=55 ${GRS80}`,
  // NAD83(CSRS) / New Brunswick Stereographic (GeoNB).
  2953: `+proj=sterea +lat_0=46.5 +lon_0=-66.5 +k=0.999912 +x_0=2500000 +y_0=7500000 ${GRS80}`,
  // NAD83 and NAD83(2011) / Kentucky Single Zone, metres and US feet (KyFromAbove).
  3088: `+proj=lcc +lat_0=36.3333333333333 +lon_0=-85.75 +lat_1=37.0833333333333 +lat_2=38.6666666666667 +x_0=1500000 +y_0=1000000 ${GRS80}`,
  3089: `+proj=lcc +lat_0=36.3333333333333 +lon_0=-85.75 +lat_1=37.0833333333333 +lat_2=38.6666666666667 +x_0=1500000 +y_0=999999.9998984 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs`,
  // S-JTSK to WGS 84 (1). The three-parameter shift epsg.io gives is good to about 8 m.
  5514: '+proj=krovak +lat_0=49.5 +lon_0=24.8333333333333 +alpha=30.2881397527778 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs',
};

// NAD83(CSRS) / MTM zones 3-10 (Montreal, Quebec's MRNF).
for (let zone = 3; zone <= 10; zone++) {
  DEFINITIONS[2942 + zone] = `+proj=tmerc +lat_0=0 +lon_0=${-(49.5 + 3 * zone)} +k=0.9999 +x_0=304800 +y_0=0 ${GRS80}`;
}
// Poland's CS2000 zones 5-8 (GUGiK's sheets).
for (let zone = 5; zone <= 8; zone++) {
  DEFINITIONS[2171 + zone] = `+proj=tmerc +lat_0=0 +lon_0=${3 * zone} +k=0.999923 +x_0=${zone * 1000000 + 500000} +y_0=0 ${GRS80}`;
}
// MGI / Austria GK West, Central, East (31254-31256) and M28, M31, M34
// (31257-31259). Vorarlberg's COPC names 31254 in a WKT without a datum
// shift, which put points about 70 m off.
[10.3333333333333, 13.3333333333333, 16.3333333333333].forEach((lon, k) => {
  const mgi = '+ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs';
  DEFINITIONS[31254 + k] = `+proj=tmerc +lat_0=0 +lon_0=${lon} +k=1 +x_0=0 +y_0=-5000000 ${mgi}`;
  DEFINITIONS[31257 + k] = `+proj=tmerc +lat_0=0 +lon_0=${lon} +k=1 +x_0=${150000 + k * 300000} +y_0=-5000000 ${mgi}`;
});
// Gauss-Kruger zones on DHDN, still used by some German states.
for (let zone = 2; zone <= 5; zone++) {
  DEFINITIONS[31464 + zone] = `+proj=tmerc +lat_0=0 +lon_0=${3 * zone} +k=1 +x_0=${zone * 1000000 + 500000} +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs`;
}
// Japan's plane rectangular zones I-XIX by their origins, on JGD2011
// (EPSG:6669-6687) and JGD2000 (2443-2461). Japanese tiles carry no CRS, so
// the zone comes from the catalog.
const JAPAN: [number, number][] = [
  [33, 129.5], [33, 131], [36, 132.166666666667], [33, 133.5], [36, 134.333333333333], [36, 136], [36, 137.166666666667], [36, 138.5], [36, 139.833333333333], [40, 140.833333333333],
  [44, 140.25], [44, 142.25], [44, 144.25], [26, 142], [26, 127.5], [26, 124], [26, 131], [20, 136], [26, 154],
];
DEFINITIONS[6472] = DEFINITIONS[3088];
DEFINITIONS[6473] = DEFINITIONS[3089];
// NAD83 and NAD83(2011) / Indiana East and West, metres and US feet (Indiana's own lidar).
for (const [lon, x, metres, feet] of [
  [-85.6666666666667, 100000, [26973, 6458], [2965, 6459]],
  [-87.0833333333333, 900000, [26974, 6460], [2966, 6461]],
] as [number, number, number[], number[]][]) {
  const zone = `+proj=tmerc +lat_0=37.5 +lon_0=${lon} +k=0.999966666666667 +x_0=${x} +y_0=250000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0`;
  for (const code of metres) DEFINITIONS[code] = `${zone} +units=m +no_defs`;
  for (const code of feet) DEFINITIONS[code] = `${zone} +units=us-ft +no_defs`;
}
// Illinois East and West on NAD83, HARN, NSRS2007 and 2011, metres and US
// feet. Its older tiles only carry GeoTIFF keys.
for (const [lon, k, x, metres, feet] of [
  [-88.3333333333333, 0.999975, 300000, [26971, 2790, 3528, 6454], [3435, 3443, 3529, 6455]],
  [-90.1666666666667, 0.999941177, 700000, [26972, 2791, 3530, 6456], [3436, 3444, 3531, 6457]],
] as [number, number, number, number[], number[]][]) {
  const zone = `+proj=tmerc +lat_0=36.6666666666667 +lon_0=${lon} +k=${k} +x_0=${x} +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0`;
  for (const code of metres) DEFINITIONS[code] = `${zone} +units=m +no_defs`;
  for (const code of feet) DEFINITIONS[code] = `${zone} +units=us-ft +no_defs`;
}
// NAD83(HARN) / Maryland (DC's own surveys).
DEFINITIONS[2804] = `+proj=lcc +lat_0=37.6666666666667 +lon_0=-77 +lat_1=39.45 +lat_2=38.3 +x_0=400000 +y_0=0 ${GRS80}`;
JAPAN.forEach(([lat, lon], k) => {
  DEFINITIONS[6669 + k] = DEFINITIONS[2443 + k] = `+proj=tmerc +lat_0=${lat} +lon_0=${lon} +k=0.9999 +x_0=0 +y_0=0 ${GRS80}`;
});
// NAD83(CSRS) UTM zones as EPSG numbers them (NRCan).
const CSRS: Record<number, number> = { 3154: 7, 3155: 8, 3156: 9, 3157: 10, 2955: 11, 2956: 12, 2957: 13, 3158: 14, 3159: 15, 3160: 16, 2958: 17, 2959: 18, 2960: 19, 2961: 20, 2962: 21, 3761: 22 };

function definition(code: number): string | null {
  if (DEFINITIONS[code]) return DEFINITIONS[code];
  if (code >= 32601 && code <= 32660) return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760) return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (code >= 25828 && code <= 25838) return `+proj=utm +zone=${code - 25800} ${GRS80}`;
  if (code >= 26901 && code <= 26923) return `+proj=utm +zone=${code - 26900} +datum=NAD83 +units=m +no_defs`;
  // NAD83(HARN) UTM zones 10-19 (NOAA's older Washington surveys).
  if (code >= 3740 && code <= 3749) return `+proj=utm +zone=${code - 3730} ${GRS80}`;
  if (CSRS[code]) return `+proj=utm +zone=${CSRS[code]} ${GRS80}`;
  // NAD83(2011) UTM zones 1-19 (NOAA), SIRGAS 2000 UTM zones 17-25 south (Brazil and neighbours).
  if (code >= 6330 && code <= 6348) return `+proj=utm +zone=${code - 6329} ${GRS80}`;
  if (code >= 31977 && code <= 31985) return `+proj=utm +zone=${code - 31960} +south ${GRS80}`;
  return null;
}

export interface CrsInfo {
  /** "EPSG:2154", or "WKT" when only the header's text describes it. */
  key: string;
  epsg: number | null;
  wkt: string | null;
  /** Metres per horizontal unit. */
  horizontalFactor: number;
  geographic: boolean;
}

/**
 * The horizontal EPSG code of a WKT: the AUTHORITY/ID of its outermost
 * projected or geographic CRS itself. Codes deeper in are its unit's or
 * datum's: an ESRI WKT of Alaska zone 4 has no EPSG code of its own and
 * ended in its unit's, 9003, and NAD83(CORS96) / UTM zone 10N in its
 * geographic CRS's, 6783.
 */
export function wktEpsg(wkt: string): number | null {
  const horizontal = horizontalPart(wkt);
  let depth = 0;
  let quoted = false;
  let code: number | null = null;
  for (let i = 0; i < horizontal.length; i++) {
    const c = horizontal[i];
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 1 && (c === 'A' || c === 'I' || c === 'a' || c === 'i')) {
      const match = /^(?:AUTHORITY|ID)\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*[\],]/i.exec(horizontal.slice(i, i + 40));
      if (match && /[,[(\s]/.test(horizontal[i - 1] ?? '')) code = Number(match[1]);
    }
  }
  return code;
}

/** The horizontal CRS of a compound WKT, or the whole WKT. */
function horizontalPart(wkt: string): string {
  const upper = wkt.toUpperCase();
  for (const tag of ['PROJCS[', 'PROJCRS[', 'GEOGCS[', 'GEOGCRS[', 'GEODCRS[']) {
    const start = upper.indexOf(tag);
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < wkt.length; i++) {
      if (wkt[i] === '[') depth++;
      else if (wkt[i] === ']' && --depth === 0) return wkt.slice(start, i + 1);
    }
  }
  return wkt;
}

/** The vertical part of a compound WKT, if any. */
function verticalPart(wkt: string): string | null {
  const upper = wkt.toUpperCase();
  for (const tag of ['VERT_CS[', 'VERTCRS[', 'VERTICALCRS[']) {
    const start = upper.indexOf(tag);
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < wkt.length; i++) {
      if (wkt[i] === '[') depth++;
      else if (wkt[i] === ']' && --depth === 0) return wkt.slice(start, i + 1);
    }
  }
  return null;
}

/** Metres per unit of the last UNIT/LENGTHUNIT in a WKT fragment. */
function unitFactor(fragment: string): number | null {
  const matches = [...fragment.matchAll(/(?:LENGTHUNIT|UNIT)\[\s*"([^"]*)"\s*,\s*([0-9.eE+-]+)/gi)];
  if (!matches.length) return null;
  const [, name, value] = matches[matches.length - 1];
  const factor = Number(value);
  if (/degree/i.test(name)) return null;
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

export function crsFromWkt(wkt: string): CrsInfo {
  const epsg = wktEpsg(wkt);
  const horizontal = horizontalPart(wkt);
  const geographic = /^(GEOGCS|GEOGCRS|GEODCRS)\[/i.test(horizontal.trim());
  return { key: epsg ? `EPSG:${epsg}` : 'WKT', epsg, wkt, horizontalFactor: geographic ? 1 : unitFactor(horizontal) ?? 1, geographic };
}

export function crsFromEpsg(epsg: number): CrsInfo {
  return { key: `EPSG:${epsg}`, epsg, wkt: null, horizontalFactor: definitionFactor(definition(epsg)), geographic: epsg === 4326 || epsg === 4258 || epsg === 4269 };
}

// Tiles with only GeoKeys or the catalog's code (Illinois' LAS 1.2 counties,
// in US feet) read 10.76 times too sparse when this was always 1.
function definitionFactor(def: string | null): number {
  const units = /\+units=([\w-]+)/.exec(def ?? '')?.[1];
  const toMeter = Number(/\+to_meter=([0-9.eE+-]+)/.exec(def ?? '')?.[1]);
  if (toMeter > 0) return toMeter;
  return units === 'us-ft' ? 1200 / 3937 : units === 'ft' ? 0.3048 : 1;
}

/** Transforms between a cloud's grid and lon/lat. */
export function lonLatTransforms(crs: CrsInfo): { toLonLat: Transform; fromLonLat: Transform } {
  if (crs.epsg === 3857 || crs.epsg === 900913 || crs.epsg === 3785) return webMercator;
  if (crs.geographic && (crs.epsg === 4326 || crs.epsg === null)) return { toLonLat: identity, fromLonLat: identity };
  // proj4 can't read a compound WKT, but it can read its horizontal part.
  const def = (crs.epsg !== null && definition(crs.epsg)) || (crs.wkt && horizontalPart(crs.wkt));
  if (!def) throw new Error(`No definition for LiDAR coordinate system ${crs.key}`);
  if (!projector) throw new Error(`Reading LiDAR in ${crs.key} needs a projection library`);
  const converter = projector(def, 'EPSG:4326');
  return {
    toLonLat: (x, y) => converter.forward([x, y]),
    fromLonLat: (lon, lat) => converter.inverse([lon, lat]),
  };
}

// WGS84 areas of every regional height system in feet, from the EPSG
// registry (the add-on reads them from pyproj). Worldwide placeholders are
// left out. Anywhere else a missing vertical unit can only be metres.
const FOOT_HEIGHT_AREAS: [number, number, number, number][] = [
  [-168.26, 24.41, -66.91, 71.4],
  [-160.3, 18.87, -154.74, 22.29],
  [-124.79, 24.41, -66.91, 49.38],
  [-124.6, 31.33, -78.52, 49.01],
  [-81.46, 19.21, -81.04, 19.41],
  [-80.14, 19.63, -79.93, 19.74],
  [-79.92, 19.66, -79.69, 19.78],
  [-10.56, 51.39, -5.34, 55.43],
  [46.54, 28.53, 48.48, 30.09],
  [167.65, 15.56, -65.69, 74.71],
];

/**
 * 1 when points lie where no foot-based height system is registered: most
 * European mirrors carry no vertical CRS at all. The US, Kuwait, Ireland and
 * the Cayman Islands keep needing metadata. The datum stays unknown, which is
 * fine: heights are roof minus ground within one survey.
 */
export function regionalVerticalFactor(bounds: [number, number, number, number]): number | null {
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) return null;
  for (const [w, s, e, n] of FOOT_HEIGHT_AREAS) {
    const spans = w <= e ? [[w, e]] : [[w, 180], [-180, e]];
    if (s <= north && south <= n && spans.some(([a, b]) => a <= east && west <= b)) return null;
  }
  return 1;
}

// Metres per unit of vertical CRSs that GeoTIFF keys name by EPSG code.
const VERTICAL_CRS: Record<number, number> = { 5703: 1, 5701: 1, 5702: 0.3048006096012192, 6360: 0.3048006096012192, 8228: 0.3048, 5714: 1, 5773: 1 };

/**
 * Z to metres from the header: a compound WKT's vertical unit, GeoTIFF's
 * vertical unit or vertical CRS keys, else null. Horizontal metres say
 * nothing about Z.
 */
export function headerVerticalFactor(wkt: string | null, keys: Map<number, number>): { factor: number; basis: string } | null {
  if (wkt) {
    const vertical = verticalPart(wkt);
    const factor = vertical ? unitFactor(vertical) : null;
    if (factor) return { factor, basis: 'CRS vertical axis' };
  }
  const unit = keys.get(4099);
  if (unit) {
    const factor = ({ 9001: 1, 9002: 0.3048, 9003: 1200 / 3937 } as Record<number, number>)[unit];
    if (factor) return { factor, basis: 'header GeoTIFF vertical unit key' };
  }
  const code = keys.get(4096);
  if (code && VERTICAL_CRS[code]) return { factor: VERTICAL_CRS[code], basis: 'header GeoTIFF vertical CRS key' };
  return null;
}

/** EPSG code of a GeoTIFF key directory's projected (3072) or geographic (2048) CRS. */
export function geoKeyEpsg(keys: Map<number, number>): number | null {
  const projected = keys.get(3072);
  if (projected && projected < 32767) return projected;
  const geographic = keys.get(2048);
  if (geographic && geographic < 32767) return geographic;
  return null;
}
