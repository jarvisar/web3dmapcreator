// A render's output. The SVG writer and the preview both draw from this.
import type { CleanupStats } from './lines/cleanup';
import type { LonLatLine, PickLines } from './routes';
import type { ElementId, OutputMode } from './settings';

export interface OutputPath {
  d: string;
  // Overrides the group's stroke width, for print road classes.
  strokeWidth?: number;
  cls?: string;
}

export interface OutputGroup {
  id: string;
  element: ElementId;
  label: string;
  kind: 'fill' | 'stroke';
  color: string;
  strokeWidth: number;
  paths: OutputPath[];
  subpaths: number;
  lengthMm: number;
  areaMm2: number;
}

export interface PlotterStats {
  penDownMm: number;
  penUpMm: number;
  penUpUnorderedMm: number;
  pens: number;
}

export interface RenderStats {
  zoom: number;
  tiles: number;
  // Tiles that could not be downloaded, so the map has holes.
  missingTiles: number;
  bytes: number;
  cleanup: CleanupStats | null;
  // Share of the road linework kept after cleanup, 0 to 1.
  coverage: number | null;
  plotter: PlotterStats | null;
  timings: Record<string, number>;
}

export interface RenderMeta {
  title: string;
  centre: { lon: number; lat: number };
  bearing: number;
  // Map window size on the ground, metres.
  widthM: number;
  heightM: number;
  // 1 : scale
  scale: number;
  attribution: string;
  generated: string;
}

export interface RenderResult {
  // Canvas size, mm.
  width: number;
  height: number;
  outline: string;
  mode: OutputMode;
  background: string | null;
  groups: OutputGroup[];
  stats: RenderStats;
  warnings: string[];
  meta: RenderMeta;
  /** Road lines the preview can pick. */
  pick?: PickLines;
  /** Picked roads (route or left out) that nothing on this map matched. */
  missingPicks?: LonLatLine[];
}
