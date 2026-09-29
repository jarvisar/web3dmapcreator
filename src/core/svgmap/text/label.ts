// Title layout, from the original plaque. Box is one line in a bordered box in
// a corner or centred at the top or bottom. Band is a full-width strip with a
// title, optional subtitle and optional divider. Either way the map under it is
// removed. Text only ever scales uniformly to fit.
import type { Path, Point } from '../lines/geometry';
import { type Shape, insetShape, shapeCentre, shapeContains } from '../layout/shapes';
import type { Layout } from '../layout/layout';
import { type LoadedFont, type TextGeometry, geometryBounds, textGeometry } from './outline';

export type LabelPosition = 'lower_right' | 'lower_left' | 'upper_right' | 'upper_left' | 'lower_center' | 'upper_center';

export interface LabelSettings {
  enabled: boolean;
  text: string;
  subtitle: string;
  style: 'box' | 'band';
  font: string;
  subtitleFont: string;
  // Percent. Scales the lettering, and for the box also the padding and outline.
  size: number;
  // Box
  position: LabelPosition;
  rotation: 0 | 90 | 180 | 270;
  textHeight: number;
  maxWidth: number;
  textScale: number;
  paddingX: number;
  paddingY: number;
  borderWidth: number;
  boxBorder: boolean;
  gap: number;
  // Band
  bandPosition: 'bottom' | 'top';
  bandHeight: number;
  bandAlign: 'left' | 'center' | 'right';
  titleHeight: number;
  bandMaxWidth: number;
  titleSpacing: number;
  bandPaddingX: number;
  bandPaddingY: number;
  subtitleHeight: number;
  subtitleSpacing: number;
  subtitleGap: number;
  divider: boolean;
  dividerWidth: number;
  dividerInset: number;
}

export const DEFAULT_LABEL: LabelSettings = {
  enabled: true,
  text: 'CHICAGO',
  subtitle: '',
  style: 'box',
  font: 'montserrat',
  subtitleFont: '',
  size: 100,
  position: 'lower_right',
  rotation: 0,
  textHeight: 7.776,
  maxWidth: 77.76,
  textScale: 0.95,
  paddingX: 1.98,
  paddingY: 1.548,
  borderWidth: 0.25,
  boxBorder: true,
  gap: 1.0,
  bandPosition: 'bottom',
  bandHeight: 20,
  bandAlign: 'center',
  titleHeight: 7,
  bandMaxWidth: 90,
  titleSpacing: 1,
  bandPaddingX: 3,
  bandPaddingY: 2,
  subtitleHeight: 2,
  subtitleSpacing: 1.2,
  subtitleGap: 2,
  divider: true,
  dividerWidth: 0.1,
  dividerInset: 0,
};

export interface LabelArtwork {
  // Region removed from the map, [x, y, w, h].
  knockout: [number, number, number, number];
  text: TextGeometry;
  // Box outline or band divider.
  frame: Path[];
  frameWidth: number;
}

export class LabelError extends Error {}

function place(g: TextGeometry, transform: (p: Point) => Point): TextGeometry {
  return {
    rings: g.rings.map((r) => r.map(transform)),
    strokes: g.strokes.map((s) => s.map(transform)),
  };
}

function mergeGeometry(a: TextGeometry, b: TextGeometry | null): TextGeometry {
  if (!b) return a;
  return { rings: [...a.rings, ...b.rings], strokes: [...a.strokes, ...b.strokes] };
}

// For round and rounded pieces, where a corner position can stick out.
function nudgeInside(limit: Shape, x: number, y: number, w: number, h: number): [number, number] | null {
  if (limit.kind === 'rect') return [x, y];
  const [cx, cy] = shapeCentre(limit);
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    const nx = x + (cx - (x + w / 2)) * t;
    const ny = y + (cy - (y + h / 2)) * t;
    const corners: Point[] = [
      [nx, ny],
      [nx + w, ny],
      [nx, ny + h],
      [nx + w, ny + h],
    ];
    if (corners.every((c) => shapeContains(limit, c))) return [nx, ny];
  }
  return null;
}

export function layoutBoxLabel(layout: Layout, s: LabelSettings, text: TextGeometry): LabelArtwork {
  const bounds = geometryBounds(text);
  if (!bounds) throw new LabelError('The title font has no visible letters for this text.');
  const [minX, minY, maxX, maxY] = bounds;
  const rawW = maxX - minX;
  const rawH = maxY - minY;
  const k = s.size / 100;
  const textHeight = s.textHeight * k;
  const maxWidth = s.maxWidth * k;
  const padX = s.paddingX * k;
  const padY = s.paddingY * k;
  const border = s.boxBorder ? s.borderWidth * k : 0;

  const boxScale = Math.min(textHeight / rawH, maxWidth / rawW);
  const textScale = boxScale * s.textScale;
  const textW = rawW * textScale;
  const textH = rawH * textScale;
  let boxW = rawW * boxScale + 2 * (padX + border);
  let boxH = rawH * boxScale + 2 * (padY + border);
  const rotation = ((s.rotation % 360) + 360) % 360;
  if (rotation === 90 || rotation === 270) [boxW, boxH] = [boxH, boxW];

  const anchor = layout.labelAnchor;
  const limit = insetShape(anchor, s.gap);
  const left0 = limit.x;
  const top0 = limit.y;
  const right0 = limit.x + limit.w - boxW;
  const bottom0 = limit.y + limit.h - boxH;
  const centreX = limit.x + (limit.w - boxW) / 2;
  const positions: Record<LabelPosition, [number, number]> = {
    lower_right: [right0, bottom0],
    lower_left: [left0, bottom0],
    upper_right: [right0, top0],
    upper_left: [left0, top0],
    lower_center: [centreX, bottom0],
    upper_center: [centreX, top0],
  };
  const start = positions[s.position] ?? positions.lower_right;
  const placed = nudgeInside(limit, start[0], start[1], boxW, boxH);
  if (!placed || boxW > limit.w || boxH > limit.h) {
    throw new LabelError('The title does not fit inside the border. Make it smaller or shorten the text.');
  }
  const [left, top] = placed;
  const cx = left + boxW / 2;
  const cy = top + boxH / 2;
  const cos = Math.round(Math.cos((rotation * Math.PI) / 180));
  const sin = Math.round(Math.sin((rotation * Math.PI) / 180));
  const lettering = place(text, ([x, y]) => {
    const ox = (x - minX) * textScale - textW / 2;
    const oy = (y - minY) * textScale - textH / 2;
    return [cx + ox * cos - oy * sin, cy + ox * sin + oy * cos];
  });
  const x2 = left + boxW;
  const y2 = top + boxH;
  // Four open segments instead of a closed path. Some laser software treats a
  // closed path as a shape to fill.
  const frame: Path[] = s.boxBorder
    ? [
        [
          [left, top],
          [x2, top],
        ],
        [
          [x2, top],
          [x2, y2],
        ],
        [
          [x2, y2],
          [left, y2],
        ],
        [
          [left, y2],
          [left, top],
        ],
      ]
    : [];
  return { knockout: [left, top, boxW, boxH], text: lettering, frame, frameWidth: border };
}

// Round and hexagonal pieces get narrower towards the edge.
function availableWidthAt(shape: Shape, y0: number, y1: number): [number, number] {
  if (shape.kind !== 'circle' && shape.kind !== 'hexagon') return [shape.x, shape.x + shape.w];
  const [cx, cy] = shapeCentre(shape);
  const d = Math.max(Math.abs(y0 - cy), Math.abs(y1 - cy));
  let half: number;
  if (shape.kind === 'hexagon') half = Math.max(0, shape.r - d / Math.sqrt(3));
  else half = d >= shape.r ? 0 : Math.sqrt(shape.r * shape.r - d * d);
  return [cx - half, cx + half];
}

export function layoutBandLabel(
  layout: Layout,
  s: LabelSettings,
  title: TextGeometry,
  subtitle: TextGeometry | null,
): LabelArtwork {
  const anchor = layout.bandAnchor;
  if (!(s.bandHeight >= 5 && s.bandHeight <= 50)) throw new LabelError('Band height must be between 5 and 50%.');
  const height = (anchor.h * s.bandHeight) / 100;
  const top = s.bandPosition === 'top' ? anchor.y : anchor.y + anchor.h - height;
  const edge = Math.max(layout.thinLine ? layout.thinWidth : 0, s.divider ? s.dividerWidth : 0) / 2;
  const padX = s.bandPaddingX + edge;
  const padY = s.bandPaddingY + edge;
  const k = s.size / 100;
  const gap = subtitle ? s.subtitleGap * k : 0;
  const availableH = height - 2 * padY;
  if (availableH <= gap) throw new LabelError('The title band has no room for text. Make it taller or reduce padding.');

  const lines: { g: TextGeometry; b: [number, number, number, number]; scale: number }[] = [];
  const fitWidth = (a: number, b: number) => ((b - a - 2 * padX) * s.bandMaxWidth) / 100;
  let widthLimit = fitWidth(anchor.x, anchor.x + anchor.w);
  for (const [g, target] of [
    [title, s.titleHeight * k],
    [subtitle, s.subtitleHeight * k],
  ] as const) {
    if (!g) continue;
    const b = geometryBounds(g);
    if (!b) continue;
    lines.push({ g, b, scale: target / (b[3] - b[1]) });
  }
  if (lines.length === 0) throw new LabelError('The title needs at least one visible character.');

  // Shrinking the text moves it, which changes the width available on a round
  // piece, so fit a few times.
  let fit = 1;
  let blockTop = 0;
  let blockH = 0;
  for (let pass = 0; pass < 3; pass++) {
    const natural = lines.reduce((sum, l) => sum + (l.b[3] - l.b[1]) * l.scale, 0);
    fit = Math.min(1, (availableH - gap) / natural);
    for (const l of lines) {
      const w = (l.b[2] - l.b[0]) * l.scale * fit;
      if (w > widthLimit) fit *= widthLimit / w;
    }
    blockH = lines.reduce((sum, l) => sum + (l.b[3] - l.b[1]) * l.scale * fit, 0) + gap;
    blockTop = top + (height - blockH) / 2;
    const [a, b] = availableWidthAt(layout.window, blockTop, blockTop + blockH);
    widthLimit = Math.min(fitWidth(anchor.x, anchor.x + anchor.w), fitWidth(a, b));
    if (widthLimit <= 0) throw new LabelError('The title band is too narrow here for any text.');
  }

  let cursor = blockTop;
  let lettering: TextGeometry = { rings: [], strokes: [] };
  const [rowLeft, rowRight] = availableWidthAt(layout.window, blockTop, blockTop + blockH);
  const left = Math.max(anchor.x, rowLeft);
  const right = Math.min(anchor.x + anchor.w, rowRight);
  for (const l of lines) {
    const scale = l.scale * fit;
    const w = (l.b[2] - l.b[0]) * scale;
    const x =
      s.bandAlign === 'left' ? left + padX : s.bandAlign === 'right' ? right - padX - w : (left + right - w) / 2;
    const y = cursor;
    lettering = mergeGeometry(
      lettering,
      place(l.g, ([px, py]) => [x + (px - l.b[0]) * scale, y + (py - l.b[1]) * scale]),
    );
    cursor += (l.b[3] - l.b[1]) * scale + gap;
  }

  const frame: Path[] = [];
  if (s.divider) {
    const dy = s.bandPosition === 'top' ? top + height : top;
    const [a, b] = availableWidthAt(anchor, dy, dy);
    const x0 = Math.max(anchor.x, a) + s.dividerInset;
    const x1 = Math.min(anchor.x + anchor.w, b) - s.dividerInset;
    if (x1 > x0) {
      frame.push([
        [x0, dy],
        [x1, dy],
      ]);
    }
  }
  return { knockout: [anchor.x, top, anchor.w, height], text: lettering, frame, frameWidth: s.dividerWidth };
}

// artwork is null when the title is off or doesn't fit, and error says why.
export function buildLabel(
  layout: Layout,
  s: LabelSettings,
  title: LoadedFont | null,
  subtitle: LoadedFont | null,
): { artwork: LabelArtwork | null; error: string | null } {
  if (!s.enabled || !s.text.trim() || !title) return { artwork: null, error: null };
  try {
    if (s.style === 'band') {
      const main = textGeometry(title, s.text.trim(), s.titleSpacing);
      const sub = s.subtitle.trim() ? textGeometry(subtitle ?? title, s.subtitle.trim(), s.subtitleSpacing) : null;
      return { artwork: layoutBandLabel(layout, s, main, sub), error: null };
    }
    return { artwork: layoutBoxLabel(layout, s, textGeometry(title, s.text.trim(), 1)), error: null };
  } catch (error) {
    if (error instanceof LabelError) return { artwork: null, error: error.message };
    throw error;
  }
}
