// Messages between the UI and the generation worker.

import type { ViewerGround as GroundGrid } from '../edit/ground';
import type { RoadLines } from '../edit/lines';
import type { EditUpdate, ObjectFacts } from '../edit/session';
import type { ModelEdits } from '../edit/types';
import type { AreaSpec, ExportFormat, ModelSettings, Palette } from '../settings';
import type { MeshPart, ModelStats } from '../types';

export type { EditUpdate, GroundGrid, ObjectFacts, RoadLines };

export interface GenerateRequest {
  area: AreaSpec;
  settings: ModelSettings;
  /** Applied as soon as the model is built, so it never shows without them. */
  edits?: ModelEdits;
  editsVersion?: number;
  /** Where the app is served from, to load fonts for text shapes. */
  baseUrl?: string;
}

export interface EditRequest {
  edits: ModelEdits;
  version: number;
  baseUrl?: string;
}

export type Stage =
  | 'data'
  | 'elevation'
  | 'terrain'
  | 'water'
  | 'land'
  | 'roads'
  | 'buildings'
  | 'trees'
  | 'lidar'
  | 'mesh'
  | 'export';

export interface ProgressEvent {
  stage: Stage;
  /** Short sentence for the UI, e.g. "Downloading buildings". */
  label: string;
  /** Overall progress, 0 to 1. */
  fraction: number;
  /** Extra detail such as "3.2 MB" or "1,204 buildings". */
  detail?: string;
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
  | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'progress'; id: number; progress: ProgressEvent }
  | { type: 'generated'; id: number; result: GenerateResult }
  | { type: 'exported'; id: number; result: ExportResult }
  | { type: 'edited'; id: number; update: EditUpdate }
  | { type: 'error'; id: number; message: string; cancelled?: boolean };
