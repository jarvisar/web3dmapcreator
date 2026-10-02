import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BORDER, type Layout, computeLayout } from '../layout/layout';
import { type Shape, insetShape, shapeContains } from '../layout/shapes';
import type { Point } from '../lines/geometry';
import { PRODUCT_PRESETS } from '../presets';
import { type HersheyFile, parseHershey } from './hershey';
import { DEFAULT_LABEL, type LabelSettings, LabelError, buildLabel, layoutBoxLabel } from './label';
import { parseOutlineFont } from './loadFont';
import { geometryBounds, textGeometry } from './outline';

const hershey = { kind: 'stroke' as const, font: parseHershey(JSON.parse(readFileSync('public/fonts/hershey/futural.json', 'utf8')) as HersheyFile) };
const bytes = readFileSync('public/fonts/Montserrat-SemiBold.ttf');
const montserrat = parseOutlineFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const plaque = computeLayout(PRODUCT_PRESETS[0].product, DEFAULT_BORDER);

const inside = (outer: [number, number, number, number], p: [number, number]) =>
  p[0] >= outer[0] - 1e-9 && p[0] <= outer[0] + outer[2] + 1e-9 && p[1] >= outer[1] - 1e-9 && p[1] <= outer[1] + outer[3] + 1e-9;

describe('text geometry', () => {
  it('outlines a word with an outline font', () => {
    const g = textGeometry(montserrat, 'CHICAGO');
    expect(g.rings.length).toBeGreaterThan(7);
    expect(g.strokes).toHaveLength(0);
  });

  it('draws a word as strokes with a single-line font', () => {
    const g = textGeometry(hershey, 'ROME');
    expect(g.rings).toHaveLength(0);
    expect(g.strokes.length).toBeGreaterThan(4);
  });

  it('spreads letters apart with letter spacing', () => {
    const tight = geometryBounds(textGeometry(montserrat, 'ROME', 1))!;
    const wide = geometryBounds(textGeometry(montserrat, 'ROME', 1.5))!;
    expect(wide[2] - wide[0]).toBeGreaterThan((tight[2] - tight[0]) * 1.2);
  });
});

describe('title layout', () => {
  it('puts the box in the lower right corner, inside the border', () => {
    const artwork = layoutBoxLabel(plaque, DEFAULT_LABEL, textGeometry(montserrat, 'CHICAGO'))!;
    const [x, y, w, h] = artwork.knockout;
    const a = plaque.labelAnchor;
    expect(x + w).toBeCloseTo(a.x + a.w - DEFAULT_LABEL.gap, 9);
    expect(y + h).toBeCloseTo(a.y + a.h - DEFAULT_LABEL.gap, 9);
    for (const ring of artwork.text.rings) for (const p of ring) expect(inside(artwork.knockout, p)).toBe(true);
  });

  it('keeps the reference text height', () => {
    const artwork = layoutBoxLabel(plaque, DEFAULT_LABEL, textGeometry(montserrat, 'CHICAGO'))!;
    const b = geometryBounds(artwork.text)!;
    expect(b[3] - b[1]).toBeCloseTo(DEFAULT_LABEL.textHeight * DEFAULT_LABEL.textScale, 6);
  });

  it('turns the box with the text', () => {
    const upright = layoutBoxLabel(plaque, DEFAULT_LABEL, textGeometry(montserrat, 'CHICAGO'));
    const turned = layoutBoxLabel(plaque, { ...DEFAULT_LABEL, rotation: 90 }, textGeometry(montserrat, 'CHICAGO'));
    expect(turned.knockout[2]).toBeCloseTo(upright.knockout[3], 9);
    expect(turned.knockout[3]).toBeCloseTo(upright.knockout[2], 9);
  });

  it('shrinks a title too big for the piece until it fits', () => {
    const artwork = layoutBoxLabel(plaque, { ...DEFAULT_LABEL, size: 1000 }, textGeometry(montserrat, 'CHICAGO'));
    const limit = insetShape(plaque.labelAnchor, DEFAULT_LABEL.gap);
    expect(artwork.scale).toBeLessThan(1);
    expect(artwork.knockout[2]).toBeCloseTo(limit.w, 3);
    expect(() => layoutBoxLabel(plaque, { ...DEFAULT_LABEL, gap: 60 }, textGeometry(montserrat, 'CHICAGO'))).toThrow(LabelError);
  });

  it('fits a title band with a subtitle at the bottom', () => {
    const s = { ...DEFAULT_LABEL, style: 'band' as const, subtitle: 'ILLINOIS' };
    const { artwork } = buildLabel(plaque, s, montserrat, montserrat);
    const [, y, , h] = artwork!.knockout;
    expect(y + h).toBeCloseTo(plaque.bandAnchor.y + plaque.bandAnchor.h, 9);
    expect(h).toBeCloseTo((plaque.bandAnchor.h * s.bandHeight) / 100, 9);
    expect(artwork!.frame).toHaveLength(1);
  });

  it('reports a problem instead of throwing', () => {
    const { artwork, error } = buildLabel(plaque, { ...DEFAULT_LABEL, gap: 60 }, montserrat, montserrat);
    expect(artwork).toBeNull();
    expect(error).toMatch(/does not fit/);
  });

  it('draws a title the font cannot shape a letter at a time, with a warning', () => {
    const font = parseOutlineFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (font.kind !== 'outline') throw new Error('outline font expected');
    font.font.stringToGlyphs = () => {
      throw new Error('lookupType: 7 - substFormat: 1 is not yet supported');
    };
    const { artwork, error, warnings } = buildLabel(plaque, DEFAULT_LABEL, font, font);
    expect(error).toBeNull();
    expect(artwork!.text.rings.length).toBe(textGeometry(montserrat, DEFAULT_LABEL.text).rings.length);
    expect(warnings.join(' ')).toMatch(/a letter at a time/);
  });

  it('loses only the title when the font throws on it', () => {
    const font = parseOutlineFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (font.kind !== 'outline') throw new Error('outline font expected');
    font.font.charToGlyphIndex = () => {
      throw new Error('broken cmap');
    };
    font.font.stringToGlyphs = () => {
      throw new Error('lookupType: 7 - substFormat: 1 is not yet supported');
    };
    const { artwork, error } = buildLabel(plaque, DEFAULT_LABEL, font, font);
    expect(artwork).toBeNull();
    expect(error).toMatch(/couldn't be drawn in this font/);
  });

  it('warns about letters the font has no glyph for', () => {
    const plotted = buildLabel(plaque, { ...DEFAULT_LABEL, text: 'MÜNCHEN' }, hershey, hershey);
    expect(plotted.warnings).toEqual(['The title font has no “Ü”, so it\'s drawn as a question mark.']);
    const boxed = buildLabel(plaque, { ...DEFAULT_LABEL, text: '東京 TOKYO' }, montserrat, montserrat);
    expect(boxed.warnings).toEqual(['The title font has no “東” or “京”, so they\'re drawn as boxes.']);
    expect(buildLabel(plaque, { ...DEFAULT_LABEL, text: 'CHICAGO' }, montserrat, montserrat).warnings).toEqual([]);
  });
});

describe('resized titles', () => {
  const text = () => textGeometry(montserrat, 'CHICAGO');
  const textSize = (artwork: { text: Parameters<typeof geometryBounds>[0] }) => {
    const b = geometryBounds(artwork.text)!;
    return [b[2] - b[0], b[3] - b[1]];
  };
  const auto = layoutBoxLabel(plaque, DEFAULT_LABEL, text());

  it('takes a set width and fits the height to the text', () => {
    const wide = layoutBoxLabel(plaque, { ...DEFAULT_LABEL, boxWidth: 80 }, text());
    expect(wide.knockout[2]).toBeCloseTo(80, 9);
    expect(wide.knockout[3]).toBeCloseTo(auto.knockout[3], 9);
    expect(textSize(wide)[0]).toBeCloseTo(textSize(auto)[0], 9);
  });

  it('shrinks the text to a box too small for it', () => {
    const narrow = layoutBoxLabel(plaque, { ...DEFAULT_LABEL, boxWidth: 30 }, text());
    expect(narrow.knockout[2]).toBeCloseTo(30, 9);
    expect(textSize(narrow)[0]).toBeLessThan(30 - 2 * DEFAULT_LABEL.paddingX);
    // The height follows the smaller text.
    expect(narrow.knockout[3]).toBeLessThan(auto.knockout[3]);
  });

  it('fills a box with autofit', () => {
    const s = { ...DEFAULT_LABEL, boxWidth: 120, boxHeight: 30, autofit: true };
    const filled = layoutBoxLabel(plaque, s, text());
    expect(filled.knockout[2]).toBeCloseTo(120, 9);
    expect(filled.knockout[3]).toBeCloseTo(30, 9);
    const [w, h] = textSize(filled);
    // One side of the text meets the padding, less the text's share of the box.
    const roomW = (120 - 2 * (DEFAULT_LABEL.paddingX + DEFAULT_LABEL.borderWidth)) * DEFAULT_LABEL.textScale;
    const roomH = (30 - 2 * (DEFAULT_LABEL.paddingY + DEFAULT_LABEL.borderWidth)) * DEFAULT_LABEL.textScale;
    expect(Math.max(w / roomW, h / roomH)).toBeCloseTo(1, 6);
    expect(w).toBeGreaterThan(textSize(auto)[0]);
  });

  it('scales a set box with the size', () => {
    const half = layoutBoxLabel(plaque, { ...DEFAULT_LABEL, boxWidth: 80, size: 50 }, text());
    expect(half.knockout[2]).toBeCloseTo(40, 9);
  });

  it('turns a set box with the text', () => {
    const turned = layoutBoxLabel(plaque, { ...DEFAULT_LABEL, boxWidth: 80, rotation: 90 }, text());
    expect(turned.knockout[3]).toBeCloseTo(80, 9);
  });

  it('refuses a box too small for its padding', () => {
    expect(() => layoutBoxLabel(plaque, { ...DEFAULT_LABEL, boxWidth: 3 }, text())).toThrow(LabelError);
  });

  it('grows band text to fill the band with autofit', () => {
    const s = { ...DEFAULT_LABEL, style: 'band' as const, bandHeight: 30 };
    const set = buildLabel(plaque, s, montserrat, montserrat).artwork!;
    const filled = buildLabel(plaque, { ...s, autofit: true }, montserrat, montserrat).artwork!;
    expect(set.scale).toBe(1);
    expect(filled.scale).toBeGreaterThan(1);
    expect(textSize(filled)[1]).toBeGreaterThan(textSize(set)[1] * 1.5);
    for (const ring of filled.text.rings) for (const p of ring) expect(inside(filled.knockout, p)).toBe(true);
  });
});

describe('titles on round and hexagonal pieces', () => {
  const single = { ...DEFAULT_BORDER, style: 'single' as const };
  const margins = { top: 2, right: 2, bottom: 2, left: 2 };
  const coaster = computeLayout({ shape: 'circle', width: 100, height: 100, cornerRadius: 0, margins }, single);
  const hexagon = computeLayout({ shape: 'hexagon', width: 120, height: 120 * (Math.sqrt(3) / 2), cornerRadius: 0, margins }, single);
  const box = (layout: Layout, patch: Partial<LabelSettings>, text = 'ROME') =>
    layoutBoxLabel(layout, { ...DEFAULT_LABEL, ...patch }, textGeometry(montserrat, text));
  const corners = ([x, y, w, h]: number[]): Point[] => [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ];
  // A micron of slack for the corners that touch the edge.
  const within = (shape: Shape, p: Point) => shapeContains(insetShape(shape, -1e-6), p);

  it('keeps every box position inside the border', () => {
    for (const layout of [coaster, hexagon]) {
      const limit = insetShape(layout.labelAnchor, DEFAULT_LABEL.gap);
      for (const position of ['lower_right', 'lower_left', 'upper_right', 'upper_left', 'lower_center', 'upper_center'] as const) {
        for (const rotation of [0, 90] as const) {
          for (const text of ['ROME', 'VANCOUVER']) {
            const { knockout } = box(layout, { position, rotation }, text);
            for (const p of corners(knockout)) expect(within(limit, p)).toBe(true);
          }
        }
      }
    }
  });

  it('puts the corner positions of a circle in the corners', () => {
    const right = box(coaster, { position: 'lower_right' }).knockout;
    const left = box(coaster, { position: 'lower_left' }).knockout;
    const [cx, cy] = [coaster.window.x + coaster.window.w / 2, coaster.window.y + coaster.window.h / 2];
    // Mirror images, well to either side and below the middle.
    expect(right[0] + right[2] / 2 - cx).toBeCloseTo(cx - (left[0] + left[2] / 2), 6);
    expect(right[0] + right[2] / 2 - cx).toBeGreaterThan(10);
    expect(right[1] + right[3] / 2 - cy).toBeGreaterThan(20);
  });

  it('sits a box on the flat bottom of a hexagon', () => {
    const limit = insetShape(hexagon.labelAnchor, DEFAULT_LABEL.gap);
    for (const position of ['lower_right', 'lower_left', 'lower_center'] as const) {
      const [, y, , h] = box(hexagon, { position }).knockout;
      expect(y + h).toBeCloseTo(limit.y + limit.h, 6);
    }
    const [x, , w] = box(hexagon, { position: 'lower_right' }).knockout;
    expect(x + w).toBeGreaterThan(limit.x + limit.w * 0.7);
  });

  it('puts the outer corner of a corner box on the rim of a circle', () => {
    const limit = insetShape(coaster.labelAnchor, DEFAULT_LABEL.gap);
    const [cx, cy] = [limit.x + limit.r, limit.y + limit.r];
    for (const rotation of [0, 90] as const) {
      const [x, y, w, h] = box(coaster, { position: 'lower_right', rotation }).knockout;
      expect(Math.hypot(x + w - cx, y + h - cy)).toBeCloseTo(limit.r, 2);
    }
  });

  it('moves a dragged box and keeps it inside', () => {
    const start = box(coaster, {});
    const moved = box(coaster, { offsetX: -0.2, offsetY: -0.3 });
    expect(moved.offset[0]).toBeCloseTo(-0.2, 9);
    expect(moved.offset[1]).toBeCloseTo(-0.3, 9);
    expect(moved.knockout[0] - start.knockout[0]).toBeCloseTo(-0.2 * coaster.labelAnchor.w, 6);
    // Dragged off the piece it stops at the edge, and says where.
    const far = box(coaster, { offsetX: 1, offsetY: 1 });
    expect(far.offset[0]).toBeLessThan(1);
    const limit = insetShape(coaster.labelAnchor, DEFAULT_LABEL.gap);
    for (const p of corners(far.knockout)) expect(within(limit, p)).toBe(true);
    const again = box(coaster, { offsetX: far.offset[0], offsetY: far.offset[1] });
    expect(again.knockout[0]).toBeCloseTo(far.knockout[0], 6);
    expect(again.knockout[1]).toBeCloseTo(far.knockout[1], 6);
  });

  it('fits band text by the straight edge of a circle, inside the window', () => {
    for (const bandPosition of ['bottom', 'top'] as const) {
      const s = { ...DEFAULT_LABEL, style: 'band' as const, bandPosition, text: 'VANCOUVER', subtitle: '49.2827° N, 123.1207° W' };
      const { artwork } = buildLabel(coaster, s, montserrat, montserrat);
      const b = geometryBounds(artwork!.text)!;
      for (const ring of artwork!.text.rings) for (const p of ring) expect(within(coaster.window, p)).toBe(true);
      const [, top, , height] = artwork!.knockout;
      const middle = top + height / 2;
      // Nearer the divider than the rim.
      if (bandPosition === 'bottom') expect((b[1] + b[3]) / 2).toBeLessThan(middle);
      else expect((b[1] + b[3]) / 2).toBeGreaterThan(middle);
    }
  });

  it('moves dragged band text within the band', () => {
    const s = { ...DEFAULT_LABEL, style: 'band' as const, text: 'ROME' };
    const start = buildLabel(hexagon, s, montserrat, montserrat).artwork!;
    const moved = buildLabel(hexagon, { ...s, bandOffsetX: -0.1 }, montserrat, montserrat).artwork!;
    expect(moved.offset[0]).toBeCloseTo(-0.1, 6);
    expect(geometryBounds(moved.text)![0] - geometryBounds(start.text)![0]).toBeCloseTo(-0.1 * hexagon.bandAnchor.w, 6);
    const far = buildLabel(hexagon, { ...s, bandOffsetX: -1, bandOffsetY: 1 }, montserrat, montserrat).artwork!;
    expect(far.offset[0]).toBeGreaterThan(-1);
    for (const ring of far.text.rings) for (const p of ring) expect(within(hexagon.window, p)).toBe(true);
  });
});
