// The survey search (sources/discover), leaving out providers that didn't
// answer a few minutes ago. One that hangs takes its whole deadline (90 s,
// NRCan's 180 s), and a result with a failed search is never kept, so every
// generation used to wait it out again. Only for this session: after a few
// minutes it's asked again, and its failure is still reported meanwhile.

import type { GeoBounds } from '../types';
import type { Fetcher } from './read/fetcher';
import { discover, PROVIDERS, providersFor, type Candidate, type Failure, type Provider } from './sources';

const QUIET_MS = 5 * 60 * 1000;
const quietUntil = new Map<string, number>();

export async function searchSurveys(fetcher: Fetcher, bbox: GeoBounds, progress?: (message: string) => void, providers: Provider[] = PROVIDERS): Promise<{ candidates: Candidate[]; failures: Failure[] }> {
  const now = Date.now();
  const resting = new Set(providersFor(bbox, providers).filter((p) => (quietUntil.get(p.id) ?? 0) > now));
  const running = new Set<string>();
  const asked = providers
    .filter((p) => !resting.has(p))
    .map((p): Provider => ({
      ...p,
      discover: (f, b, failures) => {
        running.add(p.id);
        return p.discover(f, b, failures).finally(() => running.delete(p.id));
      },
    }));
  const found = await discover(fetcher, bbox, progress, asked);
  // discover only stops waiting for a provider at its deadline, so one still
  // running now never answered.
  for (const id of running) quietUntil.set(id, Date.now() + QUIET_MS);
  for (const p of resting) found.failures.push({ source: p.name ?? p.id, reason: 'no answer a few minutes ago, so it was left out for now', search: true });
  return found;
}

/** Forgets which providers didn't answer, for tests. */
export function resetSearches(): void {
  quietUntil.clear();
}
