// Layout of the piece in mm, y down. The canvas is the material and the cut
// follows it. The artwork is the canvas minus a blank margin, the border sits
// inside the artwork edge, and the map goes in the window inside that.
//
// The defaults match the original 5 x 7 inch plaque: 177.8 x 127 mm board,
// 3.65 and 3.75 mm margins, 170.5 x 119.5 mm artwork, 160.4 x 109.4 mm window.
import { type Insets, type Shape, type ShapeKind, insetShape, makeShape, uniformInsets } from './shapes';

export interface ProductSettings {
  shape: ShapeKind;
  // A circle uses the smaller of the two, a hexagon the largest that fits.
  width: number;
  height: number;
  cornerRadius: number;
  margins: Insets;
}

export type BorderStyle = 'double' | 'single' | 'none';

export interface BorderSettings {
  style: BorderStyle;
  // Artwork edge to thick band.
  outerGap: number;
  thick: number;
  // Thick band to thin line.
  gap: number;
  thin: number;
  // Thin line to map window.
  innerGap: number;
}

export const DEFAULT_BORDER: BorderSettings = {
  style: 'double',
  outerGap: 1.5,
  thick: 0.8,
  gap: 1.0,
  thin: 0.25,
  innerGap: 1.5,
};

export interface Layout {
  canvas: Shape;
  artwork: Shape;
  thickBand: { outer: Shape; inner: Shape } | null;
  // Centreline of the thin line.
  thinLine: Shape | null;
  thinWidth: number;
  window: Shape;
  // Inner edge of the thin line. Box labels sit a gap inside it.
  labelAnchor: Shape;
  // A title band reaches the centreline of the thin line.
  bandAnchor: Shape;
}

export class LayoutError extends Error {}

export function computeLayout(product: ProductSettings, border: BorderSettings): Layout {
  const { width, height } = product;
  if (!(width > 0 && height > 0)) throw new LayoutError('Canvas width and height must be positive.');
  const canvas = makeShape(product.shape, 0, 0, width, height, product.cornerRadius);
  const m = product.margins;
  if ([m.top, m.right, m.bottom, m.left].some((v) => !(v >= 0))) {
    throw new LayoutError('Margins cannot be negative.');
  }
  const artwork = insetShape(canvas, m);
  if (artwork.w < 5 || artwork.h < 5) throw new LayoutError('The margins leave no room for the map.');
  const b = border;
  if ([b.outerGap, b.thick, b.gap, b.thin, b.innerGap].some((v) => !(v >= 0))) {
    throw new LayoutError('Border sizes cannot be negative.');
  }

  let thickBand: Layout['thickBand'] = null;
  let thinLine: Shape | null = null;
  let windowInset = 0;
  let labelInset = 0;
  let bandInset = 0;
  if (border.style === 'double') {
    thickBand = {
      outer: insetShape(artwork, border.outerGap),
      inner: insetShape(artwork, border.outerGap + border.thick),
    };
    const thinCentre = border.outerGap + border.thick + border.gap + border.thin / 2;
    thinLine = insetShape(artwork, thinCentre);
    labelInset = thinCentre + border.thin / 2;
    bandInset = thinCentre;
    windowInset = labelInset + border.innerGap;
  } else if (border.style === 'single') {
    const thinCentre = border.outerGap + border.thin / 2;
    thinLine = insetShape(artwork, thinCentre);
    labelInset = thinCentre + border.thin / 2;
    bandInset = thinCentre;
    windowInset = labelInset + border.innerGap;
  }
  const window = insetShape(artwork, uniformInsets(windowInset));
  if (window.w < 5 || window.h < 5) {
    throw new LayoutError('The border leaves no room for the map. Reduce the border or use a larger piece.');
  }
  return {
    canvas,
    artwork,
    thickBand,
    thinLine,
    thinWidth: border.thin,
    window,
    labelAnchor: insetShape(artwork, labelInset),
    bandAnchor: insetShape(artwork, bandInset),
  };
}
