import { describe, expect, it, vi } from 'vitest';
import { chosenFirst } from './choice';
import { effectiveCell, orderSurveys, pickNote, rankSurveys, type Ranked, type SurveyProbe, type SurveyRules } from './ranking';
import { workUnitYear } from './sources/usgs';
import type { Candidate } from './sources';

function survey(name: string, year: number | null, density?: number, start?: string): Ranked {
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
  };
  return { candidate, coverage: [], catalogCoverage: 1, localDensity: density };
}

const names = (list: Ranked[]) => list.map((r) => r.candidate.name);
const balanced = (cellM = 0.71, years = 5): SurveyRules => ({ preference: 'balanced', years, cellM });

// Densities from the surveys' hierarchies in San Francisco (lab, October 2026).
const usgs = (density: number) => survey('CA_SanFrancisco_1_B23', 2023, density);
const noaa = (density: number) => survey('Bay-Delta', 2025, density, '2025-08-22');

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

describe('effectiveCell', () => {
  it('works the cell out from the density, never finer than asked', () => {
    expect(effectiveCell(survey('a', 2020, 16), 0.25)).toBeCloseTo(0.5, 6);
    expect(effectiveCell(survey('a', 2020, 16), 0.71)).toBe(0.71);
    expect(effectiveCell(survey('a', 2020), 0.71)).toBe(null);
  });

  it('takes what a probe measured over the density', () => {
    const gappy = { ...survey('a', 2020, 30), probe: { requested: 0.71, cell: 1.55, density: 17.7 } };
    expect(effectiveCell(gappy, 0.71)).toBe(1.55);
    expect(effectiveCell(gappy, 2)).toBe(2);
    const filled = { ...survey('a', 2020, 4), probe: { requested: 0.71, cell: 0.71, density: 4 } };
    expect(effectiveCell(filled, 1)).toBe(1);
    // Finer than it was probed at: the estimate, but no coarser than what it filled.
    expect(effectiveCell(filled, 0.25)).toBe(0.71);
    expect(effectiveCell({ ...filled, probe: { requested: 0.71, cell: 0.71, density: 64 } }, 0.25)).toBe(0.25);
  });
});

describe('rankSurveys', () => {
  it('keeps the newest survey where it fills the cells', () => {
    // The Mission: NOAA's 2025 survey at 19 per m² fills 0.71 m cells as well as USGS's 87 do.
    expect(names(rankSurveys([usgs(87), noaa(19)], balanced(0.71)))).toEqual(['Bay-Delta', 'CA_SanFrancisco_1_B23']);
  });

  it('puts an older survey first where the newest is too sparse for the cells', () => {
    expect(names(rankSurveys([noaa(19), usgs(87)], balanced(0.25)))).toEqual(['CA_SanFrancisco_1_B23', 'Bay-Delta']);
  });

  it('allows the years given, or twice that for cells half the size', () => {
    // 7 years older and cells 1.8 times finer: only with the years raised.
    const [old, recent] = [survey('old', 2015, 87), survey('new', 2022, 19)];
    expect(names(rankSurveys([old, recent], balanced(0.25, 5)))).toEqual(['new', 'old']);
    expect(names(rankSurveys([old, recent], balanced(0.25, 7)))).toEqual(['old', 'new']);
    // Twice as fine goes up to ten years at the default five, not past it.
    const sparse = survey('sparse', 2022, 1.5);
    expect(names(rankSurveys([sparse, survey('2014', 2014, 20)], balanced(0.71)))).toEqual(['2014', 'sparse']);
    expect(names(rankSurveys([sparse, survey('2010', 2010, 20)], balanced(0.71)))).toEqual(['sparse', '2010']);
  });

  it('leaves the newest first for small differences', () => {
    // Downtown Seattle: King County's 2016-17 survey has 14 per m², 2021's 11.
    const ranked = rankSurveys([survey('PSLC', 2016, 14, '2016-02-24'), survey('WA_KingCo_1_2021', 2021, 11.4)], balanced(0.25));
    expect(names(ranked)).toEqual(['WA_KingCo_1_2021', 'PSLC']);
  });

  it('goes by what was measured where a survey was probed', () => {
    // The Financial District: NOAA's 2025 survey has 30 per m² by its hierarchy but only filled 1.55 m cells.
    const [a, b] = [noaa(30), usgs(150)];
    expect(names(rankSurveys([a, b], balanced(0.71)))).toEqual(['Bay-Delta', 'CA_SanFrancisco_1_B23']);
    a.probe = { requested: 0.71, cell: 1.55, density: 17.7 };
    b.probe = { requested: 0.71, cell: 0.71, density: 117 };
    expect(names(rankSurveys([a, b], balanced(0.71)))).toEqual(['CA_SanFrancisco_1_B23', 'Bay-Delta']);
  });

  it('only moves dated surveys with a known density', () => {
    expect(names(rankSurveys([survey('old', 2020), survey('new', 2022, 1)], balanced()))).toEqual(['new', 'old']);
    expect(names(rankSurveys([survey('old', 2020, 50), survey('new', 2022)], balanced()))).toEqual(['new', 'old']);
    expect(names(rankSurveys([survey('undated', null, 80), survey('new', 2022, 1)], balanced()))).toEqual(['new', 'undated']);
  });

  it('never moves anything for the newest, and takes the densest for the most detail', () => {
    const list = [survey('old', 2010, 15), survey('new', 2025, 4)];
    expect(names(rankSurveys(list, { preference: 'newest', years: 5, cellM: 0.25 }))).toEqual(['new', 'old']);
    // Most detail compares at the finest cell whatever the model's, and any age.
    expect(names(rankSurveys(list, { preference: 'detail', years: 5, cellM: 1.5 }))).toEqual(['old', 'new']);
    expect(names(rankSurveys([survey('old', 2010, 15), survey('new', 2025, 12)], { preference: 'detail', years: 5, cellM: 1.5 }))).toEqual(['new', 'old']);
  });

  it('gives one order for surveys that beat each other in a circle, whatever order they came in', () => {
    // At 0.25 m: b beats a (3 years, 1.4 times finer) and c beats b (5 years,
    // 1.28), but c is 8 years older than a and not twice as fine.
    const [a, b, c] = [survey('a', 2025, 8.16), survey('b', 2022, 16), survey('c', 2017, 26)];
    for (const list of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
      expect(names(rankSurveys(list, balanced(0.25)))).toEqual(['b', 'a', 'c']);
    }
  });

  it('only moves a survey within its group', () => {
    const partial = { ...survey('partial', 2023, 60), catalogCoverage: 0.5 };
    const whole = survey('whole', 2025, 1);
    const tier = (r: Ranked) => (r.catalogCoverage >= 0.99 ? 0 : 1);
    const ranked = rankSurveys([partial, whole], balanced(0.25), (x, y) => tier(x) - tier(y), (x, y) => tier(x) === tier(y));
    expect(names(ranked)).toEqual(['whole', 'partial']);
  });
});

describe('orderSurveys', () => {
  const probes = (table: Record<string, Omit<SurveyProbe, 'requested'> | null>, requested = 0.71) =>
    vi.fn(async (r: Ranked) => {
      const found = table[r.candidate.name];
      return found ? { requested, ...found } : null;
    });

  it('measures the newest only when a clearly denser survey could take its place', async () => {
    const probe = probes({});
    await orderSurveys([survey('PSLC', 2016, 14), survey('WA_KingCo_1_2021', 2021, 11.4)], balanced(), { probe });
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps the newest when it fills the cells, without measuring the others', async () => {
    const probe = probes({ 'Bay-Delta': { cell: 0.71, density: 23.8 } });
    const order = await orderSurveys([usgs(87), noaa(19)], balanced(), { probe });
    expect(names(order)).toEqual(['Bay-Delta', 'CA_SanFrancisco_1_B23']);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(pickNote(order, balanced())).toBe('CA_SanFrancisco_1_B23 (2023) is denser, but this newer one fills the 0.71 m cells near the middle of the area.');
  });

  it('measures the denser ones when the newest leaves holes, and says why the order changed', async () => {
    const probe = probes({ 'Bay-Delta': { cell: 1.55, density: 17.7 }, CA_SanFrancisco_1_B23: { cell: 0.71, density: 117 } });
    const order = await orderSurveys([noaa(30), usgs(150), survey('2010', 2010, 13)], balanced(), { probe });
    expect(names(order)).toEqual(['CA_SanFrancisco_1_B23', 'Bay-Delta', '2010']);
    // The 2010 survey is past twice the years, so it isn't measured.
    expect(probe.mock.calls.map(([r]) => r.candidate.name)).toEqual(['Bay-Delta', 'CA_SanFrancisco_1_B23']);
    expect(pickNote(order, balanced())).toBe('The newer Bay-Delta (2025) only filled 1.55 m cells near the middle of the area, where this one fills the 0.71 m asked for.');
  });

  it('goes by the densities when the newest could not be measured, and never probes for other preferences', async () => {
    const probe = probes({});
    expect(names(await orderSurveys([noaa(30), usgs(150)], balanced(), { probe }))).toEqual(['Bay-Delta', 'CA_SanFrancisco_1_B23']);
    expect(probe).toHaveBeenCalledTimes(1);
    const unused = probes({});
    await orderSurveys([noaa(30), usgs(150)], { preference: 'detail', years: 5, cellM: 0.71 }, { probe: unused });
    await orderSurveys([noaa(30), usgs(150)], { preference: 'newest', years: 5, cellM: 0.71 }, { probe: unused });
    expect(unused).not.toHaveBeenCalled();
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
