// Title layout, from the original plaque. Box is one line in a bordered box in
// a corner or centred at the top or bottom. Band is a full-width strip with a
// title, optional subtitle and optional divider. Either way the map under it is
// removed. Text only ever scales uniformly to fit.
import type { Path, Point } from '../lines/geometry';
import { insetShape } from '../layout/shapes';
import type { Layout } from '../layout/layout';
import { type LoadedFont, type TextGeometry, geometryBounds, textGeometry } from './outline';
import { boxCentres, nearestIn, regionSlice, rowsSpan } from './place';

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
  // Where the box was dragged to from its position, as a share of the space
  // inside the border. 0 leaves it where the position puts it.
  offsetX: number;
  offsetY: number;
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
  // The band's text dragged from where it's aligned, as a share of the band.
  bandOffsetX: number;
  bandOffsetY: number;
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
  offsetX: 0,
  offsetY: 0,
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
  bandOffsetX: 0,
  bandOffsetY: 0,
};

export interface LabelArtwork {
  // Region removed from the map, [x, y, w, h].
  knockout: [number, number, number, number];
  text: TextGeometry;
  // Box outline or band divider.
  frame: Path[];
  frameWidth: number;
  // The offset it ended up at once kept inside the border. A drag stores
  // this, so what's saved is what's drawn.
  offset: [number, number];
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
  const centres = boxCentres(limit, boxW, boxH);
  if (centres.length === 0) {
    throw new LabelError('The title does not fit inside the border. Make it smaller or shorten the text.');
  }
  const left0 = limit.x + boxW / 2;
  const top0 = limit.y + boxH / 2;
  const right0 = limit.x + limit.w - boxW / 2;
  const bottom0 = limit.y + limit.h - boxH / 2;
  const centreX = limit.x + limit.w / 2;
  const positions: Record<LabelPosition, Point> = {
    lower_right: [right0, bottom0],
    lower_left: [left0, bottom0],
    upper_right: [right0, top0],
    upper_left: [left0, top0],
    lower_center: [centreX, bottom0],
    upper_center: [centreX, top0],
  };
  // A corner of the bounding box is off a round or hexagonal piece, so the box
  // goes to the nearest spot that fits. Heading for the centre, as before,
  // left boxes floating mid-map.
  const start = positions[s.position] ?? positions.lower_right;
  let base: Point;
  if (limit.kind === 'circle') {
    // No flat edge to sit on, so the box's corner lands on the rim about 45
    // degrees round. Kept flush to the top or bottom, the corner boxes all but
    // met in the middle.
    base = nearestIn(centres, start)!;
  } else {
    // Flush along its long side if it fits there anywhere, so a box sits on a
    // hexagon's flat bottom and slides out of a rounded corner. Otherwise the
    // nearest spot, counted in box widths and heights so it stays near that
    // edge.
    const axis = boxW >= boxH ? 1 : 0;
    const along = regionSlice(centres, axis, start[axis]);
    if (along) {
      const other = Math.min(Math.max(start[1 - axis], along[0]), along[1]);
      base = axis === 1 ? [other, start[1]] : [start[0], other];
    } else {
      base = nearestIn(centres, start, 1 / boxW, 1 / boxH)!;
    }
  }
  const moved = s.offsetX !== 0 || s.offsetY !== 0;
  const [cx, cy] = moved ? nearestIn(centres, [base[0] + s.offsetX * anchor.w, base[1] + s.offsetY * anchor.h])! : base;
  const left = cx - boxW / 2;
  const top = cy - boxH / 2;
  const offset: [number, number] = moved ? [(cx - base[0]) / anchor.w, (cy - base[1]) / anchor.h] : [0, 0];

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
  return { knockout: [left, top, boxW, boxH], text: lettering, frame, frameWidth: border, offset };
}

// Rows the band fit tries. A 20 mm band gets them 0.1 mm apart.
const BAND_ROWS = 200;

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
  const align = s.bandAlign === 'left' ? 0 : s.bandAlign === 'right' ? 1 : 0.5;
  const window = layout.window;
  const rowsFrom = top + padY;
  const rowsTo = top + height - padY;
  const naturalH = lines.reduce((sum, l) => sum + (l.b[3] - l.b[1]) * l.scale, 0);
  const blockWidth = (fit: number) => Math.max(...lines.map((l) => (l.b[2] - l.b[0]) * l.scale * fit));

  // The range the text's left edge can take with the text at fit and its top
  // at y, or null when a line doesn't fit. Each line is held to its own rows,
  // so on a round piece a title isn't held to the narrower rows under its
  // subtitle.
  const slot = (fit: number, y: number): [number, number] | null => {
    const w = blockWidth(fit);
    let lo = -Infinity;
    let hi = Infinity;
    let cursor = y;
    for (const l of lines) {
      const lw = (l.b[2] - l.b[0]) * l.scale * fit;
      const lh = (l.b[3] - l.b[1]) * l.scale * fit;
      const span = rowsSpan(window, cursor, cursor + lh);
      if (!span) return null;
      const from = Math.max(span[0], anchor.x) + padX;
      const to = Math.min(span[1], anchor.x + anchor.w) - padX;
      if (lw > ((to - from) * s.bandMaxWidth) / 100 + 1e-9) return null;
      const shift = align * (w - lw);
      lo = Math.max(lo, from - shift);
      hi = Math.min(hi, to - lw - shift);
      cursor += lh + gap;
    }
    if (cursor - gap > rowsTo + 1e-9 || lo > hi + 1e-9) return null;
    return [lo, Math.max(lo, hi)];
  };
  // First and last top the text fits at, or null.
  const tops = (fit: number): [number, number] | null => {
    const last = rowsTo - (naturalH * fit + gap);
    if (last < rowsFrom - 1e-9) return null;
    const at = (i: number) => rowsFrom + ((last - rowsFrom) * i) / BAND_ROWS;
    let first = -1;
    let end = -1;
    for (let i = 0; i <= BAND_ROWS; i++) {
      if (!slot(fit, at(i))) continue;
      if (first < 0) first = i;
      end = i;
    }
    if (first < 0) return null;
    const edgeOf = (inside: number, outside: number) => {
      let a = at(inside);
      let b = at(outside);
      for (let i = 0; i < 20; i++) {
        const m = (a + b) / 2;
        if (slot(fit, m)) a = m;
        else b = m;
      }
      return a;
    };
    return [first > 0 ? edgeOf(first, first - 1) : at(first), end < BAND_ROWS ? edgeOf(end, end + 1) : at(end)];
  };

  // The largest text, up to the set heights, that fits somewhere in the band.
  // On a round piece that's by the band's straight edge.
  const widest = Math.min(window.w, anchor.w) - 2 * padX;
  let fit = Math.min(1, (availableH - gap) / naturalH, (widest * s.bandMaxWidth) / 100 / blockWidth(1));
  if (!(fit > 0)) throw new LabelError('The title band is too narrow here for any text.');
  if (!tops(fit)) {
    let lo = 0;
    let hi = fit;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      if (tops(m)) lo = m;
      else hi = m;
    }
    fit = lo;
  }
  const range = fit > 1e-6 ? tops(fit) : null;
  if (!range) throw new LabelError('The title band is too narrow here for any text.');

  // Centred in the rows it fits in, then aligned across them.
  const w = blockWidth(fit);
  const baseY = (range[0] + range[1]) / 2;
  const [lo, hi] = slot(fit, baseY) ?? slot(fit, range[0])!;
  const middle = window.x + window.w / 2 - w / 2;
  const baseX = align === 0 ? lo : align === 1 ? hi : Math.min(Math.max(middle, lo), hi);
  let x = baseX;
  let y = baseY;
  if (s.bandOffsetX !== 0 || s.bandOffsetY !== 0) {
    // The nearest spot to where it was dragged that it still fits.
    const tx = baseX + s.bandOffsetX * anchor.w;
    const ty = baseY + s.bandOffsetY * height;
    const clampedY = Math.min(Math.max(ty, range[0]), range[1]);
    let best = Infinity;
    for (let i = -1; i <= BAND_ROWS; i++) {
      const ry = i < 0 ? clampedY : range[0] + ((range[1] - range[0]) * i) / BAND_ROWS;
      const span = slot(fit, ry);
      if (!span) continue;
      const rx = Math.min(Math.max(tx, span[0]), span[1]);
      const d = (rx - tx) ** 2 + (ry - ty) ** 2;
      if (d < best - 1e-12) {
        best = d;
        x = rx;
        y = ry;
      }
    }
  }

  let cursor = y;
  let lettering: TextGeometry = { rings: [], strokes: [] };
  for (const l of lines) {
    const scale = l.scale * fit;
    const lx = x + align * (w - (l.b[2] - l.b[0]) * scale);
    const ly = cursor;
    lettering = mergeGeometry(
      lettering,
      place(l.g, ([px, py]) => [lx + (px - l.b[0]) * scale, ly + (py - l.b[1]) * scale]),
    );
    cursor += (l.b[3] - l.b[1]) * scale + gap;
  }

  const frame: Path[] = [];
  if (s.divider) {
    const dy = s.bandPosition === 'top' ? top + height : top;
    const span = rowsSpan(anchor, dy, dy);
    const x0 = Math.max(anchor.x, span ? span[0] : anchor.x) + s.dividerInset;
    const x1 = Math.min(anchor.x + anchor.w, span ? span[1] : anchor.x + anchor.w) - s.dividerInset;
    if (x1 > x0) {
      frame.push([
        [x0, dy],
        [x1, dy],
      ]);
    }
  }
  return {
    knockout: [anchor.x, top, anchor.w, height],
    text: lettering,
    frame,
    frameWidth: s.dividerWidth,
    offset: [(x - baseX) / anchor.w, (y - baseY) / height],
  };
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
