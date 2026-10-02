// Messages between the UI and the generation worker.

import type { ViewerGround as GroundGrid } from '../edit/ground';
import type { RoadLines } from '../edit/lines';
import type { EditUpdate, ObjectFacts } from '../edit/session';
import type { SurveyChoice } from '../lidar/choice';
import type { SurveyQuery } from '../lidar/query';
import type { LidarOffer } from '../lidar/offers';
import type { ModelEdits } from '../edit/types';
import type { TrackLines } from '../tracks/track';
import type { AreaSpec, ExportFormat, ModelSettings, Palette } from '../settings';
import type { MeshPart, ModelStats } from '../types';

export type { EditUpdate, GroundGrid, LidarOffer, ObjectFacts, RoadLines, SurveyChoice };

export interface GenerateRequest {
  area: AreaSpec;
  settings: ModelSettings;
  /** Applied as soon as the model is built, so it never shows without them. */
  edits?: ModelEdits;
  editsVersion?: number;
  /** Where the app is served from, to load fonts for text shapes. */
  baseUrl?: string;
  /** The most cells a LiDAR only grid given in metres may have on this machine (fixedCellLimit). */
  maxCells?: number;
  /** Offered LiDAR tiles the user just agreed to download (LidarOffer.tiles). The worker remembers them with the LiDAR cache. */
  approveTiles?: string[];
  /** How long work took here against the estimates, from the last job (GenerateResult.speed). */
  speed?: number;
  /** Imported routes to build, the visible ones, decoded. */
  tracks?: TrackLines[];
}

export interface EditRequest {
  edits: ModelEdits;
  version: number;
  baseUrl?: string;
}

/** The steps a job's progress is planned in (`Progress.plan`), in the order they run. */
export type Stage =
  // Map models
  | 'data'
  | 'surveys'
  | 'lidar'
  | 'grid'
  | 'water'
  | 'roads'
  | 'tidy'
  | 'ribbons'
  | 'bridges'
  | 'buildings'
  | 'footprints'
  | 'land'
  | 'close'
  | 'trees'
  // Imported routes, in both kinds of model
  | 'routes'
  // LiDAR only models, after 'surveys' and 'lidar'
  | 'mapwater'
  | 'compose'
  | 'surface'
  | 'cut'
  // Both
  | 'mesh'
  | 'session'
  // Exports
  | 'plates'
  | 'write';

export interface ProgressEvent {
  stage: Stage;
  /** Short sentence for the UI, e.g. "Downloading buildings". */
  label: string;
  /** Overall progress, 0 to 1. Never goes down during a job. */
  fraction: number;
  /** Extra detail such as "3.2 MB" or "1,204 buildings". */
  detail?: string;
  /** Seconds the job should still take, when there's enough to go on. */
  remaining?: number;
}

export interface GenerateResult {
  parts: MeshPart[];
  /** minX, minY, minZ, maxX, maxY, maxZ in model mm. */
  bounds: [number, number, number, number, number, number];
  mmPerMetre: number;
  /** Overture release the data came from. */
  release: string;
  stats: ModelStats;
  warnings: string[];
  /** Seconds per phase. */
  timings: Record<string, number>;
  /** Seconds taken per second the progress plan expected, for the next request's estimates. */
  speed?: number;
  /** What LiDAR measured, when it was on. */
  lidar?: LidarSummary;
  /** What a LiDAR Only model was read from. */
  surface?: SurfaceSummary;
  /** Road centrelines, for picking and highlighting roads in the editor. */
  roads?: RoadLines;
  /** The ground's heights, for putting shapes on it. */
  ground?: GroundGrid;
  /** Objects the editor can select, by key. */
  objects?: Record<string, ObjectFacts>;
  /** The request's edits, applied. */
  edit?: EditUpdate;
  /** False when the model can't be edited at all. */
  editable?: boolean;
  /** Edit updates for this model carry this. */
  modelId?: number;
  /** Printed mm per real metre of building height, which building height edits are kept in. */
  buildingMmPerMetre?: number;
}

export interface SurfaceSummary {
  /** Grid cell used, and asked for, in metres. */
  cellM: number;
  requestedCellM: number;
  /** Share of the area with returns. */
  coverage: number;
  surveys: { name: string; provider: string; year: number | null; attribution: string; sourcePage: string }[];
  failures: string[];
  downloadedBytes: number;
  /** Every block came from an earlier read. */
  reused: boolean;
  /** Whole-file surveys that would fill or improve it, if the user downloads them. */
  offers: LidarOffer[];
  /** Every survey found under the area, in the order they'd be read without a choice. */
  found: SurveyChoice[];
}

export interface LidarSurvey {
  name: string;
  provider: string;
  buildings: number;
  attribution: string;
  sourcePage: string;
}

export interface LidarSummary {
  /** Buildings with a usable measurement. */
  measured: number;
  /** Buildings in the area that could have been measured. */
  candidates: number;
  /** Why the others kept their mapped shape, by reason. */
  skipped: Record<string, number>;
  surveys: LidarSurvey[];
  /** Surveys or providers that could not be read. */
  failures: string[];
  downloadedBytes: number;
  /** Everything came from an earlier preparation. */
  reused: boolean;
  /** Whole-file surveys that would measure more buildings, if the user downloads them. */
  offers: LidarOffer[];
  /** Every survey found under the area, in the order they'd be picked without a choice. */
  found: SurveyChoice[];
}

/** The surveys found under an area, for picking one (`settings.lidar.survey`). */
export interface SurveyList {
  surveys: SurveyChoice[];
  /** Catalogs that couldn't be searched. */
  failures: string[];
}

export interface ExportRequest {
  format: ExportFormat;
  printer: string;
  palette: Palette;
  multiPlate: boolean;
  sectionWidthMm: number;
  sectionHeightMm: number;
  /** File name without extension. */
  fileBase: string;
  /** Part ids left out of the export (hidden in the viewer). */
  excludeParts?: string[];
  /** Edits to export the model with. */
  edits?: ModelEdits;
}

export interface ExportResult {
  fileName: string;
  /** The file, with its MIME type. A Blob posts from the worker without copying its bytes. */
  data: Blob;
  plates: number;
  warnings: string[];
  /** Pieces that could not be meshed and are missing from the file. */
  missing?: number;
}

export type ToWorker =
  | { type: 'generate'; id: number; request: GenerateRequest }
  | { type: 'export'; id: number; request: ExportRequest }
  | { type: 'edit'; id: number; request: EditRequest }
  | { type: 'surveys'; id: number; query: SurveyQuery }
  | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'progress'; id: number; progress: ProgressEvent }
  | { type: 'generated'; id: number; result: GenerateResult }
  | { type: 'exported'; id: number; result: ExportResult }
  | { type: 'edited'; id: number; update: EditUpdate }
  | { type: 'surveys'; id: number; result: SurveyList }
  | { type: 'error'; id: number; message: string; cancelled?: boolean; offers?: LidarOffer[] }
  // A worker script this tab asked for didn't load, which means a newer version replaced it.
  | { type: 'outdated' };
