// Moving and resizing the title by dragging it, on the map or in the preview.
// The offset is a share of the space inside the border (box) or of the band,
// so a moved title keeps roughly its place when the piece changes size.
//
// Handles on a box: corners scale the whole title (Size), sides set the box's
// width or height. On a band: the edge sets the band height, and the corners
// of the text scale it unless autofit is filling the band anyway.
import type { Layout } from '../../core/svgmap/layout/layout';
import { fieldRange } from '../../core/svgmap/limits';
import type { LabelArtwork, LabelSettings } from '../../core/svgmap/text/label';
import { geometryBounds } from '../../core/svgmap/text/outline';

type Point = [number, number];

const clampShare = (v: number) => Math.min(1, Math.max(-1, v));
const SIZE = fieldRange('label.size');
const BAND = fieldRange('label.bandHeight');
const clamp = (v: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, v));

export type TitleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'band' | 'text-nw' | 'text-ne' | 'text-se' | 'text-sw';
export type TitleGrip = TitleHandle | 'move';

export interface HandleSpot {
  id: TitleHandle;
  // Piece millimetres.
  x: number;
  y: number;
  // The way it pulls, for picking a resize cursor once it's on screen.
  dx: number;
  dy: number;
  label: string;
}

// Where each box handle sits as a share of the box, and its name. Corners
// first: they win when handles crowd together on a small title.
const BOX: Record<'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w', [number, number, string]> = {
  nw: [0, 0, 'top left corner'],
  ne: [1, 0, 'top right corner'],
  se: [1, 1, 'bottom right corner'],
  sw: [0, 1, 'bottom left corner'],
  n: [0.5, 0, 'top'],
  e: [1, 0.5, 'right side'],
  s: [0.5, 1, 'bottom'],
  w: [0, 0.5, 'left side'],
};
const TEXT_CORNERS: ['text-nw' | 'text-ne' | 'text-se' | 'text-sw', number, number, string][] = [
  ['text-nw', 0, 0, 'top left'],
  ['text-ne', 1, 0, 'top right'],
  ['text-se', 1, 1, 'bottom right'],
  ['text-sw', 0, 1, 'bottom left'],
];

export function titleHandles(label: LabelSettings, artwork: LabelArtwork): HandleSpot[] {
  const [x, y, w, h] = artwork.knockout;
  if (label.style === 'box') {
    return (Object.keys(BOX) as (keyof typeof BOX)[]).map((id) => {
      const [fx, fy, name] = BOX[id];
      return { id, x: x + fx * w, y: y + fy * h, dx: fx - 0.5, dy: fy - 0.5, label: `Resize the title from its ${name}` };
    });
  }
  const top = label.bandPosition === 'top';
  const spots: HandleSpot[] = [{ id: 'band', x: x + w / 2, y: top ? y + h : y, dx: 0, dy: 1, label: 'Resize the band' }];
  const b = label.autofit ? null : geometryBounds(artwork.text);
  if (b) {
    for (const [id, fx, fy, name] of TEXT_CORNERS) {
      spots.push({ id, x: fx ? b[2] : b[0], y: fy ? b[3] : b[1], dx: fx - 0.5, dy: fy - 0.5, label: `Resize the text from its ${name} corner` });
    }
  }
  return spots;
}

// The handles to show, leaving out any closer than gap to one before it on
// screen. With every handle shown, a short box's side handles covered its
// corners and a drag meant to scale it grabbed a side.
export function spacedHandles(handles: HandleSpot[], toScreen: (x: number, y: number) => Point, gap: number): HandleSpot[] {
  const shown: { spot: HandleSpot; at: Point }[] = [];
  for (const spot of handles) {
    const at = toScreen(spot.x, spot.y);
    if (shown.every((s) => Math.hypot(s.at[0] - at[0], s.at[1] - at[1]) >= gap)) shown.push({ spot, at });
  }
  return shown.map((s) => s.spot);
}

// A resize cursor for a pull in this direction on screen, y down.
export function resizeCursor(dx: number, dy: number): string {
  const angle = (((Math.atan2(dy, dx) * 180) / Math.PI) % 180 + 180) % 180;
  if (angle < 22.5 || angle >= 157.5) return 'ew-resize';
  if (angle < 67.5) return 'nwse-resize';
  return angle < 112.5 ? 'ns-resize' : 'nesw-resize';
}

export function handleAt(handles: HandleSpot[], x: number, y: number, reach: number): TitleHandle | null {
  let best: TitleHandle | null = null;
  let bestD = reach * reach;
  for (const h of handles) {
    const d = (h.x - x) ** 2 + (h.y - y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = h.id;
    }
  }
  return best;
}

export function titleAt(artwork: LabelArtwork | null, x: number, y: number): boolean {
  if (!artwork) return false;
  const [kx, ky, kw, kh] = artwork.knockout;
  return x >= kx && x <= kx + kw && y >= ky && y <= ky + kh;
}

// The title moved by (dx, dy) piece millimetres from an offset of `from`.
export function draggedLabel(layout: Layout, label: LabelSettings, from: [number, number], dx: number, dy: number): LabelSettings {
  if (label.style === 'band') {
    const anchor = layout.bandAnchor;
    const height = (anchor.h * label.bandHeight) / 100;
    return { ...label, bandOffsetX: clampShare(from[0] + dx / anchor.w), bandOffsetY: clampShare(from[1] + dy / height) };
  }
  const anchor = layout.labelAnchor;
  return { ...label, offsetX: clampShare(from[0] + dx / anchor.w), offsetY: clampShare(from[1] + dy / anchor.h) };
}

// How much a drag of (dx, dy) on `grabbed` stretches it away from `fixed`,
// measured along the line between them.
function stretch(fixed: Point, grabbed: Point, dx: number, dy: number): number {
  const vx = grabbed[0] - fixed[0];
  const vy = grabbed[1] - fixed[1];
  const length = vx * vx + vy * vy;
  return length > 0 ? Math.max(0, ((vx + dx) * vx + (vy + dy) * vy) / length) : 1;
}

export interface TitleDrag {
  grip: TitleGrip;
  // The settings and layout when it was grabbed.
  label: LabelSettings;
  artwork: LabelArtwork;
}

// The title's settings after dragging a grip by (dx, dy) piece millimetres.
// layoutWith lays out a candidate, so a resized box can be moved back to keep
// its other side where it was.
export function dragTitle(
  layout: Layout,
  drag: TitleDrag,
  dx: number,
  dy: number,
  layoutWith: (label: LabelSettings) => LabelArtwork | null,
): LabelSettings {
  const { grip, label, artwork } = drag;
  if (grip === 'move') return draggedLabel(layout, label, artwork.offset, dx, dy);
  const [x, y, w, h] = artwork.knockout;
  if (grip === 'band') {
    const height = h + (label.bandPosition === 'top' ? dy : -dy);
    return { ...label, bandHeight: clamp(Math.round((height / layout.bandAnchor.h) * 1000) / 10, BAND) };
  }
  // Scaling starts from the size it's drawn at, which is under the set size
  // when it was shrunk to fit.
  const scaled = (factor: number) => clamp(Math.round(label.size * artwork.scale * factor), SIZE);
  if (grip === 'text-nw' || grip === 'text-ne' || grip === 'text-se' || grip === 'text-sw') {
    const b = geometryBounds(artwork.text);
    if (!b) return label;
    const corner: Point = [grip.endsWith('w') ? b[0] : b[2], grip.startsWith('text-n') ? b[1] : b[3]];
    return { ...label, size: scaled(stretch([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], corner, dx, dy)) };
  }

  const [fx, fy] = BOX[grip];
  let next: LabelSettings;
  if (fx !== 0.5 && fy !== 0.5) {
    next = { ...label, size: scaled(stretch([x + (1 - fx) * w, y + (1 - fy) * h], [x + fx * w, y + fy * h], dx, dy)) };
  } else {
    // Sides are stored along the text, so a turned box swaps them.
    const k = label.size / 100;
    const turned = label.rotation === 90 || label.rotation === 270;
    const border = label.boxBorder ? label.borderWidth : 0;
    // Leave the text half a millimetre inside the padding at least.
    const smallest = (padding: number) => 2 * (padding + border) * k + 0.5;
    const mm = (v: number) => Math.round((v / k) * 100) / 100;
    if (fy === 0.5) {
      const width = Math.max(smallest(turned ? label.paddingY : label.paddingX), w + (fx === 1 ? dx : -dx));
      next = turned ? { ...label, boxHeight: mm(width) } : { ...label, boxWidth: mm(width) };
    } else {
      const height = Math.max(smallest(turned ? label.paddingX : label.paddingY), h + (fy === 1 ? dy : -dy));
      next = turned ? { ...label, boxWidth: mm(height) } : { ...label, boxHeight: mm(height) };
    }
  }
  // Keep the opposite side or corner where it was. Across a side handle the
  // box stays where its position puts it, or one flush with the bottom
  // came away from it as its height followed the text.
  const placed = layoutWith(next);
  if (!placed) return next;
  const [nx, ny, nw, nh] = placed.knockout;
  const toX = fx === 1 ? x : fx === 0 ? x + w - nw : nx;
  const toY = fy === 1 ? y : fy === 0 ? y + h - nh : ny;
  return draggedLabel(layout, next, placed.offset, toX - nx, toY - ny);
}

// The offset the title was drawn at, to store once a drag ends. Rounded, so
// a drag back to the start counts as not moved.
export function offsetPatch(label: LabelSettings, artwork: LabelArtwork): Partial<LabelSettings> {
  const [x, y] = artwork.offset.map((v) => {
    const rounded = Math.round(v * 10_000) / 10_000;
    return Math.abs(rounded) < 0.002 ? 0 : clampShare(rounded);
  });
  return label.style === 'band' ? { bandOffsetX: x, bandOffsetY: y } : { offsetX: x, offsetY: y };
}

// What to store when a drag ends: the settings it reached, at the offset
// they were drawn at.
export function droppedLabel(label: LabelSettings, artwork: LabelArtwork): LabelSettings {
  return { ...label, ...offsetPatch(label, artwork) };
}

export function labelMoved(label: LabelSettings): boolean {
  return label.style === 'band' ? label.bandOffsetX !== 0 || label.bandOffsetY !== 0 : label.offsetX !== 0 || label.offsetY !== 0;
}

export function boxResized(label: LabelSettings): boolean {
  return label.style === 'box' && (label.boxWidth > 0 || label.boxHeight > 0);
}

export const RESET_OFFSET: Partial<LabelSettings> = { offsetX: 0, offsetY: 0, bandOffsetX: 0, bandOffsetY: 0 };

// For the panel and the preview's title card.
export const AUTOFIT_HELP: Record<LabelSettings['style'], string> = {
  box: 'Grows or shrinks the text to fill the box, once the box has been resized by its sides. Off, the text keeps its size and only shrinks when the box is too small for it.',
  band: 'Grows or shrinks the text to fill the band. Off, the text keeps its size and only shrinks when the band is too small for it.',
};
