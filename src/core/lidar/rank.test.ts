import { describe, expect, it } from 'vitest';
import { chosenFirst } from './choice';
import { rankSurveys, type Ranked } from './prepare';
import { workUnitYear } from './sources/usgs';
import type { Candidate } from './sources';

function survey(name: string, year: number | null, densityM2?: number, start?: string): Ranked {
  const candidate: Candidate = {
    provider: 'Test',
    id: name,
    name,
    url: `https://example.com/${name}`,
    format: 'EPT',
    coverage: [],
    attribution: name,
    sourcePage: 'https://example.com',
    projectYearHint: year,
    acquisitionStart: start,
    densityM2,
  };
  return { candidate, coverage: [], catalogCoverage: 1 };
}

const names = (list: Ranked[]) => list.map((r) => r.candidate.name);

describe('workUnitYear', () => {
  it("reads 3DEP work units' years, and nothing else", () => {
    expect(workUnitYear('CA_SanFrancisco_1_B23')).toBe(2023);
    expect(workUnitYear('KY_Western_1_A22')).toBe(2022);
    expect(workUnitYear('AK_TyphoonMerbokNV5_1_F23')).toBe(2023);
    expect(workUnitYear('KY_FullState')).toBe(null);
    expect(workUnitYear('MA_NE_CMGP_Sandy_Z19_A1_2015')).toBe(null);
    expect(workUnitYear('NY_Zone_Z18')).toBe(null);
  });
});

describe('rankSurveys', () => {
  it('puts a much denser survey ahead of one flown a little later', () => {
    // San Francisco: USGS's 2023 work unit against NOAA's 2025 Bay-Delta survey.
    const usgs = survey('CA_SanFrancisco_1_B23', 2023, 61.7);
    const noaa = survey('Bay-Delta', 2025, 19.6, '2025-08-22');
    expect(names(rankSurveys([noaa, usgs]))).toEqual(['CA_SanFrancisco_1_B23', 'Bay-Delta']);
  });

  it('keeps the newer survey when it is five years newer, or not that much sparser', () => {
    expect(names(rankSurveys([survey('old', 2015, 40), survey('new', 2021, 10)]))).toEqual(['new', 'old']);
    expect(names(rankSurveys([survey('old', 2020, 15), survey('new', 2022, 8)]))).toEqual(['new', 'old']);
    // King County's 2016-17 survey against the 2021 one: twice as dense over its outline, not 2.5 times.
    expect(names(rankSurveys([survey('PSLC', 2016, 26.5, '2016-02-24'), survey('WA_KingCo_1_2021', 2021, 12.4)]))).toEqual(['WA_KingCo_1_2021', 'PSLC']);
    // 2.5 times as dense but not two returns per m² more.
    expect(names(rankSurveys([survey('old', 2020, 3), survey('new', 2022, 1.2)]))).toEqual(['new', 'old']);
  });

  it('only moves surveys whose densities and years are both known', () => {
    expect(names(rankSurveys([survey('old', 2020), survey('new', 2022, 5)]))).toEqual(['new', 'old']);
    expect(names(rankSurveys([survey('old', 2020, 50), survey('new', 2022)]))).toEqual(['new', 'old']);
    expect(names(rankSurveys([survey('undated', null, 80), survey('new', 2022, 5)]))).toEqual(['new', 'undated']);
  });

  it('gives one order for surveys that beat each other in a circle, whatever order they came in', () => {
    // b beats a and c beats b, but a is six years newer than c.
    const [a, b, c] = [survey('a', 2025, 4), survey('b', 2022, 11), survey('c', 2019, 30)];
    for (const list of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
      expect(names(rankSurveys(list))).toEqual(['b', 'a', 'c']);
    }
  });

  it('only moves a survey within its group', () => {
    const partial = { ...survey('partial', 2023, 60), catalogCoverage: 0.5 };
    const whole = survey('whole', 2025, 20);
    const tier = (r: Ranked) => (r.catalogCoverage >= 0.99 ? 0 : 1);
    const ranked = rankSurveys([partial, whole], (x, y) => tier(x) - tier(y), (x, y) => tier(x) === tier(y));
    expect(names(ranked)).toEqual(['whole', 'partial']);
  });
});

describe('chosenFirst', () => {
  it('moves the picked survey to the front by URL or name, and leaves the list alone otherwise', () => {
    const list = [survey('a', 2024), survey('b', 2020), survey('c', 2018)];
    expect(names(chosenFirst(list, 'https://example.com/c'))).toEqual(['c', 'a', 'b']);
    expect(names(chosenFirst(list, 'b'))).toEqual(['b', 'a', 'c']);
    expect(chosenFirst(list, 'https://example.com/missing')).toBe(list);
    expect(chosenFirst(list, '')).toBe(list);
    expect(chosenFirst(list, undefined)).toBe(list);
  });
});
