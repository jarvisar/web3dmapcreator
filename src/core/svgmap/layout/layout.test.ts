import { describe, expect, it } from 'vitest';
import { PRODUCT_PRESETS } from '../presets';
import { DEFAULT_BORDER, LayoutError, computeLayout } from './layout';
import { distanceToEdge, insetShape, makeShape, shapeContains, shapePolygon } from './shapes';

const preset = (id: string) => PRODUCT_PRESETS.find((p) => p.id === id)!.product;

describe('layout', () => {
  // Map windows from the Blender add-on's board-size table.
  it.each([
    ['plaque-4x6', 135.0, 84.0],
    ['plaque-5x7', 160.4, 109.4],
    ['plaque-8x10', 236.6, 185.6],
  ])('%s leaves a %s x %s mm map window', (id, w, h) => {
    const layout = computeLayout(preset(id), DEFAULT_BORDER);
    expect(layout.window.w).toBeCloseTo(w, 6);
    expect(layout.window.h).toBeCloseTo(h, 6);
  });

  it('puts the 5 x 7 artwork and border where the reference plaque has them', () => {
    const layout = computeLayout(preset('plaque-5x7'), DEFAULT_BORDER);
    expect(layout.artwork.w).toBeCloseTo(170.5, 6);
    expect(layout.artwork.h).toBeCloseTo(119.5, 6);
    expect(layout.window.x - layout.artwork.x).toBeCloseTo(5.05, 6);
    expect(layout.thickBand!.outer.x - layout.artwork.x).toBeCloseTo(1.5, 6);
    expect(layout.thinLine!.x - layout.artwork.x).toBeCloseTo(3.425, 6);
  });

  it('uses the whole artwork as the window without a border', () => {
    const layout = computeLayout(preset('a4'), { ...DEFAULT_BORDER, style: 'none' });
    expect(layout.window).toEqual(layout.artwork);
    expect(layout.thickBand).toBeNull();
    expect(layout.thinLine).toBeNull();
  });

  it('refuses margins that leave no room', () => {
    const product = { ...preset('coaster-100'), margins: { top: 49, right: 49, bottom: 49, left: 49 } };
    expect(() => computeLayout(product, DEFAULT_BORDER)).toThrow(LayoutError);
  });

  it('refuses negative border sizes', () => {
    expect(() => computeLayout(preset('plaque-5x7'), { ...DEFAULT_BORDER, innerGap: -1 })).toThrow(LayoutError);
  });
});

describe('shapes', () => {
  it('shrinks a circle about its centre', () => {
    const inner = insetShape(makeShape('circle', 0, 0, 100, 100), 10);
    expect(inner).toMatchObject({ x: 10, y: 10, w: 80, h: 80, r: 40 });
  });

  it('shrinks rounded corners with the shape', () => {
    const inner = insetShape(makeShape('rounded', 0, 0, 100, 60, 8), 3);
    expect(inner.r).toBe(5);
    expect(insetShape(inner, 10).r).toBe(0);
  });

  it('knows what is inside a rounded corner', () => {
    const shape = makeShape('rounded', 0, 0, 100, 60, 10);
    expect(shapeContains(shape, [1, 1])).toBe(false);
    expect(shapeContains(shape, [5, 5])).toBe(true);
    expect(shapeContains(shape, [50, 30])).toBe(true);
  });

  it('measures the distance to the outline', () => {
    expect(distanceToEdge(makeShape('rect', 0, 0, 100, 60), [10, 30])).toBe(10);
    expect(distanceToEdge(makeShape('circle', 0, 0, 100, 100), [50, 20])).toBeCloseTo(20, 9);
  });

  it('approximates a circle within the tolerance', () => {
    const circle = makeShape('circle', 0, 0, 100, 100);
    for (const [x, y] of shapePolygon(circle, 0.01)) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(50, 9);
  });

  it('fits the largest regular hexagon with flat top and bottom sides', () => {
    const wide = makeShape('hexagon', 0, 0, 200, 100);
    expect(wide.h).toBeCloseTo(100, 9);
    expect(wide.w).toBeCloseTo(200 / Math.sqrt(3), 9);
    expect(wide.x + wide.w / 2).toBeCloseTo(100, 9);
    const tall = makeShape('hexagon', 0, 0, 100, 200);
    expect(tall.w).toBeCloseTo(100, 9);
    expect(tall.h).toBeCloseTo(50 * Math.sqrt(3), 9);
    const corners = shapePolygon(tall);
    expect(corners).toHaveLength(6);
    expect(Math.min(...corners.map(([, y]) => y))).toBeCloseTo(tall.y, 9);
  });

  it('shrinks a hexagon by the same distance on every side', () => {
    const outer = makeShape('hexagon', 0, 0, 100, 100);
    const inner = insetShape(outer, 5);
    expect(outer.h - inner.h).toBeCloseTo(10, 9);
    const [cx, cy] = [outer.x + outer.w / 2, outer.y + outer.h / 2];
    // The middle of the upper right side, in by 5 mm along its normal.
    const a = Math.PI / 6;
    const apothem = (inner.r * Math.sqrt(3)) / 2;
    expect(distanceToEdge(outer, [cx + apothem * Math.cos(a), cy - apothem * Math.sin(a)])).toBeCloseTo(5, 9);
  });

  it('knows what is inside a hexagon', () => {
    const shape = makeShape('hexagon', 0, 0, 100, 100);
    const [cx, cy] = [shape.x + shape.w / 2, shape.y + shape.h / 2];
    expect(shapeContains(shape, [cx, cy])).toBe(true);
    expect(shapeContains(shape, [shape.x + 1, cy])).toBe(true);
    expect(shapeContains(shape, [shape.x + 1, shape.y + 1])).toBe(false);
    expect(shapeContains(shape, [cx + shape.r * 0.74, shape.y + 1])).toBe(false);
    expect(shapeContains(shape, [cx + shape.r * 0.49, shape.y + 1])).toBe(true);
  });

  it('lays out a hexagonal piece with its border inside', () => {
    const layout = computeLayout({ ...preset('coaster-100'), shape: 'hexagon' }, DEFAULT_BORDER);
    expect(layout.canvas.kind).toBe('hexagon');
    expect(layout.window.kind).toBe('hexagon');
    for (const p of shapePolygon(layout.window)) expect(shapeContains(layout.canvas, p)).toBe(true);
    expect(layout.window.w / layout.window.h).toBeCloseTo(2 / Math.sqrt(3), 9);
  });
});
