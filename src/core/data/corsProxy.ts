// Files whose hosts send no CORS headers, so a browser can only read them
// through the site's proxy (`proxy/`, a Cloudflare Worker). The proxy reads
// this list too and refuses anything else, so it can't be used as an open
// proxy. Node has no CORS and fetches them directly.
//
// Only the request goes through the proxy. Cache keys stay the file's own
// URL, so moving the proxy doesn't throw away what was downloaded.

export interface Proxied {
  /** Every URL under this. Keep it as narrow as the files need. */
  prefix?: string;
  /** Or URLs matching this, for hosts where a random share id comes before the file name. */
  pattern?: RegExp;
  /** The host refuses HEAD (Nextcloud answers 401, FileBrowser 404, Alfresco 405), so sizes come from a two byte range. */
  noHead?: boolean;
  /** How long the host can take to start answering. Others get the usual 30 s of silence before a retry. */
  firstByteMs?: number;
}

export const PROXIED: Proxied[] = [
  // USGS 3DEP work units that Hobu's EPT mirror hasn't built yet.
  { prefix: 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/' },
  // PASDA's copy of USGS's PA_17County_2024, about 70 times faster than rockyweb.
  { prefix: 'https://www.pasda.psu.edu/download/usgs/PA_17County_2024/' },
  // New York State's copies of USGS's Long Island 2024 and NH Gaps 2024.
  { prefix: 'https://gisdata.ny.gov/elevation/LIDAR/NYS_LongIsland2024/' },
  { prefix: 'https://gisdata.ny.gov/elevation/LIDAR/USGS_2024/' },
  // AHN5 and AHN6. The bucket's CORS rule only allows basisdata.nl.
  { prefix: 'https://fsn1.your-objectstorage.com/hwh-ahn/AHN5_KM/01_LAZ/' },
  { prefix: 'https://fsn1.your-objectstorage.com/hwh-ahn/AHN6/01_LAZ/' },
  // A HEAD asking for gzip, as Node's does, gets the file gzipped and no length.
  { prefix: 'https://geodaten.bayern.de/odd_data/laser/', noHead: true },
  // GeoSN's public Nextcloud share. Failed requests count towards its brute-force lockout, which is per IP and so shared by every user of the proxy.
  { prefix: 'https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/EpkzyJHScGb5ndd/', noHead: true },
  // Another Nextcloud. A HEAD works here, but bytes=0-0 streams the whole 20 GB ZIP.
  { prefix: 'https://www.shop.lvgl.saarland.de/cloud/public.php/dav/files/NK8ndP55qAqGEZD/OD_LIDAR_Punktwolke_2025_laz_LK/', noHead: true },
  { prefix: 'https://service.salzburg.gv.at/sagisogd/archiv/raster/hoehen/laserscan/Originalpunkte/ungefiltert/DOM/' },
  { prefix: 'https://geoportal.geoportal-th.de/hoehendaten/LAS/' },
  { prefix: 'https://vogis.cnv.at/geodaten/api/public/dl/OTSj-JMs/gelaendemodelle/lidarpunkte/', noHead: true },
  { prefix: 'https://geoportal.madrid.es/fsdescargas/IDEAM_WBGEOPORTAL/ELEVACIONES/2026/NUBE_PUNTOS/' },
  { prefix: 'https://filescartografia.navarra.es/5_LIDAR/' },
  // Didn't answer from US addresses at all in October 2026.
  { prefix: 'https://datacloud.icgc.cat/datacloud/lidar-territorial/' },
  { prefix: 'https://urbisdownload.datastore.brussels/UrbIS/Vector/M8/PointCloud2021/LAS/' },
  // Ignores Range, and at times takes 85-110 s to answer anything.
  { prefix: 'https://opendata.geoportal.gov.pl/NumDaneWys/DanePomiaroweLAZ/', firstByteMs: 180_000 },
  { prefix: 'https://geoportaal.maaruum.ee/index.php?lang_id=1&plugin_act=otsing&' },
  { prefix: 'https://data.geographic.texas.gov/' },
  { prefix: 'https://cdn.ancgis.com/datapublicstatic/Elevation2025/LiDAR_PointCloud/' },
  { prefix: 'https://nrs.objectstore.gov.bc.ca/gdwuts/' },
  // MRNF's WFS refuses any request carrying an Origin header, which the proxy doesn't send.
  { prefix: 'https://servicesvecto3.mern.gouv.qc.ca/geoserver/Index_Telechargement_Lidar_Pub/wfs?' },
  { prefix: 'https://diffusion.mern.gouv.qc.ca/diffusion/RGQ/Lidar/' },
  // Alfresco share links. The share id comes first, so a prefix would open every public share on the city's server.
  { pattern: /^https:\/\/imnube\.montevideo\.gub\.uy\/share\/s\/[A-Za-z0-9_-]+\/content\/LIDAR_MVD_2024_[A-Z0-9-]+\.laz$/, noHead: true },
  { prefix: 'https://wpgopendata.blob.core.windows.net/open-data-lidar/' },
];

const matches = (rule: Proxied, url: string) => (rule.prefix !== undefined && url.startsWith(rule.prefix)) || (rule.pattern?.test(url) ?? false);

/** The rule for a URL, or undefined for one that doesn't go through the proxy. */
export const proxyRule = (url: string): Proxied | undefined => PROXIED.find((rule) => matches(rule, url));

// The proxy's address, 'direct' (Node), or null when there's none: then these
// files can't be read and their sources are left out.
let proxy: string | null = null;

export function setCorsProxy(value: string | null | undefined): void {
  const trimmed = value?.trim().replace(/\/+$/, '');
  // An address given without its scheme (as Cloudflare shows a workers.dev one) is https.
  proxy = !trimmed ? null : trimmed === 'direct' || /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export const needsProxy = (url: string): boolean => proxyRule(url) !== undefined;

/** The proxy's User-Agent, in the usual crawler form. TxGIO's CloudFront refuses anything that doesn't start with Mozilla/5.0. */
export const PROXY_AGENT = 'Mozilla/5.0 (compatible; citymodel-lidar-proxy; +https://citymodel.jarvisar.com)';

/** Headers for going to a listed host directly (Node): the proxy's User-Agent, since Node's own ("node") gets a 403 from TxGIO. */
export function directHeaders(url: string): Record<string, string> {
  return proxy === 'direct' && needsProxy(url) ? { 'User-Agent': PROXY_AGENT } : {};
}

export const proxyAvailable = (): boolean => proxy !== null;

/** Where to send a request for `url`: the proxy for listed files, else the file itself. */
export function requestUrl(url: string): string {
  if (!proxy || proxy === 'direct' || !needsProxy(url)) return url;
  return `${proxy}/${url.slice('https://'.length)}`;
}
