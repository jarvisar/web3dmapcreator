// The piece drawn around its map window on the map: the margin, the border and
// the title, in piece millimetres, the way SVGmap's frame showed them. The area
// editor places it over the window as the map moves.
import type { Layout } from '../../core/svgmap/layout/layout';
import { bandPathD, shapePathD } from '../../core/svgmap/layout/shapes';
import { fmt, polylineD } from '../../core/svgmap/svg/format';
import type { LabelArtwork } from '../../core/svgmap/text/label';

export interface PieceOverlay {
  /** SVG markup in piece millimetres. Only numbers from the layout go in it. */
  markup: string;
  /** The map window and the whole piece, [x, y, w, h] in piece millimetres. */
  window: [number, number, number, number];
  canvas: [number, number, number, number];
}

const LINE = 'vector-effect="non-scaling-stroke"';

export function pieceOverlay(layout: Layout, artwork: LabelArtwork | null): PieceOverlay {
  const parts = [`<path class="piece-margin" d="${bandPathD(layout.canvas, layout.window)}"/>`];
  if (layout.thickBand) parts.push(`<path class="piece-band" d="${bandPathD(layout.thickBand.outer, layout.thickBand.inner)}"/>`);
  if (layout.thinLine) parts.push(`<path class="piece-line" ${LINE} d="${shapePathD(layout.thinLine)}"/>`);
  parts.push(`<path class="piece-edge" ${LINE} d="${shapePathD(layout.canvas)}"/>`);
  if (artwork) {
    const [x, y, w, h] = artwork.knockout;
    parts.push(`<rect class="piece-title-box" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"/>`);
    for (const segment of artwork.frame) parts.push(`<path class="piece-title-line" ${LINE} d="${polylineD(segment)}"/>`);
    const rings = artwork.text.rings.map((ring) => polylineD(ring, true)).join('');
    if (rings) parts.push(`<path class="piece-title-fill" d="${rings}"/>`);
    const strokes = artwork.text.strokes.map((stroke) => polylineD(stroke)).join('');
    if (strokes) parts.push(`<path class="piece-title-stroke" ${LINE} d="${strokes}"/>`);
  }
  const { window, canvas } = layout;
  return {
    markup: parts.join(''),
    window: [window.x, window.y, window.w, window.h],
    canvas: [canvas.x, canvas.y, canvas.w, canvas.h],
  };
}
