// Moving the title by dragging it, on the map or in the preview. The offset
// is a share of the space inside the border (box) or of the band, so a moved
// title keeps roughly its place when the piece changes size.
import type { Layout } from '../../core/svgmap/layout/layout';
import type { LabelArtwork, LabelSettings } from '../../core/svgmap/text/label';

const clampShare = (v: number) => Math.min(1, Math.max(-1, v));

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

// The offset the title was drawn at, to store once a drag ends. Rounded, so
// a drag back to the start counts as not moved.
export function offsetPatch(label: LabelSettings, artwork: LabelArtwork): Partial<LabelSettings> {
  const [x, y] = artwork.offset.map((v) => {
    const rounded = Math.round(v * 10_000) / 10_000;
    return Math.abs(rounded) < 0.002 ? 0 : clampShare(rounded);
  });
  return label.style === 'band' ? { bandOffsetX: x, bandOffsetY: y } : { offsetX: x, offsetY: y };
}

export function labelMoved(label: LabelSettings): boolean {
  return label.style === 'band' ? label.bandOffsetX !== 0 || label.bandOffsetY !== 0 : label.offsetX !== 0 || label.offsetY !== 0;
}

export const RESET_OFFSET: Partial<LabelSettings> = { offsetX: 0, offsetY: 0, bandOffsetX: 0, bandOffsetY: 0 };

export function titleAt(artwork: LabelArtwork | null, x: number, y: number): boolean {
  if (!artwork) return false;
  const [kx, ky, kw, kh] = artwork.knockout;
  return x >= kx && x <= kx + kw && y >= ky && y <= ky + kh;
}
