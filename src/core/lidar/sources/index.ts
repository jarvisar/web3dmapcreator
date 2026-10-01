// Finding surveys a browser can read over an area. Each provider is its own
// module: a catalog it asks, and the areas it's asked about. Only publishers
// whose catalogs and point files answer cross-origin requests (CORS) are
// here, since there is no server in between.
//
// Everything returned is in lon/lat. Spatial tests against buildings happen
// later, in the metric frame.

import { HttpError, NetworkError } from '../../data/http';
import type { GeoBounds } from '../../types';
import type { Fetcher } from '../read/fetcher';
import { overlaps, type Candidate, type Failure, type Provider } from './common';
import { aist3ddb } from './aist3ddb';
import { alaska } from './alaska';
import { arpai } from './arpai';
import { basque } from './basque';
import { berlin } from './berlin';
import { brandenburg } from './brandenburg';
import { dc } from './dc';
import { flai } from './flai';
import { genova } from './genova';
import { geonb } from './geonb';
import { halle } from './halle';
import { helsinki } from './helsinki';
import { ign } from './ign';
import { illinois } from './illinois';
import { indiana } from './indiana';
import { japan } from './japan';
import { kyfromabove } from './kyfromabove';
import { luxembourg } from './luxembourg';
import { noaa } from './noaa';
import { nrcan } from './nrcan';
import { nrw } from './nrw';
import { opentopography } from './opentopography';
import { rlp } from './rlp';
import { saoPaulo } from './saopaulo';
import { sceneLayers } from './scenelayers';
import { scotland } from './scotland';
import { slovenia } from './slovenia';
import { swisstopo } from './swisstopo';
import { trentino } from './trentino';
import { turku } from './turku';
import { usgs } from './usgs';
import { usgsStaged } from './usgsstaged';
import { wisconsin } from './wisconsin';

export type { Box, Candidate, Failure, Format, Provider, Tile } from './common';
export { geoPolygons, sphericalArea } from './common';
export { flaiInventory } from './flai';
export { USGS_CATALOG } from './usgs';

// Registry order is the order candidates come out in, which ranking falls
// back on, so it stays the same however the requests finish.
export const PROVIDERS: Provider[] = [usgs, usgsStaged, kyfromabove, indiana, illinois, wisconsin, dc, alaska, arpai, flai, ign, nrcan, swisstopo, nrw, rlp, brandenburg, berlin, halle, luxembourg, scotland, slovenia, basque, trentino, genova, helsinki, turku, geonb, noaa, saoPaulo, japan, aist3ddb, sceneLayers, opentopography];

const TIMEOUT_MS = 90_000;

/** Why a catalog failed, without the URL that network errors spell out. */
export function briefly(error: unknown): string {
  if (error instanceof HttpError) return `it answered HTTP ${error.status}`;
  if (error instanceof NetworkError) return "it couldn't be reached";
  return (error as Error)?.message ?? String(error);
}

/** Providers that may have data in `bbox`. */
export function providersFor(bbox: GeoBounds, providers = PROVIDERS): Provider[] {
  return providers.filter((p) => !p.areas || p.areas.some((area) => overlaps(area, bbox)));
}

/**
 * Every provider's candidates. One provider failing, or taking too long,
 * never stops the others: it's reported as a failure and the rest carry on.
 */
export async function discover(fetcher: Fetcher, bbox: GeoBounds, progress?: (message: string) => void, providers = PROVIDERS): Promise<{ candidates: Candidate[]; failures: Failure[] }> {
  const failures: Failure[] = [];
  const results = await Promise.all(
    providersFor(bbox, providers).map(async (provider) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = provider.timeoutMs ?? TIMEOUT_MS;
      // The requests themselves aren't stopped: they finish into the cache,
      // so the next try has them.
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(limit / 1000)} s`)), limit);
      });
      try {
        const found = await Promise.race([provider.discover(fetcher, bbox, failures), late]);
        progress?.(`${provider.id}: ${found.length} surveys`);
        return found;
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error;
        failures.push({ source: provider.name ?? provider.id, reason: briefly(error) });
        return [];
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  for (const failure of failures) failure.search = true;
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const list of results) {
    for (const candidate of list) {
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      candidates.push(candidate);
    }
  }
  return { candidates, failures };
}
