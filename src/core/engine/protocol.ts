// Messages between the UI and the generation worker.

import type { AreaSpec, ExportFormat, ModelSettings, Palette } from '../settings';
import type { MeshPart, ModelStats } from '../types';

export interface GenerateRequest {
  area: AreaSpec;
  settings: ModelSettings;
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
}

export interface ExportResult {
  fileName: string;
  mime: string;
  data: Uint8Array;
  plates: number;
  warnings: string[];
}

export type ToWorker =
  | { type: 'generate'; id: number; request: GenerateRequest }
  | { type: 'export'; id: number; request: ExportRequest }
  | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'progress'; id: number; progress: ProgressEvent }
  | { type: 'generated'; id: number; result: GenerateResult }
  | { type: 'exported'; id: number; result: ExportResult }
  | { type: 'error'; id: number; message: string; cancelled?: boolean };
