// What decides the order surveys are read in, from a model's settings. Apart
// from ranking.ts so the page can work it out without the point readers.

import { effectiveScale } from '../geo/area';
import { requestedCell } from '../dsm/grid';
import type { AreaSpec, ModelSettings, SurveyPreference } from '../settings';

export interface SurveyRules {
  preference: SurveyPreference;
  /** How much older a survey may be and still go first for its detail (twice that for twice the detail). */
  years: number;
  /** The model's grid cell, metres. */
  cellM: number;
}

/** What a survey search needs: the area, and what decides the order. */
export interface SurveyQuery {
  area: AreaSpec;
  rules: SurveyRules;
  /** Ones covering the whole area go first, as a LiDAR only model reads them. */
  tiered: boolean;
}

export function surveyRules(settings: ModelSettings, cellM: number): SurveyRules {
  return { preference: settings.lidar.surveyPreference, years: settings.lidar.olderYears, cellM };
}

/** The cell surveys are compared at: a LiDAR only model's grid, or the cells measured roofs are cut from. */
export function rankingCell(area: AreaSpec, settings: ModelSettings): number {
  const scale = effectiveScale(area, settings.scale);
  return settings.modelSource === 'lidar' ? requestedCell(settings.lidarModel, scale, area.widthM, area.heightM) : requestedCell(settings.lidarModel, scale, 0, 0);
}

export function surveyQuery(area: AreaSpec, settings: ModelSettings): SurveyQuery {
  return { area, rules: surveyRules(settings, rankingCell(area, settings)), tiered: settings.modelSource === 'lidar' };
}
