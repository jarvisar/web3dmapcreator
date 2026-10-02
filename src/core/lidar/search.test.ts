import { afterEach, describe, expect, it, vi } from 'vitest';
import { Fetcher } from './read/fetcher';
import { resetSearches, searchSurveys } from './search';
import type { Candidate, Provider } from './sources';

const bbox = { west: 0, south: 45, east: 0.01, north: 45.01 };
const found: Candidate = { provider: 'Test', id: 'x', name: 'x', url: 'https://example.com/x/', format: 'EPT', coverage: [], attribution: 'x', sourcePage: 'x', projectYearHint: 2020 };

afterEach(() => {
  resetSearches();
  vi.useRealTimers();
});

describe('survey searches', () => {
  it("don't wait again for a provider that just gave no answer", async () => {
    const hangs = vi.fn(() => new Promise<Candidate[]>(() => undefined));
    const answers = vi.fn(async () => [found]);
    const providers: Provider[] = [
      { id: 'slow', name: 'Slow catalog', timeoutMs: 20, discover: hangs },
      { id: 'quick', discover: answers },
    ];
    const first = await searchSurveys(new Fetcher(), bbox, undefined, providers);
    expect(first.candidates).toEqual([found]);
    expect(first.failures).toMatchObject([{ source: 'Slow catalog', search: true }]);
    const second = await searchSurveys(new Fetcher(), bbox, undefined, providers);
    expect(hangs).toHaveBeenCalledTimes(1);
    expect(answers).toHaveBeenCalledTimes(2);
    expect(second.candidates).toEqual([found]);
    // Still said, so the model's warnings don't change.
    expect(second.failures).toEqual([{ source: 'Slow catalog', reason: 'no answer a few minutes ago, so it was left out for now', search: true }]);
    // And asked again a few minutes later.
    vi.useFakeTimers({ now: Date.now() + 6 * 60 * 1000, toFake: ['Date'] });
    await searchSurveys(new Fetcher(), bbox, undefined, providers);
    expect(hangs).toHaveBeenCalledTimes(2);
  });

  it('asks again straight away after a quick failure', async () => {
    const fails = vi.fn(async (): Promise<Candidate[]> => {
      throw new Error('it answered HTTP 500');
    });
    const providers: Provider[] = [{ id: 'broken', discover: fails }];
    await searchSurveys(new Fetcher(), bbox, undefined, providers);
    await searchSurveys(new Fetcher(), bbox, undefined, providers);
    expect(fails).toHaveBeenCalledTimes(2);
  });
});
