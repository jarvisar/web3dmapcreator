import { describe, expect, it } from 'vitest';
import { gpsCaptureYears } from './selection';
import { NumpyRandom } from './test-helpers';

// What gpsCaptureYears did with a Date per return, before it looked years up.
function byDate(values: number[], adjusted: boolean, now: Date): number[] {
  const thisYear = now.getUTCFullYear();
  const epoch = Date.UTC(1980, 0, 6);
  return values.map((v) => {
    if (!Number.isFinite(v) || v === 0) return 0;
    if (!adjusted && !(v < 0 || v > 604800)) return 0;
    const seconds = v + 1e9;
    if (seconds < 315964800 || seconds >= (thisYear - 1979) * 366 * 86400) return 0;
    const year = new Date(epoch + Math.floor(seconds) * 1000).getUTCFullYear();
    return year >= 1990 && year <= thisYear ? year : 0;
  });
}

describe('gpsCaptureYears', () => {
  const now = new Date(Date.UTC(2026, 8, 28));
  const epoch = Date.UTC(1980, 0, 6);

  it('finds the same years as a date per return', () => {
    const rng = new NumpyRandom(11);
    const values: number[] = [];
    // Adjusted GPS time is seconds since the GPS epoch less a billion.
    for (let k = 0; k < 20000; k++) values.push((rng.random() * 48 * 365.25 + 3650) * 86400 - 1e9);
    // Either side of every new year from 1985 to 2028, and a few odd ones.
    for (let year = 1985; year <= 2028; year++) {
      const start = (Date.UTC(year, 0, 1) - epoch) / 1000 - 1e9;
      values.push(start - 1, start - 0.5, start, start + 0.25, start + 1);
    }
    values.push(0, NaN, Infinity, 604800, -5);
    for (const adjusted of [true, false]) {
      const { years } = gpsCaptureYears(values, adjusted, true, now);
      expect(Array.from(years)).toEqual(byDate(values, adjusted, now));
    }
  });

  it('leaves week time undated without the EPT mirror', () => {
    expect(gpsCaptureYears([1e8], false, false, now).basis).toBe('unknown');
  });
});
