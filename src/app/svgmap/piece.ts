// The piece an SVG map is made for (a plaque, a sheet of paper, a coaster),
// and how the shared area follows it. In SVG mode the area on the map is the
// piece's map window, so its proportions and corners come from the piece.
import type { AreaShape, AreaSpec } from '../../core/settings';
import { type BorderSettings, type Layout, LayoutError, type ProductSettings, computeLayout } from '../../core/svgmap/layout/layout';
import type { ShapeKind } from '../../core/svgmap/layout/shapes';
import { HEX_RATIO, normalizeArea } from '../lib/area';
import type { PieceSize, SvgSettings } from './settings';

const SHAPE_KINDS: Record<AreaShape, ShapeKind> = { rectangle: 'rect', rounded: 'rounded', circle: 'circle', hexagon: 'hexagon' };
const AREA_SHAPES: Record<ShapeKind, AreaShape> = { rect: 'rectangle', rounded: 'rounded', circle: 'circle', hexagon: 'hexagon' };

export const areaShapeOf = (kind: ShapeKind): AreaShape => AREA_SHAPES[kind] ?? 'rectangle';

// Circles and hexagons only have a width. Their height follows it.
export function pieceHeight(size: PieceSize, shape: AreaShape): number {
  if (shape === 'circle') return size.width;
  if (shape === 'hexagon') return size.width * HEX_RATIO;
  return size.height;
}

export function pieceProduct(size: PieceSize, shape: AreaShape): ProductSettings {
  return { ...size, shape: SHAPE_KINDS[shape] ?? 'rect', height: pieceHeight(size, shape) };
}

export function pieceLayout(size: PieceSize, shape: AreaShape, border: BorderSettings): { layout: Layout | null; error: string | null } {
  try {
    return { layout: computeLayout(pieceProduct(size, shape), border), error: null };
  } catch (error) {
    return { layout: null, error: error instanceof LayoutError ? error.message : String(error) };
  }
}

/**
 * How the map window takes the size of an area it's given: keep the width,
 * grow to cover the whole area (presets and pasted bounds), or fit inside it
 * (the visible map).
 */
export type PieceFit = 'width' | 'cover' | 'inside';

/**
 * The area as the piece's map window, and the 1:n scale that makes. A locked
 * scale sets the width whatever the fit.
 */
export function fitAreaToPiece(area: AreaSpec, svg: SvgSettings, fit: PieceFit = 'width'): { area: AreaSpec; scale: number } {
  const { layout } = pieceLayout(svg.product, area.shape, svg.border);
  if (!layout) return { area: normalizeArea(area), scale: svg.scale };
  const window = layout.window;
  const aspect = window.h / window.w;
  let width = area.widthM;
  if (svg.scaleLocked) width = (svg.scale * window.w) / 1000;
  else if (fit === 'cover') width = Math.max(area.widthM, area.heightM / aspect);
  else if (fit === 'inside') width = Math.min(area.widthM, area.heightM / aspect);
  const cornerRadius = window.kind === 'rounded' ? window.r / Math.min(window.w, window.h) : area.cornerRadius;
  const fitted = normalizeArea({ ...area, widthM: width, heightM: width * aspect, cornerRadius });
  return { area: fitted, scale: svg.scaleLocked ? svg.scale : (fitted.widthM / window.w) * 1000 };
}
