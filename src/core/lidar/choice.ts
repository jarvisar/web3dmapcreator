// Picking a survey by hand. The chosen one goes first and the others stay
// behind it in their usual order, so they still fill in where it doesn't
// reach and a model never has a hole because of the choice.

import { staged, surveyYear } from './offers';
import type { Ranked } from './prepare';
import type { Candidate, Format } from './sources';

/** A survey found over an area, for picking one. */
export interface SurveyChoice {
  /** What `settings.lidar.survey` holds when it's picked. */
  url: string;
  name: string;
  provider: string;
  year: number | null;
  densityM2?: number;
  format: Format;
  /** Share of the area its outline covers. */
  coverage: number;
  /** Only comes as whole files, downloaded once the user agrees. */
  staged: boolean;
}

export function surveyChoice(r: Ranked): SurveyChoice {
  const c = r.candidate;
  return { url: c.url, name: c.name, provider: c.provider, year: surveyYear(c), densityM2: c.densityM2, format: c.format, coverage: Math.min(1, r.catalogCoverage), staged: staged(c) };
}

/** Whether `survey` names this one: its URL, or for the CLI its name. */
export function isChosen(c: Candidate, survey: string | undefined): boolean {
  return Boolean(survey) && (c.url === survey || c.name === survey);
}

/** `list` with the chosen survey moved to the front, if it's there. */
export function chosenFirst(list: Ranked[], survey: string | undefined): Ranked[] {
  const at = list.findIndex((r) => isChosen(r.candidate, survey));
  return at <= 0 ? list : [list[at], ...list.slice(0, at), ...list.slice(at + 1)];
}
